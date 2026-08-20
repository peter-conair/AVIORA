/**
 * Analytics OS and the AI Team Coach (spec §53, §49, §50, docs/28).
 *
 * docs/28 §2 is the sentence this file exists to hold:
 *
 *     Habits, metrics and health profiles are absent from the leader, tenant
 *     and platform dashboards entirely — not aggregated, not counted, not
 *     averaged.
 *
 * So the headline tests are not the numbers. They are the DEEP SCAN: two
 * members of the same two-person team log habits, metrics and a lifestyle note,
 * and then every dashboard that is not their own is walked key by key and value
 * by value looking for any of it — the habit codes, the logged values, the
 * metric names, the metric values, the average of the two metric values (an
 * average over two people is an identification, which is exactly why §2 says
 * there is no aggregate exemption), and any key whose NAME is about habits,
 * sleep, weight or health. A named-field check would pass a dashboard that
 * leaked the same data one level deeper; this one does not.
 *
 * The scan is proved non-vacuous first: the member's OWN dashboard is scanned
 * with the same forbidden list and must FAIL to be clean, because their health
 * summary is theirs (§2, last line).
 *
 * The second promise is that the numbers mean one thing. docs/28 §3 defines
 * six terms; every expected value in this file is derived by hand in a comment
 * above the assertion that checks it, from a fixture small enough to count on
 * one hand: seven members, three teams, one busy member, one member whose only
 * recorded actions are health logs, one member with exactly one action outside
 * the 30-day window, and four members who did nothing at all.
 *
 * The third is that the coach cannot exceed the leader who asked. docs/28 §4
 * says authorization happens before retrieval, so there is no filtering step to
 * get wrong — which is only checkable from outside by asking every one of the
 * eight questions as a leader who leads two of the three teams, and proving the
 * third team's name never appears in any of the eight answers.
 *
 * Nothing here asserts a number the API could have been told. Members join
 * through the invitation flow, act through the modules that own the actions
 * (goals, community, health), and every measure is read back through the
 * analytics API. The owner client is used for exactly two things: pushing
 * `joined_at` and one goal into the past, and nothing else.
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

const RUN = `n${Date.now().toString(36)}`;
const PLATFORM_EMAIL = `e2e-platform-${RUN}@test.local`;
const PW = 'e2e-password-123456';

const DAY = 86_400_000;
const ago = (days: number): Date => new Date(Date.now() - days * DAY);

let app: INestApplication;
let base: string;
let owner: PrismaClient;

/** North runs the analytics. South exists to be invisible from North. */
let north: string;
let south: string;
let northPlanId: string;
let southPlanId: string;

/**
 * North's seven members, and the whole point of each one.
 *
 *   ada   leads Alder and Cedar. Does nothing herself, so leader-counting
 *         choices cannot move a single number below.
 *   bo    the busy member: 2 posts, 1 comment, 1 reaction, 1 goal — and a
 *         habit, a habit log, two health metrics and a lifestyle note.
 *   cy    the quiet member: the ONLY recorded actions are health logs. §3 says
 *         a habit log makes a member active "the existence, never the content",
 *         so cy is the member who proves both halves of that sentence at once.
 *   dov   exactly one action (one goal), and it is 40 days old — active in the
 *         90-day window, inactive in the 30-day one.
 *   bea   leads Birch, which ada must never see.
 *   piet  a plain member of Birch: no leadership, no actions.
 *   admin the tenant owner, backdated like everyone else so "new member" is
 *         never an accident of when this suite ran.
 */
const m: Record<'admin' | 'ada' | 'bo' | 'cy' | 'dov' | 'bea' | 'piet', string> = {} as never;
const team: Record<'alder' | 'cedar' | 'birch', string> = {} as never;
const teamName = { alder: 'Alder', cedar: 'Cedar', birch: 'Birch' } as const;

/** South's one member and one team — tokens that must never cross into North. */
let zia: string;
let basalt: string;
const SOUTH_MEMBER_NAME = `Zia Halvard ${RUN}`;
const SOUTH_TEAM_NAME = `Basalt ${RUN}`;

/**
 * How far in the past each member joined. Every one is set explicitly, so the
 * "new member" arithmetic below is a property of the fixture and not of the
 * clock at the moment the suite ran.
 */
const JOINED_DAYS_AGO = {
  admin: 300,
  ada: 200,
  bea: 210,
  bo: 5,
  cy: 20,
  dov: 45,
  piet: 100,
} as const;

/** dov's single goal, pushed here — outside 30d, inside 90d, inside 30–60d. */
const DOV_GOAL_DAYS_AGO = 40;

/* ── the health data that must never leave bo and cy ──────────────────────── */

const BO_HABIT_CODE = `hydration-${RUN}`;
const CY_HABIT_CODE = `evening-steps-${RUN}`;
const BO_HABIT_NAME = `Water through the day ${RUN}`;
const CY_HABIT_NAME = `Walk after dinner ${RUN}`;
const BO_LIFESTYLE_NOTE = `Wakes at three most nights ${RUN}`;

/** Deliberately odd values: nothing an analytics dashboard would ever compute. */
const BO_SLEEP_HOURS = 4.5;
const CY_SLEEP_HOURS = 6.5;
const BO_WEIGHT_KG = 61.2;
const BO_HABIT_TARGET = 2000;
const CY_HABIT_TARGET = 8000;
const BO_HABIT_LOGGED = 1750;
const CY_HABIT_LOGGED = 8300;
/**
 * The average of the two members' sleep. It appears nowhere in the fixture —
 * it can only exist in a response that AVERAGED two people's health data,
 * which for a two-member team names a person. (4.5 + 6.5) / 2 = 5.5
 */
const IDENTIFYING_SLEEP_AVERAGE = 5.5;

/** Every token the leader, tenant and platform dashboards must not contain. */
const FORBIDDEN = {
  strings: [
    BO_HABIT_CODE,
    CY_HABIT_CODE,
    BO_HABIT_NAME,
    CY_HABIT_NAME,
    BO_LIFESTYLE_NOTE,
    'sleep_hours',
    'weight_kg',
  ],
  numbers: [
    BO_SLEEP_HOURS,
    CY_SLEEP_HOURS,
    BO_WEIGHT_KG,
    BO_HABIT_TARGET,
    CY_HABIT_TARGET,
    BO_HABIT_LOGGED,
    CY_HABIT_LOGGED,
    IDENTIFYING_SLEEP_AVERAGE,
  ],
};

