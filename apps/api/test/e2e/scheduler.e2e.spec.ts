/**
 * The scheduler (Sprint 16, docs/35).
 *
 * docs/35 §1 does not describe a feature, it describes three ways a scheduler
 * ruins a business, and every rule in the contract exists to prevent one of
 * them. So the file is organised around those three and nothing else leads:
 *
 *   1. RUNNING TWICE — two instances, or one restarted mid-run, must not bill
 *      a subscription twice. The most important `it` in this file drives the
 *      tick twice for the SAME occurrence and finds one `scheduled_job_runs`
 *      row and one order; the second drives it again with a `claimed` row left
 *      behind by a process that died, and finds the same.
 *   2. RUNNING SILENTLY — "did renewals run last night?" must be a query and
 *      not a guess (§1). A job that did nothing still leaves a row saying so,
 *      and this file answers that question from the table ALONE.
 *   3. ONE TENANT STOPPING THE REST — one tenant's data is arranged (by the
 *      owner client, since the API will not accept it) to make renewal throw,
 *      and the other tenants' rows for the same occurrence must still be
 *      settled and successful.
 *
 * Nothing here imports the implementer's classes. The tick is found in the
 * Nest container BY SHAPE — a provider whose name mentions the schedule and
 * which exposes a no-argument "do the due work now" method — exactly as
 * integration.e2e.spec.ts finds the webhook dispatcher, and for the same
 * reason: this suite was written from the contract, in parallel with the
 * implementation, and must not depend on a name the implementer was free to
 * choose. `scheduled_job_runs` is read with raw SQL for the same reason (and
 * because it is PLATFORM scope with no tenant policy — the app role cannot
 * write it, so the owner client reads it).
 *
 * Two more deliberate choices:
 *
 *   · The runner's own clock is never asked what day it is. CI runs in UTC and
 *     a laptop runs in Asia/Bangkok, and §3 says the day belongs to the TENANT
 *     ("a tenant in Bangkok renewing at 02:00 local must not renew at 09:00
 *     local because the server thinks in UTC"). Every day in this file is read
 *     through `Intl` in a named zone; `getDate()` appears nowhere.
 *   · Assertions are on API responses and on `scheduled_job_runs`. The owner
 *     client is used to READ platform rows, to arrange the failing tenant's
 *     data, and to move a subscription's due date and a run's status — never
 *     to write an outcome the platform was supposed to produce.
 *
 * NOTE: stop any locally running API. A tick is cross-tenant, and so is the
 * outbox relay these tests read events from.
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
import { ENTITLEMENTS, EVENTS, PERMISSIONS } from '@aviora/shared';
import { createApp } from '../../src/app.factory';

const RUN = `s${Date.now().toString(36)}`;
const PLATFORM_EMAIL = `e2e-platform-${RUN}@test.local`;
const PW = 'e2e-password-123456';

/**
 * Two zones two hours apart, neither observing DST, so the SAME nominal day
 * exists in both for 22 hours out of 24 and the expected difference between
 * two occurrence instants is a constant a reader can check by hand.
 */
const HOME_ZONE = 'Asia/Bangkok'; // UTC+07:00, no DST
const EAST_ZONE = 'Asia/Tokyo'; // UTC+09:00, no DST

/** The job names §3 prints. Compared normalised, so `subscription_renew` passes. */
const JOB_RENEW = 'subscription.renew';
const JOB_RANK = 'rank.evaluate';
const JOB_COMMISSION = 'commission.draft';

const DAY_MS = 86_400_000;

let app: INestApplication;
let base: string;
let owner: PrismaClient;
/** Everything this file wrote happened after this instant. */
let suiteStart: Date;

/** home renews and is paid a commission draft; east has nothing due, ever. */
let home: string;
let east: string;
/** A tenant whose subscription cannot be billed — arranged, never invented. */
let poison: string;
/** Created inside the catch-up test, so its occurrence ledger starts empty. */
let late: string;

const HOME_ADMIN = `admin-home-${RUN}@test.local`;
const EAST_ADMIN = `admin-east-${RUN}@test.local`;
const POISON_ADMIN = `admin-poison-${RUN}@test.local`;
const ADA = `ada-${RUN}@test.local`;
const BO = `bo-${RUN}@test.local`;
const PIP = `pip-${RUN}@test.local`;

/** Ada's subscription renews on the TIMER. Bo's renews from the admin button. */
let adaSubscriptionId: string;
let boSubscriptionId: string;
let poisonSubscriptionId: string;
let homeOfferingId: string;

/** The order the scheduler made, and the one the manual path made, compared in §3. */
let timerOrderId: string;

/* ── plumbing ─────────────────────────────────────────────────────────────── */

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
  return { status: res.status, body: text ? safeJson(text) : null };
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text };
  }
}

async function login(email: string): Promise<string> {
  const res = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PW }),
  });
  expect(res.status, `login failed for ${email}`).toBe(200);
  const access = res.headers.getSetCookie().find((c) => c.startsWith('aviora_access='));
  return decodeURIComponent(access!.split(';')[0]!.split('=')[1]!);
}

/**
 * Scoped to one tenant. The shared helper applies the tenant extension as well
 * as the GUC, which matters here: these tests connect as the OWNER role, and
 * the owner BYPASSES row-level security.
 */
async function withTenant<T>(tenant: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return dbWithTenant(owner, tenant, fn);
}

async function eventCount(tenant: string, eventName: string): Promise<number> {
  return owner.domainEvent.count({ where: { tenantId: tenant, eventName } });
}

/* ── the tenant's day, never the runner's ─────────────────────────────────── */

interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  const cached = formatters.get(zone);
  if (cached) return cached;
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  formatters.set(zone, dtf);
  return dtf;
}

/**
 * The wall clock an observer in `zone` reads at `instant`. Deliberately
 * computed here rather than imported from the app: a test that reads the day
 * with the same helper the implementation uses can only prove the two agree.
 */
