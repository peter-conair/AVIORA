/**
 * Compensation rule engine (spec §42–§43, §45, docs/26).
 *
 * Spec §42 opens with the constraint this whole file exists to hold:
 *
 *     Compensation must be optional and tenant configurable.
 *     Never hard-code one network plan.
 *
 * So the headline test is not a bonus formula — it is that TWO TENANTS RUN TWO
 * DIFFERENT PLANS OUT OF THE SAME ENGINE. Tenant A pays a rank-gated percentage
 * of downline volume plus a fixed referral bonus; tenant B pays a milestone
 * fixed bonus on personal volume plus a capped percentage of it, and holds no
 * placement graph at all. Both are rows. Neither is a branch. The amounts are
 * asserted to the minor unit on both sides, and they are different amounts
 * derived from different shapes — which is the Phase 3 exit criterion in
 * docs/16 §4.3 stated as arithmetic.
 *
 * The second promise is that the compensation graph is the THIRD graph
 * (spec §17). Sprint 9 proved team ≠ referral; here a member referred by one
 * person is PAID UNDER another and sits in a team led by a third, and each
 * graph is moved while the other two are read back through their own module's
 * API. A coupling bug that was merely embarrassing last sprint pays the wrong
 * person this sprint.
 *
 * The third, and the single most important `it` in the file: asking for the
 * same period twice returns the SAME run. A second run is a second payout.
 *
 * Nothing here asserts a number the engine could have been told. Volume comes
 * from real orders paid through the commerce API; edges come from the referral
 * and compensation APIs; every expected amount is derived by hand in a comment
 * above the assertion that checks it.
 *
 * NOTE: stop any locally running API — the outbox relay is cross-tenant.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import * as argon2 from 'argon2';
import {
  createOwnerClient,
  ensureAppRole,
  withTenant as dbWithTenant,
  type PrismaClient,
  type Tx,
} from '@aviora/db';
import { ENTITLEMENTS, PERMISSIONS } from '@aviora/shared';
import { createApp } from '../../src/app.factory';

const RUN = `k${Date.now().toString(36)}`;
const PLATFORM_EMAIL = `e2e-platform-${RUN}@test.local`;
const PW = 'e2e-password-123456';

const DAY = 86_400_000;

/**
 * Metric names, hoisted so the one genuinely ambiguous decision in this file
 * lives in one place.
 *
 * docs/26 §3 says a condition "reuses the Sprint 9 vocabulary exactly … plus
 * `graph`", and §2 says "Compensation metrics traverse the compensation graph …
 * the graph it walks is a parameter, never a default." Those two sentences
 * cannot both hold for a metric hard-named `referral_downline_volume`
 * (docs/25 §3) — a metric whose NAME fixes a graph has no parameter left to
 * pass. This suite therefore uses the graph-neutral `downline_volume` and
 * states the graph explicitly on every condition. If the engine kept the
 * Sprint 9 spelling, this constant is the one-line change.
 */
const DOWNLINE_VOLUME = 'downline_volume';
const PERSONAL_VOLUME = 'personal_volume';
const DIRECT_REFERRALS = 'direct_referrals';

/**
 * The period every tenant-A run is asked for. Captured once, at module load, so
 * the idempotency test can present byte-identical bounds — asking twice for
 * "the same period" is only meaningful if the two requests really are the same.
 * The period is still open (it ends tomorrow) because the recompute cases below
 * add paid orders mid-suite and those orders must land inside it.
 */
const PERIOD_START = new Date(Date.now() - 30 * DAY).toISOString();
const PERIOD_END = new Date(Date.now() + DAY).toISOString();
/** A second, later period — used for a run that is left in draft on purpose. */
// A second, differently-bounded window over the same fixture. It has to CONTAIN
// the sales it pays for: a percentage basis defaults to the run's own period,
// so a window with no orders in it correctly pays nothing.
const LATER_START = new Date(Date.now() - 15 * DAY).toISOString();
const LATER_END = new Date(Date.now() + 3 * DAY).toISOString();

let app: INestApplication;
let base: string;
let owner: PrismaClient;

/** A pays on a downline. B pays on the member alone. C configured nothing. */
let tenantA: string;
let tenantB: string;
let tenantC: string;
let ownerMemberA: string;

let atlasPlanId: string; // growth.compensation + growth.ranks + commerce.enabled
let slatePlanId: string; // commerce only — the module must be invisible from here
let beaconPlanId: string; // tenant B
let hushPlanId: string; // tenant C

/**
 * Tenant A. Mara is the only earner; everyone else exists to be volume, to be
 * somewhere else in one of the three graphs, or to be refused.
 *   referral graph  : mara → nils, mara → orla, mara → quinn, orla → pax
 *   compensation    : mara ← nils, mara ← orla, nils ← quinn (later moved)
 *   team graph      : harbor led by orla, holding quinn and pax
 * Pax buys nothing at all, so pax can be placed and unplaced in the guard
 * cases without moving a single amount.
 */
const m: Record<'mara' | 'nils' | 'orla' | 'quinn' | 'pax' | 'remy', string> = {} as never;
/** Tenant B. */
const b: Record<'sena' | 'tao', string> = {} as never;
/** Tenant C. */
let tess: string;

const offering: Record<'anchor' | 'kit' | 'major' | 'minor', string> = {} as never;

const team: Record<'harbor' | 'quay', string> = {} as never;

/** Referral edge ids, kept so one can be ended under a live placement. */
const edge: Record<'maraNils' | 'maraOrla' | 'maraQuinn' | 'orlaPax', string> = {} as never;

/** Compensation placement ids, kept so they can be moved and ended. */
const place: Record<'nils' | 'orla' | 'quinn' | 'quinnUnderOrla' | 'pax', string> = {} as never;

let planA: string;
let planB: string;
let ruleDownlineShare: string;
let ruleReferralBonus: string;
let ruleMilestone: string;
let rulePersonalShare: string;

let runA: string; // approved
let runADraft: string; // the later period, deliberately never approved
let runB: string;

let bronzeRankId: string;

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

/**
 * Scoped to one tenant. The library helper applies the tenant extension as
 * well as the GUC, which matters here: these tests connect as the OWNER role,
 * and the owner BYPASSES row-level security — FORCE RLS binds every role
 * except the table's owner. Without the extension an unfiltered findMany
 * silently reads every tenant's rows.
 */
async function withTenant<T>(tenant: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return dbWithTenant(owner, tenant, fn);
}

async function eventCount(
  tenant: string,
  eventName: string,
  aggregateId?: string,
): Promise<number> {
  return owner.domainEvent.count({
    where: { tenantId: tenant, eventName, ...(aggregateId ? { aggregateId } : {}) },
  });
}

/** A real, fully paid order — the only way any volume in this file is allowed to move. */
async function buy(
  email: string,
  tenant: string,
  adminToken: string,
  offeringId: string,
): Promise<{ id: string; totalMinor: number }> {
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
    token: adminToken,
    tenant,
    body: JSON.stringify({ provider: 'manual', amountMinor: order.totalMinor }),
  });
  expect(paid.status).toBe(201);
  return { id: order.id, totalMinor: order.totalMinor };
}

/* ── shape tolerance ──────────────────────────────────────────────────────
 * docs/26 §7 fixes the routes and §4 fixes the columns, but not the JSON
 * envelope. The readers below are lenient about WHERE a value sits; every
 * assertion built on them is exact about WHAT it is.
 * ------------------------------------------------------------------------ */

function idOf(body: any, ...keys: string[]): string {
  for (const key of keys) {
    const candidate = body?.[key]?.id ?? (typeof body?.[key] === 'string' ? body[key] : undefined);
    if (typeof candidate === 'string') return candidate;
  }
  expect(typeof body?.id, `no id on ${JSON.stringify(body)?.slice(0, 200)}`).toBe('string');
  return body.id as string;
}

function runOf(body: any): any {
  return body?.run ?? body;
}

function runsOf(body: any): any[] {
  return body?.runs ?? body?.commissionRuns ?? [];
}

function entriesOf(body: any): any[] {
  return body?.entries ?? body?.commissionEntries ?? body?.items ?? [];
}

function plansOf(body: any): any[] {
  return body?.plans ?? body?.compensationPlans ?? [];
}

function rulesOf(plan: any): any[] {
  return plan?.rules ?? plan?.compensationRules ?? [];
}