/**
 * INTERPRETATION: the key test is on NAMES, not on prose. A dashboard that
 * "states the definitions it applied" (§3) will quote the active-member
 * definition, and that definition contains the words "habit log" — so string
 * VALUES are checked against the fixture's own tokens only, while KEYS are
 * checked against this pattern. A key called `sleepAverage`, `habitDays` or
 * `healthSummary` on a leader dashboard is a leak whatever it holds.
 */
const HEALTH_KEY = /habit|sleep|weight|health/i;

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
    where: { eventName: 'MemberInvited', tenantId: tenant, aggregateId: inv.body.invitation.id },
  });
  const accepted = await api(
    `/api/v1/invitations/${(evt!.payload as { token: string }).token}/accept`,
    { method: 'POST', body: JSON.stringify({ displayName: name, password: PW }) },
  );
  expect(accepted.status).toBe(201);
  return accepted.body.memberId;
}

/* ── the only two uses of the owner client in this file ───────────────────── */

/**
 * Raw SQL rather than `member.update`, for one reason: the goal backdate below
 * has to move `updated_at`, and Prisma's `@updatedAt` overwrites whatever it is
 * handed. Both statements are id-targeted and run inside `withTenant`.
 */
async function setJoinedAt(tenant: string, memberId: string, daysAgo: number): Promise<void> {
  const at = ago(daysAgo);
  await withTenant(
    tenant,
    (tx) => tx.$executeRaw`UPDATE members SET joined_at = ${at} WHERE id = ${memberId}::uuid`,
  );
}

/** Both stamps, since the contract does not say which one dates an action. */
async function backdateGoal(tenant: string, goalId: string, daysAgo: number): Promise<void> {
  const at = ago(daysAgo);
  await withTenant(
    tenant,
    (tx) =>
      tx.$executeRaw`UPDATE goals SET created_at = ${at}, updated_at = ${at} WHERE id = ${goalId}::uuid`,
  );
}

/* ── deep scan ────────────────────────────────────────────────────────────── */

/**
 * Walks the whole response — objects, arrays, every leaf — and returns one
 * finding per hit, with the JSON path, so a failure says WHERE the leak is.
 * Decimal columns arrive as strings ("4.50"), so numeric leaves are compared
 * numerically whether they arrive as a number or as a string.
 */
function findHealth(value: unknown, path = '$', found: string[] = []): string[] {
  if (value === null || value === undefined) return found;
  if (Array.isArray(value)) {
    value.forEach((v, i) => findHealth(v, `${path}[${i}]`, found));
    return found;
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (HEALTH_KEY.test(key)) found.push(`${path}.${key} — key names health data`);
      findHealth(child, `${path}.${key}`, found);
    }
    return found;
  }
  if (typeof value === 'string') {
    const hay = value.toLowerCase();
    for (const token of FORBIDDEN.strings) {
      if (hay.includes(token.toLowerCase())) found.push(`${path} — contains "${token}"`);
    }
    const asNumber = Number(value);
    if (value.trim() !== '' && Number.isFinite(asNumber)) {
      for (const n of FORBIDDEN.numbers) {
        if (asNumber === n) found.push(`${path} — equals health value ${n}`);
      }
    }
    return found;
  }
  if (typeof value === 'number') {
    for (const n of FORBIDDEN.numbers) {
      if (value === n) found.push(`${path} — equals health value ${n}`);
    }
  }
  return found;
}

function expectNoHealthAnywhere(label: string, body: unknown): void {
  const found = findHealth(body);
  expect(found, `${label} leaked health data:\n  ${found.join('\n  ')}`).toEqual([]);
}

function mentions(body: unknown, token: string): boolean {
  return JSON.stringify(body ?? null)
    .toLowerCase()
    .includes(token.toLowerCase());
}

/* ── shape tolerance ──────────────────────────────────────────────────────
 * docs/28 §5 fixes the routes, the permissions and the `?window=` parameter,
 * and §3 fixes the measures by NAME and definition — but not the JSON
 * envelope. The readers below are lenient about WHERE a value sits; every
 * assertion built on them is exact about WHAT it is.
 * ------------------------------------------------------------------------ */

function preview(body: unknown): string {
  return JSON.stringify(body ?? null)?.slice(0, 400) ?? '';
}

function containers(body: any): any[] {
  return [
    body,
    body?.measures,
    body?.summary,
    body?.metrics,
    body?.totals,
    body?.data,
    body?.member,
    body?.team,
    body?.tenant,
    body?.platform,
    body?.analytics,
  ].filter((c) => c && typeof c === 'object');
}

function pick(body: any, keys: string[]): unknown {
  for (const container of containers(body)) {
    for (const key of keys) {
      const value = container[key];
      if (value !== undefined && value !== null) return value;
    }
  }
  return undefined;
}

function numberOf(body: any, keys: string[], label: string): number {
  let value = pick(body, keys);
  if (value && typeof value === 'object') {
    value =
      (value as any).value ?? (value as any).count ?? (value as any).perActiveMember ?? undefined;
  }
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    value = Number(value);
  }
  expect(typeof value, `${label} not found in ${preview(body)}`).toBe('number');
  return value as number;
}

const ACTIVE_KEYS = ['activeMembers', 'active', 'activeMemberCount'];
const NEW_KEYS = ['newMembers', 'new', 'newMemberCount'];
const ENGAGEMENT_KEYS = ['engagementPerActiveMember', 'engagement', 'engagementPerActive'];
const GROWTH_KEYS = ['growth', 'activeMemberGrowth', 'growthInActiveMembers'];

function windowOf(body: any): string {
  const w = pick(body, ['window', 'resolvedWindow']);
  const code =
    typeof w === 'string' ? w : ((w as any)?.code ?? (w as any)?.key ?? (w as any)?.name);
  expect(typeof code, `no window stated on ${preview(body)}`).toBe('string');
  return code as string;
}

function windowBounds(body: any): { from: string; to: string } {
  const w = pick(body, ['window', 'resolvedWindow']) as any;
  const from = w?.from ?? w?.start ?? w?.since ?? body?.from ?? body?.periodStart;
  const to = w?.to ?? w?.end ?? w?.until ?? body?.to ?? body?.periodEnd;
  expect(typeof from, `window states no start in ${preview(body)}`).toBe('string');
  expect(typeof to, `window states no end in ${preview(body)}`).toBe('string');
  return { from, to };
}

function teamsOf(body: any): any[] {
  const teams = body?.teams ?? body?.teamMetrics ?? body?.data?.teams ?? body?.scope?.teams;
  expect(Array.isArray(teams), `no teams array in ${preview(body)}`).toBe(true);
  return teams as any[];
}

function nameOfTeam(entry: any): string {
  return entry?.name ?? entry?.team?.name ?? entry?.teamName ?? '';
}

