/**
 * Commerce OS and the Subscription engine (spec §39–§40, docs/24).
 *
 * "Commerce supports the journey." What that costs the platform in rigour is
 * this file. Three promises are pinned down here:
 *
 *   1. Money is an integer in minor units. Every assertion below is an integer;
 *      any test that needed a float would be testing the wrong thing.
 *   2. Membership pricing is DATA. Two plans with names that say nothing about
 *      price ("Aurora", "Zephyr") get one price below base and one above it, so
 *      no implementation can pass by reading a plan's name or its ordering.
 *   3. A renewal tick is safe to repeat. The same due date, ticked twice,
 *      produces exactly one order — that is the most important test in the file.
 *
 * NOTE: stop any locally running API — the outbox relay is cross-tenant.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import * as argon2 from 'argon2';
import { createOwnerClient, ensureAppRole, type PrismaClient } from '@aviora/db';
import { ENTITLEMENTS, PERMISSIONS } from '@aviora/shared';
import { createApp } from '../../src/app.factory';

const RUN = `c${Date.now().toString(36)}`;
const PLATFORM_EMAIL = `e2e-platform-${RUN}@test.local`;
const PW = 'e2e-password-123456';

let app: INestApplication;
let base: string;
let owner: PrismaClient;

/** Tenant A sells; tenant B exists only to prove it can see none of it. */
let tenantId: string;
let otherTenantId: string;

/**
 * Plan names carry no pricing meaning on purpose. Aurora pays BELOW the base
 * price, Zephyr pays ABOVE it, Marigold has no row at all and pays base.
 */
let auroraPlanId: string;
let zephyrPlanId: string;
let marigoldPlanId: string;

const offering: Record<'fieldNotes' | 'teaSampler' | 'retreatSeat' | 'monthlyBox', string> =
  {} as never;

let oneTimeOrderId: string;
let subscriptionId: string;

const DAY = 86_400_000;

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
  const accepted = await api(
    `/api/v1/invitations/${(evt!.payload as { token: string }).token}/accept`,
    { method: 'POST', body: JSON.stringify({ displayName: name, password: PW }) },
  );
  expect(accepted.status).toBe(201);
  return accepted.body.memberId;
}

