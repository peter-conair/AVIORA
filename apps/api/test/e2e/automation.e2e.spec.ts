/**
 * Automation OS and Reward OS (spec §51, §45, §23, docs/27).
 *
 * docs/27 §1 refuses to build a second pipeline: "the automation engine is not
 * a new pipeline; it is one more handler on the existing event bus". Everything
 * in this file follows from that one sentence.
 *
 * If automation is a handler, then it inherits the outbox's failure modes, and
 * the single most important `it` here is the one that drains the SAME EVENT
 * TWICE and finds one execution and one grant. `UNIQUE (rule_id, event_id)` is
 * the only thing between a relayed delivery and a second reward — the same
 * defence the commission run needed in Sprint 10 and the rank engine in
 * Sprint 9, now protecting something a member can spend.
 *
 * The second promise is that one broken action is a broken action and not a
 * broken bus. A rule whose first action cannot succeed still runs its second,
 * still records `failed` with the error, still lets the OTHER rule on the same
 * event finish, and — the part that is easy to miss — still lets the event
 * itself drain. That is the lesson docs/27 §1 credits to the email handler in
 * Sprint 3, restated where a rule can now grant something.
 *
 * The third is validation with a reason. Spec §51 lists a dozen actions and
 * this sprint has adapters for four; the other eight are refused AT CREATION
 * WITH THE ACTION NAMED, never accepted and then silently skipped. A rule that
 * can never fire is a typo, not a configuration.
 *
 * Nothing here asserts an effect the engine could have been told about. Events
 * are caused through the modules that own them — a goal is completed through
 * the goals API, a rank is achieved by evaluating real referral data, a member
 * joins a team through the teams API — and every effect is read back through
 * the module that owns IT: the notification through the notification centre,
 * the points and the badge through gamification, the course through learning
 * progress, the grant through /rewards/me. The owner client is used only for
 * domain events, execution rows and counts.
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
import { OutboxRelayService } from '../../src/common/events/outbox-relay.service';
import { EventBus } from '../../src/common/events/event-bus';

const RUN = `a${Date.now().toString(36)}`;
const PLATFORM_EMAIL = `e2e-platform-${RUN}@test.local`;
const PW = 'e2e-password-123456';

/**
 * A syntactically valid uuid that names no course in any tenant. It is the
 * first action of the half-broken rule, and the reason that rule's execution
 * must come back `failed` rather than never happening at all.
 *
 * INTERPRETATION: docs/27 §1 says only "actions with a real adapter are
 * accepted", which is a statement about the action TYPE. Validating that the
 * rows an action REFERENCES still exist would not help anyway — a course can
 * be retired the day after a rule is written — so this suite reads creation
 * validation as shape validation, and expects a missing referent to surface at
 * execution time as `failed`, which is exactly where §1 says it belongs.
 */
const MISSING_COURSE_ID = '00000000-0000-4000-8000-0000000000ff';

/**
 * The one genuinely ambiguous encoding in this file, hoisted so it lives in a
 * single place.
 *
 * docs/27 §1 extends the condition vocabulary with "payload matchers
 * (`payload.<path>` equals a value)" and stops there — the prose fixes the
 * MEANING and not the JSON keys. The shared schema's comment on
 * `AutomationRule.conditions` does fix them:
 *
 *     [{ metric | payloadPath, comparator, threshold | value, window, graph }]
 *
 * so that is the spelling this suite sends. Every assertion built on it is
 * about behaviour — a rule that matches the payload fires and one that does not
 * does not — so if the engine spells the matcher differently, this function is
 * the one-line change and nothing else in the file moves.
 */
function payloadIs(path: string, value: string): Record<string, unknown> {
  return { payloadPath: path, comparator: 'eq', value };
}

let app: INestApplication;
let base: string;
let owner: PrismaClient;
let relay: OutboxRelayService;

/** A runs automation. B exists to be invisible from A, and vice versa. */
let tenantA: string;
let tenantB: string;
/** Every tenant this file may drain events for. */
const TENANTS: string[] = [];

let pathfinderPlanId: string;
let summitPlanId: string;
let beaconPlanId: string;

/**
 * Tenant A.
 *   iva   completes goals and earns a rank — the member the firing rules act on
 *   noor  joins a team, which is the event the half-broken rule fires on
 *   pell  is the only member who buys anything, so the metric condition can be
 *         false and then true for the SAME rule without touching anyone else
 *   rune  causes nothing: every grant rune holds was handed over by an admin
 */
const m: Record<'iva' | 'noor' | 'pell' | 'rune', string> = {} as never;
/** Tenant B. */
let sol: string;

let seededCourseId: string;
let crestTeamId: string;
let beaconOfferingId: string;

/** Reward definition ids, kept so grants can be counted per reward. */
const reward: Record<
  'spark' | 'trailblazer' | 'applause' | 'firstSteps' | 'keepsake' | 'bounty' | 'elevate',
  string
> = {} as never;

/** Rule ids. */
const rule: Record<'celebrate' | 'rankReward' | 'halfBroken' | 'witness' | 'spendGated', string> =
  {} as never;

/** Event ids, kept so a single delivery can be replayed verbatim. */
const evt: Record<'goalOne' | 'goalTwo' | 'joinedTeam' | 'pellFirstGoal', string> = {} as never;

let bronzeRankId: string;
let keepsakeGrantId: string;

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

/**
 * Automation only ever runs on a DRAINED event, so every test that expects a
 * rule to have fired says so out loud by calling this. Nothing in this file
 * fires by accident, and nothing fires without a test having asked for it.
 */
async function drainOutbox(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const pending = await owner.domainEvent.count({
      where: {
        tenantId: { in: TENANTS },
        processedAt: null,
        attempts: { lt: 5 },
        nextAttemptAt: { lte: new Date() },
      },
    });
    if (pending === 0) return;
    await relay.tick();
  }
  throw new Error('outbox did not drain for these tenants');
}