function idOfTeam(entry: any): string {
  return entry?.id ?? entry?.teamId ?? entry?.team?.id ?? '';
}

function teamEntry(body: any, teamId: string): any {
  const entry = teamsOf(body).find((t) => idOfTeam(t) === teamId);
  expect(entry, `team ${teamId} missing from ${preview(body)}`).toBeTruthy();
  return entry;
}

function answerOf(body: any): string {
  const answer = body?.answer ?? body?.coach?.answer ?? body?.message ?? body?.text;
  expect(typeof answer, `coach returned no answer: ${preview(body)}`).toBe('string');
  return answer as string;
}

const namesANumber = (answer: string): boolean => /\d/.test(answer);

/* ── the eight questions, verbatim from docs/28 §4 ────────────────────────── */

const QUESTIONS = [
  'Which team is growing fastest?',
  'Which team needs support?',
  'Which leader needs coaching?',
  'Which member is inactive?',
  'Who is close to the next milestone?',
  'Which course should the team take next?',
  'What should this team focus on?',
  'What activities correlate with growth?',
] as const;

const CORRELATION_QUESTION = QUESTIONS[7];

/**
 * INTERPRETATION: §4 lists the questions as English sentences and §5 types the
 * body as `{ question }`, so the sentences are what this suite sends. If the
 * engine takes codes instead, this array is the one-line change and no
 * assertion below moves.
 */
async function askCoach(
  token: string,
  tenant: string,
  question: string,
  window = '30d',
): Promise<{ status: number; body: any }> {
  return api(`/api/v1/ai/coach/team?window=${window}`, {
    method: 'POST',
    token,
    tenant,
    body: JSON.stringify({ question }),
  });
}

async function dashboard(
  path: 'me' | 'team' | 'tenant' | 'platform',
  token: string,
  opts: { tenant?: string; window?: string } = {},
): Promise<{ status: number; body: any }> {
  const query = opts.window ? `?window=${opts.window}` : '';
  return api(`/api/v1/analytics/${path}${query}`, { token, tenant: opts.tenant });
}