function wallClock(zone: string, instant: Date): Wall {
  const parts = formatterFor(zone).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((p) => p.type === type);
    return found ? Number(found.value) : 0;
  };
  const hour = get('hour');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: hour === 24 ? 0 : hour,
    minute: get('minute'),
    second: get('second'),
  };
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** `YYYY-MM-DD` as the tenant reckons it. */
function dayIn(zone: string, instant: Date): string {
  const w = wallClock(zone, instant);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}`;
}

/** `HH:MM:SS` as the tenant reckons it — the local time of day a job fires at. */
function clockIn(zone: string, instant: Date): string {
  const w = wallClock(zone, instant);
  return `${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}`;
}

/** Zone offset in force at `instant`, in ms (local wall clock − UTC). */
function offsetMsAt(zone: string, instant: Date): number {
  const w = wallClock(zone, instant);
  const asIfUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asIfUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** `n` days before the tenant's today, as `YYYY-MM-DD` in the tenant's zone. */
function dayInZoneAgo(zone: string, days: number): string {
  return dayIn(zone, new Date(Date.now() - days * DAY_MS));
}

/* ── scheduled_job_runs, read by shape ────────────────────────────────────── */

interface JobRun {
  job: string;
  tenantId: string | null;
  scheduledFor: Date;
  status: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  outcome: unknown;
  error: string | null;
  attempts: number | null;
  id: string;
  raw: Record<string, unknown>;
}

function pick(row: Record<string, unknown>, ...candidates: string[]): unknown {
  for (const key of candidates) if (key in row) return row[key];
  return undefined;
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function toJobRun(row: Record<string, unknown>): JobRun {
  const scheduledFor = asDate(pick(row, 'scheduled_for', 'occurrence_at', 'occurrence'));
  return {
    id: String(pick(row, 'id') ?? ''),
    job: String(pick(row, 'job', 'job_name', 'name') ?? ''),
    tenantId: (pick(row, 'tenant_id') as string | null) ?? null,
    scheduledFor: scheduledFor ?? new Date(0),
    status: String(pick(row, 'status', 'state') ?? ''),
    startedAt: asDate(pick(row, 'started_at', 'claimed_at')),
    finishedAt: asDate(pick(row, 'finished_at', 'completed_at', 'settled_at')),
    outcome: pick(row, 'outcome', 'result', 'summary'),
    error: (pick(row, 'error', 'last_error', 'error_message') as string | null) ?? null,
    attempts: (pick(row, 'attempts', 'attempt_count') as number | null) ?? null,
    raw: row,
  };
}

const LEDGER_MISSING =
  'scheduled_job_runs could not be read. docs/35 §2 names it as the shape of the ' +
  'scheduler: one row per job, per tenant, per occurrence, UNIQUE on those three.';

/** Everything recent, from the owner client — the app role cannot read or write it. */
async function ledger(): Promise<JobRun[]> {
  let rows: Record<string, unknown>[];
  try {
    rows = await owner.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT * FROM scheduled_job_runs WHERE scheduled_for > now() - interval '30 days'`,
    );
  } catch (e) {
    throw new Error(`${LEDGER_MISSING}\n  ${(e as Error).message}`, { cause: e });
  }
  return rows.map(toJobRun);
}

let ledgerColumns: { name: string; nullable: boolean; hasDefault: boolean }[] | null = null;

async function columnsOfLedger(): Promise<
  { name: string; nullable: boolean; hasDefault: boolean }[]
> {
  if (ledgerColumns) return ledgerColumns;
  const rows = await owner.$queryRawUnsafe<
    { column_name: string; is_nullable: string; column_default: string | null }[]
  >(
    `SELECT column_name, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_name = 'scheduled_job_runs'`,
  );
  expect(rows.length, LEDGER_MISSING).toBeGreaterThan(0);
  ledgerColumns = rows.map((r) => ({
    name: r.column_name,
    nullable: r.is_nullable === 'YES',
    hasDefault: r.column_default !== null,
  }));
  return ledgerColumns;
}

const norm = (value: string): string => value.toLowerCase().replace(/[^a-z]/g, '');

function isJob(row: JobRun, job: string): boolean {
  return norm(row.job) === norm(job);
}

function runsFor(rows: JobRun[], job: string, tenant: string | null): JobRun[] {
  return rows.filter((r) => isJob(r, job) && r.tenantId === tenant);
}

function atOccurrence(rows: JobRun[], occurrence: Date): JobRun[] {
  return rows.filter((r) => r.scheduledFor.getTime() === occurrence.getTime());
}

/** Status vocabulary: §2 names the column, §4 names `skipped`, §1 names `claimed`. */
const succeeded = (status: string): boolean =>
  /^(succe|success|ok$|done|complete|finish)/i.test(status);
const failed = (status: string): boolean => /^(fail|error|dead)/i.test(status);
const skipped = (status: string): boolean => /^skip/i.test(status);
const settled = (status: string): boolean => succeeded(status) || failed(status) || skipped(status);

function describeRun(row: JobRun | undefined): string {
  if (!row) return '(no row)';
  return JSON.stringify({
    job: row.job,
    tenant: row.tenantId,
    scheduledFor: row.scheduledFor.toISOString(),
    status: row.status,
    error: row.error,
    outcome: row.outcome,
  });
}

/**
 * Every COUNT inside an outcome, with its path, so "it did nothing" can be
 * asserted on the outcome itself. Timings are deliberately excluded: a run that
 * took 4ms and renewed nothing is still a run that did nothing, and asserting
 * on its duration would make this a test of the clock.
 */
const TIMING_KEY = /ms$|millis|duration|elapsed|took|seconds|_at$|At$|time/i;

function countsIn(
  value: unknown,
  path = '$',
  acc: Array<[string, number]> = [],
): Array<[string, number]> {
  if (value === null || value === undefined) return acc;
  if (typeof value === 'number') {
    acc.push([path, value]);
    return acc;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => countsIn(v, `${path}[${i}]`, acc));
    return acc;
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (TIMING_KEY.test(key)) continue;
      countsIn(child, `${path}.${key}`, acc);
    }
  }
  return acc;
}

/** The one row that answers "did <job> run for <tenant> at <occurrence>?" */
function theRunFor(rows: JobRun[], job: string, tenant: string | null, occurrence: Date): JobRun {
  const found = atOccurrence(runsFor(rows, job, tenant), occurrence);
  expect(
    found.length,
    `expected exactly one ${job} row for tenant ${tenant} at ` +
      `${occurrence.toISOString()} — docs/35 §2 makes (job, tenant_id, scheduled_for) ` +
      `UNIQUE. Found ${found.length}: ${found.map(describeRun).join(' | ')}`,
  ).toBe(1);
  return found[0]!;
}

/** The occurrence a tenant's daily job most recently covered. */
function latestOccurrence(rows: JobRun[], job: string, tenant: string): Date {
  const mine = runsFor(rows, job, tenant).sort(
    (a, b) => b.scheduledFor.getTime() - a.scheduledFor.getTime(),
  );
  expect(
    mine.length,
    `no ${job} row at all for tenant ${tenant}. docs/35 §1: a job that quietly does ` +
      `not run is worse than one that fails loudly, so the occurrence is recorded ` +
      `BEFORE it starts.`,
  ).toBeGreaterThan(0);
  return mine[0]!.scheduledFor;
}

/* ── driving the tick, discovered by shape ────────────────────────────────── */

interface Driver {
  label: string;
  run: () => Promise<unknown>;
}

/** Nest's own scheduling plumbing, if @nestjs/schedule is ever added. */
const FOREIGN = /^(SchedulerRegistry|SchedulerOrchestrator|SchedulerMetadataAccessor)$/;

const TICK_METHODS = [
  'tick',
  'runDue',
  'runOccurrences',
  'dispatchDue',
  'poll',
  'drain',
  'flush',
  'sweep',
  'run',
];
const CATCHUP_METHODS = ['catchUp', 'catchup', 'runMissed', 'backfill', 'recover', 'bootstrap'];

