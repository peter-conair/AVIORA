import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { ERROR_CODES, PERMISSIONS } from '@aviora/shared';
import type { Tx } from '@aviora/db';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../common/db/prisma.service';
import { TenantDb } from '../../common/db/tenant-db.service';
import { CLS_MEMBER_ID, PLATFORM_BYPASS } from '../../common/auth/permissions.guard';
import { CLS_TENANT_ID } from '../../common/tenant/tenant-context.middleware';
import { CLS_PLATFORM_ROLE } from '../../common/auth/jwt-auth.guard';
import { STORAGE_PORT, type StoragePort } from '../../common/storage/storage.port';
import { TeamScopeService, type AccessibleTeams } from '../team/team-scope.service';

/**
 * Knowledge OS (spec §28–§33). Two rules shape everything here:
 *
 * 1. Product is never the beginning of the journey — a goal leads to topics,
 *    topics to articles and ingredients, and only then to products.
 * 2. Search ranks knowledge ABOVE products (§33), and products are returned
 *    brand-neutrally: ordering never considers the brand.
 */

/** A row's per-locale overrides, as stored in the `translations` JSONB column. */
type Translations = Record<string, Record<string, string>> | null;

/**
 * Returns the field in the requested locale, falling back to the base value.
 * Content is authored in one base language with translations layered on top,
 * so a partially translated row degrades field by field rather than all at once.
 */
function localized<T extends { translations?: unknown }>(
  row: T,
  locale: string,
  fields: Record<string, string | null>,
): Record<string, string | null> {
  const t = (row.translations as Translations)?.[locale];
  const out: Record<string, string | null> = {};
  for (const [key, base] of Object.entries(fields)) {
    out[key] = t?.[key] ?? base;
  }
  return out;
}

@Injectable()
export class KnowledgeService {
  constructor(
    private readonly db: TenantDb,
    private readonly cls: ClsService,
    private readonly teamScope: TeamScopeService,
    private readonly audit: AuditService,
    private readonly prisma: PrismaService,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
  ) {}

  /**
   * The bytes of a catalogue picture we keep our own copy of (docs/74 §7).
   *
   * Only rows with a `stored_path` are served. A row that still points at
   * somebody else's CDN is not proxied through here — the client has the URL
   * and fetching it on their behalf would make this API a bandwidth relay for
   * a file it does not own.
   *
   * Unlike a progress photograph, this is NOT private: it is a picture of a
   * product every tenant can already see, so it may be cached.
   */
  async productImageContent(id: string): Promise<{ body: Buffer; contentType: string }> {
    // Read WITHOUT tenant context, and deliberately: `product_images` carries
    // no tenant_id at all — it hangs off a global product — and `TenantDb`
    // refuses to open a transaction without one. The app role reaches it under
    // the same `join_open` policy every other link table uses, so this is the
    // ordinary path for the row rather than a way around a check.
    const image = await this.prisma.app.productImage.findFirst({
      where: { id },
      select: { storedPath: true },
    });
    if (!image?.storedPath) {
      throw new NotFoundException({
        code: ERROR_CODES.NOT_FOUND,
        message: 'No stored copy of this picture',
      });
    }
    const object = await this.storage.get(image.storedPath);
    if (!object) {
      throw new NotFoundException({
        code: ERROR_CODES.NOT_FOUND,
        message: 'No stored copy of this picture',
      });
    }
    return object;
  }