beforeAll(async () => {
  process.env.AVIORA_OUTBOX_DISABLED = 'true';
  process.env.AVIORA_PII_ENCRYPTION_KEY ??= Buffer.alloc(32, 9).toString('base64');
  delete process.env.AVIORA_AI_ANTHROPIC_KEY; // exercise the local grounded provider
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
  const mkTenant = async (
    suffix: string,
    name: string,
    adminEmail: string,
  ): Promise<{ tenantId: string; adminMemberId: string }> => {
    const res = await api('/api/v1/platform/tenants', {
      method: 'POST',
      token: platform,
      body: JSON.stringify({
        code: `e2e_an_${suffix}_${RUN}`,
        name,
        slug: `e2e-an-${suffix}-${RUN}`,
        adminEmail,
        adminDisplayName: 'Admin',
        adminPassword: PW,
      }),
    });
    expect(res.status).toBe(201);
    return { tenantId: res.body.tenant.id, adminMemberId: res.body.adminMemberId };
  };
  const northTenant = await mkTenant('n', 'North Co', `admin-n-${RUN}@test.local`);
  const southTenant = await mkTenant('s', 'South Co', `admin-s-${RUN}@test.local`);
  north = northTenant.tenantId;
  south = southTenant.tenantId;
  m.admin = northTenant.adminMemberId;

  const adminN = await login(`admin-n-${RUN}@test.local`);
  const adminS = await login(`admin-s-${RUN}@test.local`);

  const mkPlan = async (token: string, tenant: string): Promise<string> => {
    const res = await api('/api/v1/membership-plans', {
      method: 'POST',
      token,
      tenant,
      body: JSON.stringify({ code: 'std', name: 'Standard', entitlementKeys: [] }),
    });
    expect(res.status).toBe(201);
    return res.body.plan.id as string;
  };
  northPlanId = await mkPlan(adminN, north);
  southPlanId = await mkPlan(adminS, south);

  m.ada = await addMember(adminN, north, northPlanId, `ada-${RUN}@test.local`, 'Ada Vance');
  m.bo = await addMember(adminN, north, northPlanId, `bo-${RUN}@test.local`, 'Bo Ness');
  m.cy = await addMember(adminN, north, northPlanId, `cy-${RUN}@test.local`, 'Cy Marek');
  m.dov = await addMember(adminN, north, northPlanId, `dov-${RUN}@test.local`, 'Dov Estes');
  m.bea = await addMember(adminN, north, northPlanId, `bea-${RUN}@test.local`, 'Bea Rowan');
  m.piet = await addMember(adminN, north, northPlanId, `piet-${RUN}@test.local`, 'Piet Lund');

  const mkTeam = async (
    token: string,
    tenant: string,
    code: string,
    name: string,
  ): Promise<string> => {
    const res = await api('/api/v1/teams', {
      method: 'POST',
      token,
      tenant,
      body: JSON.stringify({ code, name }),
    });
    expect(res.status).toBe(201);
    return res.body.team.id as string;
  };
  const joinTeam = async (
    token: string,
    tenant: string,
    teamId: string,
    memberId: string,
  ): Promise<void> => {
    const res = await api(`/api/v1/teams/${teamId}/members`, {
      method: 'POST',
      token,
      tenant,
      body: JSON.stringify({ memberId }),
    });
    expect(res.status).toBe(201);
  };
  const leadTeam = async (
    token: string,
    tenant: string,
    teamId: string,
    memberId: string,
  ): Promise<void> => {
    const res = await api(`/api/v1/teams/${teamId}/leaders`, {
      method: 'POST',
      token,
      tenant,
      body: JSON.stringify({ memberId }),
    });
    expect(res.status).toBe(201);
  };

  team.alder = await mkTeam(adminN, north, `alder-${RUN}`, teamName.alder);
  team.cedar = await mkTeam(adminN, north, `cedar-${RUN}`, teamName.cedar);
  team.birch = await mkTeam(adminN, north, `birch-${RUN}`, teamName.birch);

  // ada leads two teams; bea leads the third. Neither leader is a MEMBER of the
  // teams they lead, so counting leaders as members cannot move any assertion.
  await leadTeam(adminN, north, team.alder, m.ada);
  await leadTeam(adminN, north, team.cedar, m.ada);
  await leadTeam(adminN, north, team.birch, m.bea);

  await joinTeam(adminN, north, team.alder, m.bo);
  await joinTeam(adminN, north, team.alder, m.cy); // Alder is exactly two people
  await joinTeam(adminN, north, team.cedar, m.dov);
  await joinTeam(adminN, north, team.birch, m.piet);

  for (const [who, days] of Object.entries(JOINED_DAYS_AGO)) {
    await setJoinedAt(north, m[who as keyof typeof m], days);
  }

  /* ── health: the data that must not leave bo and cy ─────────────────────── */

  const bo = await login(`bo-${RUN}@test.local`);
  const cy = await login(`cy-${RUN}@test.local`);

  const profile = await api('/api/v1/health/me', {
    method: 'PUT',
    token: bo,
    tenant: north,
    body: JSON.stringify({ lifestyleNotes: BO_LIFESTYLE_NOTE }),
  });
  expect(profile.status).toBe(200);

  const mkHabit = async (token: string, code: string, name: string, target: number) => {
    const res = await api('/api/v1/health/habits', {
      method: 'POST',
      token,
      tenant: north,
      body: JSON.stringify({ code, name, targetUnit: 'unit', targetValue: target }),
    });
    expect(res.status).toBe(201);
    return res.body.habit.id as string;
  };
  const boHabit = await mkHabit(bo, BO_HABIT_CODE, BO_HABIT_NAME, BO_HABIT_TARGET);
  const cyHabit = await mkHabit(cy, CY_HABIT_CODE, CY_HABIT_NAME, CY_HABIT_TARGET);

  for (const [token, habitId, value] of [
    [bo, boHabit, BO_HABIT_LOGGED],
    [cy, cyHabit, CY_HABIT_LOGGED],
  ] as const) {
    const res = await api(`/api/v1/health/habits/${habitId}/log`, {
      method: 'POST',
      token,
      tenant: north,
      body: JSON.stringify({ value }),
    });
    expect(res.status).toBe(201);
  }

  const mkMetric = async (token: string, metric: string, value: number, unit: string) => {
    const res = await api('/api/v1/health/metrics', {
      method: 'POST',
      token,
      tenant: north,
      body: JSON.stringify({ metric, value, unit }),
    });
    expect(res.status).toBe(201);
  };
  await mkMetric(bo, 'sleep_hours', BO_SLEEP_HOURS, 'h');
  await mkMetric(bo, 'weight_kg', BO_WEIGHT_KG, 'kg');
  await mkMetric(cy, 'sleep_hours', CY_SLEEP_HOURS, 'h');

  /* ── the non-health actions the measures are computed from ──────────────── */

  const mkGoal = async (token: string, title: string): Promise<string> => {
    const res = await api('/api/v1/goals', {
      method: 'POST',
      token,
      tenant: north,
      body: JSON.stringify({ title }),
    });
    expect(res.status).toBe(201);
    return res.body.goal.id as string;
  };
  await mkGoal(bo, 'Read one chapter a night');

  // dov's only action, pushed 40 days back: inside 90d, outside 30d, and inside
  // the PREVIOUS 30-day window [T-60, T-30] — which is what makes Cedar's
  // growth negative below.
  const dov = await login(`dov-${RUN}@test.local`);
  const dovGoal = await mkGoal(dov, 'Walk the long way home');
  await backdateGoal(north, dovGoal, DOV_GOAL_DAYS_AGO);

  // Alder's community: bo publishes 2 posts, 1 comment and 1 reaction = 4
  // engagement events. cy publishes none — cy's only actions are health logs.
  const alderCommunity = await api(`/api/v1/community/teams/${team.alder}`, {
    token: bo,
    tenant: north,
  });
  expect(alderCommunity.status).toBe(200);
  const communityId = alderCommunity.body.community.id as string;

  const post = async (body: string): Promise<string> => {
    const res = await api(`/api/v1/community/${communityId}/posts`, {
      method: 'POST',
      token: bo,
      tenant: north,
      body: JSON.stringify({ body }),
    });
    expect(res.status).toBe(201);
    return res.body.post.id as string;
  };
  const firstPost = await post('Morning everyone.');
  await post('Second one for the week.');
  const comment = await api(`/api/v1/community/posts/${firstPost}/comments`, {
    method: 'POST',
    token: bo,
    tenant: north,
    body: JSON.stringify({ body: 'Adding a note to my own post.' }),
  });
  expect(comment.status).toBe(201);
  const reaction = await api(`/api/v1/community/posts/${firstPost}/reactions`, {
    method: 'POST',
    token: bo,
    tenant: north,
    body: JSON.stringify({ kind: 'like' }),
  });
  expect(reaction.status).toBe(201);

  /* ── South: numbers that must never appear in North ─────────────────────── */

  zia = await addMember(adminS, south, southPlanId, `zia-${RUN}@test.local`, SOUTH_MEMBER_NAME);
  basalt = await mkTeam(adminS, south, `basalt-${RUN}`, SOUTH_TEAM_NAME);
  await leadTeam(adminS, south, basalt, zia);
  await joinTeam(adminS, south, basalt, zia);
  const ziaToken = await login(`zia-${RUN}@test.local`);
  await api('/api/v1/goals', {
    method: 'POST',
    token: ziaToken,
    tenant: south,
    body: JSON.stringify({ title: `South only goal ${RUN}` }),
  });
}, 300_000);

afterAll(async () => {
  await app?.close();
  await owner?.$disconnect();
});