/** The outbox row a module wrote when it did the thing we asked it to do. */
async function eventIdFor(tenant: string, eventName: string, aggregateId: string): Promise<string> {
  const row = await owner.domainEvent.findFirst({
    where: { tenantId: tenant, eventName, aggregateId },
    orderBy: { occurredAt: 'desc' },
  });
  expect(row, `no ${eventName} event for ${aggregateId}`).toBeTruthy();
  return row!.id;
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
 * Hands one already-delivered event back to the relay as if the delivery had
 * never happened: the per-handler ledger is cleared and the outbox row is put
 * back on the queue. This is a redelivery, which is the thing the outbox
 * promises AT LEAST ONCE of — and therefore the thing the rule engine has to
 * survive without granting twice.
 */
async function replayEvent(eventId: string): Promise<void> {
  await owner.processedEvent.deleteMany({ where: { eventId } });
  await owner.domainEvent.update({
    where: { id: eventId },
    data: { processedAt: null, attempts: 0, nextAttemptAt: new Date(), lastError: null },
  });
  await drainOutbox();
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
  const invited = await owner.domainEvent.findFirst({
    where: { eventName: 'MemberInvited', aggregateId: inv.body.invitation.id },
  });
  const accepted = await api(
    `/api/v1/invitations/${(invited!.payload as { token: string }).token}/accept`,
    { method: 'POST', body: JSON.stringify({ displayName: name, password: PW }) },
  );
  expect(accepted.status).toBe(201);
  return accepted.body.memberId;
}

/** A real, fully paid order — the only way personal_volume moves in this file. */
async function buy(
  email: string,
  tenant: string,
  adminToken: string,
  offeringId: string,
): Promise<number> {
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
  return order.totalMinor as number;
}

/** Creates a goal as the member and returns its id. */
async function createGoal(token: string, tenant: string, title: string, category = 'personal') {
  const res = await api('/api/v1/goals', {
    method: 'POST',
    token,
    tenant,
    body: JSON.stringify({ title, category }),
  });
  expect(res.status).toBe(201);
  return res.body.goal.id as string;
}

async function completeGoal(token: string, tenant: string, goalId: string) {
  const res = await api(`/api/v1/goals/${goalId}`, {
    method: 'PATCH',
    token,
    tenant,
    body: JSON.stringify({ status: 'completed' }),
  });
  expect(res.status).toBe(200);
  expect(res.body.goal.status).toBe('completed');
}

/* ── shape tolerance ──────────────────────────────────────────────────────
 * docs/27 §5 fixes the routes and the schema fixes the columns, but not the
 * JSON envelope. The readers below are lenient about WHERE a value sits;
 * every assertion built on them is exact about WHAT it is.
 * ------------------------------------------------------------------------ */

function idOf(body: any, ...keys: string[]): string {
  for (const key of keys) {
    const candidate = body?.[key]?.id ?? (typeof body?.[key] === 'string' ? body[key] : undefined);
    if (typeof candidate === 'string') return candidate;
  }
  expect(typeof body?.id, `no id on ${JSON.stringify(body)?.slice(0, 200)}`).toBe('string');
  return body.id as string;
}

function rulesOf(body: any): any[] {
  return body?.rules ?? body?.automationRules ?? body?.items ?? [];
}

function executionsOf(body: any): any[] {
  return body?.executions ?? body?.automationExecutions ?? body?.items ?? [];
}

function definitionsOf(body: any): any[] {
  return body?.definitions ?? body?.rewardDefinitions ?? body?.rewards ?? body?.items ?? [];
}

function grantsOf(body: any): any[] {
  return body?.grants ?? body?.rewardGrants ?? body?.rewards ?? body?.items ?? [];
}

/** A grant still counts as held unless it says otherwise. */
function activeGrants(body: any): any[] {
  return grantsOf(body).filter((g: any) => (g.status ?? 'granted') === 'granted');
}

function ranksOf(body: any): any[] {
  return body?.ranks ?? body?.ladder ?? body?.items ?? [];
}

function currentRank(body: any): any {
  return body?.rank ?? body?.currentRank ?? body?.current ?? null;
}

/** docs/27 §3 names the column; the JSON key is read either way, once. */
function recommendedOf(node: any): string[] {
  const value = node?.recommendedCourseIds ?? node?.recommendedCourses ?? node?.recommended;
  if (!Array.isArray(value)) return [];
  return value.map((v: any) => (typeof v === 'string' ? v : (v?.id ?? v?.courseId)));
}

async function notificationTitles(token: string, tenant: string): Promise<string[]> {
  const res = await api('/api/v1/notifications', { token, tenant });
  expect(res.status).toBe(200);
  return (res.body.notifications ?? []).map((n: { title: string }) => n.title);
}

/* ── owner-client readers: events, execution rows and counts only ───────── */

async function executionRows(
  tenant: string,
  where: { ruleId?: string; eventId?: string; memberId?: string } = {},
): Promise<any[]> {
  return withTenant(tenant, (tx) =>
    tx.automationExecution.findMany({ where, orderBy: { createdAt: 'asc' } }),
  );
}

async function grantCount(
  tenant: string,
  where: { rewardId?: string; memberId?: string; status?: string },
): Promise<number> {
  return withTenant(tenant, (tx) => tx.rewardGrant.count({ where }));
}

async function createRule(
  adminToken: string,
  tenant: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  return api('/api/v1/automation/rules', {
    method: 'POST',
    token: adminToken,
    tenant,
    body: JSON.stringify(body),
  });
}

async function createReward(
  adminToken: string,
  tenant: string,
  body: Record<string, unknown>,
): Promise<string> {
  const res = await api('/api/v1/rewards/definitions', {
    method: 'POST',
    token: adminToken,
    tenant,
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(201);
  const definition = res.body.definition ?? res.body.reward ?? res.body;
  expect(definition.code).toBe(body['code']);
  expect(definition.type).toBe(body['type']);
  return definition.id as string;
}

async function grantByHand(
  adminToken: string,
  tenant: string,
  rewardCode: string,
  memberId: string,
): Promise<{ status: number; body: any }> {
  return api('/api/v1/rewards/grants', {
    method: 'POST',
    token: adminToken,
    tenant,
    body: JSON.stringify({ rewardCode, memberId }),
  });
}

beforeAll(async () => {
  process.env.AVIORA_OUTBOX_DISABLED = 'true';
  process.env.AVIORA_PII_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
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
  relay = app.get(OutboxRelayService);
  // No SMTP here. Handlers are independent by design (docs/11 §idempotency),
  // so dropping the email consumers changes nothing this file asserts — but
  // leaving them in would fail every drain and never let automation run.
  const registry = (app.get(EventBus) as unknown as { handlers: Map<string, { name: string }[]> })
    .handlers;
  registry.forEach((list, key) =>
    registry.set(
      key,
      list.filter((r) => !r.name.startsWith('email.')),
    ),
  );

  const platform = await login(PLATFORM_EMAIL);
  const mkTenant = async (suffix: string, name: string, adminEmail: string) => {
    const res = await api('/api/v1/platform/tenants', {
      method: 'POST',
      token: platform,
      body: JSON.stringify({
        code: `e2e_au_${suffix}_${RUN}`,
        name,
        slug: `e2e-au-${suffix}-${RUN}`,
        adminEmail,
        adminDisplayName: 'Admin',
        adminPassword: PW,
      }),
    });
    expect(res.status).toBe(201);
    return res.body as { tenant: { id: string }; adminMemberId: string };
  };
  tenantA = (await mkTenant('a', 'Automation Co', `admin-a-${RUN}@test.local`)).tenant.id;
  tenantB = (await mkTenant('b', 'Quiet Co', `admin-b-${RUN}@test.local`)).tenant.id;
  TENANTS.push(tenantA, tenantB);

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

  const adminA = await login(`admin-a-${RUN}@test.local`);
  // growth.ranks makes /ranks/me visible (the recommended-learning case);
  // commerce.enabled only exists so pell can generate the volume the metric
  // condition is read from; course.access so an assigned course is startable.
  pathfinderPlanId = await mkPlan(adminA, tenantA, 'pathfinder', 'Pathfinder', [
    ENTITLEMENTS.RANKS,
    ENTITLEMENTS.COMMERCE,
    ENTITLEMENTS.COURSE_ACCESS,
  ]);
  // Named by a membership_upgrade reward that must NOT move anybody onto it.
  summitPlanId = await mkPlan(adminA, tenantA, 'summit', 'Summit', [
    ENTITLEMENTS.RANKS,
    ENTITLEMENTS.COMMERCE,
    ENTITLEMENTS.COURSE_ACCESS,
    ENTITLEMENTS.MENTOR_ACCESS,
  ]);

  m.iva = await addMember(adminA, tenantA, pathfinderPlanId, `iva-${RUN}@test.local`, 'Iva');
  m.noor = await addMember(adminA, tenantA, pathfinderPlanId, `noor-${RUN}@test.local`, 'Noor');
  m.pell = await addMember(adminA, tenantA, pathfinderPlanId, `pell-${RUN}@test.local`, 'Pell');
  m.rune = await addMember(adminA, tenantA, pathfinderPlanId, `rune-${RUN}@test.local`, 'Rune');

  // Every tenant is provisioned with one published course; the assign_course
  // adapter is pointed at THIS one when it must succeed, and at a uuid that
  // names nothing when it must fail.
  const courses = await api('/api/v1/courses', { token: adminA, tenant: tenantA });
  expect(courses.status).toBe(200);
  expect(courses.body.courses.length).toBeGreaterThan(0);
  seededCourseId = courses.body.courses[0].id;

  const team = await api('/api/v1/teams', {
    method: 'POST',
    token: adminA,
    tenant: tenantA,
    body: JSON.stringify({ code: 'crest', name: 'Crest' }),
  });
  expect(team.status).toBe(201);
  crestTeamId = team.body.team.id;

  const offering = await api('/api/v1/offerings', {
    method: 'POST',
    token: adminA,
    tenant: tenantA,
    body: JSON.stringify({
      code: 'beacon',
      name: 'Beacon pass',
      kind: 'one_time',
      currency: 'THB',
      priceMinor: 60_000,
    }),
  });
  expect(offering.status).toBe(201);
  beaconOfferingId = offering.body.offering.id;

  const adminB = await login(`admin-b-${RUN}@test.local`);
  beaconPlanId = await mkPlan(adminB, tenantB, 'quiet', 'Quiet', [ENTITLEMENTS.RANKS]);
  sol = await addMember(adminB, tenantB, beaconPlanId, `sol-${RUN}@test.local`, 'Sol');

  // Everything the fixture caused is delivered before the first rule exists,
  // so no rule in this file can fire on setup.
  await drainOutbox();
}, 300_000);

afterAll(async () => {
  await app?.close();
  await owner?.$disconnect();
});

describe('A rule is refused with a reason, or it is not stored at all (docs/27 §1)', () => {
  const refused = async (body: Record<string, unknown>) => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const res = await createRule(admin, tenantA, body);
    expect([400, 409, 422]).toContain(res.status);
    expect(['VALIDATION_FAILED', 'CONFLICT']).toContain(res.body.error.code);
    return res;
  };

  const grantSpark = { type: 'grant_reward', rewardCode: 'spark' };

  it('starts from a tenant that has configured no automation at all', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const res = await api('/api/v1/automation/rules', { token: admin, tenant: tenantA });
    expect(res.status).toBe(200);
    expect(rulesOf(res.body)).toHaveLength(0);

    const executions = await api('/api/v1/automation/executions', {
      token: admin,
      tenant: tenantA,
    });
    expect(executions.status).toBe(200);
    expect(executionsOf(executions.body)).toHaveLength(0);
  });

  it('rejects a trigger that is not an event in the catalog', async () => {
    // "A rule naming an event that does not exist is rejected at creation — a
    // rule that can never fire is a typo, not a configuration."
    const res = await refused({
      code: 'never-fires',
      name: 'When someone feels ready',
      triggerEvent: 'MemberBecameCurious',
      conditions: [],
      actions: [grantSpark],
    });
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    // and the reason names the thing that was wrong with it
    expect(JSON.stringify(res.body.error)).toContain('MemberBecameCurious');
  });

  it('rejects send_email — and says send_email, rather than dropping it quietly', async () => {
    // Spec §51 lists it; docs/27 §1 has no adapter for it. The failure mode
    // this test exists to prevent is a rule that LOOKS configured and never
    // sends anything.
    const res = await refused({
      code: 'mail-them',
      name: 'Email on completion',
      triggerEvent: 'GoalCompleted',
      conditions: [],
      actions: [{ type: 'send_email', subject: 'Well done', body: 'Well done' }],
    });
    expect(JSON.stringify(res.body.error)).toContain('send_email');
  });

  it('rejects trigger_workflow, the action that would let a rule fire a rule', async () => {
    // "rules that fire rules are how an automation engine becomes a loop
    // nobody can trace. It arrives when there is a depth guard to go with it."
    const res = await refused({
      code: 'chain-them',
      name: 'Kick off another rule',
      triggerEvent: 'GoalCompleted',
      conditions: [],
      actions: [{ type: 'trigger_workflow', workflowCode: 'onboarding' }],
    });
    expect(JSON.stringify(res.body.error)).toContain('trigger_workflow');
  });

  it('rejects the whole rule when only the SECOND action lacks an adapter', async () => {
    // A partially-valid rule is the dangerous one: half of it would work, so
    // nobody would notice the other half never ran.
    const res = await refused({
      code: 'half-supported',
      name: 'Notify, then run an AI thing',
      triggerEvent: 'GoalCompleted',
      conditions: [],
      actions: [
        { type: 'send_notification', title: 'Nice work', body: 'Nice work' },
        { type: 'run_ai', prompt: 'Say something encouraging' },
      ],
    });
    expect(JSON.stringify(res.body.error)).toContain('run_ai');
  });

  it('rejects an unknown metric in a condition', async () => {
    // The condition vocabulary is the rank and compensation vocabulary; a
    // metric nobody can compute is a condition that can never be true.
    const res = await refused({
      code: 'vibes-gate',
      name: 'When the vibes are right',
      triggerEvent: 'GoalCompleted',
      conditions: [{ metric: 'team_spirit', comparator: 'gte', threshold: 10, window: 'lifetime' }],
      actions: [grantSpark],
    });
    expect(JSON.stringify(res.body.error)).toContain('team_spirit');
  });

  it('rejects an unknown comparator and an unknown window too', async () => {
    await refused({
      code: 'roughly-gate',
      name: 'Roughly enough volume',
      triggerEvent: 'GoalCompleted',
      conditions: [
        {
          metric: 'personal_volume',
          comparator: 'approximately',
          threshold: 10,
          window: 'lifetime',
        },
      ],
      actions: [grantSpark],
    });
    await refused({
      code: 'someday-gate',
      name: 'Volume, at some point',
      triggerEvent: 'GoalCompleted',
      conditions: [
        { metric: 'personal_volume', comparator: 'gte', threshold: 10, window: 'rolling_7' },
      ],
      actions: [grantSpark],
    });
  });

  it('rejects a rule with no actions — a rule that does nothing is not a rule', async () => {
    await refused({
      code: 'does-nothing',
      name: 'Fires and shrugs',
      triggerEvent: 'GoalCompleted',
      conditions: [],
      actions: [],
    });
  });

  it('and none of the refused rules landed, nor anything they would have done', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const res = await api('/api/v1/automation/rules', { token: admin, tenant: tenantA });
    expect(res.status).toBe(200);
    expect(rulesOf(res.body)).toHaveLength(0);

    // not half-stored means not stored at the table either
    const rows = await withTenant(tenantA, (tx) => tx.automationRule.count());
    expect(rows).toBe(0);
    // and no execution was recorded for a rule that was never created
    expect(await withTenant(tenantA, (tx) => tx.automationExecution.count())).toBe(0);
  });
});