  /**
   * The team articles this caller may READ (docs/37 §2).
   *
   * Reading goes UP the tree: a member of team Y may read what is attached to
   * Y and to every ancestor of Y, because knowledge published at a region is
   * meant for the branches under it. Writing goes the other way and is
   * resolved by `TeamScopeService` — leadership, not membership. Using one for
   * the other would either hide a team's own handbook from the team, or let
   * any member publish to it.
   *
   * Returns the team ids whose articles are readable. The caller puts them IN
   * the query; nothing filters rows that were already fetched (§3).
   */
  private async readableTeamIds(tx: Tx): Promise<string[]> {
    const memberId = this.cls.get<string | undefined>(CLS_MEMBER_ID);
    if (!memberId) return [];
    const mine = await tx.teamMembership.findMany({
      where: { memberId, status: 'active' },
      select: { teamId: true },
    });
    if (mine.length === 0) return [];
    const teamIds = mine.map((m) => m.teamId);
    // Ancestors of the teams I am in — `team_closure` holds (ancestor,
    // descendant) for every pair including depth 0, so this returns my own
    // teams as well.
    const up = await tx.teamClosure.findMany({
      where: { descendantTeamId: { in: teamIds } },
      select: { ancestorTeamId: true },
    });
    return [...new Set([...teamIds, ...up.map((u) => u.ancestorTeamId)])];
  }

  /**
   * The article filter every read path shares: anything not attached to a team,
   * plus the teams this caller may read. One place, so a new route cannot
   * accidentally answer with somebody else's team knowledge.
   */
  private async articleScope(tx: Tx): Promise<{ OR: object[] }> {
    const teamIds = await this.readableTeamIds(tx);
    return {
      OR: [{ teamId: null }, ...(teamIds.length > 0 ? [{ teamId: { in: teamIds } }] : [])],
    };
  }

  /** Global + this tenant's knowledge; RLS already limits it to those two. */
  async healthGoals(locale: string) {
    const rows = await this.db.tx((tx) =>
      tx.healthGoal.findMany({
        orderBy: [{ order: 'asc' }, { name: 'asc' }],
        select: {
          id: true,
          code: true,
          name: true,
          description: true,
          tenantId: true,
          translations: true,
        },
      }),
    );
    return rows.map((g) => ({
      id: g.id,
      code: g.code,
      tenantId: g.tenantId,
      ...localized(g, locale, { name: g.name, description: g.description }),
    }));
  }