function placementsOf(body: any): any[] {
  return body?.placements ?? body?.graph ?? body?.relationships ?? body?.edges ?? [];
}

/** `totals` in the contract prose, `total_minor` in the schema — accept either. */
function runTotalMinor(run: any): number {
  const value = run?.totalMinor ?? run?.totals?.totalMinor ?? run?.totals?.amountMinor;
  expect(typeof value, 'run carries no total in minor units').toBe('number');
  return value as number;
}

function uplineIdOf(row: any): string {
  return row?.uplineMemberId ?? row?.upline?.id ?? row?.upline;
}

function downlineIdOf(row: any): string {
  return row?.downlineMemberId ?? row?.downline?.id ?? row?.downline;
}

async function placements(
  adminToken: string,
  tenant: string,
  opts: { includeEnded?: boolean } = {},
): Promise<any[]> {
  const suffix = opts.includeEnded ? '?includeEnded=true' : '';
  const res = await api(`/api/v1/compensation/graph${suffix}`, { token: adminToken, tenant });
  expect(res.status).toBe(200);
  return placementsOf(res.body);
}

/** Who is this member paid under, right now, according to the compensation module? */
async function activeUplineOf(
  adminToken: string,
  tenant: string,
  memberId: string,
): Promise<string | null> {
  const rows = (await placements(adminToken, tenant)).filter(
    (r) => downlineIdOf(r) === memberId && !r.effectiveTo,
  );
  expect(rows.length, `member has ${rows.length} active uplines`).toBeLessThanOrEqual(1);
  return rows[0] ? uplineIdOf(rows[0]) : null;
}

async function placeUnder(
  adminToken: string,
  tenant: string,
  uplineMemberId: string,
  downlineMemberId: string,
) {
  return api('/api/v1/compensation/graph', {
    method: 'POST',
    token: adminToken,
    tenant,
    body: JSON.stringify({ uplineMemberId, downlineMemberId }),
  });
}

async function endPlacement(adminToken: string, tenant: string, placementId: string) {
  return api(`/api/v1/compensation/graph/${placementId}`, {
    method: 'DELETE',
    token: adminToken,
    tenant,
  });
}

async function createRun(
  adminToken: string,
  tenant: string,
  planId: string,
  periodStart: string,
  periodEnd: string,
) {
  return api('/api/v1/compensation/runs', {
    method: 'POST',
    token: adminToken,
    tenant,
    body: JSON.stringify({ planId, periodStart, periodEnd }),
  });
}

async function runEntries(adminToken: string, tenant: string, runId: string): Promise<any[]> {
  const res = await api(`/api/v1/compensation/runs/${runId}/entries`, {
    token: adminToken,
    tenant,
  });
  expect(res.status).toBe(200);
  return entriesOf(res.body);
}

function entryFor(rows: any[], memberId: string, ruleId: string): any {
  const found = rows.find((e) => e.memberId === memberId && e.ruleId === ruleId);
  expect(found, `no entry for member ${memberId} on rule ${ruleId}`).toBeTruthy();
  return found;
}

/**
 * `basis` stores "the exact numbers that produced the amount" (docs/26 §4)
 * without the contract naming its keys, so the numbers and the labels are
 * flattened out and then asserted for exactly.
 */
function flatten(value: unknown): { numbers: number[]; strings: string[] } {
  const numbers: number[] = [];
  const strings: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'number') return void numbers.push(node);
    if (typeof node === 'string') return void strings.push(node);
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === 'object') return Object.values(node).forEach(walk);
  };
  walk(value);
  return { numbers, strings };
}

async function createReferral(
  adminToken: string,
  tenant: string,
  referrerMemberId: string,
  referredMemberId: string,
  type = 'referral',
) {
  return api('/api/v1/referrals', {
    method: 'POST',
    token: adminToken,
    tenant,
    body: JSON.stringify({ referrerMemberId, referredMemberId, type }),
  });
}

function referrerIdOf(body: any): string | null {
  const r = body?.referrer ?? body?.referredBy ?? body?.upline ?? body?.referrers?.[0] ?? null;
  if (!r) return null;
  if (typeof r === 'string') return r;
  return r.memberId ?? r.referrerMemberId ?? r.member?.id ?? null;
}

async function referralsMe(token: string, tenant: string) {
  const res = await api('/api/v1/referrals/me', { token, tenant });
  expect(res.status).toBe(200);
  return res.body;
}

async function teamMemberIds(
  adminToken: string,
  tenant: string,
  teamId: string,
): Promise<string[]> {
  const res = await api(`/api/v1/teams/${teamId}/members`, { token: adminToken, tenant });
  expect(res.status).toBe(200);
  return res.body.members.map((x: { memberId: string }) => x.memberId);
}

async function activeLeaderId(
  adminToken: string,
  tenant: string,
  teamId: string,
): Promise<string | null> {
  const res = await api(`/api/v1/teams/${teamId}/leadership-history`, {
    token: adminToken,
    tenant,
  });
  expect(res.status).toBe(200);
  const active = res.body.leaderships.find((r: { status: string }) => r.status === 'active');
  return active?.memberId ?? null;
}

function currentRankCode(body: any): string | null {
  const rank = body?.rank ?? body?.currentRank ?? body?.current ?? null;
  if (!rank) return null;
  return typeof rank === 'string' ? rank : (rank.code ?? null);
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
        code: `e2e_cp_${suffix}_${RUN}`,
        name: `Compensation ${suffix.toUpperCase()}`,
        slug: `e2e-cp-${suffix}-${RUN}`,
        adminEmail,
        adminDisplayName: 'Admin',
        adminPassword: PW,
      }),
    });
    expect(res.status).toBe(201);
    return res.body as { tenant: { id: string }; adminMemberId: string };
  };
  const a = await mkTenant('a', `admin-a-${RUN}@test.local`);
  const bt = await mkTenant('b', `admin-b-${RUN}@test.local`);
  const ct = await mkTenant('c', `admin-c-${RUN}@test.local`);
  tenantA = a.tenant.id;
  ownerMemberA = a.adminMemberId;
  tenantB = bt.tenant.id;
  tenantC = ct.tenant.id;

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
  const mkOffering = async (
    token: string,
    tenant: string,
    code: string,
    name: string,
    priceMinor: number,
  ) => {
    const res = await api('/api/v1/offerings', {
      method: 'POST',
      token,
      tenant,
      body: JSON.stringify({ code, name, kind: 'one_time', currency: 'THB', priceMinor }),
    });
    expect(res.status).toBe(201);
    return res.body.offering.id as string;
  };

  const adminA = await login(`admin-a-${RUN}@test.local`);
  // growth.compensation makes /compensation/me exist; growth.ranks lets the
  // members read the ladder whose threshold the payout rule is gated on;
  // commerce.enabled only exists so they can generate the orders the volume
  // metrics are derived from.
  atlasPlanId = await mkPlan(adminA, tenantA, 'atlas', 'Atlas Circle', [
    ENTITLEMENTS.COMPENSATION,
    ENTITLEMENTS.RANKS,
    ENTITLEMENTS.COMMERCE,
  ]);
  // same permissions, no compensation entitlement — the module must vanish
  slatePlanId = await mkPlan(adminA, tenantA, 'slate', 'Slate Circle', [ENTITLEMENTS.COMMERCE]);

  // NOTE: the tenant owner is given NO membership at all. Administration must
  // work without a plan, which is exactly why docs/26 §6 gates only the
  // member-facing earnings view on an entitlement.

  m.mara = await addMember(adminA, tenantA, atlasPlanId, `mara-${RUN}@test.local`, 'Mara');
  m.nils = await addMember(adminA, tenantA, atlasPlanId, `nils-${RUN}@test.local`, 'Nils');
  m.orla = await addMember(adminA, tenantA, atlasPlanId, `orla-${RUN}@test.local`, 'Orla');
  m.quinn = await addMember(adminA, tenantA, atlasPlanId, `quinn-${RUN}@test.local`, 'Quinn');
  m.pax = await addMember(adminA, tenantA, atlasPlanId, `pax-${RUN}@test.local`, 'Pax');
  m.remy = await addMember(adminA, tenantA, slatePlanId, `remy-${RUN}@test.local`, 'Remy');

  offering.anchor = await mkOffering(adminA, tenantA, 'anchor', 'Anchor pass', 120_000);
  offering.kit = await mkOffering(adminA, tenantA, 'kit', 'Field kit', 41_150);

  // Real money, integer minor units. Every tenant-A amount asserted below is
  // derived from exactly these five orders plus the edges built in the graph
  // suite — nothing else in this file moves a number.
  //   mara 120_000 · nils 41_150 · orla 41_150 · quinn 41_150 · pax 0
  await buy(`mara-${RUN}@test.local`, tenantA, adminA, offering.anchor);
  await buy(`nils-${RUN}@test.local`, tenantA, adminA, offering.kit);
  await buy(`orla-${RUN}@test.local`, tenantA, adminA, offering.kit);
  await buy(`quinn-${RUN}@test.local`, tenantA, adminA, offering.kit);

  const adminB = await login(`admin-b-${RUN}@test.local`);
  beaconPlanId = await mkPlan(adminB, tenantB, 'beacon', 'Beacon', [
    ENTITLEMENTS.COMPENSATION,
    ENTITLEMENTS.COMMERCE,
  ]);
  b.sena = await addMember(adminB, tenantB, beaconPlanId, `sena-${RUN}@test.local`, 'Sena');
  b.tao = await addMember(adminB, tenantB, beaconPlanId, `tao-${RUN}@test.local`, 'Tao');
  offering.major = await mkOffering(adminB, tenantB, 'major', 'Major seat', 80_000);
  offering.minor = await mkOffering(adminB, tenantB, 'minor', 'Minor seat', 30_000);
  //   sena 80_000 · tao 30_000 — and tenant B never places anybody under anybody
  await buy(`sena-${RUN}@test.local`, tenantB, adminB, offering.major);
  await buy(`tao-${RUN}@test.local`, tenantB, adminB, offering.minor);

  // Tenant C configures nothing at all: no plan, no rule, no placement, no run.
  const adminC = await login(`admin-c-${RUN}@test.local`);
  hushPlanId = await mkPlan(adminC, tenantC, 'hush', 'Hush', [ENTITLEMENTS.COMMERCE]);
  tess = await addMember(adminC, tenantC, hushPlanId, `tess-${RUN}@test.local`, 'Tess');
}, 300_000);

