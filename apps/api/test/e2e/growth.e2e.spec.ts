/**
 * Referral graph and the Rank engine (spec §17–§18, §44, docs/25).
 *
 * Spec §17 is marked mandatory and it is the reason this file exists:
 *
 *     Operational Team Tree must NOT equal Referral Tree.
 *
 * So the first thing asserted here is not a rank or an edge — it is that the
 * two graphs cannot see each other. A member is referred by one person and
 * placed under a leader who is nowhere in their referral line; then each graph
 * is moved and the OTHER one is read back through its own module's API. A
 * coupling bug is invisible until money depends on it, which is exactly one
 * sprint away.
 *
 * The other load-bearing promise is that `evaluate` is replayable. The same
 * `asOf` over the same source data must produce the same rank, one history row
 * and one event — otherwise a later commission run cannot be audited by
 * re-running it, and every duplicate is a duplicate payout.
 *
 * Metrics are never asserted as literals the engine could have been told: real
 * orders are paid through the commerce API and real edges are written through
 * the referral API, and the rank is asserted to FOLLOW from that data.
 *
 * NOTE: stop any locally running API — the outbox relay is cross-tenant.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import * as argon2 from 'argon2';
import { createOwnerClient, ensureAppRole, type PrismaClient } from '@aviora/db';
import { ENTITLEMENTS, PERMISSIONS } from '@aviora/shared';
import { createApp } from '../../src/app.factory';

const RUN = `g${Date.now().toString(36)}`;
const PLATFORM_EMAIL = `e2e-platform-${RUN}@test.local`;
const PW = 'e2e-password-123456';

const DAY = 86_400_000;

let app: INestApplication;
let base: string;
let owner: PrismaClient;

/** Tenant A runs growth. Tenant B runs its OWN ladder — which is how we prove
 *  that reading a ladder is not the same as reading THIS ladder. */
let tenantId: string;
let otherTenantId: string;
let ownerMemberId: string;

let orbitPlanId: string; // growth.ranks + commerce.enabled
let quillPlanId: string; // commerce only — no growth.ranks
let beaconPlanId: string; // tenant B

/**
 * Members of tenant A. The referral chain is vera → wren → yuki, with nell and
 * otto as vera's other two directs and zane hanging under nell. Hugo and Pia
 * are deliberately OUTSIDE the referral graph so they can lead teams without
 * any referral relationship explaining why.
 */
const m: Record<'vera' | 'wren' | 'yuki' | 'nell' | 'zane' | 'otto' | 'hugo' | 'pia', string> =
  {} as never;
/** Tenant B. */
const b: Record<'iris' | 'rafi', string> = {} as never;

const team: Record<'willow' | 'birch' | 'cedar', string> = {} as never;

const offering: Record<'canopy' | 'sapling' | 'grove', string> = {} as never;
let bOffering: string;

/** Referral edge ids, kept so they can be ended and read back. */
const edge: Record<
  'veraWren' | 'veraNell' | 'veraOtto' | 'wrenYuki' | 'nellZane' | 'ottoHugo' | 'nellOttoMentor',
  string
> = {} as never;

let bronzeRankId: string;
let silverRankId: string;

/** The instant Vera is first evaluated at — replayed verbatim for idempotency. */
let veraAsOf: string;

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