  /**
   * The §74 journey for one health goal:
   *   goal → topics → articles → ingredients → (evidence) → products
   */
  async journey(goalCode: string, locale: string) {
    return this.db.tx(async (tx) => {
      const goal = await tx.healthGoal.findFirst({ where: { code: goalCode } });
      if (!goal) {
        throw new NotFoundException({
          code: ERROR_CODES.NOT_FOUND,
          message: 'Health goal not found',
        });
      }
      const links = await tx.healthGoalTopic.findMany({
        where: { healthGoalId: goal.id },
        select: { topicId: true },
      });
      const topicIds = links.map((l) => l.topicId);
      const topics = await tx.topic.findMany({
        where: { id: { in: topicIds } },
        orderBy: { name: 'asc' },
        select: { id: true, code: true, name: true, summary: true, translations: true },
      });

      const [topicIngredients, articleTopics] = await Promise.all([
        tx.topicIngredient.findMany({
          where: { topicId: { in: topicIds } },
          select: { topicId: true, ingredientId: true },
        }),
        tx.articleTopic.findMany({
          where: { topicId: { in: topicIds } },
          select: { topicId: true, articleId: true },
        }),
      ]);

      const ingredientIds = [...new Set(topicIngredients.map((t) => t.ingredientId))];
      const articleIds = [...new Set(articleTopics.map((a) => a.articleId))];

      const [ingredients, articles, evidence, productLinks, topicProductLinks] = await Promise.all([
        tx.ingredient.findMany({
          where: { id: { in: ingredientIds } },
          orderBy: { name: 'asc' },
          select: {
            id: true,
            code: true,
            name: true,
            summary: true,
            safetyNotes: true,
            translations: true,
          },
        }),
        tx.article.findMany({
          where: { id: { in: articleIds }, status: 'published' },
          orderBy: { title: 'asc' },
          select: { id: true, slug: true, title: true, summary: true, translations: true },
        }),
        tx.evidenceReference.findMany({
          where: { ingredientId: { in: ingredientIds } },
          select: {
            ingredientId: true,
            title: true,
            source: true,
            url: true,
            summary: true,
            verifiedAt: true,
          },
        }),
        tx.productIngredient.findMany({
          where: { ingredientId: { in: ingredientIds } },
          select: { ingredientId: true, productId: true },
        }),
        // Products that hang off a TOPIC directly (docs/74 §6). A water filter
        // contains no ingredient, so without this it belongs to a goal that can
        // never reach it.
        tx.productTopic.findMany({
          where: { topicId: { in: topicIds } },
          select: { topicId: true, productId: true },
        }),
      ]);

      const products = await tx.product.findMany({
        where: {
          id: {
            in: [
              ...new Set([
                ...productLinks.map((p) => p.productId),
                ...topicProductLinks.map((p) => p.productId),
              ]),
            ],
          },
          status: 'active',
        },
        // brand-neutral ordering: by name only, never by brand
        orderBy: { name: 'asc' },
        select: {
          id: true,
          code: true,
          name: true,
          description: true,
          sourceUrl: true,
          lastVerifiedAt: true,
          safetyNotes: true,
          brand: { select: { id: true, code: true, name: true } },
          /**
           * The FIRST picture only (docs/74 §7). A card shows one thumbnail; a
           * gallery is a product page this platform does not have, and sending
           * twelve URLs per product to draw one of them is bytes nobody reads.
           */
          images: {
            orderBy: { position: 'asc' as const },
            take: 1,
            select: { id: true, url: true, alt: true, storedPath: true },
          },
        },
      });
      const productsByIngredient = new Map<string, string[]>();
      for (const link of productLinks) {
        const list = productsByIngredient.get(link.ingredientId) ?? [];
        list.push(link.productId);
        productsByIngredient.set(link.ingredientId, list);
      }
      // Same shape as `productsByIngredient`, so the UI keeps the journey
      // visible whichever way a product was reached.
      const productsByTopic = new Map<string, string[]>();
      for (const link of topicProductLinks) {
        const list = productsByTopic.get(link.topicId) ?? [];
        list.push(link.productId);
        productsByTopic.set(link.topicId, list);
      }
      const evidenceByIngredient = new Map<string, typeof evidence>();
      for (const e of evidence) {
        const list = evidenceByIngredient.get(e.ingredientId) ?? [];
        list.push(e);
        evidenceByIngredient.set(e.ingredientId, list);
      }

      return {
        goal: {
          id: goal.id,
          code: goal.code,
          ...localized(goal, locale, { name: goal.name, description: goal.description }),
        },
        topics: topics.map((t) => ({
          id: t.id,
          code: t.code,
          ...localized(t, locale, { name: t.name, summary: t.summary }),
          /** Products this topic reaches WITHOUT an ingredient (docs/74 §6). */
          productIds: productsByTopic.get(t.id) ?? [],
        })),
        articles: articles.map((a) => ({
          id: a.id,
          slug: a.slug,
          ...localized(a, locale, { title: a.title, summary: a.summary }),
        })),
        ingredients: ingredients.map((i) => ({
          id: i.id,
          code: i.code,
          ...localized(i, locale, {
            name: i.name,
            summary: i.summary,
            safetyNotes: i.safetyNotes,
          }),
          evidence: evidenceByIngredient.get(i.id) ?? [],
          productIds: productsByIngredient.get(i.id) ?? [],
        })),
        products,
        safetyNotice:
          'General wellness information only. This is not medical advice, diagnosis, or treatment. Speak with a qualified healthcare professional about your situation.',
      };
    });
  }

