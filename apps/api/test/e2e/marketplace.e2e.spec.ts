/**
 * The multi-brand marketplace (Sprint 25, docs/44).
 *
 * Spec §77 lists it as a Phase 4 surface; §31 and §33 set the rule that decides
 * whether it is a marketplace or a shop window: **brand neutrality**. So the
 * assertions that matter are not "the page loads" — they are that brand cannot
 * influence what a member sees first, and that no route reaches across tenants.
 *
 * A marketplace is exactly where a brand-neutral platform quietly stops being
 * one, and it happens through a field nobody argued about. These tests are the
 * argument.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import * as argon2 from 'argon2';
import {
  createOwnerClient,
  ensureAppRole,
  seedGlobalKnowledge,
  withTenant,
  type PrismaClient,
} from '@aviora/db';
import { ENTITLEMENTS, PERMISSIONS } from '@aviora/shared';
import { createApp } from '../../src/app.factory';

const RUN = `m${Date.now().toString(36)}`;
const PLATFORM_EMAIL = `e2e-mk-platform-${RUN}@test.local`;
const PW = 'e2e-password-123456';

let app: INestApplication;
let base: string;
let owner: PrismaClient;
/** `shop` has the marketplace entitlement; `plain` deliberately does not. */
let shop: string;
let plain: string;
let shopAdmin: string;
let shopMember: string;
let plainMember: string;
let productIds: string[] = [];

async function api(
  path: string,
  init: RequestInit & { token?: string; tenant?: string } = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...(init.tenant ? { 'x-tenant-id': init.tenant } : {}),
    },
  });
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