describe('Rewards are definitions before they are anything else (docs/27 §2)', () => {
  it('a tenant defines rewards of several types, including the ones nobody pays out', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    reward.spark = await createReward(admin, tenantA, {
      code: 'spark',
      name: 'Spark',
      type: 'points',
      config: { points: 50 },
    });
    reward.trailblazer = await createReward(admin, tenantA, {
      code: 'trailblazer',
      name: 'Trailblazer',
      type: 'badge',
      config: { badgeCode: 'trailblazer', badgeName: 'Trailblazer' },
    });
    reward.applause = await createReward(admin, tenantA, {
      code: 'applause',
      name: 'Applause',
      type: 'recognition',
    });
    reward.firstSteps = await createReward(admin, tenantA, {
      code: 'first-steps',
      name: 'First steps',
      type: 'points',
      config: { points: 25 },
    });
    reward.keepsake = await createReward(admin, tenantA, {
      code: 'keepsake',
      name: 'Keepsake certificate',
      type: 'certificate',
    });
    // "recorded, never paid. Paying is compensation's job" (docs/27 §2)
    reward.bounty = await createReward(admin, tenantA, {
      code: 'bounty',
      name: 'Founders bounty',
      type: 'cash',
      config: { amountMinor: 500_000, currency: 'THB' },
    });
    // "records the intent; changing a plan stays a deliberate act"
    reward.elevate = await createReward(admin, tenantA, {
      code: 'elevate',
      name: 'Move to Summit',
      type: 'membership_upgrade',
      config: { planCode: 'summit' },
    });

    const list = await api('/api/v1/rewards/definitions', { token: admin, tenant: tenantA });
    expect(list.status).toBe(200);
    const byCode = new Map(definitionsOf(list.body).map((d: any) => [d.code, d]));
    expect([...byCode.keys()].sort()).toEqual(
      ['applause', 'bounty', 'elevate', 'first-steps', 'keepsake', 'spark', 'trailblazer'].sort(),
    );
    expect(byCode.get('spark').type).toBe('points');
    expect(byCode.get('spark').config.points).toBe(50);
    expect(byCode.get('bounty').type).toBe('cash');
    expect(byCode.get('elevate').type).toBe('membership_upgrade');
  });

  it('refuses a reward type the platform has never heard of', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const res = await api('/api/v1/rewards/definitions', {
      method: 'POST',
      token: admin,
      tenant: tenantA,
      body: JSON.stringify({ code: 'karma', name: 'Karma', type: 'good_vibes' }),
    });
    expect([400, 422]).toContain(res.status);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');

    const list = await api('/api/v1/rewards/definitions', { token: admin, tenant: tenantA });
    expect(definitionsOf(list.body).map((d: any) => d.code)).not.toContain('karma');
  });

  it('refuses a second definition with the same code', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const res = await api('/api/v1/rewards/definitions', {
      method: 'POST',
      token: admin,
      tenant: tenantA,
      body: JSON.stringify({
        code: 'spark',
        name: 'Spark, again',
        type: 'points',
        config: { points: 9_999 },
      }),
    });
    expect([400, 409, 422]).toContain(res.status);
    expect(
      await withTenant(tenantA, (tx) => tx.rewardDefinition.count({ where: { code: 'spark' } })),
    ).toBe(1);
  });
});