  async article(slug: string, locale: string) {
    return this.db.tx(async (tx) => {
      // 404, not 403, for an article outside the caller's teams: a 403 confirms
      // it exists, and "there is a document here you may not see" is itself
      // information about another team (docs/37 §4).
      const scope = await this.articleScope(tx);
      const article = await tx.article.findFirst({
        where: { slug, status: 'published', AND: [scope] },
        select: {
          id: true,
          slug: true,
          title: true,
          summary: true,
          body: true,
          updatedAt: true,
          translations: true,
        },
      });
      if (!article) {
        throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Article not found' });
      }
      const [topicLinks, ingredientLinks] = await Promise.all([
        tx.articleTopic.findMany({
          where: { articleId: article.id },
          select: { topicId: true },
        }),
        tx.articleIngredient.findMany({
          where: { articleId: article.id },
          select: { ingredientId: true },
        }),
      ]);
      const [topics, ingredients] = await Promise.all([
        tx.topic.findMany({
          where: { id: { in: topicLinks.map((t) => t.topicId) } },
          select: { id: true, code: true, name: true, translations: true },
        }),
        tx.ingredient.findMany({
          where: { id: { in: ingredientLinks.map((i) => i.ingredientId) } },
          select: { id: true, code: true, name: true, summary: true, translations: true },
        }),
      ]);
      return {
        id: article.id,
        slug: article.slug,
        updatedAt: article.updatedAt,
        ...localized(article, locale, {
          title: article.title,
          summary: article.summary,
          body: article.body,
        }),
        topics: topics.map((t) => ({
          id: t.id,
          code: t.code,
          ...localized(t, locale, { name: t.name }),
        })),
        ingredients: ingredients.map((i) => ({
          id: i.id,
          code: i.code,
          ...localized(i, locale, { name: i.name, summary: i.summary }),
        })),
      };
    });
  }

  async ingredient(code: string, locale: string) {
    return this.db.tx(async (tx) => {
      const ingredient = await tx.ingredient.findFirst({
        where: { code },
        select: {
          id: true,
          code: true,
          name: true,
          summary: true,
          safetyNotes: true,
          translations: true,
        },
      });
      if (!ingredient) {
        throw new NotFoundException({
          code: ERROR_CODES.NOT_FOUND,
          message: 'Ingredient not found',
        });
      }
      const [evidence, links] = await Promise.all([
        tx.evidenceReference.findMany({
          where: { ingredientId: ingredient.id },
          select: { title: true, source: true, url: true, summary: true, verifiedAt: true },
        }),
        tx.productIngredient.findMany({
          where: { ingredientId: ingredient.id },
          select: { productId: true },
        }),
      ]);
      const products = await tx.product.findMany({
        where: { id: { in: links.map((l) => l.productId) }, status: 'active' },
        orderBy: { name: 'asc' },
        select: {
          id: true,
          code: true,
          name: true,
          sourceUrl: true,
          lastVerifiedAt: true,
          safetyNotes: true,
          brand: { select: { code: true, name: true } },
          /**
           * The FIRST picture only (docs/74 §7). A card shows one thumbnail; a
           * gallery is a product page this platform does not have, and sending
           * twelve URLs per product to draw one of them is bytes nobody reads.
           */
          images: {
            orderBy: { position: 'asc' as const },
            take: 1,
            select: { id: true, url: true, alt: true, storedPath: true },
          },
        },
      });
      return {
        id: ingredient.id,
        code: ingredient.code,
        ...localized(ingredient, locale, {
          name: ingredient.name,
          summary: ingredient.summary,
          safetyNotes: ingredient.safetyNotes,
        }),
        evidence,
        products,
      };
    });
  }

