/**
 * A stairstep–breakaway plan, end to end (docs/70, docs/26 §1).
 *
 * docs/26 §1 promised that every bonus is one sentence — conditions, then a
 * fixed amount or a percentage — and docs/70 §5 found the two places that
 * promise did not reach. Both failed the same way: the payout for one member is
 * not a function of that member alone. What a stairstep plan owes on a line
 * depends on the rate THAT LINE reached in the same period.
 *
 * So this file exists to hold one claim: the engine can now pay a plan of that
 * family, out of rows, with no branch anywhere named after one. Every amount
 * below is derived by hand in a comment above the assertion that checks it, and
 * every figure it is derived from comes from a real paid order or a real
 * placement edge — nothing here asserts a number the engine could have been
 * told.
 *
 * The fixture is one tenant, six members, one tree:
 *
 *     mara ──┬── nils ── vera
 *            ├── orla
 *            └── petra ── sol
 *
 * NOTE: stop any locally running API — the outbox relay is cross-tenant.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import * as argon2 from 'argon2';
import { createOwnerClient, ensureAppRole, type PrismaClient } from '@aviora/db';
import { ENTITLEMENTS, PERMISSIONS } from '@aviora/shared';
import { createApp } from '../../src/app.factory';

const RUN = `s${Date.now().toString(36)}`;
const PLATFORM_EMAIL = `e2e-step-platform-${RUN}@test.local`;
const PW = 'e2e-password-123456';
const DAY = 86_400_000;

const PERIOD_START = new Date(Date.now() - 30 * DAY).toISOString();
const PERIOD_END = new Date(Date.now() + DAY).toISOString();

/**
 * The ladder, in minor units. Not anybody's plan — the rungs are chosen so the
 * arithmetic below can be checked in your head, which is the only property a
 * test ladder needs. A real tenant types their own (docs/62 §2).
 */
const TIERS = [
  { atLeastMinor: 100_000, percent: 3 },
  { atLeastMinor: 400_000, percent: 6 },
  { atLeastMinor: 900_000, percent: 9 },
  { atLeastMinor: 1_500_000, percent: 12 },
];

/** The rung at which a leg leaves its upline's group volume. */
const BREAKAWAY_AT = 900_000;

let app: INestApplication;
let base: string;
let owner: PrismaClient;
let tenant: string;
let admin: string;
let planId: string;
let ruleStep: string;
let ruleBreakaway: string;

const m: Record<string, string> = {};

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