describe('Analytics — health data never leaves the member (docs/28 §2)', () => {
  it("carries the member's own health summary on their own dashboard", async () => {
    // The scan below is only worth anything if it can catch something. Here is
    // the one dashboard where this data BELONGS (§2, last line): if the same
    // forbidden list finds nothing here, the scan is vacuous and every clean
    // result after it is meaningless.
    const bo = await login(`bo-${RUN}@test.local`);
    const res = await dashboard('me', bo, { tenant: north, window: '30d' });
    expect(res.status).toBe(200);
    expect(windowOf(res.body)).toBe('30d');

    expect(mentions(res.body, BO_HABIT_CODE)).toBe(true);
    expect(findHealth(res.body).length).toBeGreaterThan(0);
  });

  it("does not put a two-member team's health data on the leader dashboard", async () => {
    // Alder is bo and cy and nobody else. Any average, any count of days
    // logged, any latest metric here is a statement about one identifiable
    // person — which is why §2 grants no aggregate exemption.
    const ada = await login(`ada-${RUN}@test.local`);
    const res = await dashboard('team', ada, { tenant: north, window: '30d' });
    expect(res.status).toBe(200);
    expectNoHealthAnywhere('the leader dashboard', res.body);
  });

  it('does not put health data on the tenant dashboard', async () => {
    const admin = await login(`admin-n-${RUN}@test.local`);
    const res = await dashboard('tenant', admin, { tenant: north, window: '30d' });
    expect(res.status).toBe(200);
    expectNoHealthAnywhere('the tenant dashboard', res.body);
  });

  it('does not put health data on the platform dashboard', async () => {
    const platform = await login(PLATFORM_EMAIL);
    const res = await dashboard('platform', platform, { window: '30d' });
    expect(res.status).toBe(200);
    expectNoHealthAnywhere('the platform dashboard', res.body);
  });

  it('does not leak health data through the coach either', async () => {
    // The coach reads the same scoped service the leader dashboard reads
    // (§4), so if that service holds no health data neither can this. Asked
    // over the team whose two members are the only ones with health records.
    const ada = await login(`ada-${RUN}@test.local`);
    for (const question of QUESTIONS) {
      const res = await askCoach(ada, north, question);
      expect([200, 201]).toContain(res.status);
      expectNoHealthAnywhere(`the coach answering "${question}"`, res.body);
    }
  });

  it('never averages the two members of Alder — not even into one number', async () => {
    // (4.5 + 6.5) / 2 = 5.5 sleep hours. That number exists nowhere in the
    // fixture; it can only be produced by averaging two people, and over two
    // people an average is a name.
    const ada = await login(`ada-${RUN}@test.local`);
    const admin = await login(`admin-n-${RUN}@test.local`);
    const platform = await login(PLATFORM_EMAIL);
    const bodies = [
      await dashboard('team', ada, { tenant: north, window: '90d' }),
      await dashboard('tenant', admin, { tenant: north, window: '90d' }),
      await dashboard('platform', platform, { window: '90d' }),
    ];
    for (const res of bodies) {
      expect(res.status).toBe(200);
      expect(mentions(res.body, String(IDENTIFYING_SLEEP_AVERAGE))).toBe(false);
      expectNoHealthAnywhere('a 90-day dashboard', res.body);
    }
  });
});

describe('Analytics — scope is the same machinery as everywhere else (docs/28 §1)', () => {
  it('shows a leader the teams they lead, and no others', async () => {
    const ada = await login(`ada-${RUN}@test.local`);
    const res = await dashboard('team', ada, { tenant: north, window: '30d' });
    expect(res.status).toBe(200);
    const ids = teamsOf(res.body).map(idOfTeam);
    expect(ids).toEqual(expect.arrayContaining([team.alder, team.cedar]));
    expect(ids).not.toContain(team.birch);
    const names = teamsOf(res.body).map(nameOfTeam);
    expect(names).toEqual(expect.arrayContaining([teamName.alder, teamName.cedar]));
    // and not by name, id or count anywhere else in the envelope
    expect(mentions(res.body, team.birch)).toBe(false);
    expect(mentions(res.body, teamName.birch)).toBe(false);
  });

  it("does not let the leader of Alder read Birch's numbers", async () => {
    const ada = await login(`ada-${RUN}@test.local`);
    const res = await api(`/api/v1/analytics/team?window=30d&teamId=${team.birch}`, {
      token: ada,
      tenant: north,
    });
    // Either the request is refused, or the parameter is ignored — but Birch's
    // numbers must not come back either way.
    if (res.status === 200) {
      expect(teamsOf(res.body).map(idOfTeam)).not.toContain(team.birch);
      expect(mentions(res.body, teamName.birch)).toBe(false);
    } else {
      expect([403, 404]).toContain(res.status);
    }
  });

  it('shows the leader of Birch their own team and not Alder', async () => {
    const bea = await login(`bea-${RUN}@test.local`);
    const res = await dashboard('team', bea, { tenant: north, window: '30d' });
    expect(res.status).toBe(200);
    const ids = teamsOf(res.body).map(idOfTeam);
    expect(ids).toContain(team.birch);
    expect(ids).not.toContain(team.alder);
    expect(ids).not.toContain(team.cedar);
    expect(mentions(res.body, teamName.alder)).toBe(false);
  });

  it('refuses the team dashboard to a member who leads nothing', async () => {
    const piet = await login(`piet-${RUN}@test.local`);
    const res = await dashboard('team', piet, { tenant: north, window: '30d' });
    expect(res.status).toBe(403);
  });

  it('refuses the tenant dashboard to a leader and to a plain member', async () => {
    const ada = await login(`ada-${RUN}@test.local`);
    const piet = await login(`piet-${RUN}@test.local`);
    expect((await dashboard('tenant', ada, { tenant: north })).status).toBe(403);
    expect((await dashboard('tenant', piet, { tenant: north })).status).toBe(403);
  });

  it('reaches the platform dashboard from a platform role only', async () => {
    // §5: "across tenants; platform roles only". The tenant owner holds every
    // permission in the catalog inside their tenant, which is exactly why this
    // route cannot be gated on a permission alone.
    const platform = await login(PLATFORM_EMAIL);
    expect((await dashboard('platform', platform)).status).toBe(200);

    const admin = await login(`admin-n-${RUN}@test.local`);
    expect((await dashboard('platform', admin, { tenant: north })).status).toBe(403);

    const ada = await login(`ada-${RUN}@test.local`);
    expect((await dashboard('platform', ada, { tenant: north })).status).toBe(403);
  });

  it('lets a member read their own dashboard and nobody else read it for them', async () => {
    const cy = await login(`cy-${RUN}@test.local`);
    const mine = await dashboard('me', cy, { tenant: north, window: '30d' });
    expect(mine.status).toBe(200);
    // cy's dashboard is cy's: it must not carry bo's health tokens
    expect(mentions(mine.body, BO_HABIT_CODE)).toBe(false);
    expect(mentions(mine.body, BO_LIFESTYLE_NOTE)).toBe(false);
    expect(mentions(mine.body, CY_HABIT_CODE)).toBe(true);
  });
});

