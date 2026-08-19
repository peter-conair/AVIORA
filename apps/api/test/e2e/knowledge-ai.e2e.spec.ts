/**
 * Vertical Slice 3 E2E (spec §74) + AI Lite (docs/12).
 *
 * Knowledge journey: Better Sleep → Sleep Hygiene → article → Magnesium →
 * products, proving product is never the entry point, search ranks knowledge
 * above products, and results stay brand-neutral (two brands, no favouritism).
 *
 * AI: retrieval happens over tenant-visible knowledge only, answers carry
 * citations and a health-safety reminder, the daily cap is enforced, and the
 * assistant is entitlement-gated.
 *
 * NOTE: stop any locally running API before this suite — the outbox relay is
 * cross-tenant and would drain the events these tests rely on.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import * as argon2 from 'argon2';
import { createOwnerClient, ensureAppRole, KNOWLEDGE_SEED, type PrismaClient } from '@aviora/db';
import { ENTITLEMENTS, PERMISSIONS } from '@aviora/shared';
import { createApp } from '../../src/app.factory';

const RUN = `k${Date.now().toString(36)}`;
const PLATFORM_EMAIL = `e2e-platform-${RUN}@test.local`;
const PW = 'e2e-password-123456';

let app: INestApplication;
let base: string;
let owner: PrismaClient;

let tenantId: string;
let otherTenantId: string;
let coachPlanId: string;
let basicPlanId: string;

async function api(
  path: string,
  init: RequestInit & { token?: string; tenant?: string } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
    ...(init.tenant ? { 'x-tenant-id': init.tenant } : {}),
  };
  const res = await fetch(`${base}${path}`, { ...init, headers });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function login(email: string): Promise<string> {
  const res = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PW }),
  });
  expect(res.status).toBe(200);
  const access = res.headers.getSetCookie().find((c) => c.startsWith('aviora_access='));
  return decodeURIComponent(access!.split(';')[0]!.split('=')[1]!);
}

async function addMember(
  adminToken: string,
  tenant: string,
  planId: string,
  email: string,
  name: string,
): Promise<string> {
  const inv = await api('/api/v1/invitations', {
    method: 'POST',
    token: adminToken,
    tenant,
    body: JSON.stringify({ email, planId }),
  });
  expect(inv.status).toBe(201);
  const evt = await owner.domainEvent.findFirst({
    where: { eventName: 'MemberInvited', aggregateId: inv.body.invitation.id },
  });
  const token = (evt!.payload as { token: string }).token;
  const acc = await api(`/api/v1/invitations/${token}/accept`, {
    method: 'POST',
    body: JSON.stringify({ displayName: name, password: PW }),
  });
  expect(acc.status).toBe(201);
  return acc.body.memberId;
}

/** Mirrors prisma/seed.ts seedKnowledge — global rows, idempotent by code. */
async function seedGlobalKnowledge() {
  const k = KNOWLEDGE_SEED;
  const goalId = new Map<string, string>();
  const topicId = new Map<string, string>();
  const ingredientId = new Map<string, string>();
  const brandId = new Map<string, string>();

  for (const g of k.healthGoals) {
    const found = await owner.healthGoal.findFirst({ where: { tenantId: null, code: g.code } });
    const row =
      found ??
      (await owner.healthGoal.create({
        data: { code: g.code, name: g.name, description: g.description, order: g.order },
      }));
    goalId.set(g.code, row.id);
  }
  for (const t of k.topics) {
    const found = await owner.topic.findFirst({ where: { tenantId: null, code: t.code } });
    const row =
      found ??
      (await owner.topic.create({ data: { code: t.code, name: t.name, summary: t.summary } }));
    topicId.set(t.code, row.id);
    for (const gc of t.goals) {
      const hg = goalId.get(gc)!;
      const link = await owner.healthGoalTopic.findFirst({
        where: { healthGoalId: hg, topicId: row.id },
      });
      if (!link)
        await owner.healthGoalTopic.create({ data: { healthGoalId: hg, topicId: row.id } });
    }
  }
  for (const i of k.ingredients) {
    const found = await owner.ingredient.findFirst({ where: { tenantId: null, code: i.code } });
    const row =
      found ??
      (await owner.ingredient.create({
        data: { code: i.code, name: i.name, summary: i.summary, safetyNotes: i.safetyNotes },
      }));
    ingredientId.set(i.code, row.id);
    for (const tc of i.topics) {
      const t = topicId.get(tc)!;
      const link = await owner.topicIngredient.findFirst({
        where: { topicId: t, ingredientId: row.id },
      });
      if (!link) await owner.topicIngredient.create({ data: { topicId: t, ingredientId: row.id } });
    }
  }
  for (const a of k.articles) {
    const found = await owner.article.findFirst({ where: { tenantId: null, slug: a.slug } });
    const row =
      found ??
      (await owner.article.create({
        data: { slug: a.slug, title: a.title, summary: a.summary, body: a.body },
      }));
    for (const tc of a.topics) {
      const t = topicId.get(tc)!;
      const link = await owner.articleTopic.findFirst({
        where: { articleId: row.id, topicId: t },
      });
      if (!link) await owner.articleTopic.create({ data: { articleId: row.id, topicId: t } });
    }
    for (const ic of a.ingredients) {
      const i = ingredientId.get(ic)!;
      const link = await owner.articleIngredient.findFirst({
        where: { articleId: row.id, ingredientId: i },
      });
      if (!link)
        await owner.articleIngredient.create({ data: { articleId: row.id, ingredientId: i } });
    }
  }
  for (const b of k.brands) {
    const found = await owner.brand.findFirst({ where: { tenantId: null, code: b.code } });
    const row = found ?? (await owner.brand.create({ data: { code: b.code, name: b.name } }));
    brandId.set(b.code, row.id);
  }
  for (const p of k.products) {
    const found = await owner.product.findFirst({ where: { tenantId: null, code: p.code } });
    const row =
      found ??
      (await owner.product.create({
        data: {
          brandId: brandId.get(p.brand)!,
          code: p.code,
          name: p.name,
          description: p.description,
          sourceUrl: p.sourceUrl,
          safetyNotes: p.safetyNotes,
          lastVerifiedAt: new Date(),
        },
      }));
    for (const ic of p.ingredients) {
      const i = ingredientId.get(ic)!;
      const link = await owner.productIngredient.findFirst({
        where: { productId: row.id, ingredientId: i },
      });
      if (!link)
        await owner.productIngredient.create({ data: { productId: row.id, ingredientId: i } });
    }
  }
}