describe('A rule fires when its event is drained — and its effects are real', () => {
  it('a tenant configures three adapters on one trigger, and they are stored as data', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const res = await createRule(admin, tenantA, {
      code: 'celebrate-goal',
      name: 'Celebrate a completed goal',
      triggerEvent: 'GoalCompleted',
      conditions: [],
      priority: 10,
      actions: [
        { type: 'send_notification', title: `Goal complete ${RUN}`, body: 'You finished a goal.' },
        { type: 'grant_reward', rewardCode: 'spark' },
        { type: 'assign_course', courseId: seededCourseId },
      ],
    });
    expect(res.status).toBe(201);
    rule.celebrate = idOf(res.body, 'rule');

    // a tenant can audit its own automation without reading anybody's source
    const list = await api('/api/v1/automation/rules', { token: admin, tenant: tenantA });
    const stored = rulesOf(list.body).find((r: any) => r.id === rule.celebrate);
    expect(stored.triggerEvent).toBe('GoalCompleted');
    expect(stored.status).toBe('active');
    expect(stored.conditions).toEqual([]);
    expect(stored.actions.map((a: any) => a.type)).toEqual([
      'send_notification',
      'grant_reward',
      'assign_course',
    ]);
  });

  it('nothing happens while the event is still in the outbox', async () => {
    // Automation is a handler on the bus, so an undelivered event is an
    // unfired rule. This is the baseline the next test moves off.
    const iva = await login(`iva-${RUN}@test.local`);
    const goal = await createGoal(iva, tenantA, 'Walk 10 km');
    await completeGoal(iva, tenantA, goal);
    evt.goalOne = await eventIdFor(tenantA, 'GoalCompleted', goal);

    expect(await executionRows(tenantA, { eventId: evt.goalOne })).toHaveLength(0);
    expect(await grantCount(tenantA, { memberId: m.iva })).toBe(0);
  });

  it('draining the event runs every action, and each is visible in its own module', async () => {
    await drainOutbox();
    const iva = await login(`iva-${RUN}@test.local`);

    // 1. the notification centre holds the notification the rule asked for —
    //    next to the welcome one the platform sends on its own, which is how
    //    we know the rule's is the rule's
    const titles = await notificationTitles(iva, tenantA);
    expect(titles).toContain(`Goal complete ${RUN}`);
    expect(titles).toContain('Welcome to Automation Co');

    // 2. the grant is a grant the member can see
    const mine = await api('/api/v1/rewards/me', { token: iva, tenant: tenantA });
    expect(mine.status).toBe(200);
    expect(activeGrants(mine.body)).toHaveLength(1);
    expect(activeGrants(mine.body)[0].rewardId ?? activeGrants(mine.body)[0].reward?.id).toBe(
      reward.spark,
    );

    // 3. the course was assigned, and learning is where that shows up
    const progress = await api('/api/v1/learning/progress', { token: iva, tenant: tenantA });
    expect(progress.status).toBe(200);
    expect(progress.body.progress.map((p: { courseId: string }) => p.courseId)).toContain(
      seededCourseId,
    );

    // and the execution row is the audit trail: what fired, on what event
    const rows = await executionRows(tenantA, { eventId: evt.goalOne, ruleId: rule.celebrate });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('success');
    expect(rows[0].memberId).toBe(m.iva);
    expect(rows[0].error).toBeNull();
  }, 60_000);

  it('points delegate to gamification rather than being counted twice', async () => {
    // "points live in one place only" (docs/27 §2). This tenant has configured
    // NO gamification rule, so the only points it can hold came from a reward.
    const iva = await login(`iva-${RUN}@test.local`);
    const standing = await api('/api/v1/gamification/me', { token: iva, tenant: tenantA });
    expect(standing.status).toBe(200);
    expect(standing.body.points).toBe(50);
  });

  it('a rule with no conditions fires again on the next occurrence', async () => {
    const iva = await login(`iva-${RUN}@test.local`);
    const goal = await createGoal(iva, tenantA, 'Swim 2 km');
    await completeGoal(iva, tenantA, goal);
    evt.goalTwo = await eventIdFor(tenantA, 'GoalCompleted', goal);
    expect(evt.goalTwo).not.toBe(evt.goalOne);
    await drainOutbox();

    // one execution per EVENT, not one per rule for all time
    expect(await executionRows(tenantA, { ruleId: rule.celebrate })).toHaveLength(2);
    expect(await grantCount(tenantA, { memberId: m.iva, rewardId: reward.spark })).toBe(2);
    // 50 + 50, through gamification, which is the only place points live
    const standing = await api('/api/v1/gamification/me', { token: iva, tenant: tenantA });
    expect(standing.body.points).toBe(100);
  }, 60_000);

  it('the execution list is the audit trail, newest first', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const res = await api('/api/v1/automation/executions', { token: admin, tenant: tenantA });
    expect(res.status).toBe(200);
    const rows = executionsOf(res.body);
    const first = rows.findIndex((r: any) => r.eventId === evt.goalOne);
    const second = rows.findIndex((r: any) => r.eventId === evt.goalTwo);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThanOrEqual(0);
    // the LATER event is listed EARLIER — asserted by position, so the sort
    // key's name does not have to be guessed
    expect(second).toBeLessThan(first);
  });

  it('automation itself emits nothing (docs/27 §6)', async () => {
    // "a rule that emitted an event would be a rule that can trigger a rule."
    // Rewards emit; the engine that granted them does not.
    const emitted = await owner.domainEvent.findMany({
      where: { tenantId: tenantA },
      select: { eventName: true },
      distinct: ['eventName'],
    });
    const names = emitted.map((e) => e.eventName);
    expect(names.some((n) => n.startsWith('Automation') || n.startsWith('Rule'))).toBe(false);
    expect(names).toContain('RewardGranted');
  });

  it('a disabled rule stops firing, and the ones still enabled do not', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const patched = await api(`/api/v1/automation/rules/${rule.celebrate}`, {
      method: 'PATCH',
      token: admin,
      tenant: tenantA,
      body: JSON.stringify({ status: 'disabled', priority: 55 }),
    });
    expect([200, 201]).toContain(patched.status);
    const updated = patched.body.rule ?? patched.body;
    expect(updated.status).toBe('disabled');
    expect(updated.priority).toBe(55);

    const iva = await login(`iva-${RUN}@test.local`);
    const goal = await createGoal(iva, tenantA, 'Cycle 50 km');
    await completeGoal(iva, tenantA, goal);
    await drainOutbox();

    // still two executions and two grants: the third goal produced neither
    expect(await executionRows(tenantA, { ruleId: rule.celebrate })).toHaveLength(2);
    expect(await grantCount(tenantA, { memberId: m.iva, rewardId: reward.spark })).toBe(2);
    const standing = await api('/api/v1/gamification/me', { token: iva, tenant: tenantA });
    expect(standing.body.points).toBe(100);

    // put it back so the idempotency replay below exercises a live rule
    const back = await api(`/api/v1/automation/rules/${rule.celebrate}`, {
      method: 'PATCH',
      token: admin,
      tenant: tenantA,
      body: JSON.stringify({ status: 'active' }),
    });
    expect([200, 201]).toContain(back.status);
  }, 60_000);
});

