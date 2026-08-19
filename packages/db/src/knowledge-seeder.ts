import type { PrismaClient } from '@prisma/client';
import { KNOWLEDGE_SEED } from './knowledge-seed';

/**
 * Global knowledge rows are keyed by code with tenant_id NULL. Prisma cannot
 * address a composite unique that contains NULL (SQL treats NULLs as distinct),
 * so global upserts go through an explicit find-then-write; the partial unique
 * index in the migration is what actually guarantees uniqueness.
 */
async function upsertGlobal<T extends { id: string }>(
  find: () => Promise<T | null>,
  create: () => Promise<T>,
  update: (id: string) => Promise<T>,
): Promise<T> {
  const existing = await find();
  return existing ? update(existing.id) : create();
}

/** Global knowledge (tenant_id NULL) — idempotent by code/slug. */

/**
 * Everything searchable about a row, in every language it has. Retrieval hits
 * this one column so a Thai question matches Thai content without needing a
 * per-locale index or a language guess at query time.
 */
function buildSearchText(base: Array<string | undefined>, translations?: object): string {
  const fromTranslations = translations
    ? Object.values(translations as Record<string, Record<string, string>>).flatMap((t) =>
        Object.values(t ?? {}),
      )
    : [];
  return [...base, ...fromTranslations].filter(Boolean).join(' \n ');
}

/**
 * Seeds the GLOBAL knowledge graph. Exported so the seed script and the tests
 * share one definition — a test-local copy drifted once already (missing
 * evidence rows passed locally and failed in CI).
 */