beforeAll(async () => {
  process.env.AVIORA_OUTBOX_DISABLED = 'true';
  delete process.env.AVIORA_AI_ANTHROPIC_KEY; // exercise the local grounded provider
  owner = createOwnerClient();
  await ensureAppRole(owner);
  for (const key of Object.values(PERMISSIONS)) {
    await owner.permission.upsert({ where: { key }, create: { key }, update: {} });
  }
  for (const key of Object.values(ENTITLEMENTS)) {
    await owner.entitlement.upsert({ where: { key }, create: { key }, update: {} });
  }
  await seedGlobalKnowledge();
  await owner.user.upsert({
    where: { email: PLATFORM_EMAIL },
    create: {
      email: PLATFORM_EMAIL,
      passwordHash: await argon2.hash(PW, { type: argon2.argon2id }),
      displayName: 'E2E Platform Admin',
      platformRole: 'PLATFORM_OWNER',
    },
    update: {},
  });

  app = await createApp({ logger: false });
  await app.listen(0);
  base = (await app.getUrl()).replace('[::1]', '127.0.0.1');

  const platform = await login(PLATFORM_EMAIL);
  const mkTenant = async (suffix: string, adminEmail: string) => {
    const res = await api('/api/v1/platform/tenants', {
      method: 'POST',
      token: platform,
      body: JSON.stringify({
        code: `e2e_kn_${suffix}_${RUN}`,
        name: `Knowledge ${suffix}`,
        slug: `e2e-kn-${suffix}-${RUN}`,
        adminEmail,
        adminDisplayName: 'Admin',
        adminPassword: PW,
      }),
    });
    expect(res.status).toBe(201);
    return res.body.tenant.id as string;
  };
  tenantId = await mkTenant('a', `admin-a-${RUN}@test.local`);
  otherTenantId = await mkTenant('b', `admin-b-${RUN}@test.local`);

  const adminA = await login(`admin-a-${RUN}@test.local`);
  coachPlanId = (
    await api('/api/v1/membership-plans', {
      method: 'POST',
      token: adminA,
      tenant: tenantId,
      body: JSON.stringify({
        code: 'coach',
        name: 'Coach',
        entitlementKeys: [ENTITLEMENTS.AI_COACH],
      }),
    })
  ).body.plan.id;
  basicPlanId = (
    await api('/api/v1/membership-plans', {
      method: 'POST',
      token: adminA,
      tenant: tenantId,
      body: JSON.stringify({ code: 'basic', name: 'Basic', entitlementKeys: [] }),
    })
  ).body.plan.id;

  await addMember(adminA, tenantId, coachPlanId, `seeker-${RUN}@test.local`, 'Seeker');
  await addMember(adminA, tenantId, basicPlanId, `basic-${RUN}@test.local`, 'Basic Member');
}, 240_000);