let cachedDrivers: { tick: Driver[]; catchUp: Driver[] } | null = null;

function providers(match: RegExp): Array<{ name: string; instance: Record<string, unknown> }> {
  const container = (
    app as unknown as {
      container?: {
        getModules(): Map<unknown, { providers: Map<unknown, { instance?: unknown }> }>;
      };
    }
  ).container;
  const modules = container?.getModules?.();
  const found: Array<{ name: string; instance: Record<string, unknown> }> = [];
  if (!modules) return found;
  const seen = new Set<unknown>();
  for (const mod of modules.values()) {
    for (const wrapper of mod.providers.values()) {
      const instance = wrapper?.instance as Record<string, unknown> | undefined;
      if (!instance || typeof instance !== 'object' || seen.has(instance)) continue;
      seen.add(instance);
      const className = (instance.constructor as { name?: string } | undefined)?.name ?? '';
      if (!className || FOREIGN.test(className) || !match.test(className)) continue;
      found.push({ name: className, instance });
    }
  }
  return found;
}

function driversOf(
  instances: Array<{ name: string; instance: Record<string, unknown> }>,
  methods: string[],
): Driver[] {
  const drivers: Driver[] = [];
  for (const { name, instance } of instances) {
    for (const method of methods) {
      const fn = instance[method];
      if (typeof fn === 'function' && (fn as () => unknown).length === 0) {
        drivers.push({
          label: `${name}.${method}`,
          run: () => Promise.resolve((fn as () => unknown).call(instance)),
        });
        break; // one entry point per service; never two on the same instance
      }
    }
  }
  return drivers;
}

/**
 * INTERPRETATION: §5 says the scheduler is "disabled in tests … so tests drive
 * it by hand", but names no class and no method. Whatever the implementation
 * calls it, it is a provider whose name mentions the schedule and which
 * exposes a no-argument "do the due work now" method — the same shape
 * `OutboxRelayService.tick()` has. Discovery is by shape so this file does not
 * import a class the implementer may reasonably have named otherwise.
 */
function schedulerDrivers(): { tick: Driver[]; catchUp: Driver[] } {
  if (cachedDrivers) return cachedDrivers;
  let instances = providers(/schedul/i);
  if (instances.length === 0) instances = providers(/job|cron|tick/i);
  cachedDrivers = {
    tick: driversOf(instances, TICK_METHODS),
    catchUp: driversOf(instances, CATCHUP_METHODS),
  };
  return cachedDrivers;
}

const NO_TICK =
  'nothing in the container looks like the scheduler: a provider named /schedul/ ' +
  'with a no-argument "run the due work now" method. docs/35 §5 disables the timer ' +
  'in tests precisely so this can be driven by hand.';

async function tick(): Promise<void> {
  const { tick: drivers } = schedulerDrivers();
  expect(drivers.length, NO_TICK).toBeGreaterThan(0);
  for (const driver of drivers) await driver.run();
}

/** Catch-up if the implementation separates it; otherwise the ordinary tick. */
async function catchUp(): Promise<void> {
  const { catchUp: drivers } = schedulerDrivers();
  if (drivers.length === 0) return tick();
  for (const driver of drivers) await driver.run();
  await tick();
}

/* ── fixtures ─────────────────────────────────────────────────────────────── */