/** Growth tables FORCE row-level security, so even the owner sets the tenant. */
async function withTenant<T>(tenant: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
  return owner.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenant}, true)`;
    return fn(tx as unknown as PrismaClient);
  });
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

/**
 * Rank events name a member. The contract does not fix whether the member is
 * the aggregate or lives in the payload, so both are accepted — what is being
 * counted is "how many times was this member told", and that must be one.
 */
async function memberEventCount(
  tenant: string,
  eventName: string,
  memberId: string,
): Promise<number> {
  return owner.domainEvent.count({
    where: {
      tenantId: tenant,
      eventName,
      OR: [{ aggregateId: memberId }, { payload: { path: ['memberId'], equals: memberId } }],
    },
  });
}

/** A real, fully paid order — the only way personal_volume is allowed to move. */
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

function referralIdOf(body: any): string {
  const id = body?.referral?.id ?? body?.id;
  expect(typeof id).toBe('string');
  return id as string;
}

/** The contract names the payload of /referrals/me ("the caller's referrer and
 *  their direct referrals") without fixing the field names, so a small amount
 *  of shape tolerance is deliberate here — the ASSERTIONS are exact. */
function referrerIdOf(body: any): string | null {
  // `referrer` answers "who sponsored me" for the default type; an edge of
  // another type (affiliate, mentor) still counts as having a referrer, and
  // lives in `referrers`.
  const r = body?.referrer ?? body?.referredBy ?? body?.upline ?? body?.referrers?.[0] ?? null;
  if (!r) return null;
  if (typeof r === 'string') return r;
  return r.memberId ?? r.referrerMemberId ?? r.member?.id ?? null;
}

function memberIdsOf(rows: any): string[] {
  if (!Array.isArray(rows)) return [];
  return rows.map(
    (d: any) =>
      (typeof d === 'string' ? d : (d.memberId ?? d.referredMemberId ?? d.member?.id)) as string,
  );
}

function directIdsOf(body: any): string[] {
  return memberIdsOf(body?.directReferrals ?? body?.directs ?? body?.referrals ?? []);
}

function downlineIdsOf(body: any): string[] {
  return memberIdsOf(body?.downline ?? body?.members ?? body?.referrals ?? []);
}

async function referralsMe(token: string, tenant: string) {
  const res = await api('/api/v1/referrals/me', { token, tenant });
  expect(res.status).toBe(200);
  return res.body;
}

async function downline(
  token: string,
  tenant: string,
  opts: { depth?: number; type?: string } = {},
): Promise<string[]> {
  const q = new URLSearchParams();
  if (opts.depth !== undefined) {
    // the contract calls the argument maxDepth; the query name is not fixed
    q.set('depth', String(opts.depth));
    q.set('maxDepth', String(opts.depth));
  }
  if (opts.type) q.set('type', opts.type);
  const suffix = q.toString() ? `?${q}` : '';
  const res = await api(`/api/v1/referrals/downline${suffix}`, { token, tenant });
  expect(res.status).toBe(200);
  return downlineIdsOf(res.body);
}

async function createRank(
  adminToken: string,
  tenant: string,
  body: Record<string, unknown>,
): Promise<string> {
  const res = await api('/api/v1/ranks', {
    method: 'POST',
    token: adminToken,
    tenant,
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(201);
  const rank = res.body.rank ?? res.body;
  expect(rank.code).toBe(body['code']);
  expect(rank.level).toBe(body['level']);
  return rank.id as string;
}

async function evaluate(adminToken: string, tenant: string, memberId: string, asOf: string) {
  const res = await api('/api/v1/ranks/evaluate', {
    method: 'POST',
    token: adminToken,
    tenant,
    body: JSON.stringify({ memberId, asOf }),
  });
  expect([200, 201]).toContain(res.status);
  return res;
}

function currentRankCode(body: any): string | null {
  const rank = body?.rank ?? body?.currentRank ?? body?.current ?? null;
  if (!rank) return null;
  return typeof rank === 'string' ? rank : (rank.code ?? null);
}

function nextRankCode(body: any): string | null {
  const rank = body?.nextRank ?? body?.next ?? null;
  if (!rank) return null;
  return typeof rank === 'string' ? rank : (rank.code ?? null);
}

/**
 * "You need 2 more qualified legs" is the entire point of GET /ranks/me, so the
 * shape is read leniently and then the NUMBERS are asserted exactly.
 */
function unmetOf(body: any): Array<{ metric: string; threshold: number; current: number }> {
  const candidates = [
    body?.missing,
    body?.unmet,
    body?.requirements,
    body?.nextRank?.missing,
    body?.nextRank?.unmet,
    body?.nextRank?.requirements,
    body?.nextRank?.qualifications,
  ];
  const rows: any[] = candidates.find((c) => Array.isArray(c) && c.length > 0) ?? [];
  return rows
    .filter((r) => r.met !== true && r.passed !== true)
    .map((r) => ({
      metric: r.metric,
      threshold: r.threshold,
      current: r.currentValue ?? r.current ?? r.actual ?? r.value,
    }));
}

function unmetFor(body: any, metric: string) {
  const row = unmetOf(body).find((r) => r.metric === metric);
  expect(row, `no unmet requirement reported for ${metric}`).toBeTruthy();
  return row!;
}

async function rankHistory(tenant: string, memberId: string) {
  return withTenant(tenant, (tx) =>
    tx.rankHistory.findMany({ where: { memberId }, orderBy: { achievedAt: 'asc' } }),
  );
}

async function myTeamIds(token: string, tenant: string): Promise<string[]> {
  const res = await api('/api/v1/teams', { token, tenant });
  expect(res.status).toBe(200);
  return res.body.teams.map((t: { id: string }) => t.id);
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
        code: `e2e_gr_${suffix}_${RUN}`,
        name: `Growth ${suffix.toUpperCase()}`,
        slug: `e2e-gr-${suffix}-${RUN}`,
        adminEmail,
        adminDisplayName: 'Admin',
        adminPassword: PW,
      }),
    });
    expect(res.status).toBe(201);
    return res.body as { tenant: { id: string }; adminMemberId: string };
  };
  const a = await mkTenant('a', `admin-a-${RUN}@test.local`);
  const other = await mkTenant('b', `admin-b-${RUN}@test.local`);
  tenantId = a.tenant.id;
  ownerMemberId = a.adminMemberId;
  otherTenantId = other.tenant.id;

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

  // growth.ranks is what makes the member-facing views visible; commerce.enabled
  // is only here so members can generate the orders the metrics are derived from
  orbitPlanId = await mkPlan(adminA, tenantId, 'orbit', 'Orbit Circle', [
    ENTITLEMENTS.RANKS,
    ENTITLEMENTS.COMMERCE,
  ]);
  // a tenant that does not run ranks: same permissions, no entitlement
  quillPlanId = await mkPlan(adminA, tenantId, 'quill', 'Quill Circle', [ENTITLEMENTS.COMMERCE]);

  // NOTE: the tenant owner is given NO membership at all — administration must
  // work without a plan, which is the whole reason entitlements gate only the
  // member-facing views (docs/25 §4, docs/24 §2).

  m.vera = await addMember(adminA, tenantId, orbitPlanId, `vera-${RUN}@test.local`, 'Vera');
  m.wren = await addMember(adminA, tenantId, orbitPlanId, `wren-${RUN}@test.local`, 'Wren');
  m.yuki = await addMember(adminA, tenantId, orbitPlanId, `yuki-${RUN}@test.local`, 'Yuki');
  m.nell = await addMember(adminA, tenantId, orbitPlanId, `nell-${RUN}@test.local`, 'Nell');
  m.zane = await addMember(adminA, tenantId, orbitPlanId, `zane-${RUN}@test.local`, 'Zane');
  m.otto = await addMember(adminA, tenantId, orbitPlanId, `otto-${RUN}@test.local`, 'Otto');
  m.hugo = await addMember(adminA, tenantId, orbitPlanId, `hugo-${RUN}@test.local`, 'Hugo');
  m.pia = await addMember(adminA, tenantId, quillPlanId, `pia-${RUN}@test.local`, 'Pia');

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
  offering.canopy = await mkOffering(adminA, tenantId, 'canopy', 'Canopy pass', 200_000);
  offering.sapling = await mkOffering(adminA, tenantId, 'sapling', 'Sapling pass', 60_000);
  offering.grove = await mkOffering(adminA, tenantId, 'grove', 'Grove pass', 30_000);

  // Real money, in integer minor units. Every rank asserted below is derived
  // from exactly these rows plus the referral edges built in the first suite.
  //   vera 200_000 · wren 60_000 · yuki 60_000 · nell 60_000 · zane 60_000
  //   otto 0 (so otto is never a qualified leg, under any reading of "leg")
  await buy(`vera-${RUN}@test.local`, tenantId, adminA, offering.canopy);
  await buy(`wren-${RUN}@test.local`, tenantId, adminA, offering.sapling);
  await buy(`yuki-${RUN}@test.local`, tenantId, adminA, offering.sapling);
  await buy(`nell-${RUN}@test.local`, tenantId, adminA, offering.sapling);
  await buy(`zane-${RUN}@test.local`, tenantId, adminA, offering.sapling);

  const adminB = await login(`admin-b-${RUN}@test.local`);
  beaconPlanId = await mkPlan(adminB, otherTenantId, 'beacon', 'Beacon', [
    ENTITLEMENTS.RANKS,
    ENTITLEMENTS.COMMERCE,
  ]);
  b.iris = await addMember(adminB, otherTenantId, beaconPlanId, `iris-${RUN}@test.local`, 'Iris');
  b.rafi = await addMember(adminB, otherTenantId, beaconPlanId, `rafi-${RUN}@test.local`, 'Rafi');
  bOffering = await mkOffering(adminB, otherTenantId, 'lantern', 'Lantern pass', 30_000);
}, 300_000);

afterAll(async () => {
  await app?.close();
  await owner?.$disconnect();
});

describe('Two graphs, built side by side', () => {
  it('builds a referral chain three levels deep with two extra legs', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const mk = async (referrer: string, referred: string) => {
      const res = await createReferral(admin, tenantId, referrer, referred);
      expect(res.status).toBe(201);
      return referralIdOf(res.body);
    };
    // vera → wren → yuki, plus vera → nell → zane and the barren leg vera → otto
    edge.veraWren = await mk(m.vera, m.wren);
    edge.wrenYuki = await mk(m.wren, m.yuki);
    edge.veraNell = await mk(m.vera, m.nell);
    edge.nellZane = await mk(m.nell, m.zane);
    edge.veraOtto = await mk(m.vera, m.otto);

    // hugo is referred by otto on a DIFFERENT relationship type; hugo leads a
    // team, and this edge exists only to be ended underneath that leadership
    const affiliate = await createReferral(admin, tenantId, m.otto, m.hugo, 'affiliate');
    expect(affiliate.status).toBe(201);
    edge.ottoHugo = referralIdOf(affiliate.body);
  });

  it('builds teams whose leaders are nowhere in anybody’s referral line', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const mkTeam = async (code: string, name: string, parentTeamId?: string) => {
      const res = await api('/api/v1/teams', {
        method: 'POST',
        token: admin,
        tenant: tenantId,
        body: JSON.stringify({ code, name, ...(parentTeamId ? { parentTeamId } : {}) }),
      });
      expect(res.status).toBe(201);
      return res.body.team.id as string;
    };
    team.willow = await mkTeam('willow', 'Willow');
    team.birch = await mkTeam('birch', 'Birch');
    team.cedar = await mkTeam('cedar', 'Cedar', team.willow);

    const lead = async (teamId: string, memberId: string) => {
      const res = await api(`/api/v1/teams/${teamId}/leaders`, {
        method: 'POST',
        token: admin,
        tenant: tenantId,
        body: JSON.stringify({ memberId }),
      });
      expect(res.status).toBe(201);
    };
    // Hugo and Pia are NOT vera's, wren's or yuki's referrers — the team graph
    // gets its shape from somewhere else entirely, which is the point
    await lead(team.willow, m.hugo);
    await lead(team.birch, m.pia);

    const join = async (teamId: string, memberId: string) => {
      const res = await api(`/api/v1/teams/${teamId}/members`, {
        method: 'POST',
        token: admin,
        tenant: tenantId,
        body: JSON.stringify({ memberId }),
      });
      expect(res.status).toBe(201);
    };
    await join(team.willow, m.hugo);
    await join(team.cedar, m.wren);
  });
});

describe('Graph independence — the referral tree is not the team tree (spec §17)', () => {
  it('a member referred by one person sits in a team led by someone else entirely', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const wren = await login(`wren-${RUN}@test.local`);

    // read through the REFERRAL module: wren's referrer is vera
    const me = await referralsMe(wren, tenantId);
    expect(referrerIdOf(me)).toBe(m.vera);

    // read through the TEAM module: wren is in cedar, whose tree is led by hugo
    expect(await teamMemberIds(admin, tenantId, team.cedar)).toContain(m.wren);
    expect(await activeLeaderId(admin, tenantId, team.willow)).toBe(m.hugo);

    // and the two never meet: vera leads nothing wren is in and is in no team
    // with wren; hugo is not wren's referrer and not in wren's downline
    expect(await activeLeaderId(admin, tenantId, team.cedar)).toBeNull();
    expect(await teamMemberIds(admin, tenantId, team.cedar)).not.toContain(m.vera);
    expect(await teamMemberIds(admin, tenantId, team.willow)).not.toContain(m.vera);
    expect(referrerIdOf(me)).not.toBe(m.hugo);
    expect(await downline(wren, tenantId)).not.toContain(m.hugo);
  });

  it('moving a member between teams leaves their referrer and downline untouched', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const wren = await login(`wren-${RUN}@test.local`);
    const vera = await login(`vera-${RUN}@test.local`);

    const before = await referralsMe(wren, tenantId);
    expect(referrerIdOf(before)).toBe(m.vera);
    expect(directIdsOf(before)).toEqual([m.yuki]);
    expect(await downline(vera, tenantId)).toEqual(
      expect.arrayContaining([m.wren, m.yuki, m.nell, m.zane, m.otto]),
    );

    // place wren under a completely different leader's team
    const moved = await api(`/api/v1/teams/${team.birch}/members`, {
      method: 'POST',
      token: admin,
      tenant: tenantId,
      body: JSON.stringify({ memberId: m.wren }),
    });
    expect(moved.status).toBe(201);
    expect(await teamMemberIds(admin, tenantId, team.birch)).toContain(m.wren);

    // …and NOTHING in the referral graph moved with them
    const after = await referralsMe(wren, tenantId);
    expect(referrerIdOf(after)).toBe(m.vera);
    expect(directIdsOf(after)).toEqual([m.yuki]);
    expect(await downline(vera, tenantId)).toEqual(
      expect.arrayContaining([m.wren, m.yuki, m.nell, m.zane, m.otto]),
    );
    // the new leader did not become anybody's referrer
    expect(referrerIdOf(after)).not.toBe(m.pia);
    expect(await downline(vera, tenantId)).not.toContain(m.pia);
  });

  it('moving a whole team subtree still leaves the referral graph untouched', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const wren = await login(`wren-${RUN}@test.local`);
    const vera = await login(`vera-${RUN}@test.local`);

    const res = await api(`/api/v1/teams/${team.cedar}/move`, {
      method: 'PATCH',
      token: admin,
      tenant: tenantId,
      body: JSON.stringify({ newParentId: team.birch }),
    });
    expect(res.status).toBe(200);

    // the team graph really did change: cedar now descends from birch
    const desc = await api(`/api/v1/teams/${team.birch}/descendants`, {
      token: admin,
      tenant: tenantId,
    });
    expect(desc.body.teams.map((t: { id: string }) => t.id)).toContain(team.cedar);

    // the referral graph did not
    const after = await referralsMe(wren, tenantId);
    expect(referrerIdOf(after)).toBe(m.vera);
    expect(directIdsOf(after)).toEqual([m.yuki]);
    expect(await downline(vera, tenantId, { depth: 3 })).toEqual(
      expect.arrayContaining([m.wren, m.yuki, m.nell, m.zane, m.otto]),
    );
  });

  it('ending a referral edge leaves team membership and leadership untouched', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const hugo = await login(`hugo-${RUN}@test.local`);

    const teamsBefore = (await myTeamIds(hugo, tenantId)).sort();
    const membersBefore = (await teamMemberIds(admin, tenantId, team.willow)).sort();
    expect(membersBefore).toContain(m.hugo);
    expect(await activeLeaderId(admin, tenantId, team.willow)).toBe(m.hugo);
    expect(referrerIdOf(await referralsMe(hugo, tenantId))).toBe(m.otto);

    const ended = await api(`/api/v1/referrals/${edge.ottoHugo}`, {
      method: 'DELETE',
      token: admin,
      tenant: tenantId,
    });
    expect([200, 204]).toContain(ended.status);

    // the referral side changed…
    expect(referrerIdOf(await referralsMe(hugo, tenantId))).toBeNull();
    // …and the team side did not, read back through the team module
    expect((await myTeamIds(hugo, tenantId)).sort()).toEqual(teamsBefore);
    expect((await teamMemberIds(admin, tenantId, team.willow)).sort()).toEqual(membersBefore);
    expect(await activeLeaderId(admin, tenantId, team.willow)).toBe(m.hugo);
  });

  it('and joining a team never wrote a referral edge in the first place', async () => {
    // the inverse direction, asserted at the table: nothing in the team suite
    // above may have created an edge between a leader and their team member
    const rows = await withTenant(tenantId, (tx) =>
      tx.referralRelationship.findMany({
        where: { OR: [{ referrerMemberId: m.hugo }, { referrerMemberId: m.pia }] },
      }),
    );
    expect(rows).toHaveLength(0);
  });
});

describe('Referral edges — one active sponsor per type, history kept', () => {
  it('emits ReferralCreated exactly once per edge', async () => {
    expect(await eventCount(tenantId, 'ReferralCreated', edge.veraWren)).toBe(1);
    expect(await eventCount(tenantId, 'ReferralCreated', edge.wrenYuki)).toBe(1);
  });

  it('rejects a second active edge of the same type for the same member', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const res = await createReferral(admin, tenantId, m.nell, m.wren);
    expect([400, 409, 422]).toContain(res.status);
    expect(['VALIDATION_FAILED', 'CONFLICT']).toContain(res.body.error.code);

    // and the original sponsor is untouched by the rejected write
    const wren = await login(`wren-${RUN}@test.local`);
    expect(referrerIdOf(await referralsMe(wren, tenantId))).toBe(m.vera);
  });

  it('allows a different relationship type alongside it', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    // otto already has vera as a 'referral' sponsor; a mentor_referral is a
    // different relationship and coexists with it
    const res = await createReferral(admin, tenantId, m.nell, m.otto, 'mentor_referral');
    expect(res.status).toBe(201);
    edge.nellOttoMentor = referralIdOf(res.body);

    const otto = await login(`otto-${RUN}@test.local`);
    const nell = await login(`nell-${RUN}@test.local`);
    // the 'referral' graph still says vera…
    expect(referrerIdOf(await referralsMe(otto, tenantId))).toBe(m.vera);
    // …while the mentor graph says nell
    expect(await downline(nell, tenantId, { type: 'mentor_referral' })).toContain(m.otto);
  });

  it('rejects a self-reference', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const res = await createReferral(admin, tenantId, m.vera, m.vera);
    expect([400, 409, 422]).toContain(res.status);
    expect(['VALIDATION_FAILED', 'CONFLICT']).toContain(res.body.error.code);
  });

  it('rejects a cycle, whether it closes in one hop or three', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    // vera → wren exists, so wren → vera would close the loop
    const direct = await createReferral(admin, tenantId, m.wren, m.vera);
    expect([400, 409, 422]).toContain(direct.status);
    expect(['VALIDATION_FAILED', 'CONFLICT']).toContain(direct.body.error.code);

    // vera → wren → yuki exists, so yuki → vera closes it two levels up
    const transitive = await createReferral(admin, tenantId, m.yuki, m.vera);
    expect([400, 409, 422]).toContain(transitive.status);

    // vera still has no referrer — a rejected cycle writes nothing
    const vera = await login(`vera-${RUN}@test.local`);
    expect(referrerIdOf(await referralsMe(vera, tenantId))).toBeNull();
  });

  it('ending an edge stamps effective_to, keeps the row readable, and emits ReferralEnded', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const res = await api(`/api/v1/referrals/${edge.nellOttoMentor}`, {
      method: 'DELETE',
      token: admin,
      tenant: tenantId,
    });
    expect([200, 204]).toContain(res.status);

    const row = await withTenant(tenantId, (tx) =>
      tx.referralRelationship.findUnique({ where: { id: edge.nellOttoMentor } }),
    );
    // history survives: the row is still there, closed rather than deleted
    expect(row).toBeTruthy();
    expect(row!.effectiveTo).toBeTruthy();
    expect(row!.referrerMemberId).toBe(m.nell);
    expect(row!.referredMemberId).toBe(m.otto);
    expect(row!.relationshipType).toBe('mentor_referral');
    expect(new Date(row!.effectiveTo!).getTime()).toBeGreaterThanOrEqual(
      new Date(row!.effectiveFrom).getTime(),
    );

    expect(await eventCount(tenantId, 'ReferralEnded', edge.nellOttoMentor)).toBe(1);
  });

  it('an ended edge disappears from the downline', async () => {
    const nell = await login(`nell-${RUN}@test.local`);
    expect(await downline(nell, tenantId, { type: 'mentor_referral' })).not.toContain(m.otto);
    // …while the untouched 'referral' edge under nell is still there
    expect(await downline(nell, tenantId)).toContain(m.zane);
  });
});

describe('Traversal — three levels, depth-capped', () => {
  it('walks the upline one referrer at a time to the top', async () => {
    const yuki = await login(`yuki-${RUN}@test.local`);
    const wren = await login(`wren-${RUN}@test.local`);
    const vera = await login(`vera-${RUN}@test.local`);

    expect(referrerIdOf(await referralsMe(yuki, tenantId))).toBe(m.wren);
    expect(referrerIdOf(await referralsMe(wren, tenantId))).toBe(m.vera);
    expect(referrerIdOf(await referralsMe(vera, tenantId))).toBeNull();
  });

  it('returns the whole downline of the root', async () => {
    const vera = await login(`vera-${RUN}@test.local`);
    const ids = await downline(vera, tenantId, { depth: 5 });
    expect(ids).toEqual(expect.arrayContaining([m.wren, m.nell, m.otto, m.yuki, m.zane]));
    // the root is not its own descendant, and nobody outside the graph appears
    expect(ids).not.toContain(m.vera);
    expect(ids).not.toContain(m.hugo);
    expect(ids).not.toContain(m.pia);
  });

  it('honours the depth cap', async () => {
    const vera = await login(`vera-${RUN}@test.local`);
    const oneDeep = await downline(vera, tenantId, { depth: 1 });
    expect(oneDeep.sort()).toEqual([m.wren, m.nell, m.otto].sort());
    expect(oneDeep).not.toContain(m.yuki);
    expect(oneDeep).not.toContain(m.zane);

    const twoDeep = await downline(vera, tenantId, { depth: 2 });
    expect(twoDeep).toEqual(expect.arrayContaining([m.yuki, m.zane]));
    expect(twoDeep).toHaveLength(5);
  });

  it('a leaf has an empty downline', async () => {
    const yuki = await login(`yuki-${RUN}@test.local`);
    expect(await downline(yuki, tenantId, { depth: 5 })).toHaveLength(0);
    expect(directIdsOf(await referralsMe(yuki, tenantId))).toHaveLength(0);
  });
});

describe('Rank ladder — the rules are rows, not code', () => {
  it('an admin creates bronze and silver with their qualification rows', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    bronzeRankId = await createRank(admin, tenantId, {
      code: 'bronze',
      name: 'Bronze',
      level: 10,
      qualifications: [
        { metric: 'personal_volume', comparator: 'gte', threshold: 50_000, window: 'lifetime' },
        { metric: 'direct_referrals', comparator: 'gte', threshold: 1, window: 'lifetime' },
      ],
    });
    silverRankId = await createRank(admin, tenantId, {
      code: 'silver',
      name: 'Silver',
      level: 20,
      qualifications: [
        { metric: 'personal_volume', comparator: 'gte', threshold: 150_000, window: 'lifetime' },
        { metric: 'direct_referrals', comparator: 'gte', threshold: 3, window: 'lifetime' },
        {
          metric: 'qualified_legs',
          comparator: 'gte',
          threshold: 2,
          window: 'lifetime',
          params: { legVolumeMinor: 50_000 },
        },
      ],
    });
    expect(bronzeRankId).not.toBe(silverRankId);
  });

  it('a member sees the ladder', async () => {
    const wren = await login(`wren-${RUN}@test.local`);
    const res = await api('/api/v1/ranks', { token: wren, tenant: tenantId });
    expect(res.status).toBe(200);
    const ranks = res.body.ranks;
    const codes = ranks.map((r: { code: string }) => r.code);
    expect(codes).toEqual(expect.arrayContaining(['bronze', 'silver']));

    const silver = ranks.find((r: { code: string }) => r.code === 'silver');
    expect(silver.level).toBe(20);
    // the rules are visible as data — a member can see what they must do
    const metrics = (silver.qualifications ?? []).map((q: { metric: string }) => q.metric);
    expect(metrics).toEqual(
      expect.arrayContaining(['personal_volume', 'direct_referrals', 'qualified_legs']),
    );
  });

  it('a member cannot create a rank', async () => {
    const wren = await login(`wren-${RUN}@test.local`);
    const res = await api('/api/v1/ranks', {
      method: 'POST',
      token: wren,
      tenant: tenantId,
      body: JSON.stringify({
        code: 'platinum',
        name: 'Self-awarded Platinum',
        level: 99,
        qualifications: [
          { metric: 'personal_volume', comparator: 'gte', threshold: 0, window: 'lifetime' },
        ],
      }),
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');

    // …and it did not land in the ladder anyway
    const list = await api('/api/v1/ranks', { token: wren, tenant: tenantId });
    expect(list.body.ranks.map((r: { code: string }) => r.code)).not.toContain('platinum');
  });
});

describe('Rank evaluation — the highest level whose rules all pass', () => {
  it('a member who meets nothing has no rank', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    // otto bought nothing and refers nobody, so neither rank can pass
    await evaluate(admin, tenantId, m.otto, new Date().toISOString());

    const otto = await login(`otto-${RUN}@test.local`);
    const me = await api('/api/v1/ranks/me', { token: otto, tenant: tenantId });
    expect(me.status).toBe(200);
    expect(currentRankCode(me.body)).toBeNull();
    // nothing achieved means nothing to record
    expect(await rankHistory(tenantId, m.otto)).toHaveLength(0);
    expect(await memberEventCount(tenantId, 'RankAchieved', m.otto)).toBe(0);
  });

  it('meeting the bronze rules yields bronze', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    // wren: 60_000 paid (≥ 50_000) and one direct referral (yuki) — bronze only
    await evaluate(admin, tenantId, m.wren, new Date().toISOString());

    const wren = await login(`wren-${RUN}@test.local`);
    const me = await api('/api/v1/ranks/me', { token: wren, tenant: tenantId });
    expect(me.status).toBe(200);
    expect(currentRankCode(me.body)).toBe('bronze');

    const rows = await rankHistory(tenantId, m.wren);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.rankId).toBe(bronzeRankId);
    expect(rows[0]!.reason).toBe('achieved');
    expect(rows[0]!.lostAt).toBeNull();
    expect(await memberEventCount(tenantId, 'RankAchieved', m.wren)).toBe(1);
  });

  it('meeting silver’s rules too yields silver, not bronze', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    // vera: 200_000 paid (≥ 150_000), three directs (wren, nell, otto), and two
    // qualified legs — wren's leg carries yuki's 60_000 and nell's carries
    // zane's 60_000, while otto's leg is empty. Both bronze AND silver pass;
    // the HIGHEST level is the answer.
    veraAsOf = new Date().toISOString();
    await evaluate(admin, tenantId, m.vera, veraAsOf);

    const vera = await login(`vera-${RUN}@test.local`);
    const me = await api('/api/v1/ranks/me', { token: vera, tenant: tenantId });
    expect(me.status).toBe(200);
    expect(currentRankCode(me.body)).toBe('silver');
    expect(currentRankCode(me.body)).not.toBe('bronze');

    const rows = await rankHistory(tenantId, m.vera);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.rankId).toBe(silverRankId);
    expect(rows[0]!.reason).toBe('achieved');
    expect(await memberEventCount(tenantId, 'RankAchieved', m.vera)).toBe(1);

    // the snapshot that justified it is kept, so a commission run can show
    // its working rather than recompute and hope
    const progress = await withTenant(tenantId, (tx) =>
      tx.rankProgress.findFirst({ where: { memberId: m.vera } }),
    );
    expect(progress?.rankId).toBe(silverRankId);
    expect(progress?.metrics).toBeTruthy();
  });

  it('evaluating twice with the same asOf writes no second history row and emits no second event', async () => {
    // The most important assertion in the file. A replayed evaluation is what
    // makes a commission run auditable; a second history row is a second payout.
    const admin = await login(`admin-a-${RUN}@test.local`);
    const historyBefore = await rankHistory(tenantId, m.vera);
    const achievedBefore = await memberEventCount(tenantId, 'RankAchieved', m.vera);
    expect(historyBefore).toHaveLength(1);
    expect(achievedBefore).toBe(1);

    await evaluate(admin, tenantId, m.vera, veraAsOf);
    await evaluate(admin, tenantId, m.vera, veraAsOf);

    const historyAfter = await rankHistory(tenantId, m.vera);
    expect(historyAfter).toHaveLength(1);
    expect(historyAfter[0]!.id).toBe(historyBefore[0]!.id);
    expect(historyAfter[0]!.rankId).toBe(silverRankId);
    expect(historyAfter[0]!.lostAt).toBeNull();
    expect(await memberEventCount(tenantId, 'RankAchieved', m.vera)).toBe(achievedBefore);
    expect(await memberEventCount(tenantId, 'RankLost', m.vera)).toBe(0);

    // and the answer itself is reproducible, not merely quiet
    const vera = await login(`vera-${RUN}@test.local`);
    const me = await api('/api/v1/ranks/me', { token: vera, tenant: tenantId });
    expect(currentRankCode(me.body)).toBe('silver');
  });

  it('names each unmet requirement with the member’s value and the threshold', async () => {
    // "You need 2 more qualified legs" is the only form of this that is any use
    const wren = await login(`wren-${RUN}@test.local`);
    const me = await api('/api/v1/ranks/me', { token: wren, tenant: tenantId });
    expect(me.status).toBe(200);
    expect(currentRankCode(me.body)).toBe('bronze');
    expect(nextRankCode(me.body)).toBe('silver');

    const volume = unmetFor(me.body, 'personal_volume');
    expect(volume.threshold).toBe(150_000);
    expect(volume.current).toBe(60_000); // wren paid exactly one 60_000 order

    const directs = unmetFor(me.body, 'direct_referrals');
    expect(directs.threshold).toBe(3);
    expect(directs.current).toBe(1); // yuki, and only yuki

    const legs = unmetFor(me.body, 'qualified_legs');
    expect(legs.threshold).toBe(2);
    // a leg counts the person at its head: yuki's own 60_000 clears the
    // 50_000 leg threshold even though nobody sits below her
    expect(legs.current).toBe(1);

    // every number is an integer in minor units, never a float
    for (const row of unmetOf(me.body)) {
      expect(Number.isInteger(row.threshold), row.metric).toBe(true);
      expect(Number.isInteger(row.current), row.metric).toBe(true);
    }

    // and a member at the top of the ladder is not told to chase anything
    const vera = await login(`vera-${RUN}@test.local`);
    const top = await api('/api/v1/ranks/me', { token: vera, tenant: tenantId });
    expect(currentRankCode(top.body)).toBe('silver');
    expect(unmetOf(top.body)).toHaveLength(0);
  });

  it('losing the data loses the rank, and records it without deleting history', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    // end one of vera's three direct edges: silver needs 3, bronze needs 1
    const ended = await api(`/api/v1/referrals/${edge.veraOtto}`, {
      method: 'DELETE',
      token: admin,
      tenant: tenantId,
    });
    expect([200, 204]).toContain(ended.status);
    const vera = await login(`vera-${RUN}@test.local`);
    expect((await downline(vera, tenantId, { depth: 1 })).sort()).toEqual([m.wren, m.nell].sort());

    await evaluate(admin, tenantId, m.vera, new Date().toISOString());

    // dropped to the highest rank they still pass, not to nothing
    const me = await api('/api/v1/ranks/me', { token: vera, tenant: tenantId });
    expect(currentRankCode(me.body)).toBe('bronze');

    const rows = await rankHistory(tenantId, m.vera);
    // the silver row is still there — nothing is deleted, ever
    const silverRows = rows.filter((r) => r.rankId === silverRankId);
    expect(silverRows.length).toBeGreaterThanOrEqual(1);
    expect(silverRows.some((r) => r.reason === 'achieved')).toBe(true);
    // the loss is recorded, either as a closing stamp or as its own row
    expect(silverRows.some((r) => r.reason === 'lost' || r.lostAt !== null)).toBe(true);
    // and the rank they fell back to is recorded as achieved
    expect(rows.some((r) => r.rankId === bronzeRankId && r.reason === 'achieved')).toBe(true);

    expect(await memberEventCount(tenantId, 'RankLost', m.vera)).toBe(1);
    expect(await memberEventCount(tenantId, 'RankAchieved', m.vera)).toBe(2);
  });

  it('a replay of an old asOf sees the graph as it was, not as it is now', async () => {
    // vera lost silver above because an edge was ENDED. Re-evaluating at the
    // earlier asOf must find that edge live again and return silver — otherwise
    // an audit of last month's commissions disagrees with last month.
    const admin = await login(`admin-a-${RUN}@test.local`);
    const vera = await login(`vera-${RUN}@test.local`);

    await evaluate(admin, tenantId, m.vera, veraAsOf);
    const replay = await api('/api/v1/ranks/me', { token: vera, tenant: tenantId });
    expect(currentRankCode(replay.body)).toBe('silver');

    // and evaluating at "now" puts it back where the current data says
    await evaluate(admin, tenantId, m.vera, new Date().toISOString());
    const now = await api('/api/v1/ranks/me', { token: vera, tenant: tenantId });
    expect(currentRankCode(now.body)).toBe('bronze');
  });

  it('a member cannot run an evaluation', async () => {
    const wren = await login(`wren-${RUN}@test.local`);
    const res = await api('/api/v1/ranks/evaluate', {
      method: 'POST',
      token: wren,
      tenant: tenantId,
      body: JSON.stringify({ memberId: m.wren, asOf: new Date().toISOString() }),
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});

describe('Windows — lifetime and rolling_30 disagree about an old order', () => {
  /**
   * Run in tenant B against its own two-rank ladder, so the window is the ONLY
   * thing that differs between the two ranks: same metric, same threshold.
   */
  let dawnRankId: string; // lifetime
  let duskRankId: string; // rolling_30

  it('an admin creates two ranks that differ only in their window', async () => {
    const admin = await login(`admin-b-${RUN}@test.local`);
    dawnRankId = await createRank(admin, otherTenantId, {
      code: 'dawn',
      name: 'Dawn',
      level: 10,
      qualifications: [
        { metric: 'personal_volume', comparator: 'gte', threshold: 30_000, window: 'lifetime' },
      ],
    });
    duskRankId = await createRank(admin, otherTenantId, {
      code: 'dusk',
      name: 'Dusk',
      level: 20,
      qualifications: [
        { metric: 'personal_volume', comparator: 'gte', threshold: 30_000, window: 'rolling_30' },
      ],
    });
    expect(dawnRankId).not.toBe(duskRankId);
  });

  it('a backdated order counts for lifetime but not for rolling_30', async () => {
    const admin = await login(`admin-b-${RUN}@test.local`);
    const order = await buy(`iris-${RUN}@test.local`, otherTenantId, admin, bOffering);
    expect(order.totalMinor).toBe(30_000);

    // push the order 90 days into the past — both stamps, since the contract
    // does not say which one a "paid order" is dated by
    const backdated = new Date(Date.now() - 90 * DAY);
    await withTenant(otherTenantId, (tx) =>
      tx.order.update({
        where: { id: order.id },
        data: { placedAt: backdated, paidAt: backdated },
      }),
    );

    await evaluate(admin, otherTenantId, b.iris, new Date().toISOString());

    const iris = await login(`iris-${RUN}@test.local`);
    const me = await api('/api/v1/ranks/me', { token: iris, tenant: otherTenantId });
    expect(me.status).toBe(200);
    // lifetime sees the 30_000; the 30-day window does not
    expect(currentRankCode(me.body)).toBe('dawn');
    expect(currentRankCode(me.body)).not.toBe('dusk');

    const legs = unmetFor(me.body, 'personal_volume');
    expect(legs.threshold).toBe(30_000);
    expect(legs.current).toBe(0); // nothing inside the rolling window yet
  });

  it('a fresh order brings the rolling window up to the threshold', async () => {
    const admin = await login(`admin-b-${RUN}@test.local`);
    const fresh = await buy(`iris-${RUN}@test.local`, otherTenantId, admin, bOffering);
    expect(fresh.totalMinor).toBe(30_000);

    await evaluate(admin, otherTenantId, b.iris, new Date().toISOString());

    const iris = await login(`iris-${RUN}@test.local`);
    const me = await api('/api/v1/ranks/me', { token: iris, tenant: otherTenantId });
    expect(currentRankCode(me.body)).toBe('dusk');

    // the same source data, read through two windows, gave two answers — and
    // both of them are recorded
    const rows = await rankHistory(otherTenantId, b.iris);
    expect(rows.some((r) => r.rankId === dawnRankId)).toBe(true);
    expect(rows.some((r) => r.rankId === duskRankId && r.reason === 'achieved')).toBe(true);
    expect(await memberEventCount(otherTenantId, 'RankAchieved', b.iris)).toBe(2);
  });
});

describe('Isolation and entitlement', () => {
  it("another tenant's member cannot read this tenant's ranks", async () => {
    const rafi = await login(`rafi-${RUN}@test.local`);

    // their own tenant's ladder is theirs alone — no bronze, no silver
    const own = await api('/api/v1/ranks', { token: rafi, tenant: otherTenantId });
    expect(own.status).toBe(200);
    const codes = own.body.ranks.map((r: { code: string }) => r.code);
    expect(codes).toEqual(expect.arrayContaining(['dawn', 'dusk']));
    expect(codes).not.toContain('bronze');
    expect(codes).not.toContain('silver');

    // and presenting the other tenant's header does not open the door
    const across = await api('/api/v1/ranks', { token: rafi, tenant: tenantId });
    expect([403, 404]).toContain(across.status);
    expect(across.status).not.toBe(200);
  });

  it("another tenant's member cannot read or write this tenant's referrals", async () => {
    const rafi = await login(`rafi-${RUN}@test.local`);

    const read = await api('/api/v1/referrals/me', { token: rafi, tenant: tenantId });
    expect([403, 404]).toContain(read.status);

    const write = await createReferral(rafi, tenantId, m.vera, m.hugo);
    expect(write.status).not.toBe(201);
    expect([403, 404]).toContain(write.status);

    // their own downline is empty — tenant A's graph is not visible from here
    expect(await downline(rafi, otherTenantId, { depth: 5 })).toHaveLength(0);

    // and tenant A's edges were not touched by the attempt
    const vera = await login(`vera-${RUN}@test.local`);
    expect(await downline(vera, tenantId, { depth: 1 })).not.toContain(m.hugo);
  });

  it('a plan without growth.ranks gets ENTITLEMENT_REQUIRED on the member views', async () => {
    const pia = await login(`pia-${RUN}@test.local`);
    // pia holds rank.view and referral.view exactly like everybody else; the
    // plan is what decides whether the module exists for her
    const rank = await api('/api/v1/ranks/me', { token: pia, tenant: tenantId });
    expect(rank.status).toBe(403);
    expect(rank.body.error.code).toBe('ENTITLEMENT_REQUIRED');

    const referral = await api('/api/v1/referrals/me', { token: pia, tenant: tenantId });
    expect(referral.status).toBe(403);
    expect(referral.body.error.code).toBe('ENTITLEMENT_REQUIRED');
  });

  it('an administrator can list the whole graph, including ended edges', async () => {
    // the member views are SELF-scoped and entitlement-gated, and the owner
    // holds no plan — without a tenant-wide list they could create edges and
    // never see them again
    const admin = await login(`admin-a-${RUN}@test.local`);
    const active = await api('/api/v1/referrals', { token: admin, tenant: tenantId });
    expect(active.status).toBe(200);
    const activeIds = active.body.referrals.map((r: { id: string }) => r.id);
    expect(activeIds).toContain(edge.veraWren);
    expect(activeIds).not.toContain(edge.veraOtto); // ended earlier in this file

    const withEnded = await api('/api/v1/referrals?includeEnded=true', {
      token: admin,
      tenant: tenantId,
    });
    expect(withEnded.body.referrals.map((r: { id: string }) => r.id)).toContain(edge.veraOtto);

    // it is an administrator's view, not a member's
    const wren = await login(`wren-${RUN}@test.local`);
    const denied = await api('/api/v1/referrals', { token: wren, tenant: tenantId });
    expect(denied.status).toBe(403);
  });

  it('the money thresholds say which currency they are in', async () => {
    const wren = await login(`wren-${RUN}@test.local`);
    const me = await api('/api/v1/ranks/me', { token: wren, tenant: tenantId });
    expect(me.body.currency).toMatch(/^[A-Z]{3}$/);
  });

  it('the owner, who holds no plan at all, still administers ranks and referrals', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    // the premise: this tenant owner has no membership, so no entitlement
    const memberships = await withTenant(tenantId, (tx) =>
      tx.membership.count({ where: { memberId: ownerMemberId } }),
    );
    expect(memberships).toBe(0);

    // administration is permission-scoped only — otherwise a tenant owner could
    // not configure the ranks they sell (docs/25 §4)
    const ladder = await api('/api/v1/ranks', { token: admin, tenant: tenantId });
    expect(ladder.status).toBe(200);
    expect(ladder.body.ranks.map((r: { code: string }) => r.code)).toEqual(
      expect.arrayContaining(['bronze', 'silver']),
    );

    const created = await createRank(admin, tenantId, {
      code: 'gold',
      name: 'Gold',
      level: 30,
      qualifications: [
        { metric: 'personal_volume', comparator: 'gte', threshold: 9_000_000, window: 'lifetime' },
      ],
    });
    expect(created).toBeTruthy();

    const evaluated = await evaluate(admin, tenantId, m.wren, new Date().toISOString());
    expect([200, 201]).toContain(evaluated.status);

    const edgeRes = await createReferral(admin, tenantId, m.vera, m.pia);
    expect(edgeRes.status).toBe(201);
    const vera = await login(`vera-${RUN}@test.local`);
    expect(await downline(vera, tenantId, { depth: 1 })).toContain(m.pia);
  });
});

/**
 * Sprint 39 — the monthly goal sheet (docs/58).
 *
 * The claim worth testing is not that the sheet saves. It is §3.1: goal
 * progress and rank qualification are the SAME number, because they come from
 * the same metric definitions. A goal that said 28,000 while the rank engine
 * said 31,000 for one month would leave two defensible answers and no way to
 * tell which was wrong.
 */
describe('Sprint 39 — business goals read the same metrics as ranks', () => {
  it('starts with no sheet but still knows where the member stands', async () => {
    const token = await login(`vera-${RUN}@test.local`);
    const res = await api('/api/v1/goals/business', { token, tenant: tenantId });
    expect(res.status).toBe(200);
    // No goal written yet is not the same as no progress: the month has still
    // happened, and a screen that showed nothing would invite retyping numbers
    // the system already has.
    expect(res.body.goal).toBeNull();
    expect(res.body.progress.volume.actualMinor).toBeGreaterThanOrEqual(0);
  });

  it('counts exactly the money that was actually paid this month', async () => {
    const token = await login(`vera-${RUN}@test.local`);
    const before = await api('/api/v1/goals/business', { token, tenant: tenantId });

    // An independent check, not the same code asked twice: buy something of a
    // known price through the real checkout, then require the sheet to move by
    // exactly that. The first version of this test compared the goal against a
    // /ranks/preview endpoint that does not exist, so its assertion sat inside
    // an `if` that never ran.
    const order = await buy(
      `vera-${RUN}@test.local`,
      tenantId,
      await login(`admin-a-${RUN}@test.local`),
      offering.canopy,
    );

    // A free offering would make the assertion below pass without proving
    // anything moved.
    expect(order.totalMinor).toBeGreaterThan(0);
    const after = await api('/api/v1/goals/business', { token, tenant: tenantId });
    expect(after.body.progress.volume.actualMinor).toBe(
      before.body.progress.volume.actualMinor + order.totalMinor,
    );
    // And it is the metric the rank engine names, not a private count.
    expect(after.body.progress.volume.metric).toBe('personal_volume');
  });

  it('saves the sheet and reads it back', async () => {
    const token = await login(`vera-${RUN}@test.local`);
    const goal = await api('/api/v1/goals/business', {
      method: 'PUT',
      token,
      tenant: tenantId,
      body: JSON.stringify({
        shortTerm: 'ปิดยอด 30000 PPV',
        volumeTargetMinor: 3_000_000,
        newPartnersTarget: 1,
        developCustomersTarget: 5,
        developPartnersTarget: 3,
      }),
    });
    expect(goal.status).toBe(200);
    const after = await api('/api/v1/goals/business', { token, tenant: tenantId });
    expect(after.body.goal.shortTerm).toBe('ปิดยอด 30000 PPV');
    expect(after.body.progress.volume.targetMinor).toBe(3_000_000);
  });

  it('says which numbers it measured and which a person typed', async () => {
    const token = await login(`vera-${RUN}@test.local`);
    const res = await api('/api/v1/goals/business', { token, tenant: tenantId });
    // Without this a typed number and a measured one look identical on screen,
    // and "5+3" is a coaching convention the system has no business inventing.
    expect(res.body.progress.volume.source).toBe('computed');
    expect(res.body.progress.newPartners.source).toBe('computed');
    expect(res.body.progress.develop.source).toBe('manual');
  });

  it('keeps one sheet per member per month however often it is saved', async () => {
    const token = await login(`vera-${RUN}@test.local`);
    const first = await api('/api/v1/goals/business', {
      method: 'PUT',
      token,
      tenant: tenantId,
      body: JSON.stringify({ volumeTargetMinor: 111 }),
    });
    const second = await api('/api/v1/goals/business', {
      method: 'PUT',
      token,
      tenant: tenantId,
      body: JSON.stringify({ volumeTargetMinor: 222 }),
    });
    // Two rows would leave two answers to "what was the goal", and the weekly
    // update would report against whichever it found first.
    expect(second.body.goal.id).toBe(first.body.goal.id);
    expect(second.body.goal.volumeTargetMinor).toBe(222);
  });

  it('anchors the window to the month asked about, not to today', async () => {
    const token = await login(`vera-${RUN}@test.local`);
    // A coach reviewing March in April must see March. Reading "now" would
    // show them April's empty month and call it a failed target.
    const march = await api('/api/v1/goals/business?month=2026-03-01', {
      token,
      tenant: tenantId,
    });
    expect(march.status).toBe(200);
    expect(march.body.month).toBe('2026-03-01');
    expect(march.body.progress.volume.actualMinor).toBe(0);
  });

  it('refuses to show a sheet belonging to somebody outside your scope', async () => {
    const token = await login(`yuki-${RUN}@test.local`);
    const res = await api(`/api/v1/goals/business?memberId=${m.vera}`, {
      token,
      tenant: tenantId,
    });
    expect(res.status).toBe(403);
  });
});