afterAll(async () => {
  await app?.close();
  await owner?.$disconnect();
});

describe('Slice 3 — knowledge journey', () => {
  it('lists global health goals inside a tenant', async () => {
    const seeker = await login(`seeker-${RUN}@test.local`);
    const res = await api('/api/v1/knowledge/health-goals', { token: seeker, tenant: tenantId });
    expect(res.status).toBe(200);
    const codes = res.body.healthGoals.map((g: { code: string }) => g.code);
    expect(codes).toContain('better-sleep');
    // global rows are shared, not owned by the tenant
    expect(
      res.body.healthGoals.every((g: { tenantId: string | null }) => g.tenantId === null),
    ).toBe(true);
  });

  it('walks Better Sleep → topic → article → ingredient → products', async () => {
    const seeker = await login(`seeker-${RUN}@test.local`);
    const res = await api('/api/v1/knowledge/journey/better-sleep', {
      token: seeker,
      tenant: tenantId,
    });
    expect(res.status).toBe(200);
    expect(res.body.goal.name).toBe('Better Sleep');
    expect(res.body.topics.map((t: { code: string }) => t.code)).toContain('sleep-hygiene');
    expect(res.body.articles[0].slug).toBe('winding-down-an-evening-routine-that-works');

    const magnesium = res.body.ingredients.find((i: { code: string }) => i.code === 'magnesium');
    expect(magnesium).toBeTruthy();
    expect(magnesium.evidence.length).toBeGreaterThan(0);
    expect(magnesium.safetyNotes).toMatch(/healthcare professional/i);
    expect(magnesium.productIds.length).toBeGreaterThan(0);

    // products come last and every one is reachable only via an ingredient
    expect(res.body.products.length).toBeGreaterThan(0);
    expect(res.body.safetyNotice).toMatch(/not medical advice/i);
  });

  it('stays brand neutral: multiple brands, ordering independent of brand', async () => {
    const seeker = await login(`seeker-${RUN}@test.local`);
    const res = await api('/api/v1/knowledge/journey/better-sleep', {
      token: seeker,
      tenant: tenantId,
    });
    const brands = new Set(res.body.products.map((p: { brand: { code: string } }) => p.brand.code));
    expect(brands.size).toBeGreaterThanOrEqual(2); // a second brand needed no schema change
    const names = res.body.products.map((p: { name: string }) => p.name);
    expect(names).toEqual([...names].sort((a: string, b: string) => a.localeCompare(b)));
  });

  it('ranks knowledge above products in search (spec §33)', async () => {
    const seeker = await login(`seeker-${RUN}@test.local`);
    const res = await api('/api/v1/knowledge/search?q=magnesium', {
      token: seeker,
      tenant: tenantId,
    });
    expect(res.status).toBe(200);
    expect(res.body.knowledge.length).toBeGreaterThan(0);
    expect(res.body.knowledge[0].kind).not.toBe('product');
    expect(res.body.products.length).toBeGreaterThan(0);
    // the ingredient itself must appear in the knowledge half, not only as a product
    expect(res.body.knowledge.some((k: { kind: string }) => k.kind === 'ingredient')).toBe(true);
  });

  it('serves an article with its topics and ingredients', async () => {
    const seeker = await login(`seeker-${RUN}@test.local`);
    const res = await api('/api/v1/knowledge/articles/winding-down-an-evening-routine-that-works', {
      token: seeker,
      tenant: tenantId,
    });
    expect(res.status).toBe(200);
    expect(res.body.article.body).toMatch(/consistent wake time/i);
    expect(res.body.article.ingredients.map((i: { code: string }) => i.code)).toContain(
      'magnesium',
    );
  });

  it('tenant-private knowledge stays invisible to other tenants', async () => {
    // tenant A curates its own goal; tenant B must never see it
    await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      const existing = await tx.healthGoal.findFirst({
        where: { tenantId, code: `private-${RUN}` },
      });
      if (!existing) {
        await tx.healthGoal.create({
          data: { tenantId, code: `private-${RUN}`, name: 'Private Goal A', order: 99 },
        });
      }
    });

    const seeker = await login(`seeker-${RUN}@test.local`);
    const mine = await api('/api/v1/knowledge/health-goals', { token: seeker, tenant: tenantId });
    expect(mine.body.healthGoals.map((g: { code: string }) => g.code)).toContain(`private-${RUN}`);

    const adminB = await login(`admin-b-${RUN}@test.local`);
    const theirs = await api('/api/v1/knowledge/health-goals', {
      token: adminB,
      tenant: otherTenantId,
    });
    expect(theirs.body.healthGoals.map((g: { code: string }) => g.code)).not.toContain(
      `private-${RUN}`,
    );
    // ...but global knowledge is shared with them
    expect(theirs.body.healthGoals.map((g: { code: string }) => g.code)).toContain('better-sleep');
  });
});