afterAll(async () => {
  await app?.close();
  await owner?.$disconnect();
});

describe('Two tenants, two plans, one engine (spec §42, docs/16 §4.3)', () => {
  it('tenant A configures a rank-gated percentage of downline volume and a fixed referral bonus', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const res = await api('/api/v1/compensation/plans', {
      method: 'POST',
      token: admin,
      tenant: tenantA,
      body: JSON.stringify({
        code: 'atlas-comp',
        name: 'Atlas compensation',
        currency: 'THB',
        rules: [
          {
            code: 'downline-share',
            name: 'Downline share',
            // a LABEL carried to reporting, never a code path (docs/26 §1)
            bonusType: 'rank',
            priority: 10,
            conditions: [
              {
                metric: PERSONAL_VOLUME,
                comparator: 'gte',
                threshold: 100_000,
                window: 'lifetime',
                graph: 'compensation',
              },
            ],
            payout: { kind: 'percent', percent: 3, basis: DOWNLINE_VOLUME },
          },
          {
            code: 'referral-bonus',
            name: 'Referral bonus',
            bonusType: 'referral',
            priority: 20,
            // graph: 'referral' is load-bearing — mara has THREE referral
            // directs but only TWO compensation directs, so an engine that
            // defaulted to the compensation graph fails this threshold
            conditions: [
              {
                metric: DIRECT_REFERRALS,
                comparator: 'gte',
                threshold: 3,
                window: 'lifetime',
                graph: 'referral',
              },
            ],
            payout: { kind: 'fixed', amountMinor: 50_000 },
          },
        ],
      }),
    });
    expect(res.status).toBe(201);
    planA = idOf(res.body, 'plan');

    const rules = rulesOf(res.body.plan ?? res.body);
    expect(rules).toHaveLength(2);
    ruleDownlineShare = rules.find((r: any) => r.code === 'downline-share').id;
    ruleReferralBonus = rules.find((r: any) => r.code === 'referral-bonus').id;
    expect(ruleDownlineShare).not.toBe(ruleReferralBonus);
  });

  it('tenant B configures a completely different shape — milestone plus a capped personal percentage', async () => {
    const admin = await login(`admin-b-${RUN}@test.local`);
    const res = await api('/api/v1/compensation/plans', {
      method: 'POST',
      token: admin,
      tenant: tenantB,
      body: JSON.stringify({
        code: 'beacon-comp',
        name: 'Beacon compensation',
        currency: 'THB',
        rules: [
          {
            code: 'milestone',
            name: 'Volume milestone',
            bonusType: 'milestone',
            priority: 10,
            conditions: [
              {
                metric: PERSONAL_VOLUME,
                comparator: 'gte',
                threshold: 60_000,
                window: 'lifetime',
                graph: 'compensation',
              },
            ],
            payout: { kind: 'fixed', amountMinor: 25_000 },
          },
          {
            code: 'personal-share',
            name: 'Personal share',
            bonusType: 'percentage',
            priority: 20,
            conditions: [
              {
                metric: PERSONAL_VOLUME,
                comparator: 'gte',
                threshold: 1,
                window: 'lifetime',
                graph: 'compensation',
              },
            ],
            payout: {
              kind: 'percent',
              percent: 12,
              basis: PERSONAL_VOLUME,
              capMinor: 9_000,
            },
          },
        ],
      }),
    });
    expect(res.status).toBe(201);
    planB = idOf(res.body, 'plan');

    const rules = rulesOf(res.body.plan ?? res.body);
    expect(rules).toHaveLength(2);
    ruleMilestone = rules.find((r: any) => r.code === 'milestone').id;
    rulePersonalShare = rules.find((r: any) => r.code === 'personal-share').id;
  });

  it('the two plans are visibly different data, and neither tenant sees the other', async () => {
    const adminA = await login(`admin-a-${RUN}@test.local`);
    const adminB = await login(`admin-b-${RUN}@test.local`);

    const listA = await api('/api/v1/compensation/plans', { token: adminA, tenant: tenantA });
    expect(listA.status).toBe(200);
    const atlas = plansOf(listA.body).find((p: any) => p.code === 'atlas-comp');
    expect(atlas).toBeTruthy();
    expect(atlas.currency).toBe('THB');
    // the rules are readable as rows — a tenant can audit its own plan without
    // reading anybody's source code
    const atlasRules = rulesOf(atlas);
    expect(atlasRules.map((r: any) => r.code).sort()).toEqual(
      ['downline-share', 'referral-bonus'].sort(),
    );
    const share = atlasRules.find((r: any) => r.code === 'downline-share');
    expect(share.payout.kind).toBe('percent');
    expect(share.payout.percent).toBe(3);
    expect(share.payout.basis).toBe(DOWNLINE_VOLUME);
    expect(share.payout.capMinor ?? null).toBeNull();
    expect(share.bonusType).toBe('rank');

    const listB = await api('/api/v1/compensation/plans', { token: adminB, tenant: tenantB });
    expect(listB.status).toBe(200);
    const beacon = plansOf(listB.body).find((p: any) => p.code === 'beacon-comp');
    const beaconRules = rulesOf(beacon);
    expect(beaconRules.map((r: any) => r.code).sort()).toEqual(
      ['milestone', 'personal-share'].sort(),
    );
    const capped = beaconRules.find((r: any) => r.code === 'personal-share');
    expect(capped.payout.kind).toBe('percent');
    expect(capped.payout.percent).toBe(12);
    expect(capped.payout.basis).toBe(PERSONAL_VOLUME);
    expect(capped.payout.capMinor).toBe(9_000);

    // nothing about one plan is reachable from the other tenant
    expect(plansOf(listA.body).map((p: any) => p.code)).not.toContain('beacon-comp');
    expect(plansOf(listB.body).map((p: any) => p.code)).not.toContain('atlas-comp');
  });
});