async function mkTenant(
  suffix: string,
  zone: string,
  adminEmail: string,
): Promise<{ id: string; adminMemberId: string }> {
  const platform = await login(PLATFORM_EMAIL);
  const res = await api('/api/v1/platform/tenants', {
    method: 'POST',
    token: platform,
    body: JSON.stringify({
      code: `e2e_sch_${suffix}_${RUN}`,
      name: `Scheduler ${suffix}`,
      slug: `e2e-sch-${suffix}-${RUN}`,
      timezone: zone,
      adminEmail,
      adminDisplayName: 'Admin',
      adminPassword: PW,
    }),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { id: res.body.tenant.id as string, adminMemberId: res.body.adminMemberId as string };
}

async function mkPlan(token: string, tenant: string, code: string): Promise<string> {
  const res = await api('/api/v1/membership-plans', {
    method: 'POST',
    token,
    tenant,
    body: JSON.stringify({
      code,
      name: code,
      entitlementKeys: [ENTITLEMENTS.COMMERCE, ENTITLEMENTS.RANKS, ENTITLEMENTS.COMPENSATION],
    }),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.plan.id as string;
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
  expect(inv.status, JSON.stringify(inv.body)).toBe(201);
  const invited = await owner.domainEvent.findFirst({
    where: { eventName: 'MemberInvited', tenantId: tenant, aggregateId: inv.body.invitation.id },
  });
  const accepted = await api(
    `/api/v1/invitations/${(invited!.payload as { token: string }).token}/accept`,
    { method: 'POST', body: JSON.stringify({ displayName: name, password: PW }) },
  );
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
  return accepted.body.memberId as string;
}

async function mkSubscriptionOffering(
  token: string,
  tenant: string,
  code: string,
): Promise<string> {
  const res = await api('/api/v1/offerings', {
    method: 'POST',
    token,
    tenant,
    body: JSON.stringify({
      code,
      name: `Monthly ${code}`,
      kind: 'subscription',
      currency: 'THB',
      priceMinor: 90_000,
      intervalUnit: 'month',
      intervalCount: 1,
    }),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.offering.id as string;
}

/** Checkout is the only way a subscription starts; nothing here is inserted by hand. */
async function startSubscription(
  memberEmail: string,
  tenant: string,
  offeringId: string,
): Promise<string> {
  const token = await login(memberEmail);
  const add = await api('/api/v1/cart/items', {
    method: 'POST',
    token,
    tenant,
    body: JSON.stringify({ offeringId, quantity: 1 }),
  });
  expect(add.status, JSON.stringify(add.body)).toBe(201);
  const checkout = await api('/api/v1/cart/checkout', { method: 'POST', token, tenant });
  expect(checkout.status, JSON.stringify(checkout.body)).toBe(201);
  const list = await api('/api/v1/subscriptions', { token, tenant });
  expect(list.status).toBe(200);
  expect(list.body.subscriptions.length).toBeGreaterThan(0);
  return list.body.subscriptions[0].id as string;
}

/**
 * Moves the DUE DATE — the clock, never an outcome. A subscription that came
 * due yesterday is the only precondition a renewal job has.
 */
async function setDue(tenant: string, subscriptionId: string, day: string): Promise<void> {
  await withTenant(tenant, (tx) =>
    tx.$executeRawUnsafe(
      `UPDATE subscriptions SET next_run_on = $1::date, status = 'active', auto_renew = true
        WHERE id = $2::uuid AND tenant_id = $3::uuid`,
      day,
      subscriptionId,
      tenant,
    ),
  );
}

async function ordersOf(memberEmail: string, tenant: string): Promise<any[]> {
  const token = await login(memberEmail);
  const res = await api('/api/v1/orders', { token, tenant });
  expect(res.status).toBe(200);
  return res.body.orders as any[];
}

async function orderDetail(memberEmail: string, tenant: string, orderId: string): Promise<any> {
  const token = await login(memberEmail);
  const res = await api(`/api/v1/orders/${orderId}`, { token, tenant });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.order;
}

async function subscriptionRunCount(tenant: string, subscriptionId: string): Promise<number> {
  return withTenant(tenant, (tx) => tx.subscriptionRun.count({ where: { subscriptionId } }));
}

/* ── the platform's operating surface (§5) ────────────────────────────────── */

async function listRuns(token: string, tenantId?: string): Promise<{ status: number; body: any }> {
  // The listing is a page, newest occurrence first, across every tenant. On a
  // platform with a thousand tenants the first page is a thousand other
  // people's rows, so asking "did MY tenant run" means asking for that tenant —
  // which is what the route's filter is for, and what an operator would do.
  // Filtering a page client-side worked only while the database was small.
  const query = tenantId ? `?tenantId=${tenantId}` : '';
  return api(`/api/v1/platform/scheduler/runs${query}`, { token });
}

function runsOf(body: any): any[] {
  if (Array.isArray(body)) return body;
  return body?.runs ?? body?.scheduledJobRuns ?? body?.items ?? body?.data ?? [];
}

/**
 * INTERPRETATION: §5 fixes the route and what it is for ("force one
 * job/occurrence") but not the body. The canonical shape is tried first and
 * the alternatives only if the platform refused it, so a 4xx from a NAMING
 * disagreement never reads as a missing feature.
 */
async function forceRun(
  token: string,
  job: string,
  tenantId: string | null,
  occurrence: Date,
  zone: string,
): Promise<{ status: number; body: any; sent: Record<string, unknown> }> {
  const iso = occurrence.toISOString();
  const day = dayIn(zone, occurrence);
  const candidates: Record<string, unknown>[] = [
    { job, tenantId, scheduledFor: iso },
    { job, tenantId, occurrence: iso },
    { job, tenantId, scheduledFor: day },
    { job, tenantId, date: day },
    { job, tenantId },
    { job },
  ];
  let last: { status: number; body: any; sent: Record<string, unknown> } | null = null;
  for (const sent of candidates) {
    const res = await api('/api/v1/platform/scheduler/run', {
      method: 'POST',
      token,
      body: JSON.stringify(sent),
    });
    last = { ...res, sent };
    if (res.status < 400) return last;
    // A 403/404 is an answer about the ROUTE, not about the body — stop trying.
    if (res.status === 403 || res.status === 404) return last;
  }
  return last!;
}

/* ── writing a row the platform did not write ─────────────────────────────── */

/**
 * Inserts one `scheduled_job_runs` row, adapting to whatever the implementer
 * named the columns. Used ONLY to anchor the catch-up test: a tenant whose
 * last recorded run was ten days ago is the state §4 is about, and it cannot
 * be produced through any API.
 */
async function insertLedgerRow(
  job: string,
  tenantId: string | null,
  scheduledFor: Date,
  status: string,
): Promise<void> {
  const cols = await columnsOfLedger();
  const iso = scheduledFor.toISOString();
  const names: string[] = [];
  const values: string[] = [];
  const used = new Set<string>();
  const put = (candidates: string[], sql: string) => {
    const col = cols.find((c) => candidates.includes(c.name));
    if (!col) return;
    names.push(`"${col.name}"`);
    values.push(sql);
    used.add(col.name);
  };
  put(['id'], 'gen_random_uuid()');
  put(['job', 'job_name', 'name'], `'${job}'`);
  put(['tenant_id'], tenantId ? `'${tenantId}'::uuid` : 'NULL');
  put(['scheduled_for', 'occurrence_at', 'occurrence'], `'${iso}'::timestamptz`);
  put(['status', 'state'], `'${status}'`);
  put(['started_at', 'claimed_at'], `'${iso}'::timestamptz`);
  put(['finished_at', 'completed_at', 'settled_at'], `'${iso}'::timestamptz`);
  put(['outcome', 'result', 'summary'], `'{}'::jsonb`);
  put(['attempts', 'attempt_count'], '1');

  const unfilled = cols.filter((c) => !c.nullable && !c.hasDefault && !used.has(c.name));
  expect(
    unfilled.map((c) => c.name),
    'scheduled_job_runs has a required column this test cannot guess a value for',
  ).toEqual([]);

  await owner.$executeRawUnsafe(
    `INSERT INTO scheduled_job_runs (${names.join(', ')}) VALUES (${values.join(', ')})`,
  );
}

/** Leaves a settled row looking like a process that claimed it and then died. */
async function leaveClaimed(row: JobRun): Promise<() => Promise<void>> {
  const cols = await columnsOfLedger();
  const statusCol = cols.find((c) => ['status', 'state'].includes(c.name))!.name;
  const finishedCol = cols.find((c) =>
    ['finished_at', 'completed_at', 'settled_at'].includes(c.name),
  )?.name;
  const sets = [`"${statusCol}" = 'claimed'`];
  if (finishedCol) sets.push(`"${finishedCol}" = NULL`);
  await owner.$executeRawUnsafe(
    `UPDATE scheduled_job_runs SET ${sets.join(', ')} WHERE id = '${row.id}'::uuid`,
  );
  // The crash belongs to this test, not to the suite. A row left `claimed`
  // for ever is a real state — §5 gives an operator the forced re-run for
  // exactly it — but it is also the NEWEST occurrence every later test reads
  // when it asks "is the schedule settled?". Leaving it broken would make
  // those tests fail on this test's fixture rather than on the implementation.
  return async () => {
    const restore = [`"${statusCol}" = $2`];
    const params: unknown[] = [row.id, row.status];
    if (finishedCol) {
      restore.push(`"${finishedCol}" = $3`);
      params.push(row.finishedAt);
    }
    await owner.$executeRawUnsafe(
      `UPDATE scheduled_job_runs SET ${restore.join(', ')} WHERE id = $1::uuid`,
      ...params,
    );
  };
}

/* ── comparing two orders ─────────────────────────────────────────────────── */

/** Identity and time differ between any two orders; nothing else may. */
const VOLATILE = new Set([
  'id',
  'orderId',
  'order_id',
  'memberId',
  'member_id',
  'subscriptionId',
  'subscription_id',
  'cartId',
  'cart_id',
  'number',
  'orderNumber',
  'order_number',
  'reference',
  'createdAt',
  'created_at',
  'updatedAt',
  'updated_at',
  'placedAt',
  'placed_at',
  'paidAt',
  'paid_at',
  'settledAt',
  'settled_at',
]);

function shapeOf(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shapeOf);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (VOLATILE.has(key)) continue;
      out[key] = shapeOf(child);
    }
    return out;
  }
  return value;
}

/* ── setup ────────────────────────────────────────────────────────────────── */

beforeAll(async () => {
  // §5: "Disabled in tests and in any process that sets
  // AVIORA_SCHEDULER_DISABLED, the same switch the outbox relay already
  // honours, so tests drive it by hand." If the implementation ignores this,
  // the first test's "exactly one row" fails — which is the right failure.
  process.env.AVIORA_SCHEDULER_DISABLED = 'true';
  process.env.AVIORA_OUTBOX_DISABLED = 'true';
  process.env.AVIORA_PII_ENCRYPTION_KEY ??= Buffer.alloc(32, 5).toString('base64');

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
  suiteStart = new Date();

  home = (await mkTenant('home', HOME_ZONE, HOME_ADMIN)).id;
  east = (await mkTenant('east', EAST_ZONE, EAST_ADMIN)).id;
  poison = (await mkTenant('poison', HOME_ZONE, POISON_ADMIN)).id;

  const homeAdmin = await login(HOME_ADMIN);
  const poisonAdmin = await login(POISON_ADMIN);

  const homePlan = await mkPlan(homeAdmin, home, 'orbit');
  const poisonPlan = await mkPlan(poisonAdmin, poison, 'rift');
  // east sells nothing and owes nothing: it is the tenant whose renewal job
  // has no work at all, and must still leave a row saying so (§1).
  await mkPlan(await login(EAST_ADMIN), east, 'hush');

  homeOfferingId = await mkSubscriptionOffering(homeAdmin, home, 'orbit-box');
  const poisonOfferingId = await mkSubscriptionOffering(poisonAdmin, poison, 'rift-box');

  // Ada and Bo are on the SAME plan and buy the SAME offering, so the order the
  // timer makes and the order the button makes have nothing to differ about
  // except identity and time.
  await addMember(homeAdmin, home, homePlan, ADA, 'Ada');
  await addMember(homeAdmin, home, homePlan, BO, 'Bo');
  await addMember(poisonAdmin, poison, poisonPlan, PIP, 'Pip');

  adaSubscriptionId = await startSubscription(ADA, home, homeOfferingId);
  boSubscriptionId = await startSubscription(BO, home, homeOfferingId);
  poisonSubscriptionId = await startSubscription(PIP, poison, poisonOfferingId);

  // Ada came due yesterday, in HER tenant's reckoning of yesterday.
  await setDue(home, adaSubscriptionId, dayInZoneAgo(HOME_ZONE, 1));
  // Bo is not due: his renewal must come from the admin endpoint, later, so
  // the two paths can be compared without either having caused the other.
  await setDue(home, boSubscriptionId, dayIn(HOME_ZONE, new Date(Date.now() + 60 * DAY_MS)));

  // The failing tenant. `total_minor` is a 32-bit integer, so 2,000,000,000 × 2
  // cannot be stored — the renewal throws on Pip's row and on nobody else's.
  // Arranged with the owner client because the API would (rightly) refuse it.
  await withTenant(poison, (tx) =>
    tx.$executeRawUnsafe(
      `UPDATE subscriptions SET price_minor = 2000000000, quantity = 2
        WHERE id = $1::uuid AND tenant_id = $2::uuid`,
      poisonSubscriptionId,
      poison,
    ),
  );
  await setDue(poison, poisonSubscriptionId, dayInZoneAgo(HOME_ZONE, 1));

  // A compensation plan for home, so commission.draft has something to draft.
  const plan = await api('/api/v1/compensation/plans', {
    method: 'POST',
    token: homeAdmin,
    tenant: home,
    body: JSON.stringify({
      code: 'orbit-comp',
      name: 'Orbit compensation',
      currency: 'THB',
      rules: [
        {
          code: 'everybody',
          name: 'Everybody',
          bonusType: 'fixed_bonus',
          priority: 10,
          conditions: [
            {
              metric: 'personal_volume',
              comparator: 'gte',
              threshold: 0,
              window: 'lifetime',
              graph: 'compensation',
            },
          ],
          payout: { kind: 'fixed', amountMinor: 1_000 },
        },
      ],
    }),
  });
  expect(plan.status, JSON.stringify(plan.body)).toBe(201);
}, 300_000);

afterAll(async () => {
  await app?.close();
  await owner?.$disconnect();
});

/* ── 1. it does not run twice ─────────────────────────────────────────────── */

describe('It does not run twice (docs/35 §1)', () => {
  it('ticks the same occurrence twice and bills one renewal, from one run row', async () => {
    // THE most important test in this file. Two instances, or one restarted
    // mid-run, must not bill a subscription twice — and the defence is a row
    // claimed with FOR UPDATE SKIP LOCKED, UNIQUE on the work it represents.
    const before = await ordersOf(ADA, home);

    await tick();
    await tick();

    const rows = await ledger();
    const occurrence = latestOccurrence(rows, JOB_RENEW, home);
    const run = theRunFor(rows, JOB_RENEW, home, occurrence);
    expect(
      settled(run.status),
      `the renewal run for this occurrence is not settled: ${describeRun(run)}`,
    ).toBe(true);
    expect(succeeded(run.status), `renewal did not succeed: ${describeRun(run)}`).toBe(true);

    // one unit of work: one new order for the subscription that was due
    const after = await ordersOf(ADA, home);
    expect(after.length, 'two ticks over one occurrence produced more than one renewal order').toBe(
      before.length + 1,
    );
    const fresh = after.filter((o) => !before.some((b) => b.id === o.id));
    expect(fresh).toHaveLength(1);
    timerOrderId = fresh[0]!.id as string;
    expect(fresh[0]!.totalMinor).toBe(90_000);

    // and one row in the ledger the renewal engine keeps for itself
    expect(await subscriptionRunCount(home, adaSubscriptionId)).toBe(1);
    expect(await eventCount(home, EVENTS.SubscriptionRenewed)).toBe(1);
  }, 180_000);

  it('a run left claimed by a process that died does not bill a second time', async () => {
    // The restart case §1 names explicitly. Nothing about the subscription is
    // reset: the money already moved, and the only question is whether a
    // scheduler that finds a half-finished occurrence moves it again.
    const rows = await ledger();
    const occurrence = latestOccurrence(rows, JOB_RENEW, home);
    const run = theRunFor(rows, JOB_RENEW, home, occurrence);

    const ordersBefore = await ordersOf(ADA, home);
    const runsBefore = await subscriptionRunCount(home, adaSubscriptionId);

    const undoCrash = await leaveClaimed(run);
    try {
      await tick();
      await tick();

      const after = await ledger();
      // still ONE row for that occurrence — a restart does not produce a second
      expect(atOccurrence(runsFor(after, JOB_RENEW, home), occurrence)).toHaveLength(1);
      expect(await ordersOf(ADA, home)).toHaveLength(ordersBefore.length);
      expect(await subscriptionRunCount(home, adaSubscriptionId)).toBe(runsBefore);
      expect(await eventCount(home, EVENTS.SubscriptionRenewed)).toBe(1);
    } finally {
      await undoCrash();
    }
  }, 180_000);
});

/* ── 2. it does not run silently ──────────────────────────────────────────── */

describe('It does not run silently (docs/35 §1)', () => {
  it('leaves a row per job with a status, a start, a finish and an outcome', async () => {
    const rows = await ledger();
    for (const job of [JOB_RENEW, JOB_RANK]) {
      const mine = runsFor(rows, job, home);
      expect(
        mine.length,
        `no ${job} row for the home tenant. §3 lists it as a DAILY job, and §1 ` +
          `records every occurrence before it starts.`,
      ).toBeGreaterThan(0);
      const run = mine.sort((a, b) => b.scheduledFor.getTime() - a.scheduledFor.getTime())[0]!;
      expect(settled(run.status), `unsettled: ${describeRun(run)}`).toBe(true);
      expect(run.startedAt, `no start time: ${describeRun(run)}`).toBeTruthy();
      expect(run.finishedAt, `no finish time: ${describeRun(run)}`).toBeTruthy();
      expect(run.finishedAt!.getTime()).toBeGreaterThanOrEqual(run.startedAt!.getTime());
      expect(run.startedAt!.getTime()).toBeGreaterThanOrEqual(suiteStart.getTime() - 60_000);
      expect(
        run.outcome ?? null,
        `no outcome: "${job} ran" is not an answer to "what did it do?" — ${describeRun(run)}`,
      ).not.toBeNull();
    }
  });

  it('says so even when the job had nothing to do', async () => {
    // east sells nothing, so its renewal job renews nothing. A silent absence
    // and a recorded "nothing was due" are indistinguishable to an operator at
    // 3am — which is why §1 insists on the second.
    const rows = await ledger();
    const occurrence = latestOccurrence(rows, JOB_RENEW, east);
    const run = theRunFor(rows, JOB_RENEW, east, occurrence);

    expect(succeeded(run.status), `a job with no work is not a failure: ${describeRun(run)}`).toBe(
      true,
    );
    expect(run.finishedAt, `never settled: ${describeRun(run)}`).toBeTruthy();
    expect(run.outcome ?? null, `no outcome: ${describeRun(run)}`).not.toBeNull();
    // and the outcome says NOTHING happened, rather than saying nothing at all
    const worked = countsIn(run.outcome).filter(([, n]) => n !== 0);
    expect(
      worked.map(([path, n]) => `${path} = ${n}`),
      `a tenant with nothing due reported work it cannot have done: ${describeRun(run)}`,
    ).toEqual([]);
  });

  it('answers "did renewals run for this occurrence" from the table alone', async () => {
    // No API call, no service, no log: the question §1 poses is asked of
    // `scheduled_job_runs` and answered by it.
    const rows = await ledger();
    const occurrence = latestOccurrence(rows, JOB_RENEW, home);
    const answer = atOccurrence(runsFor(rows, JOB_RENEW, home), occurrence);

    expect(answer).toHaveLength(1);
    expect(answer[0]!.job).toBeTruthy();
    expect(answer[0]!.tenantId).toBe(home);
    expect(succeeded(answer[0]!.status)).toBe(true);
    expect(answer[0]!.finishedAt).toBeTruthy();

    // and the same question about an occurrence that never happened is
    // answered "no row", not "probably"
    const never = new Date(occurrence.getTime() - 365 * DAY_MS);
    expect(atOccurrence(runsFor(rows, JOB_RENEW, home), never)).toHaveLength(0);
  });

  it('records the platform-wide job against no tenant at all', async () => {
    // §2: "Platform-wide jobs carry tenant_id = NULL". `webhook.sweep` is the
    // one §3 lists, and it is read-only — the row is the whole product.
    const rows = await ledger();
    const platformRows = rows.filter(
      (r) => r.tenantId === null && r.scheduledFor.getTime() > suiteStart.getTime() - 3_600_000,
    );
    expect(
      platformRows.length,
      'no platform-scope run row (tenant_id IS NULL) since this suite started. ' +
        '§3 lists webhook.sweep as a platform job running every 5 minutes.',
    ).toBeGreaterThan(0);
    for (const row of platformRows) {
      expect(settled(row.status), `unsettled platform run: ${describeRun(row)}`).toBe(true);
      expect(row.finishedAt, `platform run never settled: ${describeRun(row)}`).toBeTruthy();
    }
  });
});

/* ── 3. one tenant does not stop the others ───────────────────────────────── */

describe('One tenant does not stop the others (docs/35 §1)', () => {
  it('records the failing tenant’s error and leaves every other tenant succeeded', async () => {
    // Pip's subscription cannot be billed: the total does not fit the column.
    // That is a data fault in ONE tenant, arranged before the first tick, and
    // the lesson the email handler taught in Sprint 3 says it stops there.
    await tick();

    const rows = await ledger();
    const occurrence = latestOccurrence(rows, JOB_RENEW, poison);
    const broken = theRunFor(rows, JOB_RENEW, poison, occurrence);

    expect(
      failed(broken.status),
      `the poisoned tenant's renewal did not fail — the fixture no longer breaks ` +
        `anything, so this test proves nothing: ${describeRun(broken)}`,
    ).toBe(true);
    expect(
      broken.error,
      `a failed run with no error text is not a support answer: ${describeRun(broken)}`,
    ).toBeTruthy();
    expect(
      broken.finishedAt,
      `a failed run must still settle: ${describeRun(broken)}`,
    ).toBeTruthy();
    // no order was invented for the tenant that failed
    expect(await ordersOf(PIP, poison)).toHaveLength(1); // the checkout order only

    // …and everyone else's occurrence is untouched by it
    for (const other of [home, east]) {
      const theirs = runsFor(rows, JOB_RENEW, other).sort(
        (a, b) => b.scheduledFor.getTime() - a.scheduledFor.getTime(),
      )[0];
      expect(
        theirs && succeeded(theirs.status),
        `tenant ${other} was stopped by another tenant's data: ${describeRun(theirs)}`,
      ).toBe(true);
    }

    // the failure is isolated to the JOB as well as to the tenant: the poisoned
    // tenant's other daily job still ran
    const rank = runsFor(rows, JOB_RANK, poison);
    if (rank.length > 0) {
      const latest = rank.sort((a, b) => b.scheduledFor.getTime() - a.scheduledFor.getTime())[0]!;
      expect(
        failed(latest.status),
        `rank evaluation failed because renewal did: ${describeRun(latest)}`,
      ).toBe(false);
    }
  }, 180_000);
});

/* ── 4. renewals actually happen on a timer ───────────────────────────────── */

describe('Renewals happen on the timer path (docs/35 §3)', () => {
  it('the order the scheduler made is the order the admin endpoint would have made', async () => {
    // §3: "Nothing here computes anything new. Every job calls the same service
    // an administrator's button already calls — a second implementation would
    // be a second answer." So the two orders are compared field by field.
    expect(
      timerOrderId,
      'no order was produced by the scheduler, so there is nothing to compare',
    ).toBeTruthy();

    const admin = await login(HOME_ADMIN);
    const today = dayIn(HOME_ZONE, new Date());
    await setDue(home, boSubscriptionId, today);

    const before = await ordersOf(BO, home);
    const manual = await api('/api/v1/subscriptions/run-due', {
      method: 'POST',
      token: admin,
      tenant: home,
      body: JSON.stringify({ asOf: today }),
    });
    expect(manual.status, JSON.stringify(manual.body)).toBe(201);

    const after = await ordersOf(BO, home);
    const fresh = after.filter((o) => !before.some((b) => b.id === o.id));
    expect(fresh, 'the admin endpoint did not renew Bo').toHaveLength(1);

    const byTimer = await orderDetail(ADA, home, timerOrderId);
    const byHand = await orderDetail(BO, home, fresh[0]!.id as string);

    // the same keys …
    expect(Object.keys(byTimer).sort()).toEqual(Object.keys(byHand).sort());
    // … and the same values, once identity and time are removed
    expect(shapeOf(byTimer)).toEqual(shapeOf(byHand));
    // and the values a reader would check by hand
    expect(byTimer.totalMinor).toBe(90_000);
    expect(byTimer.currency).toBe('THB');
    expect(byTimer.memberId).not.toBe(byHand.memberId);
  }, 120_000);
});

/* ── 5. commission.draft never approves ───────────────────────────────────── */

describe('commission.draft never approves (docs/35 §3)', () => {
  it('prepares a draft and stops, emitting nothing a member could be paid on', async () => {
    // "Money leaves on a person's decision, not a timer's." Today is not the
    // 1st, so the monthly occurrence is FORCED — which is exactly the override
    // §5 gives an operator, and it drives the same job the timer would.
    const platform = await login(PLATFORM_EMAIL);
    const now = new Date();
    const w = wallClock(HOME_ZONE, now);
    // the 1st of this month, as home reckons it — the occurrence for the month
    // that just ended
    const firstOfMonth = new Date(Date.UTC(w.year, w.month - 1, 1) - offsetMsAt(HOME_ZONE, now));

    const forced = await forceRun(platform, JOB_COMMISSION, home, firstOfMonth, HOME_ZONE);
    expect(
      forced.status,
      `POST /platform/scheduler/run refused every body shape tried; last was ` +
        `${JSON.stringify(forced.sent)} → ${JSON.stringify(forced.body)}`,
    ).toBeLessThan(400);

    const admin = await login(HOME_ADMIN);
    const list = await api('/api/v1/compensation/runs', { token: admin, tenant: home });
    expect(list.status).toBe(200);
    const runs = (list.body.runs ?? list.body.commissionRuns ?? []) as any[];
    expect(
      runs.length,
      'the commission.draft job produced no run at all — §3 says it creates a DRAFT run',
    ).toBeGreaterThan(0);

    for (const run of runs) {
      expect(run.status, `a timer approved a commission run: ${JSON.stringify(run)}`).toBe('draft');
      expect(run.approvedAt ?? null).toBeNull();
    }

    // the assertion the section exists for: nothing downstream was told
    expect(await eventCount(home, EVENTS.CommissionEarned)).toBe(0);
    expect(await eventCount(home, EVENTS.CommissionRunApproved)).toBe(0);

    // …and the scheduler said what it did
    const rows = await ledger();
    const drafts = runsFor(rows, JOB_COMMISSION, home);
    expect(
      drafts.length,
      'commission.draft ran but left no row, so nobody can tell it did',
    ).toBeGreaterThan(0);
    expect(settled(drafts[0]!.status), describeRun(drafts[0])).toBe(true);

    // and the same run, approved by a PERSON, does emit — so the silence above
    // is a decision the job made and not an engine that cannot pay anyone
    const draft = runs[0];
    const entries = await api(`/api/v1/compensation/runs/${draft.id}/entries`, {
      token: admin,
      tenant: home,
    });
    expect(entries.status).toBe(200);
    const entryCount = (entries.body.entries ?? []).length as number;
    const approve = await api(`/api/v1/compensation/runs/${draft.id}/approve`, {
      method: 'POST',
      token: admin,
      tenant: home,
    });
    expect([200, 201]).toContain(approve.status);
    expect(await eventCount(home, EVENTS.CommissionEarned)).toBe(entryCount);
  }, 120_000);
});

/* ── 6. the tenant's timezone decides the day ─────────────────────────────── */

describe('The tenant’s timezone decides the day (docs/35 §3)', () => {
  it('gives two tenants occurrence instants a zone apart for the same nominal day', async () => {
    // §3: "A tenant in Bangkok renewing at 02:00 local must not renew at 09:00
    // local because the server thinks in UTC." Bangkok is UTC+7 and Tokyo is
    // UTC+9 all year, so the same nominal day starts two hours apart, and the
    // stored occurrence has to show it.
    await tick();
    const rows = await ledger();

    const homeRuns = runsFor(rows, JOB_RENEW, home);
    const eastRuns = runsFor(rows, JOB_RENEW, east);
    expect(homeRuns.length, 'no renewal occurrence for the Bangkok tenant').toBeGreaterThan(0);
    expect(eastRuns.length, 'no renewal occurrence for the Tokyo tenant').toBeGreaterThan(0);

    // Each occurrence is read in ITS OWN tenant's zone — never the runner's,
    // which is UTC in CI and Asia/Bangkok on a laptop.
    const homeByDay = new Map(homeRuns.map((r) => [dayIn(HOME_ZONE, r.scheduledFor), r]));
    const eastByDay = new Map(eastRuns.map((r) => [dayIn(EAST_ZONE, r.scheduledFor), r]));
    const shared = [...homeByDay.keys()].filter((d) => eastByDay.has(d)).sort();
    expect(
      shared.length,
      `the two tenants share no nominal day: Bangkok has ${[...homeByDay.keys()].join(', ')} ` +
        `and Tokyo has ${[...eastByDay.keys()].join(', ')}`,
    ).toBeGreaterThan(0);

    const day = shared[shared.length - 1]!;
    const a = homeByDay.get(day)!;
    const b = eastByDay.get(day)!;

    // the same LOCAL time of day in both tenants — the cadence is fixed (§6)
    expect(
      clockIn(EAST_ZONE, b.scheduledFor),
      `the two tenants fire at different local times, so the difference below ` +
        `would not be a zone offset: ${describeRun(a)} vs ${describeRun(b)}`,
    ).toBe(clockIn(HOME_ZONE, a.scheduledFor));

    // and therefore two DIFFERENT instants, exactly the offset apart
    const offsetGap = offsetMsAt(EAST_ZONE, b.scheduledFor) - offsetMsAt(HOME_ZONE, a.scheduledFor);
    expect(offsetGap).toBe(2 * 3_600_000); // Tokyo is two hours ahead of Bangkok
    expect(
      a.scheduledFor.getTime() - b.scheduledFor.getTime(),
      `the same nominal day (${day}) produced instants that are not a zone apart: ` +
        `${describeRun(a)} vs ${describeRun(b)}. An occurrence computed in UTC would ` +
        `make these equal.`,
    ).toBe(offsetGap);
    expect(a.scheduledFor.getTime()).not.toBe(b.scheduledFor.getTime());
  }, 120_000);
});

/* ── 7. catch-up is bounded ───────────────────────────────────────────────── */

describe('Catch-up is bounded (docs/35 §4)', () => {
  it('runs a missed occurrence inside three days and skips, with a reason, one older', async () => {
    // §4: "a month of missed renewals firing at once is not recovery, it is an
    // incident." A tenant whose last recorded run was ten days ago is the only
    // way to state that, and it cannot be produced through any API.
    const rows = await ledger();
    const settledHome = runsFor(rows, JOB_RENEW, home).find((r) => succeeded(r.status));
    const okToken = settledHome?.status ?? 'succeeded';

    late = (await mkTenant('late', HOME_ZONE, `admin-late-${RUN}@test.local`)).id;
    const anchor = new Date(Date.now() - 10 * DAY_MS);
    await insertLedgerRow(JOB_RENEW, late, anchor, okToken);

    await catchUp();

    const after = (await ledger()).filter((r) => r.tenantId === late && isJob(r, JOB_RENEW));
    const window = Date.now() - 3 * DAY_MS;
    const older = after.filter(
      (r) => r.scheduledFor.getTime() < window && r.scheduledFor.getTime() > anchor.getTime(),
    );
    const inside = after.filter((r) => r.scheduledFor.getTime() >= window);

    // nothing older than the window RAN …
    for (const row of older) {
      expect(
        succeeded(row.status),
        `an occurrence ${Math.round((Date.now() - row.scheduledFor.getTime()) / DAY_MS)} days ` +
          `old was run: ${describeRun(row)}`,
      ).toBe(false);
      expect(skipped(row.status), `not recorded as skipped: ${describeRun(row)}`).toBe(true);
      const reason = row.error ?? JSON.stringify(row.outcome ?? null);
      expect(
        reason && reason !== 'null' && reason !== '{}',
        `skipped with no reason: ${describeRun(row)}. §4 records the reason, because a ` +
          `skipped renewal somebody has to explain to a customer is not a silent one.`,
      ).toBeTruthy();
    }
    expect(
      older.length,
      'nothing older than three days was recorded at all. §4: "Beyond that it records ' +
        'them as skipped with the reason" — an unrecorded skip is the silence §1 forbids.',
    ).toBeGreaterThan(0);

    // … and something inside it did
    expect(
      inside.some((r) => succeeded(r.status)),
      `no occurrence inside the three-day window ran: ${inside.map(describeRun).join(' | ')}`,
    ).toBe(true);

    // the bound itself: a daily job that was ten days behind ran at most the
    // window's worth of occurrences, not ten
    const ran = after.filter(
      (r) => succeeded(r.status) && r.scheduledFor.getTime() > anchor.getTime(),
    );
    expect(
      ran.length,
      `catch-up ran ${ran.length} occurrences; §4 bounds it to the last three days: ` +
        `${ran.map(describeRun).join(' | ')}`,
    ).toBeLessThanOrEqual(4);
  }, 240_000);
});

/* ── 8. operating it ──────────────────────────────────────────────────────── */

describe('Operating it (docs/35 §5)', () => {
  it('a platform role lists what ran, and can force one occurrence by hand', async () => {
    const platform = await login(PLATFORM_EMAIL);

    const listed = await listRuns(platform);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(
      runsOf(listed.body).length,
      'the listing is the answer to "did it run" (§5)',
    ).toBeGreaterThan(0);

    // the listing carries what an operator at 3am needs: which job, whose, when
    // and what happened
    const forHome = await listRuns(platform, home);
    expect(forHome.status, JSON.stringify(forHome.body)).toBe(200);
    const listing = runsOf(forHome.body);
    const mine = listing.filter((r: any) => (r.tenantId ?? r.tenant_id) === home);
    expect(
      listing.length,
      'a tenant-filtered listing returned rows belonging to other tenants',
    ).toBe(mine.length);
    expect(
      mine.length,
      'the listing shows nothing for a tenant that demonstrably ran',
    ).toBeGreaterThan(0);
    const row = mine[0];
    expect(String(row.job ?? row.jobName ?? row.name)).toBeTruthy();
    expect(row.status).toBeTruthy();
    expect(row.scheduledFor ?? row.scheduled_for).toBeTruthy();

    // and the override: forcing an occurrence that already ran does not run it
    // twice — the same unique key defends the manual path (§1, §2)
    const rowsBefore = await ledger();
    const occurrence = latestOccurrence(rowsBefore, JOB_RENEW, home);
    const ordersBefore = await ordersOf(ADA, home);

    const forced = await forceRun(platform, JOB_RENEW, home, occurrence, HOME_ZONE);
    expect(
      forced.status,
      `POST /platform/scheduler/run refused every body shape tried; last was ` +
        `${JSON.stringify(forced.sent)} → ${JSON.stringify(forced.body)}`,
    ).toBeLessThan(400);

    const rowsAfter = await ledger();
    expect(atOccurrence(runsFor(rowsAfter, JOB_RENEW, home), occurrence)).toHaveLength(1);
    expect(await ordersOf(ADA, home)).toHaveLength(ordersBefore.length);
  }, 120_000);

  it('refuses a tenant owner both routes — the schedule is the platform’s machinery', async () => {
    // §5: "it is platform-scope because the schedule is the platform's
    // machinery, not a tenant's." A tenant owner is the most privileged role
    // inside a tenant and still has no business here.
    const admin = await login(HOME_ADMIN);

    const listed = await api('/api/v1/platform/scheduler/runs', { token: admin, tenant: home });
    expect(listed.status, JSON.stringify(listed.body)).toBe(403);
    expect(listed.body?.error?.code).toBe('FORBIDDEN');

    const forced = await api('/api/v1/platform/scheduler/run', {
      method: 'POST',
      token: admin,
      tenant: home,
      body: JSON.stringify({
        job: JOB_RENEW,
        tenantId: home,
        scheduledFor: new Date().toISOString(),
      }),
    });
    expect(forced.status, JSON.stringify(forced.body)).toBe(403);

    // and a plain member is refused as well, from their own tenant
    const ada = await login(ADA);
    expect(
      (await api('/api/v1/platform/scheduler/runs', { token: ada, tenant: home })).status,
    ).toBe(403);
  });

  it('never lets one tenant read another tenant’s schedule through a tenant route', async () => {
    // There is no tenant-facing scheduler route to leak through — and if one is
    // ever added, this is where it fails.
    const admin = await login(HOME_ADMIN);
    for (const path of ['/api/v1/scheduler/runs', '/api/v1/tenant/scheduler/runs']) {
      const res = await api(path, { token: admin, tenant: home });
      expect([403, 404], `${path} answered ${res.status}`).toContain(res.status);
    }
  });
});