describe('Slice 3 — AI assistant', () => {
  it('answers from retrieved knowledge with citations and a safety reminder', async () => {
    const seeker = await login(`seeker-${RUN}@test.local`);
    const res = await api('/api/v1/ai/ask', {
      method: 'POST',
      token: seeker,
      tenant: tenantId,
      body: JSON.stringify({ question: 'magnesium' }),
    });
    expect(res.status).toBe(201);
    expect(res.body.answer).toMatch(/magnesium/i);
    expect(res.body.answer).toMatch(/healthcare professional/i);
    expect(res.body.citations.length).toBeGreaterThan(0);
    expect(res.body.provider).toBe('grounded-local');
    expect(res.body.conversationId).toBeTruthy();
  });

  it('says so plainly when the knowledge base has nothing', async () => {
    const seeker = await login(`seeker-${RUN}@test.local`);
    const res = await api('/api/v1/ai/ask', {
      method: 'POST',
      token: seeker,
      tenant: tenantId,
      body: JSON.stringify({ question: 'quantum tunnelling schedules' }),
    });
    expect(res.status).toBe(201);
    expect(res.body.answer).toMatch(/could not find/i);
    expect(res.body.citations).toHaveLength(0);
  });

  it('keeps conversation history per member', async () => {
    const seeker = await login(`seeker-${RUN}@test.local`);
    const list = await api('/api/v1/ai/conversations', { token: seeker, tenant: tenantId });
    expect(list.body.conversations.length).toBeGreaterThanOrEqual(2);

    const detail = await api(`/api/v1/ai/conversations/${list.body.conversations[0].id}`, {
      token: seeker,
      tenant: tenantId,
    });
    expect(detail.status).toBe(200);
    expect(detail.body.conversation.messages).toHaveLength(2); // user + assistant
    expect(detail.body.conversation.messages[0].role).toBe('user');
  });

  it("another member cannot open someone else's conversation", async () => {
    const seeker = await login(`seeker-${RUN}@test.local`);
    const list = await api('/api/v1/ai/conversations', { token: seeker, tenant: tenantId });
    const id = list.body.conversations[0].id;

    const basic = await login(`basic-${RUN}@test.local`);
    const res = await api(`/api/v1/ai/conversations/${id}`, { token: basic, tenant: tenantId });
    expect(res.status).toBe(404);
  });

  it('is entitlement-gated: a plan without ai.coach cannot ask', async () => {
    const basic = await login(`basic-${RUN}@test.local`);
    const res = await api('/api/v1/ai/ask', {
      method: 'POST',
      token: basic,
      tenant: tenantId,
      body: JSON.stringify({ question: 'magnesium' }),
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ENTITLEMENT_REQUIRED');
  });

  it('enforces the tenant daily request cap and reports usage', async () => {
    const adminA = await login(`admin-a-${RUN}@test.local`);
    // tenant lowers its own cap to 2 requests/day
    await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      await tx.tenantSetting.upsert({
        where: { tenantId_key: { tenantId, key: 'ai.dailyRequestCap' } },
        create: { tenantId, key: 'ai.dailyRequestCap', value: 2 },
        update: { value: 2 },
      });
    });
    expect(adminA).toBeTruthy();

    const seeker = await login(`seeker-${RUN}@test.local`);
    const usage = await api('/api/v1/ai/usage', { token: seeker, tenant: tenantId });
    expect(usage.body.dailyRequestCap).toBe(2);
    expect(usage.body.requests).toBe(2); // the two asks above
    expect(usage.body.remaining).toBe(0);

    const blocked = await api('/api/v1/ai/ask', {
      method: 'POST',
      token: seeker,
      tenant: tenantId,
      body: JSON.stringify({ question: 'magnesium again' }),
    });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
  });
});