describe('Rule validation — a malformed rule is refused, not half-stored', () => {
  const bad = async (rule: Record<string, unknown>) => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const res = await api(`/api/v1/compensation/plans/${planA}/rules`, {
      method: 'POST',
      token: admin,
      tenant: tenantA,
      body: JSON.stringify(rule),
    });
    expect([400, 409, 422]).toContain(res.status);
    expect(['VALIDATION_FAILED', 'CONFLICT']).toContain(res.body.error.code);
    return res;
  };

  const okCondition = {
    metric: PERSONAL_VOLUME,
    comparator: 'gte',
    threshold: 1,
    window: 'lifetime',
    graph: 'compensation',
  };

  it('rejects a percent payout with no basis — round(? × 3 / 100) has no answer', async () => {
    const res = await bad({
      code: 'no-basis',
      name: 'Percent of nothing',
      bonusType: 'percentage',
      conditions: [okCondition],
      payout: { kind: 'percent', percent: 3 },
    });
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects a fixed payout with no amountMinor', async () => {
    const res = await bad({
      code: 'no-amount',
      name: 'Fixed nothing',
      bonusType: 'fixed_cash',
      conditions: [okCondition],
      payout: { kind: 'fixed' },
    });
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects an unknown metric', async () => {
    await bad({
      code: 'bad-metric',
      name: 'Vibes',
      bonusType: 'growth',
      conditions: [{ ...okCondition, metric: 'team_spirit' }],
      payout: { kind: 'fixed', amountMinor: 1_000 },
    });
  });

  it('rejects an unknown comparator', async () => {
    await bad({
      code: 'bad-comparator',
      name: 'Roughly',
      bonusType: 'growth',
      conditions: [{ ...okCondition, comparator: 'approximately' }],
      payout: { kind: 'fixed', amountMinor: 1_000 },
    });
  });

  it('rejects an unknown window', async () => {
    await bad({
      code: 'bad-window',
      name: 'Since forever-ish',
      bonusType: 'growth',
      conditions: [{ ...okCondition, window: 'rolling_7' }],
      payout: { kind: 'fixed', amountMinor: 1_000 },
    });
  });

  it('rejects an unknown graph — and `team` is the one that must never be accepted', async () => {
    // spec §17 keeps the team tree out of compensation. Accepting it here would
    // couple the two graphs through a JSON string.
    await bad({
      code: 'bad-graph',
      name: 'Paid down the org chart',
      bonusType: 'team',
      conditions: [{ ...okCondition, metric: DOWNLINE_VOLUME, graph: 'team' }],
      payout: { kind: 'percent', percent: 5, basis: DOWNLINE_VOLUME },
    });
  });

  it('and none of the refused rules landed in the plan', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const res = await api('/api/v1/compensation/plans', { token: admin, tenant: tenantA });
    const atlas = plansOf(res.body).find((p: any) => p.code === 'atlas-comp');
    expect(
      rulesOf(atlas)
        .map((r: any) => r.code)
        .sort(),
    ).toEqual(['downline-share', 'referral-bonus'].sort());
  });
});

describe('The compensation graph is the third graph (spec §17, docs/26 §2)', () => {
  it('builds three graphs whose shapes disagree with each other on purpose', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);

    // 1. referral graph — mara sponsors three people, orla sponsors pax
    const mkRef = async (referrer: string, referred: string) => {
      const res = await createReferral(admin, tenantA, referrer, referred);
      expect(res.status).toBe(201);
      return idOf(res.body, 'referral');
    };
    edge.maraNils = await mkRef(m.mara, m.nils);
    edge.maraOrla = await mkRef(m.mara, m.orla);
    edge.maraQuinn = await mkRef(m.mara, m.quinn);
    edge.orlaPax = await mkRef(m.orla, m.pax);

    // 2. compensation graph — quinn is REFERRED by mara but PAID UNDER nils,
    //    which docs/26 §2 calls the normal case and not an edge case
    const mkPlace = async (upline: string, downline: string) => {
      const res = await placeUnder(admin, tenantA, upline, downline);
      expect(res.status).toBe(201);
      return idOf(res.body, 'placement', 'relationship');
    };
    place.nils = await mkPlace(m.mara, m.nils);
    place.orla = await mkPlace(m.mara, m.orla);
    place.quinn = await mkPlace(m.nils, m.quinn);

    // 3. team graph — led by orla, who sponsors none of its members
    const mkTeam = async (code: string, name: string) => {
      const res = await api('/api/v1/teams', {
        method: 'POST',
        token: admin,
        tenant: tenantA,
        body: JSON.stringify({ code, name }),
      });
      expect(res.status).toBe(201);
      return res.body.team.id as string;
    };
    team.harbor = await mkTeam('harbor', 'Harbor');
    team.quay = await mkTeam('quay', 'Quay');

    const lead = await api(`/api/v1/teams/${team.harbor}/leaders`, {
      method: 'POST',
      token: admin,
      tenant: tenantA,
      body: JSON.stringify({ memberId: m.orla }),
    });
    expect(lead.status).toBe(201);
    for (const memberId of [m.quinn, m.pax]) {
      const join = await api(`/api/v1/teams/${team.harbor}/members`, {
        method: 'POST',
        token: admin,
        tenant: tenantA,
        body: JSON.stringify({ memberId }),
      });
      expect(join.status).toBe(201);
    }

    expect(await eventCount(tenantA, 'CompensationPlacementCreated', place.quinn)).toBe(1);
  });

  it('one member, three different answers, read through three modules', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const quinn = await login(`quinn-${RUN}@test.local`);

    // referral module: quinn was sponsored by mara
    expect(referrerIdOf(await referralsMe(quinn, tenantA))).toBe(m.mara);
    // compensation module: quinn is paid under nils
    expect(await activeUplineOf(admin, tenantA, m.quinn)).toBe(m.nils);
    // team module: quinn's team is led by orla
    expect(await teamMemberIds(admin, tenantA, team.harbor)).toContain(m.quinn);
    expect(await activeLeaderId(admin, tenantA, team.harbor)).toBe(m.orla);

    // and the three never meet
    expect(await activeUplineOf(admin, tenantA, m.quinn)).not.toBe(m.mara);
    expect(await activeUplineOf(admin, tenantA, m.quinn)).not.toBe(m.orla);
    expect(referrerIdOf(await referralsMe(quinn, tenantA))).not.toBe(m.nils);
  });

  it('changing the placement leaves the referral graph and the team graph untouched', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const quinn = await login(`quinn-${RUN}@test.local`);

    const teamBefore = (await teamMemberIds(admin, tenantA, team.harbor)).sort();
    const referrerBefore = referrerIdOf(await referralsMe(quinn, tenantA));

    // move quinn from nils's line to orla's line
    const ended = await endPlacement(admin, tenantA, place.quinn);
    expect([200, 204]).toContain(ended.status);
    const moved = await placeUnder(admin, tenantA, m.orla, m.quinn);
    expect(moved.status).toBe(201);
    place.quinnUnderOrla = idOf(moved.body, 'placement', 'relationship');

    // the compensation graph really did move …
    expect(await activeUplineOf(admin, tenantA, m.quinn)).toBe(m.orla);
    // … and nothing else did
    expect(referrerIdOf(await referralsMe(quinn, tenantA))).toBe(referrerBefore);
    expect(referrerIdOf(await referralsMe(quinn, tenantA))).toBe(m.mara);
    expect((await teamMemberIds(admin, tenantA, team.harbor)).sort()).toEqual(teamBefore);
    expect(await activeLeaderId(admin, tenantA, team.harbor)).toBe(m.orla);
  });

  it('ending a referral edge leaves the placement graph and the team graph untouched', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);

    const placementsBefore = (await placements(admin, tenantA))
      .filter((r) => !r.effectiveTo)
      .map((r) => `${uplineIdOf(r)}>${downlineIdOf(r)}`)
      .sort();
    const teamBefore = (await teamMemberIds(admin, tenantA, team.harbor)).sort();

    const ended = await api(`/api/v1/referrals/${edge.orlaPax}`, {
      method: 'DELETE',
      token: admin,
      tenant: tenantA,
    });
    expect([200, 204]).toContain(ended.status);

    const pax = await login(`pax-${RUN}@test.local`);
    expect(referrerIdOf(await referralsMe(pax, tenantA))).toBeNull();

    expect(
      (await placements(admin, tenantA))
        .filter((r) => !r.effectiveTo)
        .map((r) => `${uplineIdOf(r)}>${downlineIdOf(r)}`)
        .sort(),
    ).toEqual(placementsBefore);
    expect((await teamMemberIds(admin, tenantA, team.harbor)).sort()).toEqual(teamBefore);
  });

  it('moving a member between teams leaves the placement and the referral untouched', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const quinn = await login(`quinn-${RUN}@test.local`);

    const join = await api(`/api/v1/teams/${team.quay}/members`, {
      method: 'POST',
      token: admin,
      tenant: tenantA,
      body: JSON.stringify({ memberId: m.quinn }),
    });
    expect(join.status).toBe(201);
    expect(await teamMemberIds(admin, tenantA, team.quay)).toContain(m.quinn);

    expect(await activeUplineOf(admin, tenantA, m.quinn)).toBe(m.orla);
    expect(referrerIdOf(await referralsMe(quinn, tenantA))).toBe(m.mara);
  });

  it('and building a team or a referral never wrote a placement in the first place', async () => {
    // the inverse direction, asserted at the table: only the three explicit
    // POSTs above may have produced compensation rows
    const rows = await withTenant(tenantA, (tx) =>
      tx.compensationRelationship.findMany({ orderBy: { effectiveFrom: 'asc' } }),
    );
    expect(rows).toHaveLength(4); // nils, orla, quinn-under-nils (ended), quinn-under-orla
    expect(rows.filter((r) => r.effectiveTo === null)).toHaveLength(3);
    // pax is in a team and was sponsored by orla, and is paid under nobody
    expect(rows.some((r) => r.downlineMemberId === m.pax)).toBe(false);
  });
});