  /**
   * Search ranked knowledge-first (spec §33): goals, topics, articles and
   * ingredients are returned above products, and products carry the ingredient
   * that led to them so the UI can keep the journey visible.
   */
  async search(query: string, locale = 'en') {
    const q = query.trim();
    if (q.length < 2) return { query: q, knowledge: [], products: [] };

    // Members (and the assistant) ask in sentences — "how can I sleep better?"
    // — so match on meaningful terms rather than the phrase as a whole.
    const terms = tokenize(q);
    // One searchable column per row holds every language's text, so a Thai
    // question matches Thai content without guessing the query's language.
    const anyTerm = () => ({
      OR: terms.map((term) => ({ searchText: { contains: term, mode: 'insensitive' as const } })),
    });

    return this.db.tx(async (tx) => {
      const [goals, topics, articles, ingredients] = await Promise.all([
        tx.healthGoal.findMany({
          where: anyTerm(),
          take: 10,
          select: { id: true, code: true, name: true, description: true, translations: true },
        }),
        tx.topic.findMany({
          where: anyTerm(),
          take: 10,
          select: { id: true, code: true, name: true, summary: true, translations: true },
        }),
        // The team scope is part of the QUERY, not a filter applied to results
        // (docs/37 §3): an article this member may not read is never loaded,
        // so it can never be ranked, summarised or cited.
        this.articleScope(tx).then((scope) =>
          tx.article.findMany({
            where: { status: 'published', AND: [scope], ...anyTerm() },
            take: 10,
            select: { id: true, slug: true, title: true, summary: true, translations: true },
          }),
        ),
        tx.ingredient.findMany({
          where: anyTerm(),
          take: 10,
          select: { id: true, code: true, name: true, summary: true, translations: true },
        }),
      ]);

      const unranked = [
        ...goals.map((g) => {
          const l = localized(g, locale, { name: g.name, description: g.description });
          return {
            kind: 'health_goal' as const,
            id: g.id,
            code: g.code,
            title: l.name!,
            summary: l.description,
          };
        }),
        ...topics.map((t) => {
          const l = localized(t, locale, { name: t.name, summary: t.summary });
          return {
            kind: 'topic' as const,
            id: t.id,
            code: t.code,
            title: l.name!,
            summary: l.summary,
          };
        }),
        ...articles.map((a) => {
          const l = localized(a, locale, { title: a.title, summary: a.summary });
          return {
            kind: 'article' as const,
            id: a.id,
            code: a.slug,
            title: l.title!,
            summary: l.summary,
          };
        }),
        ...ingredients.map((i) => {
          const l = localized(i, locale, { name: i.name, summary: i.summary });
          return {
            kind: 'ingredient' as const,
            id: i.id,
            code: i.code,
            title: l.name!,
            summary: l.summary,
          };
        }),
      ];

      // most terms matched first; ties keep the goal → topic → article →
      // ingredient order, which is the journey order the spec asks for
      const knowledge = unranked
        .map((item) => ({ item, score: scoreTerms(terms, `${item.title} ${item.summary ?? ''}`) }))
        .sort((a, b) => b.score - a.score)
        .map((r) => r.item);

      // products come last and only through their ingredients
      const ingredientIds = ingredients.map((i) => i.id);
      const links = ingredientIds.length
        ? await tx.productIngredient.findMany({
            where: { ingredientId: { in: ingredientIds } },
            select: { productId: true, ingredientId: true },
          })
        : [];
      const directMatches = await tx.product.findMany({
        where: { status: 'active', ...anyTerm() },
        take: 10,
        select: { id: true },
      });
      const productIds = [
        ...new Set([...links.map((l) => l.productId), ...directMatches.map((p) => p.id)]),
      ];
      const products = productIds.length
        ? await tx.product.findMany({
            where: { id: { in: productIds }, status: 'active' },
            orderBy: { name: 'asc' }, // brand-neutral
            select: {
              id: true,
              code: true,
              name: true,
              description: true,
              sourceUrl: true,
              brand: { select: { code: true, name: true } },
              /**
               * The FIRST picture only (docs/74 §7). A card shows one thumbnail; a
               * gallery is a product page this platform does not have, and sending
               * twelve URLs per product to draw one of them is bytes nobody reads.
               */
              images: {
                orderBy: { position: 'asc' as const },
                take: 1,
                select: { id: true, url: true, alt: true, storedPath: true },
              },
            },
          })
        : [];

      return { query: q, knowledge, products };
    });
  }