describe('Idempotency — one event fires a rule once, however often it is delivered', () => {
  /**
   * The most important test in the file. The outbox promises AT LEAST ONCE, so
   * a redelivery is not a fault to be prevented — it is a normal Tuesday. The
   * only thing between it and a second reward is `UNIQUE (rule_id, event_id)`.
   */
  it('redelivering the same event writes no second execution and grants no second reward', async () => {
    const before = {
      executions: (await executionRows(tenantA, { eventId: evt.goalOne })).length,
      grants: await grantCount(tenantA, { memberId: m.iva, rewardId: reward.spark }),
      granted: await eventCount(tenantA, 'RewardGranted'),
    };
    expect(before.executions).toBe(1);
    expect(before.grants).toBe(2);

    await replayEvent(evt.goalOne);

    expect(await executionRows(tenantA, { eventId: evt.goalOne })).toHaveLength(1);
    expect(await grantCount(tenantA, { memberId: m.iva, rewardId: reward.spark })).toBe(2);
    expect(await eventCount(tenantA, 'RewardGranted')).toBe(before.granted);

    const iva = await login(`iva-${RUN}@test.local`);
    const standing = await api('/api/v1/gamification/me', { token: iva, tenant: tenantA });
    expect(standing.body.points).toBe(100);
  }, 60_000);

  it('and a SECOND redelivery moves nothing either', async () => {
    // Once could be a handler ledger that happened to remember. Twice is the
    // unique key doing its job.
    await replayEvent(evt.goalOne);
    await replayEvent(evt.goalTwo);
    await replayEvent(evt.goalOne);

    expect(await executionRows(tenantA, { ruleId: rule.celebrate })).toHaveLength(2);
    expect(await executionRows(tenantA, { eventId: evt.goalOne })).toHaveLength(1);
    expect(await executionRows(tenantA, { eventId: evt.goalTwo })).toHaveLength(1);
    expect(await grantCount(tenantA, { memberId: m.iva, rewardId: reward.spark })).toBe(2);

    const iva = await login(`iva-${RUN}@test.local`);
    expect(
      (await api('/api/v1/gamification/me', { token: iva, tenant: tenantA })).body.points,
    ).toBe(100);
    // the member's own view agrees: two sparks, not four
    const mine = await api('/api/v1/rewards/me', { token: iva, tenant: tenantA });
    expect(
      activeGrants(mine.body).filter((g: any) => (g.rewardId ?? g.reward?.id) === reward.spark),
    ).toHaveLength(2);

    // the notification is not duplicated either — the whole rule ran once
    const titles = await notificationTitles(iva, tenantA);
    expect(titles.filter((t) => t === `Goal complete ${RUN}`)).toHaveLength(2);
  }, 90_000);
});

describe('Failure isolation — a broken action is not a broken bus (docs/27 §1)', () => {
  it('a tenant configures two rules on one trigger, one of which cannot fully succeed', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);

    const broken = await createRule(admin, tenantA, {
      code: 'welcome-pack',
      name: 'Welcome pack',
      triggerEvent: 'MemberJoinedTeam',
      conditions: [],
      priority: 10,
      actions: [
        // this course does not exist, and the rule was written when nobody
        // could know that — which is why it must fail HERE and not at creation
        { type: 'assign_course', courseId: MISSING_COURSE_ID },
        { type: 'send_notification', title: `Welcome aboard ${RUN}`, body: 'Say hello.' },
      ],
    });
    expect(broken.status).toBe(201);
    rule.halfBroken = idOf(broken.body, 'rule');

    const witness = await createRule(admin, tenantA, {
      code: 'team-applause',
      name: 'Applause for joining',
      triggerEvent: 'MemberJoinedTeam',
      conditions: [],
      priority: 20,
      actions: [{ type: 'grant_reward', rewardCode: 'applause' }],
    });
    expect(witness.status).toBe(201);
    rule.witness = idOf(witness.body, 'rule');
  });

  it('the broken rule records failed with its error, and still runs its second action', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const joined = await api(`/api/v1/teams/${crestTeamId}/members`, {
      method: 'POST',
      token: admin,
      tenant: tenantA,
      body: JSON.stringify({ memberId: m.noor }),
    });
    expect(joined.status).toBe(201);
    evt.joinedTeam = await eventIdFor(tenantA, 'MemberJoinedTeam', crestTeamId);
    await drainOutbox();

    const rows = await executionRows(tenantA, {
      eventId: evt.joinedTeam,
      ruleId: rule.halfBroken,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('failed');
    expect(typeof rows[0].error).toBe('string');
    expect(rows[0].error.length).toBeGreaterThan(0);

    // …and the action AFTER the failure still ran: the notification arrived
    const noor = await login(`noor-${RUN}@test.local`);
    expect(await notificationTitles(noor, tenantA)).toContain(`Welcome aboard ${RUN}`);
  }, 60_000);

  it('the other rule on the same event succeeded — which is the whole point', async () => {
    const rows = await executionRows(tenantA, {
      eventId: evt.joinedTeam,
      ruleId: rule.witness,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('success');

    const noor = await login(`noor-${RUN}@test.local`);
    const mine = await api('/api/v1/rewards/me', { token: noor, tenant: tenantA });
    expect(mine.status).toBe(200);
    expect(activeGrants(mine.body)).toHaveLength(1);
    expect(activeGrants(mine.body)[0].rewardId ?? activeGrants(mine.body)[0].reward?.id).toBe(
      reward.applause,
    );
  });

  it('and the event itself drained — a failed action does not wedge the outbox', async () => {
    const row = await owner.domainEvent.findUnique({ where: { id: evt.joinedTeam } });
    expect(row?.processedAt).toBeTruthy();

    // the platform's own handler for this event ran too: the failure was
    // contained inside one rule, not spread across the bus
    const noor = await login(`noor-${RUN}@test.local`);
    expect(await notificationTitles(noor, tenantA)).toContain('You joined a team');
  });

  it('redelivering the failed event does not double what DID work', async () => {
    // A failure is the case where a retry is most tempting and most dangerous:
    // the succeeding half would run again. `UNIQUE (rule_id, event_id)` covers
    // the failed rule exactly as it covers the successful one.
    const applauseBefore = await grantCount(tenantA, {
      memberId: m.noor,
      rewardId: reward.applause,
    });
    await replayEvent(evt.joinedTeam);

    expect(
      await executionRows(tenantA, { eventId: evt.joinedTeam, ruleId: rule.halfBroken }),
    ).toHaveLength(1);
    expect(
      await executionRows(tenantA, { eventId: evt.joinedTeam, ruleId: rule.witness }),
    ).toHaveLength(1);
    expect(await grantCount(tenantA, { memberId: m.noor, rewardId: reward.applause })).toBe(
      applauseBefore,
    );

    const noor = await login(`noor-${RUN}@test.local`);
    const titles = await notificationTitles(noor, tenantA);
    expect(titles.filter((t) => t === `Welcome aboard ${RUN}`)).toHaveLength(1);
  }, 60_000);
});

describe('Conditions — a rule that should not fire does not fire', () => {
  it('a tenant gates a rule on a metric, and on a value in the payload', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const res = await createRule(admin, tenantA, {
      code: 'spend-gated-welcome',
      name: 'Reward the members who bought in',
      triggerEvent: 'GoalCreated',
      conditions: [
        // the rank/compensation vocabulary, unchanged (docs/27 §1)
        { metric: 'personal_volume', comparator: 'gte', threshold: 50_000, window: 'lifetime' },
        // …plus a payload matcher; see payloadIs above for the one thing in
        // this file whose spelling docs/27 leaves open
        payloadIs('category', 'business'),
      ],
      priority: 30,
      actions: [{ type: 'grant_reward', rewardCode: 'first-steps' }],
    });
    expect(res.status).toBe(201);
    rule.spendGated = idOf(res.body, 'rule');
  });

  it('a member whose metric is not met does not fire it, and holds nothing', async () => {
    const pell = await login(`pell-${RUN}@test.local`);
    const goal = await createGoal(pell, tenantA, 'Open a second location', 'business');
    evt.pellFirstGoal = await eventIdFor(tenantA, 'GoalCreated', goal);
    await drainOutbox();

    // docs/27 §1 makes executions the audit trail without saying whether a rule
    // that declined to fire leaves a row; either answer is honest, and NEITHER
    // may leave a grant behind.
    const rows = await executionRows(tenantA, {
      eventId: evt.pellFirstGoal,
      ruleId: rule.spendGated,
    });
    expect(rows.length).toBeLessThanOrEqual(1);
    if (rows[0]) expect(rows[0].status).toBe('skipped');
    expect(await grantCount(tenantA, { memberId: m.pell })).toBe(0);

    const mine = await api('/api/v1/rewards/me', { token: pell, tenant: tenantA });
    expect(mine.status).toBe(200);
    expect(activeGrants(mine.body)).toHaveLength(0);
  }, 60_000);

  it('the same rule fires once the member’s own data passes it', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    // 60_000 ≥ 50_000 — real money through the commerce API, never a number
    // handed to the engine
    expect(await buy(`pell-${RUN}@test.local`, tenantA, admin, beaconOfferingId)).toBe(60_000);

    const pell = await login(`pell-${RUN}@test.local`);
    const goal = await createGoal(pell, tenantA, 'Hire a second coach', 'business');
    const eventId = await eventIdFor(tenantA, 'GoalCreated', goal);
    await drainOutbox();

    const rows = await executionRows(tenantA, { eventId, ruleId: rule.spendGated });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('success');
    expect(rows[0].memberId).toBe(m.pell);

    const mine = await api('/api/v1/rewards/me', { token: pell, tenant: tenantA });
    expect(activeGrants(mine.body)).toHaveLength(1);
    expect(activeGrants(mine.body)[0].rewardId ?? activeGrants(mine.body)[0].reward?.id).toBe(
      reward.firstSteps,
    );
    // 25 points, from the reward, through gamification
    expect(
      (await api('/api/v1/gamification/me', { token: pell, tenant: tenantA })).body.points,
    ).toBe(25);
  }, 90_000);

  it('the payload matcher is load-bearing: the metric alone is not enough', async () => {
    // pell now clears the volume threshold, so a goal in a DIFFERENT category
    // isolates the second condition and nothing else.
    const pell = await login(`pell-${RUN}@test.local`);
    const grantsBefore = await grantCount(tenantA, { memberId: m.pell });
    const goal = await createGoal(pell, tenantA, 'Sleep eight hours', 'health');
    const eventId = await eventIdFor(tenantA, 'GoalCreated', goal);
    await drainOutbox();

    const rows = await executionRows(tenantA, { eventId, ruleId: rule.spendGated });
    expect(rows.length).toBeLessThanOrEqual(1);
    if (rows[0]) expect(rows[0].status).toBe('skipped');
    expect(await grantCount(tenantA, { memberId: m.pell })).toBe(grantsBefore);
  }, 60_000);

  it('a member the rule does not describe is never touched by it', async () => {
    // rune bought nothing and created no goal; iva bought nothing either. The
    // gated rule has been live for three deliveries and has granted exactly
    // one thing, to exactly one member.
    expect(await grantCount(tenantA, { rewardId: reward.firstSteps })).toBe(1);
    expect(await grantCount(tenantA, { rewardId: reward.firstSteps, memberId: m.pell })).toBe(1);
    expect(await grantCount(tenantA, { memberId: m.rune })).toBe(0);
  });
});