describe('Placement guards — the same line the referral graph holds', () => {
  it('rejects a self-placement', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const res = await placeUnder(admin, tenantA, m.pax, m.pax);
    expect([400, 409, 422]).toContain(res.status);
    expect(['VALIDATION_FAILED', 'CONFLICT']).toContain(res.body.error.code);
    expect(await activeUplineOf(admin, tenantA, m.pax)).toBeNull();
  });

  it('rejects a cycle, whether it closes in one hop or two', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    // mara ← orla exists, so placing mara under orla closes the loop directly
    const direct = await placeUnder(admin, tenantA, m.orla, m.mara);
    expect([400, 409, 422]).toContain(direct.status);
    expect(['VALIDATION_FAILED', 'CONFLICT']).toContain(direct.body.error.code);

    // mara ← orla ← quinn exists, so placing mara under quinn closes it two up
    const transitive = await placeUnder(admin, tenantA, m.quinn, m.mara);
    expect([400, 409, 422]).toContain(transitive.status);

    // mara is still paid under nobody — a rejected placement writes nothing
    expect(await activeUplineOf(admin, tenantA, m.mara)).toBeNull();
  });

  it('rejects a second active upline for a member who already has one', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    // nils is already paid under mara; orla may not also claim him
    const res = await placeUnder(admin, tenantA, m.orla, m.nils);
    expect([400, 409, 422]).toContain(res.status);
    expect(['VALIDATION_FAILED', 'CONFLICT']).toContain(res.body.error.code);
    expect(await activeUplineOf(admin, tenantA, m.nils)).toBe(m.mara);
  });

  it('ending a placement stamps effective_to and the row stays readable', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const created = await placeUnder(admin, tenantA, m.orla, m.pax);
    expect(created.status).toBe(201);
    place.pax = idOf(created.body, 'placement', 'relationship');
    expect(await activeUplineOf(admin, tenantA, m.pax)).toBe(m.orla);

    const ended = await endPlacement(admin, tenantA, place.pax);
    expect([200, 204]).toContain(ended.status);
    expect(await activeUplineOf(admin, tenantA, m.pax)).toBeNull();

    // history survives: closed, not deleted
    const row = await withTenant(tenantA, (tx) =>
      tx.compensationRelationship.findUnique({ where: { id: place.pax } }),
    );
    expect(row).toBeTruthy();
    expect(row!.effectiveTo).toBeTruthy();
    expect(row!.uplineMemberId).toBe(m.orla);
    expect(row!.downlineMemberId).toBe(m.pax);
    expect(new Date(row!.effectiveTo!).getTime()).toBeGreaterThanOrEqual(
      new Date(row!.effectiveFrom).getTime(),
    );

    // and it is still readable through the API when asked for
    const withEnded = await placements(admin, tenantA, { includeEnded: true });
    expect(withEnded.map((r) => r.id)).toContain(place.pax);
    expect((await placements(admin, tenantA)).map((r) => r.id)).not.toContain(place.pax);

    expect(await eventCount(tenantA, 'CompensationPlacementEnded', place.pax)).toBe(1);
  });

  it('a member cannot place themselves under anybody', async () => {
    const quinn = await login(`quinn-${RUN}@test.local`);
    const res = await placeUnder(quinn, tenantA, m.mara, m.pax);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});

describe('The gate and the rank say the same thing (docs/26 §3)', () => {
  /**
   * "A rank rule and a bonus rule that both say 'personal volume ≥ 50,000' must
   * compute the same number, or the plan is lying to somebody." So the ladder is
   * built with the SAME threshold the payout rule is gated on, and the rank the
   * engine awards is asserted to agree with who the run pays.
   */
  it('a bronze rank is defined on exactly the threshold the payout rule gates on', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const res = await api('/api/v1/ranks', {
      method: 'POST',
      token: admin,
      tenant: tenantA,
      body: JSON.stringify({
        code: 'bronze',
        name: 'Bronze',
        level: 10,
        qualifications: [
          { metric: PERSONAL_VOLUME, comparator: 'gte', threshold: 100_000, window: 'lifetime' },
        ],
      }),
    });
    expect(res.status).toBe(201);
    bronzeRankId = (res.body.rank ?? res.body).id;
  });

  it('mara holds it and nils does not — 120_000 clears 100_000, 41_150 does not', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const asOf = new Date().toISOString();
    for (const memberId of [m.mara, m.nils]) {
      const res = await api('/api/v1/ranks/evaluate', {
        method: 'POST',
        token: admin,
        tenant: tenantA,
        body: JSON.stringify({ memberId, asOf }),
      });
      expect([200, 201]).toContain(res.status);
    }

    const mara = await login(`mara-${RUN}@test.local`);
    const nils = await login(`nils-${RUN}@test.local`);
    expect(
      currentRankCode((await api('/api/v1/ranks/me', { token: mara, tenant: tenantA })).body),
    ).toBe('bronze');
    expect(
      currentRankCode((await api('/api/v1/ranks/me', { token: nils, tenant: tenantA })).body),
    ).toBeNull();
    expect(bronzeRankId).toBeTruthy();
  });
});