export async function seedGlobalKnowledge(
  prisma: PrismaClient,
): Promise<{ nodes: number; products: number }> {
  const k = KNOWLEDGE_SEED;
  const goalId = new Map<string, string>();
  const topicId = new Map<string, string>();
  const ingredientId = new Map<string, string>();
  const brandId = new Map<string, string>();
  let nodes = 0;

  for (const g of k.healthGoals) {
    const row = await upsertGlobal(
      () => prisma.healthGoal.findFirst({ where: { tenantId: null, code: g.code } }),
      () =>
        prisma.healthGoal.create({
          data: {
            code: g.code,
            name: g.name,
            description: g.description,
            order: g.order,
            translations: g.translations,
            searchText: buildSearchText([g.name, g.description], g.translations),
          },
        }),
      (id) =>
        prisma.healthGoal.update({
          where: { id },
          data: {
            name: g.name,
            description: g.description,
            order: g.order,
            translations: g.translations,
            searchText: buildSearchText([g.name, g.description], g.translations),
          },
        }),
    );
    goalId.set(g.code, row.id);
    nodes++;
  }
  for (const t of k.topics) {
    const row = await upsertGlobal(
      () => prisma.topic.findFirst({ where: { tenantId: null, code: t.code } }),
      () =>
        prisma.topic.create({
          data: {
            code: t.code,
            name: t.name,
            summary: t.summary,
            translations: t.translations,
            searchText: buildSearchText([t.name, t.summary], t.translations),
          },
        }),
      (id) =>
        prisma.topic.update({
          where: { id },
          data: {
            name: t.name,
            summary: t.summary,
            translations: t.translations,
            searchText: buildSearchText([t.name, t.summary], t.translations),
          },
        }),
    );
    topicId.set(t.code, row.id);
    nodes++;
    for (const gCode of t.goals) {
      const healthGoalId = goalId.get(gCode);
      if (!healthGoalId) continue;
      await prisma.healthGoalTopic.upsert({
        where: { healthGoalId_topicId: { healthGoalId, topicId: row.id } },
        create: { healthGoalId, topicId: row.id },
        update: {},
      });
    }
  }
  for (const i of k.ingredients) {
    const row = await upsertGlobal(
      () => prisma.ingredient.findFirst({ where: { tenantId: null, code: i.code } }),
      () =>
        prisma.ingredient.create({
          data: {
            code: i.code,
            name: i.name,
            summary: i.summary,
            safetyNotes: i.safetyNotes,
            translations: i.translations,
            searchText: buildSearchText([i.name, i.summary], i.translations),
          },
        }),
      (id) =>
        prisma.ingredient.update({
          where: { id },
          data: {
            name: i.name,
            summary: i.summary,
            safetyNotes: i.safetyNotes,
            translations: i.translations,
            searchText: buildSearchText([i.name, i.summary], i.translations),
          },
        }),
    );
    ingredientId.set(i.code, row.id);
    nodes++;
    for (const tCode of i.topics) {
      const tId = topicId.get(tCode);
      if (!tId) continue;
      await prisma.topicIngredient.upsert({
        where: { topicId_ingredientId: { topicId: tId, ingredientId: row.id } },
        create: { topicId: tId, ingredientId: row.id },
        update: {},
      });
    }
  }
  for (const a of k.articles) {
    const row = await upsertGlobal(
      () => prisma.article.findFirst({ where: { tenantId: null, slug: a.slug } }),
      () =>
        prisma.article.create({
          data: {
            slug: a.slug,
            title: a.title,
            summary: a.summary,
            body: a.body,
            translations: a.translations,
            searchText: buildSearchText([a.title, a.summary, a.body], a.translations),
          },
        }),
      (id) =>
        prisma.article.update({
          where: { id },
          data: {
            title: a.title,
            summary: a.summary,
            body: a.body,
            translations: a.translations,
            searchText: buildSearchText([a.title, a.summary, a.body], a.translations),
          },
        }),
    );
    nodes++;
    for (const tCode of a.topics) {
      const tId = topicId.get(tCode);
      if (!tId) continue;
      await prisma.articleTopic.upsert({
        where: { articleId_topicId: { articleId: row.id, topicId: tId } },
        create: { articleId: row.id, topicId: tId },
        update: {},
      });
    }
    for (const iCode of a.ingredients) {
      const iId = ingredientId.get(iCode);
      if (!iId) continue;
      await prisma.articleIngredient.upsert({
        where: { articleId_ingredientId: { articleId: row.id, ingredientId: iId } },
        create: { articleId: row.id, ingredientId: iId },
        update: {},
      });
    }
  }
  for (const e of k.evidence) {
    const iId = ingredientId.get(e.ingredient);
    if (!iId) continue;
    const existing = await prisma.evidenceReference.findFirst({
      where: { ingredientId: iId, title: e.title },
    });
    if (!existing) {
      await prisma.evidenceReference.create({
        data: {
          ingredientId: iId,
          title: e.title,
          source: e.source,
          url: e.url,
          summary: e.summary,
        },
      });
      nodes++;
    }
  }
  for (const b of k.brands) {
    const row = await upsertGlobal(
      () => prisma.brand.findFirst({ where: { tenantId: null, code: b.code } }),
      () => prisma.brand.create({ data: { code: b.code, name: b.name } }),
      (id) => prisma.brand.update({ where: { id }, data: { name: b.name } }),
    );
    brandId.set(b.code, row.id);
  }
  let products = 0;
  for (const p of k.products) {
    const bId = brandId.get(p.brand);
    if (!bId) continue;
    const row = await upsertGlobal(
      () => prisma.product.findFirst({ where: { tenantId: null, code: p.code } }),
      () =>
        prisma.product.create({
          data: {
            brandId: bId,
            code: p.code,
            name: p.name,
            description: p.description,
            sourceUrl: p.sourceUrl,
            safetyNotes: p.safetyNotes,
            lastVerifiedAt: new Date(),
            searchText: buildSearchText([p.name, p.description]),
          },
        }),
      (id) =>
        prisma.product.update({
          where: { id },
          data: {
            name: p.name,
            description: p.description,
            safetyNotes: p.safetyNotes,
            searchText: buildSearchText([p.name, p.description]),
          },
        }),
    );
    products++;
    for (const iCode of p.ingredients) {
      const iId = ingredientId.get(iCode);
      if (!iId) continue;
      await prisma.productIngredient.upsert({
        where: { productId_ingredientId: { productId: row.id, ingredientId: iId } },
        create: { productId: row.id, ingredientId: iId },
        update: {},
      });
    }
  }
  return { nodes, products };
}
