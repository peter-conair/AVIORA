import { Injectable, NotFoundException } from '@nestjs/common';
import { ERROR_CODES } from '@aviora/shared';
import { TenantDb } from '../../common/db/tenant-db.service';

/**
 * Knowledge OS (spec §28–§33). Two rules shape everything here:
 *
 * 1. Product is never the beginning of the journey — a goal leads to topics,
 *    topics to articles and ingredients, and only then to products.
 * 2. Search ranks knowledge ABOVE products (§33), and products are returned
 *    brand-neutrally: ordering never considers the brand.
 */
@Injectable()
export class KnowledgeService {
  constructor(private readonly db: TenantDb) {}

  /** Global + this tenant's knowledge; RLS already limits it to those two. */
  healthGoals() {
    return this.db.tx((tx) =>
      tx.healthGoal.findMany({
        orderBy: [{ order: 'asc' }, { name: 'asc' }],
        select: { id: true, code: true, name: true, description: true, tenantId: true },
      }),
    );
  }

  /**
   * The §74 journey for one health goal:
   *   goal → topics → articles → ingredients → (evidence) → products
   */
  async journey(goalCode: string) {
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
        select: { id: true, code: true, name: true, summary: true },
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

      const [ingredients, articles, evidence, productLinks] = await Promise.all([
        tx.ingredient.findMany({
          where: { id: { in: ingredientIds } },
          orderBy: { name: 'asc' },
          select: { id: true, code: true, name: true, summary: true, safetyNotes: true },
        }),
        tx.article.findMany({
          where: { id: { in: articleIds }, status: 'published' },
          orderBy: { title: 'asc' },
          select: { id: true, slug: true, title: true, summary: true },
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
      ]);

      const products = await tx.product.findMany({
        where: { id: { in: [...new Set(productLinks.map((p) => p.productId))] }, status: 'active' },
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
        },
      });
      const productsByIngredient = new Map<string, string[]>();
      for (const link of productLinks) {
        const list = productsByIngredient.get(link.ingredientId) ?? [];
        list.push(link.productId);
        productsByIngredient.set(link.ingredientId, list);
      }
      const evidenceByIngredient = new Map<string, typeof evidence>();
      for (const e of evidence) {
        const list = evidenceByIngredient.get(e.ingredientId) ?? [];
        list.push(e);
        evidenceByIngredient.set(e.ingredientId, list);
      }

      return {
        goal: { id: goal.id, code: goal.code, name: goal.name, description: goal.description },
        topics,
        articles,
        ingredients: ingredients.map((i) => ({
          ...i,
          evidence: evidenceByIngredient.get(i.id) ?? [],
          productIds: productsByIngredient.get(i.id) ?? [],
        })),
        products,
        safetyNotice:
          'General wellness information only. This is not medical advice, diagnosis, or treatment. Speak with a qualified healthcare professional about your situation.',
      };
    });
  }

  async article(slug: string) {
    return this.db.tx(async (tx) => {
      const article = await tx.article.findFirst({
        where: { slug, status: 'published' },
        select: { id: true, slug: true, title: true, summary: true, body: true, updatedAt: true },
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
          select: { id: true, code: true, name: true },
        }),
        tx.ingredient.findMany({
          where: { id: { in: ingredientLinks.map((i) => i.ingredientId) } },
          select: { id: true, code: true, name: true, summary: true },
        }),
      ]);
      return { ...article, topics, ingredients };
    });
  }

  async ingredient(code: string) {
    return this.db.tx(async (tx) => {
      const ingredient = await tx.ingredient.findFirst({
        where: { code },
        select: { id: true, code: true, name: true, summary: true, safetyNotes: true },
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
        },
      });
      return { ...ingredient, evidence, products };
    });
  }

  /**
   * Search ranked knowledge-first (spec §33): goals, topics, articles and
   * ingredients are returned above products, and products carry the ingredient
   * that led to them so the UI can keep the journey visible.
   */
  async search(query: string) {
    const q = query.trim();
    if (q.length < 2) return { query: q, knowledge: [], products: [] };

    // Members (and the assistant) ask in sentences — "how can I sleep better?"
    // — so match on meaningful terms rather than the phrase as a whole.
    const terms = tokenize(q);
    const anyTerm = (fields: string[]) => ({
      OR: terms.flatMap((term) =>
        fields.map((field) => ({ [field]: { contains: term, mode: 'insensitive' as const } })),
      ),
    });

    return this.db.tx(async (tx) => {
      const [goals, topics, articles, ingredients] = await Promise.all([
        tx.healthGoal.findMany({
          where: anyTerm(['name', 'description']),
          take: 10,
          select: { id: true, code: true, name: true, description: true },
        }),
        tx.topic.findMany({
          where: anyTerm(['name', 'summary']),
          take: 10,
          select: { id: true, code: true, name: true, summary: true },
        }),
        tx.article.findMany({
          where: { status: 'published', ...anyTerm(['title', 'summary', 'body']) },
          take: 10,
          select: { id: true, slug: true, title: true, summary: true },
        }),
        tx.ingredient.findMany({
          where: anyTerm(['name', 'summary']),
          take: 10,
          select: { id: true, code: true, name: true, summary: true },
        }),
      ]);

      const unranked = [
        ...goals.map((g) => ({
          kind: 'health_goal' as const,
          id: g.id,
          code: g.code,
          title: g.name,
          summary: g.description,
        })),
        ...topics.map((t) => ({
          kind: 'topic' as const,
          id: t.id,
          code: t.code,
          title: t.name,
          summary: t.summary,
        })),
        ...articles.map((a) => ({
          kind: 'article' as const,
          id: a.id,
          code: a.slug,
          title: a.title,
          summary: a.summary,
        })),
        ...ingredients.map((i) => ({
          kind: 'ingredient' as const,
          id: i.id,
          code: i.code,
          title: i.name,
          summary: i.summary,
        })),
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
        where: { status: 'active', ...anyTerm(['name', 'description']) },
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
            },
          })
        : [];

      return { query: q, knowledge, products };
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

/**
 * Splits a question into retrieval terms. Latin words shorter than three
 * characters and stop words are dropped; Thai text has no spaces between words,
 * so any CJK/Thai run is kept whole and matched as a substring.
 */
export function tokenize(query: string): string[] {
  const terms = query
    .toLowerCase()
    // \p{M} matters: Thai vowels and tone marks are combining marks, and
    // splitting on them would slice words like การนอนหลับ mid-syllable.
    .split(/[^\p{L}\p{M}\p{N}-]+/u)
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t) => {
      if (/[฀-๿一-鿿]/.test(t)) return t.length >= 2; // Thai / CJK
      return t.length >= 3 && !STOP_WORDS.has(t);
    });
  const unique = [...new Set(terms)];
  // fall back to the raw query when the question was only stop words
  return unique.length ? unique.slice(0, 8) : [query.trim().toLowerCase()];
}

/** How many distinct terms appear in the text — the ranking signal. */
function scoreTerms(terms: string[], text: string): number {
  const haystack = text.toLowerCase();
  return terms.reduce((n, term) => (haystack.includes(term) ? n + 1 : n), 0);
}