describe('Runs — a snapshot of a period', () => {
  it('computing a period produces exactly the entries the fixture arithmetic predicts', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const res = await createRun(admin, tenantA, planA, PERIOD_START, PERIOD_END);
    expect(res.status).toBe(201);
    const run = runOf(res.body);
    runA = run.id;
    expect(run.status).toBe('draft');
    expect(run.currency).toBe('THB');

    const entries = await runEntries(admin, tenantA, runA);
    // Only mara qualifies for anything:
    //   downline-share gate  personal_volume ≥ 100_000 → mara 120_000 ✓,
    //                        nils/orla/quinn 41_150 ✗
    //   referral-bonus gate  direct_referrals ≥ 3 on the REFERRAL graph →
    //                        mara sponsors nils, orla, quinn ✓; everyone else 0
    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((e) => e.memberId))).toEqual(new Set([m.mara]));

    // mara's compensation downline is nils + orla + quinn (quinn sits one level
    // further down, under orla), and pax — unplaced — is not in it:
    //   41_150 + 41_150 + 41_150 = 123_450
    //   123_450 × 3 / 100 = 3_703.5 → Math.round → 3_704
    const share = entryFor(entries, m.mara, ruleDownlineShare);
    expect(share.amountMinor).toBe(3_704);
    // rounding the three contributions separately would give
    //   3 × round(41_150 × 3 / 100) = 3 × 1_235 = 3_705 — one unit too much
    expect(share.amountMinor).not.toBe(3_705);
    expect(share.bonusType).toBe('rank');
    expect(share.currency).toBe('THB');

    const bonus = entryFor(entries, m.mara, ruleReferralBonus);
    expect(bonus.amountMinor).toBe(50_000);
    expect(bonus.bonusType).toBe('referral');

    // 3_704 + 50_000 = 53_704
    expect(runTotalMinor(run)).toBe(53_704);
    expect(await eventCount(tenantA, 'CommissionRunCreated', runA)).toBe(1);
  });

  it('every entry shows its working', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const entries = await runEntries(admin, tenantA, runA);

    const share = entryFor(entries, m.mara, ruleDownlineShare);
    expect(share.basis).toBeTruthy();
    const shareBasis = flatten(share.basis);
    // the basis the percentage was taken of, and the percentage itself
    expect(shareBasis.numbers).toContain(123_450);
    expect(shareBasis.numbers).toContain(3);
    // and the rule's own threshold, so the entry explains why it fired
    expect(shareBasis.numbers).toContain(100_000);
    expect(shareBasis.strings).toEqual(expect.arrayContaining([DOWNLINE_VOLUME, PERSONAL_VOLUME]));

    const bonus = entryFor(entries, m.mara, ruleReferralBonus);
    const bonusBasis = flatten(bonus.basis);
    expect(bonusBasis.strings).toContain(DIRECT_REFERRALS);
    expect(bonusBasis.numbers).toContain(3); // threshold met, and mara's count

    // every amount anywhere in the payload is a whole number of minor units
    for (const entry of entries) {
      for (const [key, value] of Object.entries(entry)) {
        if (/Minor$/.test(key)) {
          expect(typeof value, key).toBe('number');
          expect(Number.isInteger(value), key).toBe(true);
        }
      }
    }
  });

  it('asking for the same period twice returns the SAME run and doubles nothing', async () => {
    // The most important test in the file. `UNIQUE (tenant, plan, start, end)`
    // is the only thing between a retried request and a second payout.
    const admin = await login(`admin-a-${RUN}@test.local`);
    const before = await runEntries(admin, tenantA, runA);
    expect(before).toHaveLength(2);

    const again = await createRun(admin, tenantA, planA, PERIOD_START, PERIOD_END);
    expect([200, 201]).toContain(again.status);
    expect(runOf(again.body).id).toBe(runA);

    const third = await createRun(admin, tenantA, planA, PERIOD_START, PERIOD_END);
    expect([200, 201]).toContain(third.status);
    expect(runOf(third.body).id).toBe(runA);

    const after = await runEntries(admin, tenantA, runA);
    expect(after).toHaveLength(2);
    expect(after.map((e) => e.amountMinor).sort((x, y) => x - y)).toEqual([3_704, 50_000]);
    expect(runTotalMinor(runOf(third.body))).toBe(53_704);

    // one run row for that window, and one creation event — not two of either
    const rows = await withTenant(tenantA, (tx) =>
      tx.commissionRun.count({ where: { planId: planA } }),
    );
    expect(rows).toBe(1);
    expect(await eventCount(tenantA, 'CommissionRunCreated', runA)).toBe(1);

    const list = await api('/api/v1/compensation/runs', { token: admin, tenant: tenantA });
    expect(list.status).toBe(200);
    expect(runsOf(list.body).filter((r: any) => r.id === runA)).toHaveLength(1);
  });

  it('recomputing a draft over unchanged data reproduces the same entries', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const before = await runEntries(admin, tenantA, runA);

    const res = await api(`/api/v1/compensation/runs/${runA}/recompute`, {
      method: 'POST',
      token: admin,
      tenant: tenantA,
    });
    expect([200, 201]).toContain(res.status);

    const after = await runEntries(admin, tenantA, runA);
    expect(after).toHaveLength(before.length);
    expect(after.map((e) => `${e.memberId}:${e.ruleId}:${e.amountMinor}`).sort()).toEqual(
      before.map((e) => `${e.memberId}:${e.ruleId}:${e.amountMinor}`).sort(),
    );
    const list = await api('/api/v1/compensation/runs', { token: admin, tenant: tenantA });
    expect(runTotalMinor(runsOf(list.body).find((r: any) => r.id === runA))).toBe(53_704);
  });

  it('recomputing after the source data moves changes the entries', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    // orla buys a second field kit: 41_150 + 41_150 = 82_300
    const extra = await buy(`orla-${RUN}@test.local`, tenantA, admin, offering.kit);
    expect(extra.totalMinor).toBe(41_150);

    const res = await api(`/api/v1/compensation/runs/${runA}/recompute`, {
      method: 'POST',
      token: admin,
      tenant: tenantA,
    });
    expect([200, 201]).toContain(res.status);

    const entries = await runEntries(admin, tenantA, runA);
    expect(entries).toHaveLength(2);
    // mara's downline is now nils 41_150 + orla 82_300 + quinn 41_150 = 164_600
    //   164_600 × 3 / 100 = 4_938 exactly
    expect(entryFor(entries, m.mara, ruleDownlineShare).amountMinor).toBe(4_938);
    // the fixed bonus does not move, because nothing it depends on moved
    expect(entryFor(entries, m.mara, ruleReferralBonus).amountMinor).toBe(50_000);
    expect(flatten(entryFor(entries, m.mara, ruleDownlineShare).basis).numbers).toContain(164_600);

    // replaced in place, not appended: still one entry per (member, rule)
    const rows = await withTenant(tenantA, (tx) =>
      tx.commissionEntry.count({ where: { runId: runA } }),
    );
    expect(rows).toBe(2);
  });

  it('emits no CommissionEarned while the run is only a draft', async () => {
    // "a draft is a proposal, and nothing downstream should react to a
    // proposal" (docs/26 §4)
    expect(await eventCount(tenantA, 'CommissionEarned')).toBe(0);
    expect(await eventCount(tenantA, 'CommissionRunApproved', runA)).toBe(0);
  });

  it('a draft entry never reaches the member', async () => {
    const mara = await login(`mara-${RUN}@test.local`);
    const res = await api('/api/v1/compensation/me', { token: mara, tenant: tenantA });
    expect(res.status).toBe(200);
    expect(entriesOf(res.body)).toHaveLength(0);
  });

  it('approving freezes the run and emits CommissionEarned once per entry', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const res = await api(`/api/v1/compensation/runs/${runA}/approve`, {
      method: 'POST',
      token: admin,
      tenant: tenantA,
    });
    expect([200, 201]).toContain(res.status);
    expect(runOf(res.body).status).toBe('approved');

    // two entries → two events, and exactly one approval
    expect(await eventCount(tenantA, 'CommissionEarned')).toBe(2);
    expect(await eventCount(tenantA, 'CommissionRunApproved', runA)).toBe(1);

    const list = await api('/api/v1/compensation/runs', { token: admin, tenant: tenantA });
    const stored = runsOf(list.body).find((r: any) => r.id === runA);
    expect(stored.status).toBe('approved');
    // 4_938 + 50_000 = 54_938
    expect(runTotalMinor(stored)).toBe(54_938);
  });

  it('a recompute against an approved run is refused, and the entries do not move', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const before = await runEntries(admin, tenantA, runA);

    // the source data moves underneath it: orla buys a third field kit
    const extra = await buy(`orla-${RUN}@test.local`, tenantA, admin, offering.kit);
    expect(extra.totalMinor).toBe(41_150);

    const res = await api(`/api/v1/compensation/runs/${runA}/recompute`, {
      method: 'POST',
      token: admin,
      tenant: tenantA,
    });
    // "refused, not silently ignored" (docs/26 §4)
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');

    const after = await runEntries(admin, tenantA, runA);
    expect(after.map((e) => `${e.memberId}:${e.ruleId}:${e.amountMinor}`).sort()).toEqual(
      before.map((e) => `${e.memberId}:${e.ruleId}:${e.amountMinor}`).sort(),
    );
    expect(entryFor(after, m.mara, ruleDownlineShare).amountMinor).toBe(4_938);
    // and no second round of events came out of the refusal
    expect(await eventCount(tenantA, 'CommissionEarned')).toBe(2);
  });

  it('a later period computes fresh numbers and stays a draft', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const res = await createRun(admin, tenantA, planA, LATER_START, LATER_END);
    expect(res.status).toBe(201);
    runADraft = runOf(res.body).id;
    expect(runADraft).not.toBe(runA);
    expect(runOf(res.body).status).toBe('draft');

    const entries = await runEntries(admin, tenantA, runADraft);
    // orla has now bought three field kits: 3 × 41_150 = 123_450, so mara's
    // downline is 41_150 + 123_450 + 41_150 = 205_750
    //   205_750 × 3 / 100 = 6_172.5 → Math.round → 6_173
    expect(entryFor(entries, m.mara, ruleDownlineShare).amountMinor).toBe(6_173);
    expect(entryFor(entries, m.mara, ruleReferralBonus).amountMinor).toBe(50_000);

    // still nothing downstream: only the approved run ever emitted anything
    expect(await eventCount(tenantA, 'CommissionEarned')).toBe(2);
  });

  it('a percentage pays for the period, unless the plan says otherwise', async () => {
    // The default that matters most in this file. A percentage of LIFETIME
    // volume would pay for the same sales again in every period, for ever, so
    // the basis window defaults to the run's own period — and a plan that
    // really means all-time has to say so out loud.
    const admin = await login(`admin-a-${RUN}@test.local`);

    const lifetimeRule = await api(`/api/v1/compensation/plans/${planA}/rules`, {
      method: 'POST',
      token: admin,
      tenant: tenantA,
      body: JSON.stringify({
        code: `alltime-${RUN}`,
        name: 'All-time share',
        bonusType: 'team',
        conditions: [],
        payout: {
          kind: 'percent',
          percent: 3,
          basis: DOWNLINE_VOLUME,
          basisGraph: 'compensation',
          basisWindow: 'lifetime',
        },
      }),
    });
    expect(lifetimeRule.status).toBe(201);
    const lifetimeRuleId = idOf(lifetimeRule.body, 'rule');

    // a window that deliberately contains no sales at all
    const emptyStart = new Date(Date.now() + 40 * DAY).toISOString();
    const emptyEnd = new Date(Date.now() + 41 * DAY).toISOString();
    const run = await createRun(admin, tenantA, planA, emptyStart, emptyEnd);
    expect(run.status).toBe(201);
    const entries = await runEntries(admin, tenantA, runOf(run.body).id);

    // the period-scoped rule finds nothing to pay on …
    expect(entries.find((e: any) => e.ruleId === ruleDownlineShare)).toBeUndefined();
    // … while the rule that asked for all time still pays on all time
    expect(entryFor(entries, m.mara, lifetimeRuleId).amountMinor).toBe(6_173);
  });

  it('a member sees their own approved entries and never a draft or somebody else’s', async () => {
    const mara = await login(`mara-${RUN}@test.local`);
    const res = await api('/api/v1/compensation/me', { token: mara, tenant: tenantA });
    expect(res.status).toBe(200);
    const mine = entriesOf(res.body);

    // the approved run's two entries, and only those
    expect(mine).toHaveLength(2);
    expect(mine.map((e: any) => e.amountMinor).sort((x: number, y: number) => x - y)).toEqual([
      4_938, 50_000,
    ]);
    // 6_173 belongs to the draft run and must be nowhere in sight
    expect(mine.map((e: any) => e.amountMinor)).not.toContain(6_173);
    expect(mine.every((e: any) => e.memberId === m.mara || e.memberId === undefined)).toBe(true);
    // "with the numbers that produced each" — the working travels to the member
    expect(flatten(mine.find((e: any) => e.amountMinor === 4_938).basis).numbers).toContain(
      164_600,
    );

    // nils earned nothing, and does not get to look at what mara earned
    const nils = await login(`nils-${RUN}@test.local`);
    const theirs = await api('/api/v1/compensation/me', { token: nils, tenant: tenantA });
    expect(theirs.status).toBe(200);
    expect(entriesOf(theirs.body)).toHaveLength(0);

    // and a member cannot read the run's entry list either
    const admin2 = await api(`/api/v1/compensation/runs/${runA}/entries`, {
      token: nils,
      tenant: tenantA,
    });
    expect(admin2.status).toBe(403);
    expect(admin2.body.error.code).toBe('FORBIDDEN');
  });

  it('a member cannot create, recompute or approve a run', async () => {
    const mara = await login(`mara-${RUN}@test.local`);
    const created = await createRun(mara, tenantA, planA, PERIOD_START, PERIOD_END);
    expect(created.status).toBe(403);
    expect(created.body.error.code).toBe('FORBIDDEN');

    for (const action of ['recompute', 'approve']) {
      const res = await api(`/api/v1/compensation/runs/${runADraft}/${action}`, {
        method: 'POST',
        token: mara,
        tenant: tenantA,
      });
      expect(res.status).toBe(403);
    }

    // the draft is still a draft, and nothing was emitted
    const admin = await login(`admin-a-${RUN}@test.local`);
    const list = await api('/api/v1/compensation/runs', { token: admin, tenant: tenantA });
    expect(runsOf(list.body).find((r: any) => r.id === runADraft).status).toBe('draft');
    expect(await eventCount(tenantA, 'CommissionEarned')).toBe(2);
  });
});