describe('Analytics — the definitions, computed by hand (docs/28 §3)', () => {
  it('counts a new member as one whose joinedAt falls inside the window', async () => {
    // joinedAt, days ago: admin 300 · ada 200 · bea 210 · bo 5 · cy 20 ·
    // dov 45 · piet 100. Inside 30 days: bo (5) and cy (20) = 2.
    const admin = await login(`admin-n-${RUN}@test.local`);
    const res = await dashboard('tenant', admin, { tenant: north, window: '30d' });
    expect(res.status).toBe(200);
    expect(numberOf(res.body, NEW_KEYS, 'tenant newMembers')).toBe(2);
  });

  it('counts a member active on one recorded action, and never on none', async () => {
    // In the 30-day window:
    //   bo  — 2 posts + 1 comment + 1 reaction + 1 goal + habit log → active
    //   cy  — ONE habit log and nothing else → active, because §3 counts the
    //         EXISTENCE of a habit log ("never the content")
    //   dov — one goal, but 40 days ago → outside the window, not active
    //   ada, bea, piet, admin — nothing at all → not active
    // active members = bo + cy = 2
    const admin = await login(`admin-n-${RUN}@test.local`);
    const res = await dashboard('tenant', admin, { tenant: north, window: '30d' });
    expect(numberOf(res.body, ACTIVE_KEYS, 'tenant activeMembers')).toBe(2);

    // and the same two, counted through the leader's scope: Alder is bo and cy
    const ada = await login(`ada-${RUN}@test.local`);
    const team30 = await dashboard('team', ada, { tenant: north, window: '30d' });
    expect(numberOf(teamEntry(team30.body, team.alder), ACTIVE_KEYS, 'Alder activeMembers')).toBe(
      2,
    );
    // Cedar is dov alone, whose one action is outside the window
    expect(numberOf(teamEntry(team30.body, team.cedar), ACTIVE_KEYS, 'Cedar activeMembers')).toBe(
      0,
    );
  });

  it('counts new members per team from the same joinedAt rule', async () => {
    // Alder = bo (5 days) + cy (20 days) → both new inside 30 days = 2.
    // Cedar = dov (45 days) → 0. ada leads both and joined 200 days ago, so
    // whether leaders are counted as members changes neither number.
    const ada = await login(`ada-${RUN}@test.local`);
    const res = await dashboard('team', ada, { tenant: north, window: '30d' });
    expect(numberOf(teamEntry(res.body, team.alder), NEW_KEYS, 'Alder newMembers')).toBe(2);
    expect(numberOf(teamEntry(res.body, team.cedar), NEW_KEYS, 'Cedar newMembers')).toBe(0);
  });

  it('divides engagement by active members — and does not divide by zero', async () => {
    // Engagement = posts + comments + reactions, per active member (§3).
    // Alder, 30 days: bo published 2 posts + 1 comment + 1 reaction = 4 events;
    // cy published none. Active members in Alder = 2 (bo, cy).
    //   4 / 2 = 2
    const ada = await login(`ada-${RUN}@test.local`);
    const res = await dashboard('team', ada, { tenant: north, window: '30d' });
    expect(
      numberOf(teamEntry(res.body, team.alder), ENGAGEMENT_KEYS, 'Alder engagement'),
    ).toBeCloseTo(2, 6);

    // Cedar has 0 events and 0 active members. 0/0 is not a number a dashboard
    // may print: it is 0 or it is nothing, never NaN and never Infinity.
    const cedar = teamEntry(res.body, team.cedar);
    const raw = pick(cedar, ENGAGEMENT_KEYS);
    const value = typeof raw === 'object' && raw ? ((raw as any).value ?? null) : raw;
    if (value !== null && value !== undefined) {
      expect(Number.isFinite(Number(value))).toBe(true);
      expect(Number(value)).toBe(0);
    }
    expect(JSON.stringify(res.body)).not.toMatch(/NaN|Infinity/);

    // tenant-wide, the same four events over the same two active members:
    //   4 / 2 = 2
    const admin = await login(`admin-n-${RUN}@test.local`);
    const tenant = await dashboard('tenant', admin, { tenant: north, window: '30d' });
    expect(numberOf(tenant.body, ENGAGEMENT_KEYS, 'tenant engagement')).toBeCloseTo(2, 6);
  });

  it('states the window it used and the definitions it applied', async () => {
    // §3: "A number without its window is a number that will be misquoted."
    const bo = await login(`bo-${RUN}@test.local`);
    const ada = await login(`ada-${RUN}@test.local`);
    const admin = await login(`admin-n-${RUN}@test.local`);
    const platform = await login(PLATFORM_EMAIL);
    const responses = [
      await dashboard('me', bo, { tenant: north, window: '90d' }),
      await dashboard('team', ada, { tenant: north, window: '90d' }),
      await dashboard('tenant', admin, { tenant: north, window: '90d' }),
      await dashboard('platform', platform, { window: '90d' }),
    ];
    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(windowOf(res.body)).toBe('90d');
      const definitions = pick(res.body, ['definitions', 'appliedDefinitions']);
      expect(definitions, `no definitions stated in ${preview(res.body)}`).toBeTruthy();
      const stated = JSON.stringify(definitions);
      expect(stated).toMatch(/active/i);
      expect(stated).toMatch(/new/i);
    }
  });
});

describe('Analytics — windows disagree over the same data (docs/28 §3, §5)', () => {
  it('answers differently for 30d and 90d, and says which it answered', async () => {
    const admin = await login(`admin-n-${RUN}@test.local`);
    const thirty = await dashboard('tenant', admin, { tenant: north, window: '30d' });
    const ninety = await dashboard('tenant', admin, { tenant: north, window: '90d' });
    expect(windowOf(thirty.body)).toBe('30d');
    expect(windowOf(ninety.body)).toBe('90d');

    // new members: 30d = bo (5) + cy (20) = 2
    //              90d = bo (5) + cy (20) + dov (45) = 3
    expect(numberOf(thirty.body, NEW_KEYS, '30d newMembers')).toBe(2);
    expect(numberOf(ninety.body, NEW_KEYS, '90d newMembers')).toBe(3);

    // active members: 30d = bo + cy = 2
    //                 90d = bo + cy + dov (one goal, 40 days ago) = 3
    expect(numberOf(thirty.body, ACTIVE_KEYS, '30d activeMembers')).toBe(2);
    expect(numberOf(ninety.body, ACTIVE_KEYS, '90d activeMembers')).toBe(3);

    // engagement follows the divisor, not just the numerator: the four events
    // are all recent, so 90d has the same 4 over one more active member.
    //   30d: 4 / 2 = 2      90d: 4 / 3 = 1.333…
    expect(numberOf(thirty.body, ENGAGEMENT_KEYS, '30d engagement')).toBeCloseTo(2, 6);
    expect(numberOf(ninety.body, ENGAGEMENT_KEYS, '90d engagement')).toBeCloseTo(4 / 3, 3);
  });

  it('treats month as the calendar month, and counts its own joiners', async () => {
    const admin = await login(`admin-n-${RUN}@test.local`);
    const res = await dashboard('tenant', admin, { tenant: north, window: 'month' });
    expect(res.status).toBe(200);
    expect(windowOf(res.body)).toBe('month');

    const { from } = windowBounds(res.body);
    const start = new Date(from);
    const now = new Date();
    expect(start.getUTCDate() <= 1 || start.getDate() === 1).toBe(true);
    expect(start.getTime()).toBeLessThanOrEqual(now.getTime());

    // Same fixture, third answer: the members whose joinedAt lands inside the
    // calendar month, counted from the offsets this suite set itself.
    //   admin 300 · ada 200 · bea 210 · bo 5 · cy 20 · dov 45 · piet 100
    const expectedNew = Object.values(JOINED_DAYS_AGO).filter(
      (days) => ago(days).getTime() >= start.getTime(),
    ).length;
    expect(numberOf(res.body, NEW_KEYS, 'month newMembers')).toBe(expectedNew);

    // ...and the month window never reaches back past 90 days, so it can never
    // exceed the 90-day count.
    const ninety = await dashboard('tenant', admin, { tenant: north, window: '90d' });
    expect(numberOf(res.body, NEW_KEYS, 'month newMembers')).toBeLessThanOrEqual(
      numberOf(ninety.body, NEW_KEYS, '90d newMembers'),
    );
  });

  it('measures growth between two equal, adjacent windows', async () => {
    // §3: growth = change in active members between two equal, adjacent
    // windows. With a 30-day window the previous one is [T-60, T-30].
    //   Alder — now: bo + cy = 2 · before: nobody acted = 0 → +2
    //   Cedar — now: 0 · before: dov's goal at 40 days ago = 1 → −1
    // INTERPRETATION: §3 says "change in active members", so this is a count,
    // not a percentage.
    const ada = await login(`ada-${RUN}@test.local`);
    const res = await dashboard('team', ada, { tenant: north, window: '30d' });
    expect(numberOf(teamEntry(res.body, team.alder), GROWTH_KEYS, 'Alder growth')).toBe(2);
    expect(numberOf(teamEntry(res.body, team.cedar), GROWTH_KEYS, 'Cedar growth')).toBe(-1);
  });

  it('echoes the window on the coach as well', async () => {
    const ada = await login(`ada-${RUN}@test.local`);
    const res = await askCoach(ada, north, QUESTIONS[0], '90d');
    expect([200, 201]).toContain(res.status);
    expect(windowOf(res.body)).toBe('90d');
  });
});