describe('Rewards on a rank, and rewards by hand (docs/27 §2, §3)', () => {
  it('a rank ladder gets a rule, with no rank-specific code anywhere in it', async () => {
    // docs/27 §3: "rewards on RankAchieved, which the automation engine now
    // provides with no rank-specific code at all." So the rank module is not
    // extended — a row is added to the automation table.
    const admin = await login(`admin-a-${RUN}@test.local`);
    const rank = await api('/api/v1/ranks', {
      method: 'POST',
      token: admin,
      tenant: tenantA,
      body: JSON.stringify({
        code: 'bronze',
        name: 'Bronze',
        level: 10,
        qualifications: [
          { metric: 'direct_referrals', comparator: 'gte', threshold: 1, window: 'lifetime' },
        ],
        // §3's other half — the learning a member can do next
        recommendedCourseIds: [seededCourseId],
      }),
    });
    expect(rank.status).toBe(201);
    bronzeRankId = (rank.body.rank ?? rank.body).id;

    const res = await createRule(admin, tenantA, {
      code: 'rank-reward',
      name: 'Badge on reaching a rank',
      triggerEvent: 'RankAchieved',
      conditions: [],
      priority: 10,
      actions: [{ type: 'grant_reward', rewardCode: 'trailblazer' }],
    });
    expect(res.status).toBe(201);
    rule.rankReward = idOf(res.body, 'rule');
  });

  it('achieving the rank grants the badge, and gamification is where the badge lives', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    // a real referral edge, written through the referral API — iva sponsors noor
    const referral = await api('/api/v1/referrals', {
      method: 'POST',
      token: admin,
      tenant: tenantA,
      body: JSON.stringify({
        referrerMemberId: m.iva,
        referredMemberId: m.noor,
        type: 'referral',
      }),
    });
    expect(referral.status).toBe(201);

    const evaluated = await api('/api/v1/ranks/evaluate', {
      method: 'POST',
      token: admin,
      tenant: tenantA,
      body: JSON.stringify({ memberId: m.iva, asOf: new Date().toISOString() }),
    });
    expect([200, 201]).toContain(evaluated.status);
    await drainOutbox();

    const iva = await login(`iva-${RUN}@test.local`);
    const me = await api('/api/v1/ranks/me', { token: iva, tenant: tenantA });
    expect(me.status).toBe(200);
    expect(currentRank(me.body)?.code ?? currentRank(me.body)).toBe('bronze');

    // the badge arrived, and it arrived in gamification — "delegates to
    // gamification" means there is no second badge table to disagree with it
    const standing = await api('/api/v1/gamification/me', { token: iva, tenant: tenantA });
    expect(standing.body.badges.map((b: { badgeCode: string }) => b.badgeCode)).toContain(
      'trailblazer',
    );
    // and it did not quietly pay points as well
    expect(standing.body.points).toBe(100);

    expect(await grantCount(tenantA, { memberId: m.iva, rewardId: reward.trailblazer })).toBe(1);
    const rows = await executionRows(tenantA, { ruleId: rule.rankReward });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('success');
    expect(rows[0].memberId).toBe(m.iva);
  }, 90_000);

  it('re-evaluating the same rank does not grant the badge again', async () => {
    // The rank engine refuses to record a second achievement, so no second
    // event exists — and even if one did, the execution key would hold.
    const admin = await login(`admin-a-${RUN}@test.local`);
    for (let i = 0; i < 2; i++) {
      await api('/api/v1/ranks/evaluate', {
        method: 'POST',
        token: admin,
        tenant: tenantA,
        body: JSON.stringify({ memberId: m.iva, asOf: new Date().toISOString() }),
      });
    }
    await drainOutbox();

    expect(await grantCount(tenantA, { memberId: m.iva, rewardId: reward.trailblazer })).toBe(1);
    expect(await executionRows(tenantA, { ruleId: rule.rankReward })).toHaveLength(1);
  }, 60_000);

  it('an admin grants by hand, and the grant says who caused it', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const keepsake = await grantByHand(admin, tenantA, 'keepsake', m.rune);
    expect(keepsake.status).toBe(201);
    keepsakeGrantId = idOf(keepsake.body, 'grant');
    const bounty = await grantByHand(admin, tenantA, 'bounty', m.rune);
    expect(bounty.status).toBe(201);
    const elevate = await grantByHand(admin, tenantA, 'elevate', m.rune);
    expect(elevate.status).toBe(201);
    await drainOutbox();

    const rune = await login(`rune-${RUN}@test.local`);
    const mine = await api('/api/v1/rewards/me', { token: rune, tenant: tenantA });
    expect(mine.status).toBe(200);
    expect(activeGrants(mine.body)).toHaveLength(3);

    // an automated grant and a hand-written one are distinguishable, which is
    // the only way an audit can answer "who decided this?"
    const rows = await withTenant(tenantA, (tx) =>
      tx.rewardGrant.findMany({ where: { memberId: m.rune } }),
    );
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.sourceType))).toEqual(new Set(['manual']));
    const automated = await withTenant(tenantA, (tx) =>
      tx.rewardGrant.findMany({ where: { memberId: m.iva } }),
    );
    expect(new Set(automated.map((r) => r.sourceType))).toEqual(new Set(['automation']));
  }, 60_000);

  it('a cash reward is recorded and never paid (docs/27 §2)', async () => {
    // "Paying is compensation's job, and even there money moves through a
    // payout provider that does not exist yet."
    expect(await grantCount(tenantA, { rewardId: reward.bounty, memberId: m.rune })).toBe(1);
    expect(await withTenant(tenantA, (tx) => tx.commissionEntry.count())).toBe(0);
    expect(await withTenant(tenantA, (tx) => tx.commissionRun.count())).toBe(0);
    // and it did not become points either — cash is not a points synonym
    const rune = await login(`rune-${RUN}@test.local`);
    expect(
      (await api('/api/v1/gamification/me', { token: rune, tenant: tenantA })).body.points,
    ).toBe(0);
  });

  it('a membership_upgrade records the intent and moves nobody’s plan', async () => {
    // "changing a plan stays a deliberate act" (docs/27 §2)
    const memberships = await withTenant(tenantA, (tx) =>
      tx.membership.findMany({ where: { memberId: m.rune } }),
    );
    expect(memberships.length).toBeGreaterThan(0);
    expect(memberships.every((x) => x.planId === pathfinderPlanId)).toBe(true);
    expect(memberships.some((x) => x.planId === summitPlanId)).toBe(false);
  });

  it('refuses a grant of a reward this tenant never defined', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const res = await grantByHand(admin, tenantA, `no-such-reward-${RUN}`, m.rune);
    expect([400, 404, 422]).toContain(res.status);
    expect(res.status).not.toBe(201);
    expect(await grantCount(tenantA, { memberId: m.rune })).toBe(3);
  });

  it('revoking keeps the row, stamps the status, and emits RewardRevoked', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const revokedBefore = await eventCount(tenantA, 'RewardRevoked');

    const res = await api(`/api/v1/rewards/grants/${keepsakeGrantId}`, {
      method: 'DELETE',
      token: admin,
      tenant: tenantA,
    });
    expect([200, 204]).toContain(res.status);

    // "A grant is revocable and never deleted" — the history of what was given
    // and taken back is the reason to record a reward at all
    const row = await withTenant(tenantA, (tx) =>
      tx.rewardGrant.findUnique({ where: { id: keepsakeGrantId } }),
    );
    expect(row).toBeTruthy();
    expect(row!.status).toBe('revoked');
    expect(row!.revokedAt).toBeTruthy();
    expect(row!.rewardId).toBe(reward.keepsake);

    expect(await eventCount(tenantA, 'RewardRevoked')).toBe(revokedBefore + 1);

    // …and the member no longer holds it
    const rune = await login(`rune-${RUN}@test.local`);
    const mine = await api('/api/v1/rewards/me', { token: rune, tenant: tenantA });
    expect(activeGrants(mine.body)).toHaveLength(2);
    expect(activeGrants(mine.body).map((g: any) => g.id)).not.toContain(keepsakeGrantId);
    // the row still exists, so revoking is not a delete dressed up
    expect(await grantCount(tenantA, { memberId: m.rune })).toBe(3);
    expect(await grantCount(tenantA, { memberId: m.rune, status: 'revoked' })).toBe(1);
  });

  it('revoking the same grant twice revokes it once', async () => {
    // Whether a second DELETE is refused or quietly accepted is the caller's
    // business; what matters is that it does not announce a second revocation
    // to everything downstream, and does not multiply the history it exists to
    // keep. Both readings pass here — a second RewardRevoked does not.
    const admin = await login(`admin-a-${RUN}@test.local`);
    const revokedBefore = await eventCount(tenantA, 'RewardRevoked');
    const res = await api(`/api/v1/rewards/grants/${keepsakeGrantId}`, {
      method: 'DELETE',
      token: admin,
      tenant: tenantA,
    });
    expect(res.status).not.toBe(500);
    expect(await eventCount(tenantA, 'RewardRevoked')).toBe(revokedBefore);
    expect(await grantCount(tenantA, { memberId: m.rune, status: 'revoked' })).toBe(1);
    expect(await grantCount(tenantA, { memberId: m.rune })).toBe(3);
  });
});