  /* ── publishing team knowledge (docs/37 §5) ─────────────────────────────── */

  /**
   * The teams this caller may PUBLISH to — leadership, resolved by the same
   * service every other team-scoped write uses. There is deliberately no second
   * answer to "which teams may this person act on" living in this module.
   */
  private async writableTeamIds(tx: Tx): Promise<AccessibleTeams> {
    return this.teamScope.accessibleTeamIds(
      tx,
      {
        memberId: this.cls.get<string | undefined>(CLS_MEMBER_ID) ?? null,
        platformBypass: PLATFORM_BYPASS.has(
          this.cls.get<string | undefined>(CLS_PLATFORM_ROLE) ?? '',
        ),
      },
      PERMISSIONS.KNOWLEDGE_TEAM_MANAGE,
    );
  }

  private async assertMayPublish(tx: Tx, teamId: string): Promise<void> {
    const allowed = await this.writableTeamIds(tx);
    if (allowed === 'ALL' || allowed.has(teamId)) return;
    // Refused with the reason, rather than silently writing it somewhere the
    // caller can see — a write that lands in the wrong scope is worse than one
    // that fails loudly.
    throw new ForbiddenException({
      code: ERROR_CODES.FORBIDDEN,
      message: 'You can publish knowledge only to teams you lead',
    });
  }

  async createTeamArticle(input: {
    teamId: string;
    slug: string;
    title: string;
    body: string;
    summary?: string | null;
  }) {
    return this.db.tx(async (tx) => {
      await this.assertMayPublish(tx, input.teamId);
      const team = await tx.team.findFirst({ where: { id: input.teamId }, select: { id: true } });
      if (!team) {
        throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Team not found' });
      }
      const existing = await tx.article.findFirst({
        where: { slug: input.slug },
        select: { id: true },
      });
      if (existing) {
        throw new ConflictException({
          code: ERROR_CODES.CONFLICT,
          message: 'An article with that slug already exists',
        });
      }
      // `Article.tenant_id` is nullable — a null means PLATFORM knowledge — so
      // the tenant extension does not stamp it the way it stamps a tenant-owned
      // model. Team knowledge must carry it explicitly, and the database's
      // `article_team_requires_tenant` check refuses the row if this is ever
      // forgotten again.
      const tenantId = this.cls.get<string | undefined>(CLS_TENANT_ID);
      if (!tenantId) {
        throw new ForbiddenException({
          code: ERROR_CODES.FORBIDDEN,
          message: 'Team knowledge belongs to a tenant, and this request resolved to none',
        });
      }
      const created = await tx.article.create({
        data: {
          tenantId,
          teamId: input.teamId,
          slug: input.slug,
          title: input.title,
          body: input.body,
          summary: input.summary ?? null,
          status: 'published',
          // The same column the term search reads, built the same way it is for
          // every other article — team knowledge is findable or it is filing.
          searchText: [input.title, input.summary ?? '', input.body].join(' ').toLowerCase(),
        },
        select: { id: true, slug: true, title: true, teamId: true, status: true },
      });
      // A team acts on the guidance published to it, and docs/37 §5 keeps an
      // unpublished article precisely so somebody can explain what it said.
      // Who published it belongs in the same story.
      await this.audit.record({
        action: 'knowledge.team_article.publish',
        entityType: 'article',
        entityId: created.id,
        after: { slug: created.slug, teamId: created.teamId },
      });
      return created;
    });
  }