describe('AI Team Coach — answers from these numbers (docs/28 §4)', () => {
  it('answers all eight questions, and names numbers in the answer', async () => {
    // §4: "The coach's answer names the numbers it used. An AI answer a leader
    // cannot check is an answer they should not act on."
    const ada = await login(`ada-${RUN}@test.local`);
    for (const question of QUESTIONS) {
      const res = await askCoach(ada, north, question);
      expect([200, 201], `"${question}" → ${res.status}`).toContain(res.status);
      const answer = answerOf(res.body);
      expect(answer.length, `"${question}" answered with nothing`).toBeGreaterThan(0);

      if (question === CORRELATION_QUESTION) continue; // §6 refusal, asserted below

      // INTERPRETATION: ranks and courses are optional modules and this tenant
      // runs neither, so the honest answer to those two questions is a stated
      // absence rather than an invented name. Every other answer must carry a
      // number the leader can check.
      const optional =
        question === 'Who is close to the next milestone?' ||
        question === 'Which course should the team take next?';
      const ok = namesANumber(answer) || (optional && /no |none|not |nothing/i.test(answer));
      expect(ok, `"${question}" answered without a number: ${answer}`).toBe(true);
    }
  });

  it('names the fastest-growing team in scope, with its number', async () => {
    // Alder +2 active members, Cedar −1 (arithmetic above). Alder wins.
    const ada = await login(`ada-${RUN}@test.local`);
    const res = await askCoach(ada, north, 'Which team is growing fastest?');
    const answer = answerOf(res.body);
    expect(answer).toContain(teamName.alder);
    expect(answer).not.toContain(teamName.birch);
    expect(namesANumber(answer)).toBe(true);
  });

  it('names the team that needs support, and it is the one that shrank', async () => {
    // Cedar: 0 active of 1 member, growth −1. Lowest growth AND lowest active
    // share, so both readings in §4 agree.
    const ada = await login(`ada-${RUN}@test.local`);
    const res = await askCoach(ada, north, 'Which team needs support?');
    const answer = answerOf(res.body);
    expect(answer).toContain(teamName.cedar);
    expect(namesANumber(answer)).toBe(true);
  });

  it('names the inactive member — and only one inside the caller’s scope', async () => {
    // 30-day window: dov is the only member in ada's two teams with no
    // recorded action. piet is idle too, but piet is in Birch, which ada does
    // not lead — naming piet would be a scope breach wearing a helpful face.
    const ada = await login(`ada-${RUN}@test.local`);
    const res = await askCoach(ada, north, 'Which member is inactive?');
    const answer = answerOf(res.body);
    expect(answer).toMatch(/Estes/); // Dov Estes
    expect(answer).not.toMatch(/Lund/); // Piet Lund, in Birch
    expect(answer).not.toMatch(/Rowan/); // Bea Rowan, leader of Birch
    expect(answer).not.toMatch(/Ness|Marek/); // bo and cy are active
  });

  it('names a measure that fell, not a judgement about a person', async () => {
    // §6: "the honest answer names a measure that fell, not a judgement about
    // a person."
    const ada = await login(`ada-${RUN}@test.local`);
    const res = await askCoach(ada, north, 'Which leader needs coaching?');
    const answer = answerOf(res.body);
    expect(answer).toMatch(/engagement|active|growth/i);
    expect(namesANumber(answer)).toBe(true);
    expect(answer).not.toMatch(/underperform|poor performer|weak leader|lazy|at risk of leaving/i);
  });

  it('names the weakest measure when asked what to focus on', async () => {
    const ada = await login(`ada-${RUN}@test.local`);
    const res = await askCoach(ada, north, 'What should this team focus on?');
    const answer = answerOf(res.body);
    expect(answer).toMatch(/engagement|active|growth|new member/i);
    expect(namesANumber(answer)).toBe(true);
  });

  it('refuses the correlation question and hands back the series instead', async () => {
    // §6: correlation over a handful of teams and a few weeks is noise
    // presented as insight. The refusal is the feature.
    const ada = await login(`ada-${RUN}@test.local`);
    const res = await askCoach(ada, north, CORRELATION_QUESTION);
    expect([200, 201]).toContain(res.status);
    const answer = answerOf(res.body);
    expect(answer).toMatch(
      /not enough|too few|too little|insufficient|noise|cannot|can't|will not|won't|refus/i,
    );
    // and it says when it WILL answer — §6 promises the platform will, later
    expect(answer).toMatch(/history|enough data|over time|later|yet/i);

    // the underlying series comes back so the leader can look for themselves
    const series = pick(res.body, ['series', 'underlyingSeries', 'activities']);
    expect(Array.isArray(series), `no series returned: ${preview(res.body)}`).toBe(true);
    expect((series as unknown[]).length).toBeGreaterThan(0);

    // no fabricated coefficient anywhere, under any name
    const coefficients: string[] = [];
    const walk = (value: unknown, path: string): void => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) return value.forEach((v, i) => walk(v, `${path}[${i}]`));
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (/correlat|coefficient|rsquared|r2|pvalue/i.test(key) && typeof child === 'number') {
          coefficients.push(`${path}.${key} = ${child}`);
        }
        walk(child, `${path}.${key}`);
      }
    };
    walk(res.body, '$');
    expect(coefficients, `a correlation was invented: ${coefficients.join(', ')}`).toEqual([]);
  });

  it('never names a team outside the caller’s scope, in any of the eight answers', async () => {
    // §4: authorization happens BEFORE retrieval, so there is no filtering
    // step that can be forgotten. Checkable only from outside, like this.
    const ada = await login(`ada-${RUN}@test.local`);
    for (const question of QUESTIONS) {
      const res = await askCoach(ada, north, question);
      expect([200, 201]).toContain(res.status);
      expect(mentions(res.body, teamName.birch), `"${question}" named Birch`).toBe(false);
      expect(mentions(res.body, team.birch), `"${question}" carried Birch's id`).toBe(false);
      expect(mentions(res.body, 'Rowan'), `"${question}" named Birch's leader`).toBe(false);
      expect(mentions(res.body, 'Lund'), `"${question}" named a member of Birch`).toBe(false);
      // and nothing from the other tenant, either
      expect(mentions(res.body, SOUTH_TEAM_NAME), `"${question}" named South's team`).toBe(false);
      expect(mentions(res.body, SOUTH_MEMBER_NAME), `"${question}" named South's member`).toBe(
        false,
      );
    }
  });

  it("answers Birch's leader about Birch, and never about Alder", async () => {
    const bea = await login(`bea-${RUN}@test.local`);
    const res = await askCoach(bea, north, 'Which team needs support?');
    expect([200, 201]).toContain(res.status);
    expect(mentions(res.body, teamName.alder)).toBe(false);
    expect(mentions(res.body, teamName.cedar)).toBe(false);
    expect(mentions(res.body, 'Ness')).toBe(false); // bo
    expect(mentions(res.body, 'Marek')).toBe(false); // cy
  });

  it('refuses the coach to a member who leads nothing', async () => {
    const piet = await login(`piet-${RUN}@test.local`);
    const res = await askCoach(piet, north, 'Which team needs support?');
    expect(res.status).toBe(403);
  });
});