describe('The same engine, a plan with a different shape (tenant B)', () => {
  it('computes a milestone bonus and a capped personal percentage', async () => {
    const admin = await login(`admin-b-${RUN}@test.local`);
    const res = await createRun(admin, tenantB, planB, PERIOD_START, PERIOD_END);
    expect(res.status).toBe(201);
    runB = runOf(res.body).id;

    const entries = await runEntries(admin, tenantB, runB);
    // sena, personal volume 80_000:
    //   milestone       80_000 ≥ 60_000 → fixed 25_000
    //   personal-share  80_000 × 12 / 100 = 9_600 → capped at 9_000
    // tao, personal volume 30_000:
    //   milestone       30_000 < 60_000 → no entry at all
    //   personal-share  30_000 × 12 / 100 = 3_600, under the cap → 3_600
    expect(entries).toHaveLength(3);
    expect(entryFor(entries, b.sena, ruleMilestone).amountMinor).toBe(25_000);
    expect(entryFor(entries, b.sena, rulePersonalShare).amountMinor).toBe(9_000);
    expect(entryFor(entries, b.tao, rulePersonalShare).amountMinor).toBe(3_600);
    expect(entries.find((e) => e.memberId === b.tao && e.ruleId === ruleMilestone)).toBeUndefined();

    // 25_000 + 9_000 + 3_600 = 37_600 — a different number, from a different
    // shape, out of the same engine as tenant A's 54_938
    expect(runTotalMinor(runOf(res.body))).toBe(37_600);
    expect(runTotalMinor(runOf(res.body))).not.toBe(54_938);
  });

  it('pays on a plan that has no placement graph at all', async () => {
    const admin = await login(`admin-b-${RUN}@test.local`);
    // tenant B never placed anybody under anybody, and still gets paid — the
    // graph is a rule's input, not a precondition of the module
    expect(await placements(admin, tenantB, { includeEnded: true })).toHaveLength(0);
    expect(await runEntries(admin, tenantB, runB)).toHaveLength(3);
  });

  it('the cap is a ceiling, not a rounding rule', async () => {
    const admin = await login(`admin-b-${RUN}@test.local`);
    const entries = await runEntries(admin, tenantB, runB);
    const capped = entryFor(entries, b.sena, rulePersonalShare);
    const uncapped = entryFor(entries, b.tao, rulePersonalShare);

    expect(capped.amountMinor).toBe(9_000); // would have been 9_600
    expect(capped.amountMinor).toBeLessThan(9_600);
    expect(uncapped.amountMinor).toBe(3_600); // nowhere near the cap, untouched
    expect(uncapped.amountMinor).toBeLessThan(9_000);

    // the entry still shows what it would have been, so the cap is auditable
    const basis = flatten(capped.basis);
    expect(basis.numbers).toContain(80_000);
    expect(basis.numbers).toContain(12);
    expect(basis.numbers).toContain(9_000);
  });

  it('approving tenant B emits its own three events and nobody else’s', async () => {
    const admin = await login(`admin-b-${RUN}@test.local`);
    const res = await api(`/api/v1/compensation/runs/${runB}/approve`, {
      method: 'POST',
      token: admin,
      tenant: tenantB,
    });
    expect([200, 201]).toContain(res.status);

    expect(await eventCount(tenantB, 'CommissionEarned')).toBe(3);
    expect(await eventCount(tenantB, 'CommissionRunApproved', runB)).toBe(1);
    // tenant A's ledger did not move
    expect(await eventCount(tenantA, 'CommissionEarned')).toBe(2);
  });

  it('each tenant B member sees exactly their own approved entries', async () => {
    const sena = await login(`sena-${RUN}@test.local`);
    const mine = entriesOf(
      (await api('/api/v1/compensation/me', { token: sena, tenant: tenantB })).body,
    );
    expect(mine.map((e: any) => e.amountMinor).sort((x: number, y: number) => x - y)).toEqual([
      9_000, 25_000,
    ]);

    const tao = await login(`tao-${RUN}@test.local`);
    const theirs = entriesOf(
      (await api('/api/v1/compensation/me', { token: tao, tenant: tenantB })).body,
    );
    expect(theirs.map((e: any) => e.amountMinor)).toEqual([3_600]);
    expect(theirs.map((e: any) => e.amountMinor)).not.toContain(25_000);
  });
});