/** Commerce tables FORCE row-level security, so even the owner sets the tenant. */
async function withTenant<T>(tenant: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
  return owner.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenant}, true)`;
    return fn(tx as unknown as PrismaClient);
  });
}

async function eventCount(eventName: string, aggregateId?: string): Promise<number> {
  return owner.domainEvent.count({
    where: { tenantId, eventName, ...(aggregateId ? { aggregateId } : {}) },
  });
}

/**
 * A membership on a commerce-enabled plan. The owner does NOT need one to run
 * the shop (administration is permission-scoped), but the suite gives them one
 * so the owner-side buying paths can be exercised too.
 */
async function giveMembership(tenant: string, memberId: string, planId: string): Promise<void> {
  await withTenant(tenant, async (tx) => {
    await tx.membership.create({
      data: { tenantId: tenant, memberId, planId, status: 'active' },
    });
  });
}

/** The caller's price. The contract says "the caller's price" without naming the
 *  field, so either an explicit resolved field or a resolved `priceMinor` counts. */
function priceOf(row: { priceMinor?: number; yourPriceMinor?: number }): number {
  return row.yourPriceMinor ?? row.priceMinor!;
}

function findOffering(body: any, code: string) {
  return body.offerings.find((o: { code: string }) => o.code === code);
}

function utcDay(value: string | Date): Date {
  const d = new Date(value);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function today(): Date {
  return utcDay(new Date());
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((utcDay(b).getTime() - utcDay(a).getTime()) / DAY);
}

async function orderCount(token: string): Promise<number> {
  const res = await api('/api/v1/orders', { token, tenant: tenantId });
  expect(res.status).toBe(200);
  return res.body.orders.length;
}

async function getCart(token: string) {
  const res = await api('/api/v1/cart', { token, tenant: tenantId });
  expect(res.status).toBe(200);
  return res.body.cart;
}

async function setNextRunOn(day: Date): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx.subscription.update({
      where: { id: subscriptionId },
      data: { nextRunOn: new Date(`${isoDay(day)}T00:00:00.000Z`) },
    });
  });
}

async function runDue(adminToken: string, asOf: Date) {
  return api('/api/v1/subscriptions/run-due', {
    method: 'POST',
    token: adminToken,
    tenant: tenantId,
    body: JSON.stringify({ asOf: isoDay(asOf) }),
  });
}

async function mySubscription(token: string) {
  const res = await api('/api/v1/subscriptions', { token, tenant: tenantId });
  expect(res.status).toBe(200);
  const found = res.body.subscriptions.find((s: { id: string }) => s.id === subscriptionId);
  expect(found).toBeTruthy();
  return found;
}

beforeAll(async () => {
  process.env.AVIORA_OUTBOX_DISABLED = 'true';
  process.env.AVIORA_PII_ENCRYPTION_KEY ??= Buffer.alloc(32, 9).toString('base64');
  owner = createOwnerClient();
  await ensureAppRole(owner);
  for (const key of Object.values(PERMISSIONS)) {
    await owner.permission.upsert({ where: { key }, create: { key }, update: {} });
  }
  for (const key of Object.values(ENTITLEMENTS)) {
    await owner.entitlement.upsert({ where: { key }, create: { key }, update: {} });
  }
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
        code: `e2e_cm_${suffix}_${RUN}`,
        name: `Commerce ${suffix.toUpperCase()}`,
        slug: `e2e-cm-${suffix}-${RUN}`,
        adminEmail,
        adminDisplayName: 'Admin',
        adminPassword: PW,
      }),
    });
    expect(res.status).toBe(201);
    return res.body as { tenant: { id: string }; adminMemberId: string };
  };
  const a = await mkTenant('a', `admin-a-${RUN}@test.local`);
  const b = await mkTenant('b', `admin-b-${RUN}@test.local`);
  tenantId = a.tenant.id;
  otherTenantId = b.tenant.id;

  const adminA = await login(`admin-a-${RUN}@test.local`);
  const mkPlan = async (
    token: string,
    tenant: string,
    code: string,
    name: string,
    entitlementKeys: string[],
  ): Promise<string> => {
    const res = await api('/api/v1/membership-plans', {
      method: 'POST',
      token,
      tenant,
      body: JSON.stringify({ code, name, entitlementKeys }),
    });
    expect(res.status).toBe(201);
    return res.body.plan.id as string;
  };

  auroraPlanId = await mkPlan(adminA, tenantId, 'aurora', 'Aurora Circle', [ENTITLEMENTS.COMMERCE]);
  zephyrPlanId = await mkPlan(adminA, tenantId, 'zephyr', 'Zephyr Circle', [ENTITLEMENTS.COMMERCE]);
  marigoldPlanId = await mkPlan(adminA, tenantId, 'marigold', 'Marigold Circle', [
    ENTITLEMENTS.COMMERCE,
  ]);
  // a plan that sells nothing: no commerce.enabled, so the module is invisible
  const juniperPlanId = await mkPlan(adminA, tenantId, 'juniper', 'Juniper Circle', []);
  const opsPlanId = await mkPlan(adminA, tenantId, 'thistle', 'Thistle Ops', [
    ENTITLEMENTS.COMMERCE,
  ]);

  // the tenant owner is a member too, and entitlements come from a plan
  await giveMembership(tenantId, a.adminMemberId, opsPlanId);

  await addMember(adminA, tenantId, auroraPlanId, `ada-${RUN}@test.local`, 'Ada');
  await addMember(adminA, tenantId, zephyrPlanId, `bo-${RUN}@test.local`, 'Bo');
  await addMember(adminA, tenantId, marigoldPlanId, `cy-${RUN}@test.local`, 'Cy');
  await addMember(adminA, tenantId, juniperPlanId, `di-${RUN}@test.local`, 'Di');

  const adminB = await login(`admin-b-${RUN}@test.local`);
  const bPlanId = await mkPlan(adminB, otherTenantId, 'basic', 'Basic', [ENTITLEMENTS.COMMERCE]);
  await giveMembership(otherTenantId, b.adminMemberId, bPlanId);
  await addMember(adminB, otherTenantId, bPlanId, `eli-${RUN}@test.local`, 'Eli');
}, 240_000);

afterAll(async () => {
  await app?.close();
  await owner?.$disconnect();
});

describe('Catalogue — a tenant decides what it sells', () => {
  it('an admin publishes a one-time offering and a subscription offering', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const create = async (body: Record<string, unknown>) => {
      const res = await api('/api/v1/offerings', {
        method: 'POST',
        token: admin,
        tenant: tenantId,
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(201);
      return res.body.offering;
    };

    const fieldNotes = await create({
      code: 'field-notes',
      name: 'Field Notes booklet',
      kind: 'one_time',
      currency: 'THB',
      priceMinor: 25_000,
    });
    expect(fieldNotes.kind).toBe('one_time');
    expect(fieldNotes.priceMinor).toBe(25_000);
    expect(fieldNotes.currency).toBe('THB');
    offering.fieldNotes = fieldNotes.id;

    offering.teaSampler = (
      await create({
        code: 'tea-sampler',
        name: 'Tea sampler',
        kind: 'one_time',
        currency: 'THB',
        priceMinor: 40_000,
      })
    ).id;
    offering.retreatSeat = (
      await create({
        code: 'retreat-seat',
        name: 'Retreat seat',
        kind: 'one_time',
        currency: 'THB',
        priceMinor: 100_000,
      })
    ).id;

    const monthlyBox = await create({
      code: 'monthly-box',
      name: 'Monthly box',
      kind: 'subscription',
      currency: 'THB',
      priceMinor: 90_000,
      intervalUnit: 'month',
      intervalCount: 1,
    });
    expect(monthlyBox.kind).toBe('subscription');
    expect(monthlyBox.intervalUnit).toBe('month');
    expect(monthlyBox.intervalCount).toBe(1);
    offering.monthlyBox = monthlyBox.id;
  });

  it('a member sees the catalogue', async () => {
    const ada = await login(`ada-${RUN}@test.local`);
    const res = await api('/api/v1/offerings', { token: ada, tenant: tenantId });
    expect(res.status).toBe(200);
    const codes = res.body.offerings.map((o: { code: string }) => o.code);
    expect(codes).toEqual(
      expect.arrayContaining(['field-notes', 'tea-sampler', 'retreat-seat', 'monthly-box']),
    );
  });

  it('a member cannot publish an offering', async () => {
    const ada = await login(`ada-${RUN}@test.local`);
    const res = await api('/api/v1/offerings', {
      method: 'POST',
      token: ada,
      tenant: tenantId,
      body: JSON.stringify({
        code: 'self-published',
        name: 'Something I made up',
        kind: 'one_time',
        currency: 'THB',
        priceMinor: 1,
      }),
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('a member cannot read the coupon list either', async () => {
    const ada = await login(`ada-${RUN}@test.local`);
    const res = await api('/api/v1/coupons', { token: ada, tenant: tenantId });
    expect(res.status).toBe(403);
  });

  it('a plan without commerce.enabled may browse but cannot put anything in a cart', async () => {
    const di = await login(`di-${RUN}@test.local`);
    // browsing is permission-scoped: the shop is visible …
    const browse = await api('/api/v1/offerings', { token: di, tenant: tenantId });
    expect(browse.status).toBe(200);
    // … but buying is the capability the plan grants, and this plan does not
    const buy = await api('/api/v1/cart/items', {
      method: 'POST',
      token: di,
      tenant: tenantId,
      body: JSON.stringify({ offeringId: offering.fieldNotes, quantity: 1 }),
    });
    expect(buy.status).toBe(403);
    expect(buy.body.error.code).toBe('ENTITLEMENT_REQUIRED');
  });
});

describe('Membership pricing — a plan pays a different price, as data', () => {
  it('an admin attaches plan prices above and below the base price', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const put = async (planId: string, priceMinor: number) => {
      const res = await api(`/api/v1/offerings/${offering.fieldNotes}/plan-price`, {
        method: 'PUT',
        token: admin,
        tenant: tenantId,
        body: JSON.stringify({ planId, priceMinor }),
      });
      expect(res.status).toBe(200);
      return res.body;
    };
    // Aurora pays less than base, Zephyr pays MORE than base. Nothing about the
    // names orders these; only the rows do.
    await put(auroraPlanId, 19_000);
    await put(zephyrPlanId, 27_000);

    // upsert: writing the same plan again replaces rather than duplicates
    await put(auroraPlanId, 19_000);
    const rows = await withTenant(tenantId, (tx) =>
      tx.offeringPlanPrice.count({ where: { offeringId: offering.fieldNotes } }),
    );
    expect(rows).toBe(2);
  });

  it('the plan price overrides the base price for a member on that plan', async () => {
    const ada = await login(`ada-${RUN}@test.local`);
    const res = await api('/api/v1/offerings', { token: ada, tenant: tenantId });
    expect(priceOf(findOffering(res.body, 'field-notes'))).toBe(19_000);

    // and an override may be higher — a plan is a price list, not a discount tier
    const bo = await login(`bo-${RUN}@test.local`);
    const forBo = await api('/api/v1/offerings', { token: bo, tenant: tenantId });
    expect(priceOf(findOffering(forBo.body, 'field-notes'))).toBe(27_000);
  });

  it('a member on a plan with no row pays the base price', async () => {
    const cy = await login(`cy-${RUN}@test.local`);
    const res = await api('/api/v1/offerings', { token: cy, tenant: tenantId });
    expect(priceOf(findOffering(res.body, 'field-notes'))).toBe(25_000);
    // an offering nobody has a plan price for is base for everyone
    expect(priceOf(findOffering(res.body, 'retreat-seat'))).toBe(100_000);
  });

  it('the resolved price is what lands in the cart, not the base price', async () => {
    const ada = await login(`ada-${RUN}@test.local`);
    const add = await api('/api/v1/cart/items', {
      method: 'POST',
      token: ada,
      tenant: tenantId,
      body: JSON.stringify({ offeringId: offering.fieldNotes, quantity: 1 }),
    });
    expect(add.status).toBe(201);

    const cart = await getCart(ada);
    expect(cart.items).toHaveLength(1);
    expect(cart.items[0].unitPriceMinor).toBe(19_000);
    expect(cart.subtotalMinor).toBe(19_000);

    // leave the cart clean for the cart suite
    const remove = await api(`/api/v1/cart/items/${cart.items[0].id}`, {
      method: 'DELETE',
      token: ada,
      tenant: tenantId,
    });
    expect(remove.status).toBe(200);
  });
});

describe('Cart — what the member saw is what they pay', () => {
  it('opens an empty cart on first read', async () => {
    const bo = await login(`bo-${RUN}@test.local`);
    const cart = await getCart(bo);
    expect(cart.items).toHaveLength(0);
    expect(cart.subtotalMinor).toBe(0);
    expect(cart.discountMinor).toBe(0);
    expect(cart.totalMinor).toBe(0);

    // reading again returns the same open cart, not a second one
    const again = await getCart(bo);
    expect(again.id).toBe(cart.id);
  });

  it('adds an item and updates the quantity when the same item is added again', async () => {
    const ada = await login(`ada-${RUN}@test.local`);
    const add = async (quantity: number) => {
      const res = await api('/api/v1/cart/items', {
        method: 'POST',
        token: ada,
        tenant: tenantId,
        body: JSON.stringify({ offeringId: offering.teaSampler, quantity }),
      });
      expect(res.status).toBe(201);
    };

    await add(1);
    let cart = await getCart(ada);
    expect(cart.items).toHaveLength(1);
    expect(cart.items[0].quantity).toBe(1);
    expect(cart.subtotalMinor).toBe(40_000);

    // re-adding UPDATES the quantity to the value sent; it does not add a line
    await add(2);
    cart = await getCart(ada);
    expect(cart.items).toHaveLength(1);
    expect(cart.items[0].quantity).toBe(2);
    expect(cart.subtotalMinor).toBe(80_000);
  });

  it('keeps the snapshotted price when the catalogue price changes underneath', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const patch = await api(`/api/v1/offerings/${offering.teaSampler}`, {
      method: 'PATCH',
      token: admin,
      tenant: tenantId,
      body: JSON.stringify({ priceMinor: 55_000 }),
    });
    expect(patch.status).toBe(200);
    expect(patch.body.offering.priceMinor).toBe(55_000);

    const ada = await login(`ada-${RUN}@test.local`);
    const cart = await getCart(ada);
    expect(cart.items[0].unitPriceMinor).toBe(40_000);
    expect(cart.subtotalMinor).toBe(80_000);

    // a NEW line takes the new price — the snapshot is per item, not per cart
    const add = await api('/api/v1/cart/items', {
      method: 'POST',
      token: ada,
      tenant: tenantId,
      body: JSON.stringify({ offeringId: offering.retreatSeat, quantity: 1 }),
    });
    expect(add.status).toBe(201);
    const withSeat = await getCart(ada);
    expect(withSeat.subtotalMinor).toBe(180_000);
  });

  it('removes an item and the subtotal follows', async () => {
    const ada = await login(`ada-${RUN}@test.local`);
    const cart = await getCart(ada);
    const sampler = cart.items.find(
      (i: { offeringId: string }) => i.offeringId === offering.teaSampler,
    );
    const res = await api(`/api/v1/cart/items/${sampler.id}`, {
      method: 'DELETE',
      token: ada,
      tenant: tenantId,
    });
    expect(res.status).toBe(200);

    const after = await getCart(ada);
    expect(after.items).toHaveLength(1);
    // one retreat seat is left, which is what the coupon suite prices against
    expect(after.subtotalMinor).toBe(100_000);
    expect(after.totalMinor).toBe(100_000);
  });
});

describe('Coupons — a discount is a rule, not a favour', () => {
  it('an admin creates percent, fixed, lapsed, capped and floor-bound coupons', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const create = async (body: Record<string, unknown>) => {
      const res = await api('/api/v1/coupons', {
        method: 'POST',
        token: admin,
        tenant: tenantId,
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(201);
      return res.body.coupon;
    };

    await create({ code: `SPRING10-${RUN}`, kind: 'percent', value: 10 });
    await create({ code: `FLAT250-${RUN}`, kind: 'fixed', value: 25_000, currency: 'THB' });
    await create({
      code: `LAPSED-${RUN}`,
      kind: 'percent',
      value: 50,
      startsAt: new Date(Date.now() - 30 * DAY).toISOString(),
      endsAt: new Date(Date.now() - DAY).toISOString(),
    });
    await create({
      code: `ONLYONE-${RUN}`,
      kind: 'fixed',
      value: 5_000,
      currency: 'THB',
      maxRedemptions: 1,
    });
    await create({
      code: `BIGSPEND-${RUN}`,
      kind: 'fixed',
      value: 30_000,
      currency: 'THB',
      minSubtotalMinor: 200_000,
    });

    const list = await api('/api/v1/coupons', { token: admin, tenant: tenantId });
    expect(list.status).toBe(200);
    // codes are stored in one case, because people type them in any case
    expect(list.body.coupons.map((c: { code: string }) => c.code)).toEqual(
      expect.arrayContaining([`SPRING10-${RUN}`.toUpperCase(), `BIGSPEND-${RUN}`.toUpperCase()]),
    );
  });

  it('applies a percent discount against the subtotal', async () => {
    const ada = await login(`ada-${RUN}@test.local`);
    const res = await api('/api/v1/cart/coupon', {
      method: 'POST',
      token: ada,
      tenant: tenantId,
      body: JSON.stringify({ code: `SPRING10-${RUN}` }),
    });
    expect(res.status).toBe(201);

    const cart = await getCart(ada);
    expect(cart.subtotalMinor).toBe(100_000);
    expect(cart.discountMinor).toBe(10_000);
    expect(cart.totalMinor).toBe(90_000);
  });

  it('applies a fixed discount in minor units', async () => {
    const ada = await login(`ada-${RUN}@test.local`);
    const res = await api('/api/v1/cart/coupon', {
      method: 'POST',
      token: ada,
      tenant: tenantId,
      body: JSON.stringify({ code: `FLAT250-${RUN}` }),
    });
    expect(res.status).toBe(201);

    const cart = await getCart(ada);
    expect(cart.discountMinor).toBe(25_000);
    expect(cart.totalMinor).toBe(75_000);

    // removing it puts the cart back to full price
    const off = await api('/api/v1/cart/coupon', {
      method: 'DELETE',
      token: ada,
      tenant: tenantId,
    });
    expect(off.status).toBe(200);
    const bare = await getCart(ada);
    expect(bare.discountMinor).toBe(0);
    expect(bare.totalMinor).toBe(100_000);
  });

  it('rejects a coupon whose window has closed', async () => {
    const ada = await login(`ada-${RUN}@test.local`);
    const res = await api('/api/v1/cart/coupon', {
      method: 'POST',
      token: ada,
      tenant: tenantId,
      body: JSON.stringify({ code: `LAPSED-${RUN}` }),
    });
    expect([400, 409, 422]).toContain(res.status);
    expect(['VALIDATION_FAILED', 'CONFLICT']).toContain(res.body.error.code);
    expect(res.body.error.message).toMatch(/expired|no longer|valid/i);

    // and the cart is untouched by a rejected coupon
    const cart = await getCart(ada);
    expect(cart.discountMinor).toBe(0);
    expect(cart.totalMinor).toBe(100_000);
  });

  it('rejects a coupon below its minimum subtotal', async () => {
    const ada = await login(`ada-${RUN}@test.local`);
    const res = await api('/api/v1/cart/coupon', {
      method: 'POST',
      token: ada,
      tenant: tenantId,
      body: JSON.stringify({ code: `BIGSPEND-${RUN}` }),
    });
    expect([400, 409, 422]).toContain(res.status);
    expect(['VALIDATION_FAILED', 'CONFLICT']).toContain(res.body.error.code);
    expect(res.body.error.message).toMatch(/minimum|subtotal|least/i);

    const cart = await getCart(ada);
    expect(cart.discountMinor).toBe(0);
  });

  it('rejects a coupon that has reached its redemption cap', async () => {
    // Bo spends the single redemption on a real checkout...
    const bo = await login(`bo-${RUN}@test.local`);
    const add = await api('/api/v1/cart/items', {
      method: 'POST',
      token: bo,
      tenant: tenantId,
      body: JSON.stringify({ offeringId: offering.retreatSeat, quantity: 1 }),
    });
    expect(add.status).toBe(201);
    const applied = await api('/api/v1/cart/coupon', {
      method: 'POST',
      token: bo,
      tenant: tenantId,
      body: JSON.stringify({ code: `ONLYONE-${RUN}` }),
    });
    expect(applied.status).toBe(201);
    const checkout = await api('/api/v1/cart/checkout', {
      method: 'POST',
      token: bo,
      tenant: tenantId,
    });
    expect(checkout.status).toBe(201);
    expect(checkout.body.order.discountMinor).toBe(5_000);
    expect(checkout.body.order.totalMinor).toBe(95_000);

    // ...so Ada cannot have it
    const ada = await login(`ada-${RUN}@test.local`);
    const res = await api('/api/v1/cart/coupon', {
      method: 'POST',
      token: ada,
      tenant: tenantId,
      body: JSON.stringify({ code: `ONLYONE-${RUN}` }),
    });
    expect([400, 409, 422]).toContain(res.status);
    expect(['VALIDATION_FAILED', 'CONFLICT']).toContain(res.body.error.code);
    expect(res.body.error.message).toMatch(/redemption|limit|used up|no longer/i);

    const cart = await getCart(ada);
    expect(cart.discountMinor).toBe(0);
  });

  it('an unknown code is rejected, not silently ignored', async () => {
    const ada = await login(`ada-${RUN}@test.local`);
    const res = await api('/api/v1/cart/coupon', {
      method: 'POST',
      token: ada,
      tenant: tenantId,
      body: JSON.stringify({ code: `NOSUCHCODE-${RUN}` }),
    });
    expect([400, 404, 409, 422]).toContain(res.status);
    expect(res.status).not.toBe(201);
  });
});

describe('Checkout — the order is the immutable record', () => {
  it('turns the cart into an order with the discount priced in', async () => {
    const ada = await login(`ada-${RUN}@test.local`);
    const applied = await api('/api/v1/cart/coupon', {
      method: 'POST',
      token: ada,
      tenant: tenantId,
      body: JSON.stringify({ code: `SPRING10-${RUN}` }),
    });
    expect(applied.status).toBe(201);

    const res = await api('/api/v1/cart/checkout', {
      method: 'POST',
      token: ada,
      tenant: tenantId,
    });
    expect(res.status).toBe(201);
    const order = res.body.order;
    oneTimeOrderId = order.id;

    expect(order.status).toBe('pending');
    expect(order.currency).toBe('THB');
    expect(order.subtotalMinor).toBe(100_000);
    expect(order.discountMinor).toBe(10_000);
    expect(order.totalMinor).toBe(90_000);
    expect(order.number).toBeTruthy();
    expect(order.paidAt ?? null).toBeNull();
  });

  it('closes the cart it came from and opens a fresh empty one', async () => {
    const ada = await login(`ada-${RUN}@test.local`);
    const cart = await getCart(ada);
    expect(cart.status).toBe('open');
    expect(cart.items).toHaveLength(0);
    expect(cart.subtotalMinor).toBe(0);
    expect(cart.discountMinor).toBe(0);
  });

  it('snapshots the item name so a later rename cannot rewrite history', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const renamed = await api(`/api/v1/offerings/${offering.retreatSeat}`, {
      method: 'PATCH',
      token: admin,
      tenant: tenantId,
      body: JSON.stringify({ name: 'Retreat seat (2027 season)' }),
    });
    expect(renamed.status).toBe(200);

    const ada = await login(`ada-${RUN}@test.local`);
    const res = await api(`/api/v1/orders/${oneTimeOrderId}`, { token: ada, tenant: tenantId });
    expect(res.status).toBe(200);
    expect(res.body.order.items[0].name).toBe('Retreat seat');
    expect(res.body.order.items[0].quantity).toBe(1);
    expect(res.body.order.items[0].unitPriceMinor).toBe(100_000);
    expect(res.body.order.items[0].lineTotalMinor).toBe(100_000);
  });

  it('emits OrderPlaced into the outbox', async () => {
    expect(await eventCount('OrderPlaced', oneTimeOrderId)).toBe(1);
  });

  it('a member sees their own orders and not another member’s', async () => {
    const ada = await login(`ada-${RUN}@test.local`);
    const mine = await api('/api/v1/orders', { token: ada, tenant: tenantId });
    expect(mine.status).toBe(200);
    expect(mine.body.orders.map((o: { id: string }) => o.id)).toContain(oneTimeOrderId);

    const cy = await login(`cy-${RUN}@test.local`);
    const theirs = await api(`/api/v1/orders/${oneTimeOrderId}`, { token: cy, tenant: tenantId });
    expect(theirs.status).toBe(404);
  });
});

describe('Payment — an order is paid when the money adds up', () => {
  it('a member cannot record a payment against their own order', async () => {
    const ada = await login(`ada-${RUN}@test.local`);
    const res = await api(`/api/v1/orders/${oneTimeOrderId}/payments`, {
      method: 'POST',
      token: ada,
      tenant: tenantId,
      body: JSON.stringify({ provider: 'manual', amountMinor: 90_000 }),
    });
    expect(res.status).toBe(403);
  });

  it('leaves the order pending while the payment is only partial', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const res = await api(`/api/v1/orders/${oneTimeOrderId}/payments`, {
      method: 'POST',
      token: admin,
      tenant: tenantId,
      body: JSON.stringify({ provider: 'manual', amountMinor: 40_000, providerRef: 'slip-1' }),
    });
    expect(res.status).toBe(201);

    const order = await api(`/api/v1/orders/${oneTimeOrderId}`, {
      token: admin,
      tenant: tenantId,
    });
    expect(order.body.order.status).toBe('pending');
    expect(order.body.order.paidAt ?? null).toBeNull();
    expect(await eventCount('OrderCompleted', oneTimeOrderId)).toBe(0);
  });

  it('flips the order to paid when the payments reach the total', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const res = await api(`/api/v1/orders/${oneTimeOrderId}/payments`, {
      method: 'POST',
      token: admin,
      tenant: tenantId,
      body: JSON.stringify({ provider: 'manual', amountMinor: 50_000, providerRef: 'slip-2' }),
    });
    expect(res.status).toBe(201);

    const order = await api(`/api/v1/orders/${oneTimeOrderId}`, {
      token: admin,
      tenant: tenantId,
    });
    expect(order.body.order.status).toBe('paid');
    expect(order.body.order.paidAt).toBeTruthy();
    expect(await eventCount('OrderCompleted', oneTimeOrderId)).toBe(1);
  });

  it('a paid order can no longer be cancelled', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const res = await api(`/api/v1/orders/${oneTimeOrderId}/cancel`, {
      method: 'POST',
      token: admin,
      tenant: tenantId,
    });
    expect([400, 409, 422]).toContain(res.status);

    const order = await api(`/api/v1/orders/${oneTimeOrderId}`, {
      token: admin,
      tenant: tenantId,
    });
    expect(order.body.order.status).toBe('paid');
  });
});

describe('Subscriptions — the recurring engine (spec §40)', () => {
  it('checking out a subscription offering starts an active subscription', async () => {
    const ada = await login(`ada-${RUN}@test.local`);
    const add = await api('/api/v1/cart/items', {
      method: 'POST',
      token: ada,
      tenant: tenantId,
      body: JSON.stringify({ offeringId: offering.monthlyBox, quantity: 1 }),
    });
    expect(add.status).toBe(201);

    const checkout = await api('/api/v1/cart/checkout', {
      method: 'POST',
      token: ada,
      tenant: tenantId,
    });
    expect(checkout.status).toBe(201);
    expect(checkout.body.order.totalMinor).toBe(90_000);

    const list = await api('/api/v1/subscriptions', { token: ada, tenant: tenantId });
    expect(list.status).toBe(200);
    expect(list.body.subscriptions).toHaveLength(1);
    const sub = list.body.subscriptions[0];
    subscriptionId = sub.id;

    expect(sub.status).toBe('active');
    expect(sub.intervalUnit).toBe('month');
    expect(sub.intervalCount).toBe(1);
    expect(sub.quantity).toBe(1);
    expect(sub.priceMinor).toBe(90_000);
    expect(sub.currency).toBe('THB');
    // the next cycle is scheduled for a future day, not for today
    expect(utcDay(sub.nextRunOn).getTime()).toBeGreaterThan(today().getTime());
    expect(await eventCount('SubscriptionCreated', subscriptionId)).toBe(1);
  });

  it('run-due creates exactly one order for a subscription that has come due', async () => {
    const ada = await login(`ada-${RUN}@test.local`);
    const admin = await login(`admin-a-${RUN}@test.local`);
    const due = new Date(today().getTime() - DAY);
    await setNextRunOn(due);

    const before = await orderCount(ada);
    const res = await runDue(admin, due);
    expect(res.status).toBe(201);
    const after = await orderCount(ada);
    expect(after).toBe(before + 1);

    const orders = await api('/api/v1/orders', { token: ada, tenant: tenantId });
    const renewal = orders.body.orders.find((o: { id: string }) => o.id !== oneTimeOrderId);
    expect(renewal.totalMinor).toBe(90_000);
    expect(await eventCount('SubscriptionRenewed', subscriptionId)).toBe(1);

    // and the schedule moved on by one cycle
    const sub = await mySubscription(ada);
    expect(daysBetween(due, utcDay(sub.nextRunOn))).toBeGreaterThanOrEqual(28);
    expect(daysBetween(due, utcDay(sub.nextRunOn))).toBeLessThanOrEqual(31);
  });

  it('running the same due date twice creates no second order', async () => {
    const ada = await login(`ada-${RUN}@test.local`);
    const admin = await login(`admin-a-${RUN}@test.local`);
    const due = new Date(today().getTime() - DAY);
    const before = await orderCount(ada);

    // a plain repeat of the tick
    expect((await runDue(admin, due)).status).toBe(201);
    expect(await orderCount(ada)).toBe(before);

    // and the harder case: a crashed or racing tick that finds the schedule
    // still pointing at the date it already billed
    await setNextRunOn(due);
    expect((await runDue(admin, due)).status).toBe(201);
    expect(await orderCount(ada)).toBe(before);

    // the run ledger holds exactly one row for that cycle — that unique key is
    // the whole reason a retry is safe
    const runs = await withTenant(tenantId, (tx) =>
      tx.subscriptionRun.count({
        where: { subscriptionId, scheduledFor: new Date(`${isoDay(due)}T00:00:00.000Z`) },
      }),
    );
    expect(runs).toBe(1);
    expect(await eventCount('SubscriptionRenewed', subscriptionId)).toBe(1);
  });

  it('pausing stops the renewal even when the date is due', async () => {
    const ada = await login(`ada-${RUN}@test.local`);
    const admin = await login(`admin-a-${RUN}@test.local`);
    const pause = await api(`/api/v1/subscriptions/${subscriptionId}/pause`, {
      method: 'POST',
      token: ada,
      tenant: tenantId,
    });
    expect(pause.status).toBe(201);
    expect((await mySubscription(ada)).status).toBe('paused');
    expect(await eventCount('SubscriptionPaused', subscriptionId)).toBe(1);

    const due = new Date(today().getTime() - 2 * DAY);
    await setNextRunOn(due);
    const before = await orderCount(ada);
    expect((await runDue(admin, today())).status).toBe(201);
    expect(await orderCount(ada)).toBe(before);
  });

  it('resuming after months of pause owes one cycle, not one per missed month', async () => {
    const ada = await login(`ada-${RUN}@test.local`);
    const admin = await login(`admin-a-${RUN}@test.local`);
    // six monthly cycles went by while it was paused
    await setNextRunOn(new Date(today().getTime() - 180 * DAY));

    const resume = await api(`/api/v1/subscriptions/${subscriptionId}/resume`, {
      method: 'POST',
      token: ada,
      tenant: tenantId,
    });
    expect(resume.status).toBe(201);

    const sub = await mySubscription(ada);
    expect(sub.status).toBe('active');
    // the schedule was moved forward, never left in the past
    expect(utcDay(sub.nextRunOn).getTime()).toBeGreaterThanOrEqual(today().getTime());
    expect(await eventCount('SubscriptionResumed', subscriptionId)).toBe(1);

    const before = await orderCount(ada);
    expect((await runDue(admin, today())).status).toBe(201);
    const after = await orderCount(ada);
    expect(after - before).toBeLessThanOrEqual(1);
  });

  it('skipping records a skipped run and advances exactly one cycle', async () => {
    const ada = await login(`ada-${RUN}@test.local`);
    const beforeSub = await mySubscription(ada);
    const scheduled = utcDay(beforeSub.nextRunOn);
    const before = await orderCount(ada);

    const skip = await api(`/api/v1/subscriptions/${subscriptionId}/skip`, {
      method: 'POST',
      token: ada,
      tenant: tenantId,
    });
    expect(skip.status).toBe(201);

    const afterSub = await mySubscription(ada);
    expect(afterSub.status).toBe('active');
    const gap = daysBetween(scheduled, utcDay(afterSub.nextRunOn));
    expect(gap).toBeGreaterThanOrEqual(28);
    expect(gap).toBeLessThanOrEqual(31);
    // a skip costs nothing
    expect(await orderCount(ada)).toBe(before);

    const skipped = await withTenant(tenantId, (tx) =>
      tx.subscriptionRun.findFirst({
        where: { subscriptionId, scheduledFor: new Date(`${isoDay(scheduled)}T00:00:00.000Z`) },
      }),
    );
    expect(skipped?.outcome).toBe('skipped');
    expect(skipped?.orderId ?? null).toBeNull();
  });

  it('cancelling is terminal — it cannot be resumed and never renews again', async () => {
    const ada = await login(`ada-${RUN}@test.local`);
    const admin = await login(`admin-a-${RUN}@test.local`);
    const cancel = await api(`/api/v1/subscriptions/${subscriptionId}/cancel`, {
      method: 'POST',
      token: ada,
      tenant: tenantId,
    });
    expect(cancel.status).toBe(201);

    const sub = await mySubscription(ada);
    expect(sub.status).toBe('cancelled');
    expect(sub.cancelledAt).toBeTruthy();
    expect(await eventCount('SubscriptionCancelled', subscriptionId)).toBe(1);

    const resume = await api(`/api/v1/subscriptions/${subscriptionId}/resume`, {
      method: 'POST',
      token: ada,
      tenant: tenantId,
    });
    expect([400, 409, 422]).toContain(resume.status);

    await setNextRunOn(new Date(today().getTime() - DAY));
    const before = await orderCount(ada);
    expect((await runDue(admin, today())).status).toBe(201);
    expect(await orderCount(ada)).toBe(before);
  });

  it('another member cannot touch a subscription that is not theirs', async () => {
    const cy = await login(`cy-${RUN}@test.local`);
    const res = await api(`/api/v1/subscriptions/${subscriptionId}/pause`, {
      method: 'POST',
      token: cy,
      tenant: tenantId,
    });
    expect(res.status).toBe(404);
  });

  it('a member cannot run the scheduler', async () => {
    const ada = await login(`ada-${RUN}@test.local`);
    const res = await api('/api/v1/subscriptions/run-due', {
      method: 'POST',
      token: ada,
      tenant: tenantId,
      body: JSON.stringify({ asOf: isoDay(today()) }),
    });
    expect(res.status).toBe(403);
  });
});

describe('Tenant isolation — commerce is never shared', () => {
  it("a member of another tenant cannot read this tenant's order", async () => {
    const eli = await login(`eli-${RUN}@test.local`);
    const res = await api(`/api/v1/orders/${oneTimeOrderId}`, {
      token: eli,
      tenant: otherTenantId,
    });
    expect(res.status).toBe(404);
  });

  it('and cannot reach it by presenting the other tenant’s header either', async () => {
    const eli = await login(`eli-${RUN}@test.local`);
    const res = await api(`/api/v1/orders/${oneTimeOrderId}`, { token: eli, tenant: tenantId });
    // rejected at the tenant boundary, long before the order is looked up
    expect([403, 404]).toContain(res.status);
    expect(res.status).not.toBe(200);
  });

  it("cannot see the other tenant's offerings", async () => {
    const eli = await login(`eli-${RUN}@test.local`);
    const res = await api('/api/v1/offerings', { token: eli, tenant: otherTenantId });
    expect(res.status).toBe(200);
    const codes = res.body.offerings.map((o: { code: string }) => o.code);
    expect(codes).not.toContain('field-notes');
    expect(codes).not.toContain('monthly-box');
    expect(res.body.offerings).toHaveLength(0);
  });

  it("cannot redeem the other tenant's coupon", async () => {
    const eli = await login(`eli-${RUN}@test.local`);
    const res = await api('/api/v1/cart/coupon', {
      method: 'POST',
      token: eli,
      tenant: otherTenantId,
      body: JSON.stringify({ code: `SPRING10-${RUN}` }),
    });
    expect(res.status).not.toBe(201);
    expect([400, 404, 409, 422]).toContain(res.status);
  });
});

describe('Money — integers in minor units, never floats', () => {
  it('every amount an order returns is a whole number of minor units', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const res = await api(`/api/v1/orders/${oneTimeOrderId}`, { token: admin, tenant: tenantId });
    expect(res.status).toBe(200);

    const amounts: Array<[string, unknown]> = [];
    const walk = (value: unknown) => {
      if (Array.isArray(value)) return value.forEach(walk);
      if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
          if (/Minor$/.test(k)) amounts.push([k, v]);
          else walk(v);
        }
      }
    };
    walk(res.body.order);

    expect(amounts.length).toBeGreaterThan(0);
    for (const [key, value] of amounts) {
      expect(typeof value, key).toBe('number');
      expect(Number.isInteger(value), key).toBe(true);
    }
  });

  it('the total is the subtotal less the discount, to the unit', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const res = await api(`/api/v1/orders/${oneTimeOrderId}`, { token: admin, tenant: tenantId });
    const o = res.body.order;
    expect(o.subtotalMinor - o.discountMinor).toBe(o.totalMinor);
    expect(o.currency).toMatch(/^[A-Z]{3}$/);
  });
});

describe('Coupon codes — typed by humans', () => {
  it('accepts a code typed in the wrong case', async () => {
    const ada = await login(`ada-${RUN}@test.local`);
    const added = await api('/api/v1/cart/items', {
      method: 'POST',
      token: ada,
      tenant: tenantId,
      body: JSON.stringify({ offeringId: offering.fieldNotes, quantity: 1 }),
    });
    const res = await api('/api/v1/cart/coupon', {
      method: 'POST',
      token: ada,
      tenant: tenantId,
      body: JSON.stringify({ code: `spring10-${RUN}`.toLowerCase() }),
    });
    expect(res.status).toBe(201);
    expect(res.body.cart.discountMinor).toBeGreaterThan(0);

    // leave the cart as it was found — the cases below build their own
    await api('/api/v1/cart/coupon', { method: 'DELETE', token: ada, tenant: tenantId });
    for (const item of added.body.cart.items) {
      await api(`/api/v1/cart/items/${item.id}`, {
        method: 'DELETE',
        token: ada,
        tenant: tenantId,
      });
    }
  });
});