describe('Platform — honest about what is not measured (docs/28 §6)', () => {
  it('reports AI, storage and infrastructure cost as not measured, never as 0', async () => {
    // §6: "nothing meters them yet, and a fabricated cost is worse than a
    // missing one. The dashboard names them as not-yet-measured rather than
    // showing zero."
    const platform = await login(PLATFORM_EMAIL);
    const res = await dashboard('platform', platform, { window: '30d' });
    expect(res.status).toBe(200);

    const serialised = JSON.stringify(res.body);
    expect(serialised).toMatch(/not[- ]?(yet[- ])?measured|notMeasured|not_measured/i);
    expect(serialised).toMatch(/ai/i);
    expect(serialised).toMatch(/storage/i);
    expect(serialised).toMatch(/infrastructure|infra/i);

    // and no key that is about cost or storage may carry a number — a zero
    // here is the exact lie §6 forbids
    const zeros: string[] = [];
    const walk = (value: unknown, path: string): void => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) return value.forEach((v, i) => walk(v, `${path}[${i}]`));
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (/cost|storage|infra/i.test(key) && typeof child === 'number') {
          zeros.push(`${path}.${key} = ${child}`);
        }
        walk(child, `${path}.${key}`);
      }
    };
    walk(res.body, '$');
    expect(zeros, `a cost was reported as a number: ${zeros.join(', ')}`).toEqual([]);
  });

  it('counts tenants and members across tenants, with the window stated', async () => {
    const platform = await login(PLATFORM_EMAIL);
    const res = await dashboard('platform', platform, { window: '90d' });
    expect(res.status).toBe(200);
    expect(windowOf(res.body)).toBe('90d');
    // both fixture tenants exist, so whatever the platform counts, it counts
    // at least two of them
    const tenants = numberOf(res.body, ['tenants', 'tenantCount', 'totalTenants'], 'tenant count');
    expect(tenants).toBeGreaterThanOrEqual(2);
  });
});

describe("Isolation — another tenant's numbers stay in their tenant", () => {
  it("keeps South's member, team and activity out of North's dashboards", async () => {
    const admin = await login(`admin-n-${RUN}@test.local`);
    const ada = await login(`ada-${RUN}@test.local`);
    const bo = await login(`bo-${RUN}@test.local`);
    for (const res of [
      await dashboard('tenant', admin, { tenant: north, window: '90d' }),
      await dashboard('team', ada, { tenant: north, window: '90d' }),
      await dashboard('me', bo, { tenant: north, window: '90d' }),
    ]) {
      expect(res.status).toBe(200);
      expect(mentions(res.body, SOUTH_MEMBER_NAME)).toBe(false);
      expect(mentions(res.body, SOUTH_TEAM_NAME)).toBe(false);
      expect(mentions(res.body, zia)).toBe(false);
      expect(mentions(res.body, basalt)).toBe(false);
      expect(mentions(res.body, south)).toBe(false);
    }
  });

  it("does not let South's activity move North's numbers", async () => {
    // zia joined today and created a goal today. If tenant scoping were
    // missing, North's 90-day counts would read 4 new and 4 active instead of
    // 3 and 3.
    const admin = await login(`admin-n-${RUN}@test.local`);
    const res = await dashboard('tenant', admin, { tenant: north, window: '90d' });
    expect(numberOf(res.body, NEW_KEYS, 'North 90d newMembers')).toBe(3);
    expect(numberOf(res.body, ACTIVE_KEYS, 'North 90d activeMembers')).toBe(3);
  });

  it("shows South its own single active member, unaffected by North's", async () => {
    // South: zia joined at provisioning time (today) and created one goal.
    // Its admin member has done nothing. active = 1.
    const adminS = await login(`admin-s-${RUN}@test.local`);
    const res = await dashboard('tenant', adminS, { tenant: south, window: '30d' });
    expect(res.status).toBe(200);
    expect(numberOf(res.body, ACTIVE_KEYS, 'South activeMembers')).toBe(1);
    expect(mentions(res.body, 'Ness')).toBe(false); // bo
    expect(mentions(res.body, 'Marek')).toBe(false); // cy
    expect(mentions(res.body, teamName.alder)).toBe(false);
    expectNoHealthAnywhere("South's tenant dashboard", res.body);
  });
});