describe('Money — integers in minor units, rounded exactly once', () => {
  it('every amount an entry list returns is a whole number of minor units', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const res = await api(`/api/v1/compensation/runs/${runA}/entries`, {
      token: admin,
      tenant: tenantA,
    });
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
    walk(res.body);

    expect(amounts.length).toBeGreaterThan(0);
    for (const [key, value] of amounts) {
      expect(typeof value, key).toBe('number');
      expect(Number.isInteger(value), key).toBe(true);
    }
  });

  it('a percentage of a summed basis rounds once, not once per contributor', async () => {
    // This is why the fixture price is 41_150 rather than a round number.
    // The first run's basis was three equal contributions of 41_150:
    //   rounded ONCE, correctly : round(123_450 × 3 / 100) = round(3_703.5) = 3_704
    //   rounded per contributor : 3 × round(41_150 × 3 / 100) = 3 × 1_235   = 3_705
    // The draft run's basis is nils 41_150 + orla 123_450 + quinn 41_150 =
    // 205_750, where the same trap reappears with a different shape:
    //   rounded ONCE, correctly : round(205_750 × 3 / 100) = round(6_172.5) = 6_173
    //   rounded per contributor : 1_235 + 3_704 + 1_235                     = 6_174
    const admin = await login(`admin-a-${RUN}@test.local`);
    const draft = await runEntries(admin, tenantA, runADraft);
    const amount = entryFor(draft, m.mara, ruleDownlineShare).amountMinor;
    expect(amount).toBe(6_173);
    expect(amount).not.toBe(6_174);
    expect(Number.isInteger(amount)).toBe(true);

    // and the frozen run still carries the exactly-divisible middle figure
    const approved = await runEntries(admin, tenantA, runA);
    expect(entryFor(approved, m.mara, ruleDownlineShare).amountMinor).toBe(4_938);

    // the summed basis is what the percentage was taken of — one number, one round
    const basis = flatten(entryFor(draft, m.mara, ruleDownlineShare).basis);
    expect(basis.numbers).toContain(205_750);
  });

  it('the run totals are the sum of their entries, to the unit', async () => {
    const adminA = await login(`admin-a-${RUN}@test.local`);
    const adminB = await login(`admin-b-${RUN}@test.local`);

    const listA = await api('/api/v1/compensation/runs', { token: adminA, tenant: tenantA });
    const storedA = runsOf(listA.body).find((r: any) => r.id === runA);
    const entriesA = await runEntries(adminA, tenantA, runA);
    expect(runTotalMinor(storedA)).toBe(entriesA.reduce((sum, e) => sum + e.amountMinor, 0));
    expect(storedA.currency).toMatch(/^[A-Z]{3}$/);

    const listB = await api('/api/v1/compensation/runs', { token: adminB, tenant: tenantB });
    const storedB = runsOf(listB.body).find((r: any) => r.id === runB);
    const entriesB = await runEntries(adminB, tenantB, runB);
    expect(runTotalMinor(storedB)).toBe(entriesB.reduce((sum, e) => sum + e.amountMinor, 0));
  });
});

describe('Isolation and gating — compensation is never shared and never assumed', () => {
  it("another tenant's administrator cannot read this tenant's plans, runs or entries", async () => {
    const adminB = await login(`admin-b-${RUN}@test.local`);

    const plans = await api('/api/v1/compensation/plans', { token: adminB, tenant: tenantA });
    expect([403, 404]).toContain(plans.status);
    expect(plans.status).not.toBe(200);

    const runs = await api('/api/v1/compensation/runs', { token: adminB, tenant: tenantA });
    expect([403, 404]).toContain(runs.status);

    const entries = await api(`/api/v1/compensation/runs/${runA}/entries`, {
      token: adminB,
      tenant: tenantA,
    });
    expect([403, 404]).toContain(entries.status);

    // and presenting their OWN tenant header does not surface a foreign run
    const own = await api(`/api/v1/compensation/runs/${runA}/entries`, {
      token: adminB,
      tenant: tenantB,
    });
    expect([403, 404]).toContain(own.status);

    const graph = await api('/api/v1/compensation/graph', { token: adminB, tenant: tenantA });
    expect([403, 404]).toContain(graph.status);
  });

  it("another tenant's member cannot read this tenant's earnings", async () => {
    const tao = await login(`tao-${RUN}@test.local`);
    const res = await api('/api/v1/compensation/me', { token: tao, tenant: tenantA });
    expect([403, 404]).toContain(res.status);
    expect(res.status).not.toBe(200);

    // and their own view still holds only their own 3_600
    const own = await api('/api/v1/compensation/me', { token: tao, tenant: tenantB });
    expect(own.status).toBe(200);
    expect(entriesOf(own.body).map((e: any) => e.amountMinor)).toEqual([3_600]);
  });

  it('a member without growth.compensation gets ENTITLEMENT_REQUIRED, not an empty list', async () => {
    const remy = await login(`remy-${RUN}@test.local`);
    // remy holds compensation.view exactly like mara; the PLAN is what decides
    // whether the module exists (docs/26 §6, docs/24 §2)
    const res = await api('/api/v1/compensation/me', { token: remy, tenant: tenantA });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ENTITLEMENT_REQUIRED');
    expect(slatePlanId).toBeTruthy();
  });

  it('a tenant that configured nothing has no plans, no runs, and no module for its members', async () => {
    const adminC = await login(`admin-c-${RUN}@test.local`);

    const plans = await api('/api/v1/compensation/plans', { token: adminC, tenant: tenantC });
    expect(plans.status).toBe(200);
    expect(plansOf(plans.body)).toHaveLength(0);

    const runs = await api('/api/v1/compensation/runs', { token: adminC, tenant: tenantC });
    expect(runs.status).toBe(200);
    expect(runsOf(runs.body)).toHaveLength(0);

    const graph = await api('/api/v1/compensation/graph', { token: adminC, tenant: tenantC });
    expect(graph.status).toBe(200);
    expect(placementsOf(graph.body)).toHaveLength(0);

    // "Nothing about the module appears for a tenant that never configured one"
    const tessToken = await login(`tess-${RUN}@test.local`);
    const me = await api('/api/v1/compensation/me', { token: tessToken, tenant: tenantC });
    expect(me.status).toBe(403);
    expect(me.body.error.code).toBe('ENTITLEMENT_REQUIRED');
    expect(tess).toBeTruthy();
    expect(hushPlanId).toBeTruthy();

    // and it cannot borrow another tenant's plan to run against
    const borrowed = await createRun(adminC, tenantC, planA, PERIOD_START, PERIOD_END);
    expect([400, 403, 404, 422]).toContain(borrowed.status);
    expect(borrowed.status).not.toBe(201);
    expect(
      runsOf((await api('/api/v1/compensation/runs', { token: adminC, tenant: tenantC })).body),
    ).toHaveLength(0);
  });

  it('the owner, who holds no plan at all, still administers compensation', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    // the premise: this tenant owner has no membership, therefore no entitlement
    const memberships = await withTenant(tenantA, (tx) =>
      tx.membership.count({ where: { memberId: ownerMemberA } }),
    );
    expect(memberships).toBe(0);

    // …and every administrative surface still answers
    expect(
      (await api('/api/v1/compensation/plans', { token: admin, tenant: tenantA })).status,
    ).toBe(200);
    expect((await api('/api/v1/compensation/runs', { token: admin, tenant: tenantA })).status).toBe(
      200,
    );
    expect(await runEntries(admin, tenantA, runA)).toHaveLength(2);

    const added = await api(`/api/v1/compensation/plans/${planA}/rules`, {
      method: 'POST',
      token: admin,
      tenant: tenantA,
      body: JSON.stringify({
        code: 'late-addition',
        name: 'Added by an owner with no plan',
        bonusType: 'fixed_cash',
        priority: 90,
        conditions: [
          {
            metric: PERSONAL_VOLUME,
            comparator: 'gte',
            threshold: 9_000_000,
            window: 'lifetime',
            graph: 'compensation',
          },
        ],
        payout: { kind: 'fixed', amountMinor: 1_000 },
      }),
    });
    expect(added.status).toBe(201);

    const placed = await placeUnder(admin, tenantA, m.nils, m.pax);
    expect(placed.status).toBe(201);
    expect(await activeUplineOf(admin, tenantA, m.pax)).toBe(m.nils);
  });
});