  async updateTeamArticle(
    id: string,
    input: { title?: string; body?: string; summary?: string | null; status?: string },
  ) {
    return this.db.tx(async (tx) => {
      const article = await tx.article.findFirst({
        where: { id },
        select: { id: true, teamId: true, title: true, body: true, summary: true },
      });
      if (!article?.teamId) {
        throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Article not found' });
      }
      await this.assertMayPublish(tx, article.teamId);
      const title = input.title ?? article.title;
      const summary = input.summary === undefined ? article.summary : input.summary;
      const bodyText = input.body ?? article.body;
      const updated = await tx.article.update({
        where: { id },
        data: {
          title,
          summary,
          body: bodyText,
          ...(input.status ? { status: input.status } : {}),
          searchText: [title, summary ?? '', bodyText].join(' ').toLowerCase(),
        },
        select: { id: true, slug: true, title: true, teamId: true, status: true },
      });
      await this.audit.record({
        action: 'knowledge.team_article.update',
        entityType: 'article',
        entityId: updated.id,
        before: { title: article.title },
        after: { title: updated.title, status: updated.status },
      });
      return updated;
    });
  }

  /** What this leader has published, across the teams they lead. */
  async listTeamArticles() {
    return this.db.tx(async (tx) => {
      const allowed = await this.writableTeamIds(tx);
      if (allowed !== 'ALL' && allowed.size === 0) return { articles: [] };
      const articles = await tx.article.findMany({
        where: {
          teamId: allowed === 'ALL' ? { not: null } : { in: [...allowed] },
        },
        orderBy: { updatedAt: 'desc' },
        take: 100,
        select: {
          id: true,
          slug: true,
          title: true,
          summary: true,
          teamId: true,
          status: true,
          updatedAt: true,
        },
      });
      return { articles };
    });
  }
}

/** Words that carry no retrieval signal in a question. */
const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'you',
  'your',
  'are',
  'was',
  'can',
  'could',
  'how',
  'what',
  'why',
  'when',
  'who',
  'which',
  'have',
  'has',
  'from',
  'about',
  'into',
  'more',
  'most',
  'some',
  'any',
  'get',
  'got',
  'make',
  'made',
  'does',
  'did',
  'not',
  'but',
  'all',
  'out',
  'use',
  'using',
  'help',
  'helps',
  'better',
  'best',
  'good',
  'way',
  'ways',
  'tip',
  'tips',
  'should',
  'would',
  'will',
  'need',
  'want',
  'my',
  'me',
  'i',
  'a',
  'an',
  'of',
  'to',
  'in',
  'on',
  'is',
  'it',
  'do',
]);

/** Scripts written without spaces between words (Thai, CJK). */
const UNSPACED_SCRIPT = /[\u0E00-\u0E7F\u4E00-\u9FFF]/;
const NGRAM = 4;

/**
 * Splits a question into retrieval terms.
 *
 * Latin text splits on spaces, minus stop words. Thai and CJK put no spaces
 * between words, so a whole sentence would arrive as one token that matches
 * nothing; those runs are additionally cut into overlapping n-grams, which is
 * enough for substring retrieval without shipping a dictionary segmenter.
 */
export function tokenize(query: string): string[] {
  const raw = query
    .toLowerCase()
    // \p{M} matters: Thai vowels and tone marks are combining marks, and
    // splitting on them would slice words like การนอนหลับ mid-syllable.
    .split(/[^\p{L}\p{M}\p{N}-]+/u)
    .map((t) => t.trim())
    .filter(Boolean);

  const terms: string[] = [];
  for (const token of raw) {
    if (UNSPACED_SCRIPT.test(token)) {
      terms.push(token); // the full run still matches an exact phrase
      for (let i = 0; i + NGRAM <= token.length; i += 2) {
        terms.push(token.slice(i, i + NGRAM));
      }
    } else if (token.length >= 3 && !STOP_WORDS.has(token)) {
      terms.push(token);
    }
  }

  const unique = [...new Set(terms)];
  // fall back to the raw query when the question was only stop words
  return unique.length ? unique.slice(0, 16) : [query.trim().toLowerCase()];
}

/** How many distinct terms appear in the text — the ranking signal. */
function scoreTerms(terms: string[], text: string): number {
  const haystack = text.toLowerCase();
  return terms.reduce((n, term) => (haystack.includes(term) ? n + 1 : n), 0);
}