describe('Isolation and permissions — automation is tenant machinery (docs/27 §4)', () => {
  it('tenant B runs its own rules and its own rewards', async () => {
    const admin = await login(`admin-b-${RUN}@test.local`);
    const definition = await createReward(admin, tenantB, {
      code: 'quiet-token',
      name: 'Quiet token',
      type: 'recognition',
    });
    expect(definition).toBeTruthy();

    const res = await createRule(admin, tenantB, {
      code: 'quiet-rule',
      name: 'Applause in the other tenant',
      triggerEvent: 'GoalCompleted',
      conditions: [],
      actions: [{ type: 'grant_reward', rewardCode: 'quiet-token' }],
    });
    expect(res.status).toBe(201);

    const granted = await grantByHand(admin, tenantB, 'quiet-token', sol);
    expect(granted.status).toBe(201);
    await drainOutbox();
  }, 60_000);

  it('neither tenant can see the other’s rules, executions, definitions or grants', async () => {
    const adminA = await login(`admin-a-${RUN}@test.local`);
    const adminB = await login(`admin-b-${RUN}@test.local`);

    const listA = await api('/api/v1/automation/rules', { token: adminA, tenant: tenantA });
    expect(rulesOf(listA.body).map((r: any) => r.code)).not.toContain('quiet-rule');
    const listB = await api('/api/v1/automation/rules', { token: adminB, tenant: tenantB });
    expect(rulesOf(listB.body).map((r: any) => r.code)).toEqual(['quiet-rule']);

    const defsB = await api('/api/v1/rewards/definitions', { token: adminB, tenant: tenantB });
    expect(definitionsOf(defsB.body).map((d: any) => d.code)).toEqual(['quiet-token']);

    // presenting somebody else's tenant header does not open the door
    for (const path of [
      '/api/v1/automation/rules',
      '/api/v1/automation/executions',
      '/api/v1/rewards/definitions',
    ]) {
      const res = await api(path, { token: adminB, tenant: tenantA });
      expect([403, 404]).toContain(res.status);
      expect(res.status).not.toBe(200);
    }

    // and tenant B's executions are its own: nothing of tenant A's leaks in
    const execB = await api('/api/v1/automation/executions', { token: adminB, tenant: tenantB });
    expect(execB.status).toBe(200);
    const ruleIds = new Set(rulesOf(listB.body).map((r: any) => r.id));
    for (const row of executionsOf(execB.body)) {
      expect(ruleIds.has(row.ruleId ?? row.rule?.id)).toBe(true);
    }
  });

  it('a foreign admin cannot grant a reward into this tenant', async () => {
    const adminB = await login(`admin-b-${RUN}@test.local`);
    const res = await grantByHand(adminB, tenantA, 'spark', m.iva);
    expect([403, 404]).toContain(res.status);
    expect(res.status).not.toBe(201);
    expect(await grantCount(tenantA, { memberId: m.iva, rewardId: reward.spark })).toBe(2);
  });

  it('a member cannot write rules, read executions, or hand out rewards', async () => {
    const iva = await login(`iva-${RUN}@test.local`);

    const created = await createRule(iva, tenantA, {
      code: 'self-service',
      name: 'Pay myself',
      triggerEvent: 'GoalCompleted',
      conditions: [],
      actions: [{ type: 'grant_reward', rewardCode: 'spark' }],
    });
    expect(created.status).toBe(403);
    expect(created.body.error.code).toBe('FORBIDDEN');

    for (const path of [
      '/api/v1/automation/rules',
      '/api/v1/automation/executions',
      '/api/v1/rewards/definitions',
    ]) {
      const res = await api(path, { token: iva, tenant: tenantA });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }

    const granted = await grantByHand(iva, tenantA, 'spark', m.iva);
    expect(granted.status).toBe(403);

    const patched = await api(`/api/v1/automation/rules/${rule.celebrate}`, {
      method: 'PATCH',
      token: iva,
      tenant: tenantA,
      body: JSON.stringify({ status: 'disabled' }),
    });
    expect(patched.status).toBe(403);

    const revoked = await api(`/api/v1/rewards/grants/${keepsakeGrantId}`, {
      method: 'DELETE',
      token: iva,
      tenant: tenantA,
    });
    expect(revoked.status).toBe(403);

    // nothing the member tried changed anything
    expect(
      await withTenant(tenantA, (tx) =>
        tx.automationRule.count({ where: { code: 'self-service' } }),
      ),
    ).toBe(0);
    expect(await grantCount(tenantA, { memberId: m.iva, rewardId: reward.spark })).toBe(2);
    const stored = rulesOf(
      (
        await api('/api/v1/automation/rules', {
          token: await login(`admin-a-${RUN}@test.local`),
          tenant: tenantA,
        })
      ).body,
    ).find((r: any) => r.id === rule.celebrate);
    expect(stored.status).toBe('active');
  });

  it('a member sees their own grants at /rewards/me and nobody else’s', async () => {
    // "a member sees what they were given" (docs/27 §4) — reward.view is
    // SELF-scoped, and SELF is the whole of it.
    const iva = await login(`iva-${RUN}@test.local`);
    const mineIva = await api('/api/v1/rewards/me', { token: iva, tenant: tenantA });
    expect(mineIva.status).toBe(200);
    // two sparks and a trailblazer
    expect(activeGrants(mineIva.body)).toHaveLength(3);
    expect(activeGrants(mineIva.body).map((g: any) => g.id)).not.toContain(keepsakeGrantId);
    expect(activeGrants(mineIva.body).every((g: any) => (g.memberId ?? m.iva) === m.iva)).toBe(
      true,
    );

    const rune = await login(`rune-${RUN}@test.local`);
    const mineRune = await api('/api/v1/rewards/me', { token: rune, tenant: tenantA });
    expect(activeGrants(mineRune.body)).toHaveLength(2);
    const runeRewardIds = activeGrants(mineRune.body).map((g: any) => g.rewardId ?? g.reward?.id);
    expect(runeRewardIds).not.toContain(reward.spark);
    expect(runeRewardIds).not.toContain(reward.trailblazer);

    // newest first, per docs/27 §5
    const grantedAt = activeGrants(mineRune.body).map((g: any) =>
      new Date(g.grantedAt ?? g.createdAt).getTime(),
    );
    expect(grantedAt).toEqual([...grantedAt].sort((x, y) => y - x));
  });

  it("another tenant's member cannot read this tenant's rewards", async () => {
    const solToken = await login(`sol-${RUN}@test.local`);
    const across = await api('/api/v1/rewards/me', { token: solToken, tenant: tenantA });
    expect([403, 404]).toContain(across.status);
    expect(across.status).not.toBe(200);

    // …and their own view holds exactly their own one token
    const own = await api('/api/v1/rewards/me', { token: solToken, tenant: tenantB });
    expect(own.status).toBe(200);
    expect(activeGrants(own.body)).toHaveLength(1);
  });

  it('no entitlement gates automation — the owner holds no plan and runs it anyway', async () => {
    // docs/27 §4: "No entitlement gates automation: it is tenant machinery,
    // not a member capability."
    const admin = await login(`admin-a-${RUN}@test.local`);
    const res = await api('/api/v1/automation/rules', { token: admin, tenant: tenantA });
    expect(res.status).toBe(200);
    expect(rulesOf(res.body).length).toBeGreaterThan(0);

    const executions = await api('/api/v1/automation/executions', {
      token: admin,
      tenant: tenantA,
    });
    expect(executions.status).toBe(200);
    expect(executionsOf(executions.body).length).toBeGreaterThan(0);
  });
});