beforeAll(async () => {
  process.env.AVIORA_SCHEDULER_DISABLED = 'true';
  process.env.AVIORA_OUTBOX_DISABLED = 'true';
  process.env.AVIORA_PII_ENCRYPTION_KEY ??= Buffer.alloc(32, 19).toString('base64');

  owner = createOwnerClient();
  await ensureAppRole(owner);
  for (const key of Object.values(PERMISSIONS)) {
    await owner.permission.upsert({ where: { key }, create: { key }, update: {} });
  }
  for (const key of Object.values(ENTITLEMENTS)) {
    await owner.entitlement.upsert({ where: { key }, create: { key }, update: {} });
  }
  // Two brands, so neutrality is provable rather than asserted about one.
  await seedGlobalKnowledge(owner);
  const products = await owner.product.findMany({
    where: { tenantId: null },
    select: { id: true, brandId: true },
    take: 4,
  });
  productIds = products.map((p) => p.id);
  expect(
    new Set(products.map((p) => p.brandId)).size,
    'the knowledge seed no longer has two brands, so nothing here can prove neutrality',
  ).toBeGreaterThanOrEqual(2);

  await owner.user.upsert({
    where: { email: PLATFORM_EMAIL },
    create: {
      email: PLATFORM_EMAIL,
      passwordHash: await argon2.hash(PW, { type: argon2.argon2id }),
      displayName: 'E2E Marketplace Platform',
      platformRole: 'PLATFORM_OWNER',
    },
    update: {},
  });

  app = await createApp({ logger: false });
  await app.listen(0);
  base = (await app.getUrl()).replace('[::1]', '127.0.0.1');

  const platform = await login(PLATFORM_EMAIL);
  const mkTenant = async (suffix: string, name: string): Promise<string> => {
    const res = await api('/api/v1/platform/tenants', {
      method: 'POST',
      token: platform,
      body: JSON.stringify({
        code: `e2e_mk_${suffix}_${RUN}`,
        name,
        slug: `e2e-mk-${suffix}-${RUN}`,
        adminEmail: `mk-${suffix}-admin-${RUN}@test.local`,
        adminDisplayName: 'Admin',
        adminPassword: PW,
      }),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.tenant.id;
  };
  shop = await mkTenant('shop', 'Shop Co');
  plain = await mkTenant('plain', 'Plain Co');
  shopAdmin = await login(`mk-shop-admin-${RUN}@test.local`);
  const plainAdmin = await login(`mk-plain-admin-${RUN}@test.local`);

  const mkPlan = async (token: string, tenant: string, keys: string[]): Promise<string> => {
    const res = await api('/api/v1/membership-plans', {
      method: 'POST',
      token,
      tenant,
      body: JSON.stringify({ code: 'std', name: 'Standard', entitlementKeys: keys }),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.plan.id;
  };
  const shopPlan = await mkPlan(shopAdmin, shop, [ENTITLEMENTS.COMMERCE, ENTITLEMENTS.MARKETPLACE]);
  // Commerce, but NO marketplace: the tenant still sells, and the browse
  // surface is what the entitlement gates (docs/44 §3).
  const plainPlan = await mkPlan(plainAdmin, plain, [ENTITLEMENTS.COMMERCE]);

  const addMember = async (
    adminToken: string,
    tenant: string,
    planId: string,
    email: string,
  ): Promise<void> => {
    const inv = await api('/api/v1/invitations', {
      method: 'POST',
      token: adminToken,
      tenant,
      body: JSON.stringify({ email, planId }),
    });
    expect(inv.status).toBe(201);
    const evt = await owner.domainEvent.findFirst({
      where: { eventName: 'MemberInvited', tenantId: tenant, aggregateId: inv.body.invitation.id },
    });
    const accepted = await api(
      `/api/v1/invitations/${(evt!.payload as { token: string }).token}/accept`,
      { method: 'POST', body: JSON.stringify({ displayName: 'Shopper', password: PW }) },
    );
    expect(accepted.status).toBe(201);
  };
  await addMember(shopAdmin, shop, shopPlan, `mk-shopper-${RUN}@test.local`);
  await addMember(plainAdmin, plain, plainPlan, `mk-plainer-${RUN}@test.local`);
  shopMember = await login(`mk-shopper-${RUN}@test.local`);
  plainMember = await login(`mk-plainer-${RUN}@test.local`);

  // Offerings across BOTH brands, named so that alphabetical order and brand
  // order disagree — otherwise "sorted by name" and "sorted by brand" would be
  // indistinguishable and the neutrality test would prove nothing.
  const offerings = [
    { code: `mk-a-${RUN}`, name: 'Alpha pack', product: 1 },
    { code: `mk-b-${RUN}`, name: 'Beta pack', product: 0 },
    { code: `mk-c-${RUN}`, name: 'Gamma pack', product: 1 },
    { code: `mk-d-${RUN}`, name: 'Delta pack', product: 0 },
  ];
  for (const o of offerings) {
    const res = await api('/api/v1/offerings', {
      method: 'POST',
      token: shopAdmin,
      tenant: shop,
      body: JSON.stringify({
        code: o.code,
        name: o.name,
        productId: productIds[o.product],
        kind: 'one_time',
        priceMinor: 50_000,
      }),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  }
  // One offering with no product at all: it has no brand, and must appear
  // rather than vanish because it could not be grouped.
  const standalone = await api('/api/v1/offerings', {
    method: 'POST',
    token: shopAdmin,
    tenant: shop,
    body: JSON.stringify({
      code: `mk-solo-${RUN}`,
      name: 'Coaching hour',
      kind: 'one_time',
      priceMinor: 90_000,
    }),
  });
  expect(standalone.status, JSON.stringify(standalone.body)).toBe(201);
}, 240_000);

afterAll(async () => {
  await app?.close();
  await owner?.$disconnect();
});

/* ── 1. brand neutrality ──────────────────────────────────────────────────── */

describe('Brand is a facet, never a ranking signal (spec §31, docs/44 §2)', () => {
  it('orders by the offering’s own attributes, with brands interleaved', async () => {
    const res = await api('/api/v1/marketplace', { token: shopMember, tenant: shop });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const names = res.body.offerings.map((o: { name: string }) => o.name);
    expect(names, 'the marketplace is not sorted by name').toEqual([...names].sort());

    // The real check: brands must not be clustered. If ordering considered
    // brand at all, every offering of one brand would appear before the other.
    const brands = res.body.offerings
      .map((o: any) => o.brand?.id ?? null)
      .filter((b: string | null) => b !== null);
    const distinct = new Set(brands);
    expect(distinct.size, 'the fixture no longer spans two brands').toBeGreaterThanOrEqual(2);
    const clustered = brands.every(
      (b: string, i: number) => i === 0 || b === brands[i - 1] || !brands.slice(0, i).includes(b),
    );
    expect(
      clustered,
      `brands came back grouped (${brands.join(', ')}). Sorted by name, this ` +
        `fixture interleaves them — grouping means something other than the ` +
        `offering's own attributes reached the comparison.`,
    ).toBe(false);
  });

  it('says out loud that ordering ignores brand', async () => {
    const res = await api('/api/v1/marketplace', { token: shopMember, tenant: shop });
    expect(res.body.sort).toBe('name');
    expect(res.body.note).toMatch(/never considers brand/i);
  });

  it('counts brands alphabetically, not by popularity', async () => {
    const res = await api('/api/v1/marketplace/brands', { token: shopMember, tenant: shop });
    expect(res.status).toBe(200);
    const names = res.body.brands.map((b: { name: string }) => b.name);
    expect(
      names,
      'facets ordered by count are brands ordered by prominence — the same rule ' +
        'broken in a smaller place',
    ).toEqual([...names].sort());
    expect(res.body.brands.every((b: { count: number }) => b.count > 0)).toBe(true);
  });

  it('shows an offering that has no brand rather than dropping it', async () => {
    const res = await api('/api/v1/marketplace', { token: shopMember, tenant: shop });
    const solo = res.body.offerings.find((o: { name: string }) => o.name === 'Coaching hour');
    expect(solo, 'an offering with no product vanished from the marketplace').toBeTruthy();
    expect(solo.brand).toBeNull();
    const unbranded = res.body.brands.find((b: { id: string | null }) => b.id === null);
    expect(unbranded?.count, 'the unbranded facet did not count it').toBeGreaterThan(0);
  });
});

/* ── 2. filtering ─────────────────────────────────────────────────────────── */

describe('Filtering is deliberate, and the response says what it did', () => {
  it('filters to one brand and reports the filter back', async () => {
    const facets = await api('/api/v1/marketplace/brands', { token: shopMember, tenant: shop });
    const brand = facets.body.brands.find((b: { id: string | null }) => b.id !== null);

    const res = await api(`/api/v1/marketplace?brand=${brand.id}`, {
      token: shopMember,
      tenant: shop,
    });
    expect(res.status).toBe(200);
    expect(res.body.offerings.length).toBe(brand.count);
    for (const o of res.body.offerings) expect(o.brand.id).toBe(brand.id);
    expect(res.body.appliedFilters.brandId).toBe(brand.id);
  });

  it('searches names and descriptions', async () => {
    const res = await api('/api/v1/marketplace?q=coaching', { token: shopMember, tenant: shop });
    expect(res.body.offerings.map((o: { name: string }) => o.name)).toEqual(['Coaching hour']);
    expect(res.body.appliedFilters.q).toBe('coaching');
  });
});

/* ── 3. the entitlement gates browsing, not selling ───────────────────────── */

describe('A tenant without the entitlement still sells (docs/44 §3)', () => {
  it('refuses the marketplace to a member whose plan lacks it', async () => {
    const res = await api('/api/v1/marketplace', { token: plainMember, tenant: plain });
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toMatch(/entitlement/i);
  });

  it('but leaves that tenant’s catalogue working', async () => {
    const res = await api('/api/v1/offerings', { token: plainMember, tenant: plain });
    expect(
      res.status,
      'gating the marketplace broke the catalogue — the mistake docs/24 §2 ' +
        'already had to undo once',
    ).toBe(200);
  });
});

/* ── 4. no cross-tenant storefront ────────────────────────────────────────── */

describe('The marketplace does not reach across tenants (docs/44 §1)', () => {
  it('shows a tenant only its own offerings', async () => {
    // Give the plain tenant an offering of its own, then prove the shop's
    // marketplace has never heard of it.
    const plainAdmin = await login(`mk-plain-admin-${RUN}@test.local`);
    const created = await api('/api/v1/offerings', {
      method: 'POST',
      token: plainAdmin,
      tenant: plain,
      body: JSON.stringify({
        code: `mk-other-${RUN}`,
        name: 'Neighbour special',
        kind: 'one_time',
        priceMinor: 1_000,
      }),
    });
    expect(created.status).toBe(201);

    const res = await api('/api/v1/marketplace', { token: shopMember, tenant: shop });
    const names = res.body.offerings.map((o: { name: string }) => o.name);
    expect(
      names,
      'one tenant’s marketplace listed another tenant’s offering — a cross-tenant ' +
        'storefront is refused precisely because it would undo the one guarantee ' +
        'this platform makes',
    ).not.toContain('Neighbour special');

    // and the count agrees with what the tenant actually owns
    const mine = await withTenant(owner, shop, (tx) =>
      tx.offering.count({ where: { status: 'active' } }),
    );
    expect(res.body.offerings.length).toBe(mine);
  });
});