async function addMember(planId: string, email: string, name: string): Promise<string> {
  const inv = await api('/api/v1/invitations', {
    method: 'POST',
    token: admin,
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
  return accepted.body.memberId as string;
}

/** A real, fully paid order — the only way any volume in this file moves. */
async function buy(email: string, offeringId: string): Promise<void> {
  const token = await login(email);
  const add = await api('/api/v1/cart/items', {
    method: 'POST',
    token,
    tenant,
    body: JSON.stringify({ offeringId, quantity: 1 }),
  });
  expect(add.status).toBe(201);
  const checkout = await api('/api/v1/cart/checkout', { method: 'POST', token, tenant });
  expect(checkout.status).toBe(201);
  const order = checkout.body.order;
  const paid = await api(`/api/v1/orders/${order.id}/payments`, {
    method: 'POST',
    token: admin,
    tenant,
    body: JSON.stringify({ provider: 'manual', amountMinor: order.totalMinor }),
  });
  expect(paid.status).toBe(201);
}

async function placeUnder(uplineMemberId: string, downlineMemberId: string): Promise<void> {
  const res = await api('/api/v1/compensation/graph', {
    method: 'POST',
    token: admin,
    tenant,
    body: JSON.stringify({ uplineMemberId, downlineMemberId }),
  });
  expect(res.status).toBe(201);
}

function legsOf(entry: any): any[] {
  return entry.basis.payout.legs as any[];
}

function legFor(entry: any, memberId: string): any {
  const leg = legsOf(entry).find((l) => l.memberId === memberId);
  expect(leg, `entry has no leg for ${memberId}`).toBeTruthy();
  return leg;
}

function entryFor(rows: any[], memberId: string, ruleId: string): any {
  const found = rows.find((e) => e.memberId === memberId && e.ruleId === ruleId);
  expect(found, `no entry for member ${memberId} on rule ${ruleId}`).toBeTruthy();
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
  const made = await api('/api/v1/platform/tenants', {
    method: 'POST',
    token: platform,
    body: JSON.stringify({
      code: `e2e_step_${RUN}`,
      name: 'Stairstep',
      slug: `e2e-step-${RUN}`,
      adminEmail: `admin-${RUN}@test.local`,
      adminDisplayName: 'Admin',
      adminPassword: PW,
    }),
  });
  expect(made.status).toBe(201);
  tenant = made.body.tenant.id;
  admin = await login(`admin-${RUN}@test.local`);

  const membership = await api('/api/v1/membership-plans', {
    method: 'POST',
    token: admin,
    tenant,
    body: JSON.stringify({
      code: 'step',
      name: 'Step',
      entitlementKeys: [ENTITLEMENTS.COMPENSATION, ENTITLEMENTS.COMMERCE],
    }),
  });
  expect(membership.status).toBe(201);
  const membershipPlanId = membership.body.plan.id as string;

  for (const name of ['mara', 'nils', 'vera', 'orla', 'petra', 'sol']) {
    m[name] = await addMember(membershipPlanId, `${name}-${RUN}@test.local`, name);
  }

  // One offering per distinct amount, so every member's personal volume is
  // exactly one order and can be read off the fixture rather than summed.
  const offerings: Record<number, string> = {};
  for (const priceMinor of [100_000, 200_000, 300_000, 400_000, 600_000]) {
    const res = await api('/api/v1/offerings', {
      method: 'POST',
      token: admin,
      tenant,
      body: JSON.stringify({
        code: `o${priceMinor}`,
        name: `Offering ${priceMinor}`,
        kind: 'one_time',
        currency: 'THB',
        priceMinor,
      }),
    });
    expect(res.status).toBe(201);
    offerings[priceMinor] = res.body.offering.id as string;
  }

  //   mara 100_000 · nils 200_000 · vera 300_000
  //   orla 100_000 · petra 400_000 · sol 600_000
  await buy(`mara-${RUN}@test.local`, offerings[100_000]!);
  await buy(`nils-${RUN}@test.local`, offerings[200_000]!);
  await buy(`vera-${RUN}@test.local`, offerings[300_000]!);
  await buy(`orla-${RUN}@test.local`, offerings[100_000]!);
  await buy(`petra-${RUN}@test.local`, offerings[400_000]!);
  await buy(`sol-${RUN}@test.local`, offerings[600_000]!);

  await placeUnder(m.mara!, m.nils!);
  await placeUnder(m.mara!, m.orla!);
  await placeUnder(m.mara!, m.petra!);
  await placeUnder(m.nils!, m.vera!);
  await placeUnder(m.petra!, m.sol!);
}, 300_000);

afterAll(async () => {
  await app?.close();
  await owner?.$disconnect();
});

describe('A stairstep plan is rows (docs/26 §1, docs/70 §5)', () => {
  it('the plan is accepted with two differential rules', async () => {
    const common = {
      basis: 'downline_volume',
      basisWindow: 'period',
      basisGraph: 'compensation',
    };
    const res = await api('/api/v1/compensation/plans', {
      method: 'POST',
      token: admin,
      tenant,
      body: JSON.stringify({
        code: 'step-comp',
        name: 'Stairstep compensation',
        currency: 'THB',
        rules: [
          {
            code: 'step',
            name: 'Differential',
            bonusType: 'differential',
            priority: 10,
            conditions: [],
            payout: { kind: 'differential', tiers: TIERS, ...common },
          },
          {
            code: 'step-breakaway',
            name: 'Differential, with breakaway',
            bonusType: 'differential',
            priority: 20,
            conditions: [],
            payout: {
              kind: 'differential',
              tiers: TIERS,
              ...common,
              basisParams: { excludeLegsAtOrAboveMinor: BREAKAWAY_AT },
            },
          },
        ],
      }),
    });
    expect(res.status).toBe(201);
    planId = res.body.plan.id;
    const rules = res.body.plan.rules as any[];
    ruleStep = rules.find((r) => r.code === 'step').id;
    ruleBreakaway = rules.find((r) => r.code === 'step-breakaway').id;
  });

  it('refuses a ladder whose rungs are out of order', async () => {
    const res = await api(`/api/v1/compensation/plans/${planId}/rules`, {
      method: 'POST',
      token: admin,
      tenant,
      body: JSON.stringify({
        code: 'jumbled',
        name: 'Jumbled ladder',
        bonusType: 'differential',
        conditions: [],
        payout: {
          kind: 'differential',
          basis: 'downline_volume',
          basisGraph: 'compensation',
          tiers: [
            { atLeastMinor: 400_000, percent: 6 },
            { atLeastMinor: 100_000, percent: 3 },
          ],
        },
      }),
    });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toMatch(/ordered/i);
  });

  it('refuses a breakaway threshold of zero, which would exclude every leg', async () => {
    const res = await api(`/api/v1/compensation/plans/${planId}/rules`, {
      method: 'POST',
      token: admin,
      tenant,
      body: JSON.stringify({
        code: 'zero-breakaway',
        name: 'Zero breakaway',
        bonusType: 'percentage',
        conditions: [
          {
            metric: 'downline_volume',
            comparator: 'gte',
            threshold: 1,
            window: 'period',
            graph: 'compensation',
            params: { excludeLegsAtOrAboveMinor: 0 },
          },
        ],
        payout: { kind: 'percent', percent: 5, basis: 'personal_volume' },
      }),
    });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toMatch(/every leg/i);
  });
});

describe('The differential pays the step, not the pile (docs/70 §3)', () => {
  let entries: any[];

  beforeAll(async () => {
    const created = await api('/api/v1/compensation/runs', {
      method: 'POST',
      token: admin,
      tenant,
      body: JSON.stringify({ planId, periodStart: PERIOD_START, periodEnd: PERIOD_END }),
    });
    expect(created.status).toBe(201);
    const res = await api(`/api/v1/compensation/runs/${created.body.run.id}/entries`, {
      token: admin,
      tenant,
    });
    expect(res.status).toBe(200);
    entries = res.body.entries;
  });

  it('pays mara the difference between her rung and each leg’s', () => {
    // Two different numbers per leg, and confusing them is the mistake this
    // comment exists to prevent. A leg's VOLUME is the whole line including its
    // head — that is what the percentage multiplies. A leg's RATE comes from
    // the head's OWN downline, which does not include the head.
    //
    // mara's line: nils 200 + vera 300 + orla 100 + petra 400 + sol 600
    //            = 1_600_000 → the 1_500_000 rung → 12%
    //
    //   leg     volume     head's own line       rate   step   paid
    //   nils    500_000    vera      300_000      3%     9%   45_000
    //   orla    100_000    (empty)         0      0%    12%   12_000
    //   petra 1_000_000    sol       600_000      6%     6%   60_000
    //                                                total = 117_000
    const entry = entryFor(entries, m.mara!, ruleStep);
    expect(entry.basis.payout.basisValue).toBe(1_600_000);
    expect(entry.basis.payout.ratePercent).toBe(12);

    expect(legFor(entry, m.nils!).volumeMinor).toBe(500_000);
    expect(legFor(entry, m.nils!).ratePercent).toBe(3);
    expect(legFor(entry, m.nils!).amountMinor).toBe(45_000);

    expect(legFor(entry, m.orla!).volumeMinor).toBe(100_000);
    expect(legFor(entry, m.orla!).ratePercent).toBe(0);
    expect(legFor(entry, m.orla!).amountMinor).toBe(12_000);

    expect(legFor(entry, m.petra!).volumeMinor).toBe(1_000_000);
    expect(legFor(entry, m.petra!).ratePercent).toBe(6);
    expect(legFor(entry, m.petra!).amountMinor).toBe(60_000);

    expect(entry.amountMinor).toBe(117_000);
  });

  it('the legs it paid on add up to the line it qualified on', () => {
    // The two numbers come from different code paths — a subtree sum and a
    // per-leg walk — and a plan in which they disagree is a plan that qualifies
    // somebody on volume it then declines to pay them for.
    const entry = entryFor(entries, m.mara!, ruleStep);
    const summed = legsOf(entry).reduce((total, leg) => total + leg.volumeMinor, 0);
    expect(summed).toBe(entry.basis.payout.basisValue);
  });

  it('the itemisation adds up to the amount paid', () => {
    const entry = entryFor(entries, m.mara!, ruleStep);
    const summed = legsOf(entry).reduce((total, leg) => total + leg.amountMinor, 0);
    expect(summed).toBe(entry.amountMinor);
  });

  it('pays the middle of the tree on its own legs, out of the same rule', () => {
    // nils: own line = vera 300_000 → 100_000 rung → 3%
    //       leg vera 300_000, vera's own line is empty → 0% … 3 − 0 = 3% → 9_000
    const nils = entryFor(entries, m.nils!, ruleStep);
    expect(nils.basis.payout.ratePercent).toBe(3);
    expect(nils.amountMinor).toBe(9_000);

    // petra: own line = sol 600_000 → 400_000 rung → 6%
    //        leg sol 600_000, sol's own line is empty → 0% … 6 − 0 = 6% → 36_000
    const petra = entryFor(entries, m.petra!, ruleStep);
    expect(petra.basis.payout.ratePercent).toBe(6);
    expect(petra.amountMinor).toBe(36_000);
  });

  it('pays nobody who has no line beneath them', () => {
    for (const name of ['orla', 'vera', 'sol']) {
      expect(entries.find((e) => e.memberId === m[name] && e.ruleId === ruleStep)).toBeUndefined();
    }
  });

  it('does not depend on the order members were computed in', () => {
    // The proof that the two passes are real: vera is computed before mara by
    // no rule at all — member order is by id — yet mara's payout reads vera's
    // resolved rate through nils's leg. In a single pass this number would move
    // when a member id changed.
    const mara = entryFor(entries, m.mara!, ruleStep);
    expect(legFor(mara, m.nils!).ratePercent).toBe(3);
  });
});

describe('Breakaway is the same subtraction, one rung higher (docs/70 §4)', () => {
  let entries: any[];

  beforeAll(async () => {
    const runs = await api('/api/v1/compensation/runs', { token: admin, tenant });
    const run = runs.body.runs[0];
    const res = await api(`/api/v1/compensation/runs/${run.id}/entries`, { token: admin, tenant });
    entries = res.body.entries;
  });

  it('drops a broken-away leg from the volume that qualifies its upline', () => {
    // Same tree, one parameter. petra's leg is 1_000_000, at or above the
    // 900_000 threshold, so it leaves mara's group volume:
    //   nils 500_000 + orla 100_000 = 600_000 → the 400_000 rung → 6%
    // rather than the 1_600_000 and 12% the unmodified rule saw.
    const entry = entryFor(entries, m.mara!, ruleBreakaway);
    expect(entry.basis.payout.basisValue).toBe(600_000);
    expect(entry.basis.payout.ratePercent).toBe(6);
  });

  it('pays nothing on the leg that left — and says so rather than omitting it', () => {
    // petra is on 6%, the same rung as mara. The step between them is flat, so
    // the differential is nil. No code anywhere says the word "breakaway"; the
    // subtraction says it.
    const entry = entryFor(entries, m.mara!, ruleBreakaway);
    const petra = legFor(entry, m.petra!);
    expect(petra.ratePercent).toBe(6);
    expect(petra.differentialPercent).toBe(0);
    expect(petra.amountMinor).toBe(0);
  });

  it('still pays the legs that stayed', () => {
    //   nils  500_000, head on 3% … 6 − 3 = 3% → 15_000
    //   orla  100_000, head on 0% … 6 − 0 = 6% →  6_000
    //   petra                                        0
    //                                     total = 21_000
    const entry = entryFor(entries, m.mara!, ruleBreakaway);
    expect(legFor(entry, m.nils!).amountMinor).toBe(15_000);
    expect(legFor(entry, m.orla!).amountMinor).toBe(6_000);
    expect(entry.amountMinor).toBe(21_000);
  });

  it('leaves a member whose legs are all below the threshold untouched', () => {
    // Nothing in nils's line reaches 900_000, so breakaway changes nothing for
    // nils and the two rules pay identically.
    const plain = entryFor(entries, m.nils!, ruleStep);
    const broken = entryFor(entries, m.nils!, ruleBreakaway);
    expect(broken.amountMinor).toBe(plain.amountMinor);
  });
});