describe('The growth journey is the rank ladder, with the learning attached (docs/27 §3)', () => {
  it('the ladder carries the courses a member can do next', async () => {
    // §3 refuses to build a second ladder — "Building a second ladder would
    // mean two engines disagreeing about what a member has achieved" — and
    // adds only the field §44's dashboard was missing.
    const iva = await login(`iva-${RUN}@test.local`);
    const res = await api('/api/v1/ranks', { token: iva, tenant: tenantA });
    expect(res.status).toBe(200);
    const bronze = ranksOf(res.body).find((r: any) => r.code === 'bronze');
    expect(bronze).toBeTruthy();
    expect(bronze.id).toBe(bronzeRankId);
    expect(recommendedOf(bronze)).toEqual([seededCourseId]);
  });

  it('and /ranks/me carries them too, where a member actually looks', async () => {
    const iva = await login(`iva-${RUN}@test.local`);
    const me = await api('/api/v1/ranks/me', { token: iva, tenant: tenantA });
    expect(me.status).toBe(200);
    expect(currentRank(me.body)?.code ?? currentRank(me.body)).toBe('bronze');

    // on the rank itself, or hoisted to the top of the response — either is
    // an answer to "what should I do next?", and one of them must be there
    const recommended =
      recommendedOf(currentRank(me.body)).length > 0
        ? recommendedOf(currentRank(me.body))
        : recommendedOf(me.body);
    expect(recommended).toEqual([seededCourseId]);
  });

  it('a rank with no recommendations is still a rank', async () => {
    // The field is optional: §3 adds a hint, not a requirement.
    const admin = await login(`admin-a-${RUN}@test.local`);
    const res = await api('/api/v1/ranks', {
      method: 'POST',
      token: admin,
      tenant: tenantA,
      body: JSON.stringify({
        code: 'gold',
        name: 'Gold',
        level: 30,
        qualifications: [
          { metric: 'direct_referrals', comparator: 'gte', threshold: 5, window: 'lifetime' },
        ],
      }),
    });
    expect(res.status).toBe(201);

    const iva = await login(`iva-${RUN}@test.local`);
    const ladder = await api('/api/v1/ranks', { token: iva, tenant: tenantA });
    const gold = ranksOf(ladder.body).find((r: any) => r.code === 'gold');
    expect(gold).toBeTruthy();
    expect(recommendedOf(gold)).toEqual([]);
    // and iva did not accidentally acquire it
    const me = await api('/api/v1/ranks/me', { token: iva, tenant: tenantA });
    expect(currentRank(me.body)?.code ?? currentRank(me.body)).toBe('bronze');
  });
});

describe('Automation does not react to its own output', () => {
  it('a reward granted BY a rule does not trigger a rule watching RewardGranted', async () => {
    // Rewards emit events and any event is a legal trigger, so a rule granting
    // a reward on RewardGranted would chain for ever — the loop docs/27 §1
    // refuses `trigger_workflow` to avoid, arriving through the back door.
    // Nothing is lost by cutting it: a rule's actions are a list, so anything
    // that should happen alongside an automated grant goes in the same rule.
    const admin = await login(`admin-a-${RUN}@test.local`);

    const echo = await createReward(admin, tenantA, {
      code: 'echo',
      name: 'Echo',
      type: 'recognition',
    });
    expect(echo).toBeTruthy();

    const rule = await createRule(admin, tenantA, {
      code: 'echo-chain',
      name: 'Grant on every grant',
      triggerEvent: 'RewardGranted',
      conditions: [],
      actions: [{ type: 'grant_reward', rewardCode: 'echo' }],
    });
    expect(rule.status).toBe(201);

    const before = await owner.rewardGrant.count({ where: { tenantId: tenantA } });

    // a MANUAL grant is not automation's output, so the watching rule may fire…
    const manual = await api('/api/v1/rewards/grants', {
      method: 'POST',
      token: admin,
      tenant: tenantA,
      body: JSON.stringify({ rewardCode: 'applause', memberId: m.iva }),
    });
    expect(manual.status).toBe(201);
    await drainOutbox();

    // …once, and its own grant must not feed itself again
    const after = await owner.rewardGrant.count({ where: { tenantId: tenantA } });
    expect(after - before).toBeLessThanOrEqual(2);

    // and it settles: draining again moves nothing
    await drainOutbox();
    expect(await owner.rewardGrant.count({ where: { tenantId: tenantA } })).toBe(after);
  });
});
