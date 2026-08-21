/**
 * Alerting (Sprint 23, docs/42).
 *
 * docs/42 §1 names the failure this is designed against, and it is not "the
 * alert did not fire". It is being unable to tell the difference between
 * nothing being wrong and nothing being checked. So the assertions here are
 * mostly about that distinction: `lastCheckedAt`, state transitions, and the
 * sweep surviving a notification it could not deliver.
 *
 * Every assertion is written against a BASELINE taken at the start rather than
 * against an absolute. This database has ambient stale claims and ambient
 * backlog from other suites, and three separate failures in this project have
 * come from a test reading shared, accumulating data as though it owned it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import * as argon2 from 'argon2';
import { createOwnerClient, ensureAppRole, type PrismaClient } from '@aviora/db';
import { ENTITLEMENTS, PERMISSIONS } from '@aviora/shared';
import { createApp } from '../../src/app.factory';
import { AlertsService } from '../../src/modules/observability/alerts.service';

const RUN = `a${Date.now().toString(36)}`;
const PLATFORM_EMAIL = `e2e-alert-platform-${RUN}@test.local`;
const PW = 'e2e-password-123456';
const STALE_JOB = `alert.fixture.${RUN.toLowerCase()}`.slice(0, 40);

let app: INestApplication;
let base: string;
let owner: PrismaClient;
let platform: string;
let tenantAdmin: string;
let tenant: string;

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

const check = (body: any, name: string) =>
  [...(body.firing ?? []), ...(body.quiet ?? [])].find((c: any) => c.check === name);

beforeAll(async () => {
  process.env.AVIORA_SCHEDULER_DISABLED = 'true';
  process.env.AVIORA_OUTBOX_DISABLED = 'true';
  process.env.AVIORA_PII_ENCRYPTION_KEY ??= Buffer.alloc(32, 17).toString('base64');
  // A real address with an SMTP server that is not there. Delivery failing is
  // the interesting case: the sweep must still record what it found.
  process.env.AVIORA_ALERT_EMAIL = `oncall-${RUN}@test.local`;
  process.env.AVIORA_SMTP_URL = 'smtp://127.0.0.1:1';

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
      displayName: 'E2E Alert Platform',
      platformRole: 'PLATFORM_OWNER',
    },
    update: {},
  });

  app = await createApp({ logger: false });
  await app.listen(0);
  base = (await app.getUrl()).replace('[::1]', '127.0.0.1');

  platform = await login(PLATFORM_EMAIL);
  const created = await api('/api/v1/platform/tenants', {
    method: 'POST',
    token: platform,
    body: JSON.stringify({
      code: `e2e_al_${RUN}`,
      name: 'Alert Co',
      slug: `e2e-al-${RUN}`,
      adminEmail: `al-admin-${RUN}@test.local`,
      adminDisplayName: 'Admin',
      adminPassword: PW,
    }),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  tenant = created.body.tenant.id;
  tenantAdmin = await login(`al-admin-${RUN}@test.local`);
}, 240_000);

afterAll(async () => {
  // The fixture is a stale claim. Left behind it would fire for every later
  // run of every suite that looks at alerts — a test that permanently arms an
  // alarm is worse than no test.
  await owner?.scheduledJobRun.deleteMany({ where: { job: STALE_JOB } });
  await app?.close();
  await owner?.$disconnect();
});

/* ── 1. silence has to mean something ─────────────────────────────────────── */

describe('An answer that cannot tell health from silence (docs/42 §1)', () => {
  it('always says when the checks last ran, not only what is firing', async () => {
    const res = await api('/api/v1/platform/observability/alerts', { token: platform });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(
      res.body,
      'the response must carry lastCheckedAt: "nothing is firing" from a sweep ' +
        'ninety seconds old and from one that stopped yesterday are the same words',
    ).toHaveProperty('lastCheckedAt');
    expect(res.body.note).toBeTruthy();
  });

  it('states the measured value and the line it was measured against', async () => {
    const res = await api('/api/v1/platform/observability/alerts', { token: platform });
    const all = [...res.body.firing, ...res.body.quiet];
    expect(all.length, 'no checks at all is not an alerting system').toBeGreaterThan(0);
    for (const c of all) {
      expect(typeof c.value, `${c.check} reported no value`).toBe('number');
      expect(typeof c.threshold, `${c.check} reported no threshold`).toBe('number');
      expect(c.summary, `${c.check} said nothing a person could act on`).toBeTruthy();
    }
  });

  it('refuses a tenant owner — the platform’s health is not tenant data', async () => {
    const res = await api('/api/v1/platform/observability/alerts', {
      token: tenantAdmin,
      tenant,
    });
    expect(res.status).toBe(403);
  });
});

/* ── 2. a check that can actually fire ────────────────────────────────────── */

describe('A stale claim is reported, because nothing will retry it (docs/35 §5)', () => {
  it('fires when a run has been claimed too long, and clears when it is gone', async () => {
    const before = check(
      (await api('/api/v1/platform/observability/alerts', { token: platform })).body,
      'scheduler.stale_claim',
    );
    expect(before, 'there is no stale-claim check').toBeTruthy();
    const baseline = before.value as number;

    // A run claimed two hours ago and never settled — exactly what a process
    // that died mid-occurrence leaves behind.
    await owner.scheduledJobRun.create({
      data: {
        job: STALE_JOB,
        tenantId: null,
        scheduledFor: new Date(Date.now() - 2 * 3_600_000),
        status: 'claimed',
        attempts: 1,
        startedAt: new Date(Date.now() - 2 * 3_600_000),
      },
    });

    const during = check(
      (await api('/api/v1/platform/observability/alerts', { token: platform })).body,
      'scheduler.stale_claim',
    );
    expect(
      during.value,
      'a run claimed two hours ago was not counted — this check is the only ' +
        'thing that tells an operator about a job nobody will ever retry',
    ).toBe(baseline + 1);
    expect(during.firing).toBe(true);
    expect(during.summary).toMatch(/claim/i);

    await owner.scheduledJobRun.deleteMany({ where: { job: STALE_JOB } });

    const after = check(
      (await api('/api/v1/platform/observability/alerts', { token: platform })).body,
      'scheduler.stale_claim',
    );
    expect(after.value, 'the check did not come back down').toBe(baseline);
  });
});

/* ── 3. the sweep ─────────────────────────────────────────────────────────── */

describe('The sweep records what it saw, and survives being unable to say so', () => {
  it('runs, writes state for every check, and sets lastCheckedAt', async () => {
    const result = await app.get(AlertsService).sweep();
    expect(result.checked, 'a sweep that checked nothing').toBeGreaterThan(0);

    const states = await owner.alertState.findMany();
    expect(states.length).toBe(result.checked);
    for (const s of states) {
      expect(s.checkedAt.getTime()).toBeGreaterThan(Date.now() - 120_000);
    }

    const res = await api('/api/v1/platform/observability/alerts', { token: platform });
    expect(
      res.body.lastCheckedAt,
      'the sweep ran but the endpoint still cannot say when',
    ).toBeTruthy();
  });

  it('does not stop when the alert cannot be delivered', async () => {
    // SMTP points at a dead port for this whole file. An alert nobody could be
    // told about must still be recorded — otherwise a broken mail server turns
    // into a platform with no monitoring and no sign of it.
    await owner.scheduledJobRun.create({
      data: {
        job: STALE_JOB,
        tenantId: null,
        scheduledFor: new Date(Date.now() - 3 * 3_600_000),
        status: 'claimed',
        attempts: 1,
        startedAt: new Date(Date.now() - 3 * 3_600_000),
      },
    });

    const result = await app.get(AlertsService).sweep();
    expect(result.firing).toContain('scheduler.stale_claim');

    const state = await owner.alertState.findUnique({ where: { check: 'scheduler.stale_claim' } });
    expect(state?.firing, 'the sweep failed to record a firing check').toBe(true);
    expect(
      state?.firingSince,
      'a firing check with no start time cannot answer "how long has this been broken?"',
    ).toBeTruthy();

    // Sweeping again keeps the episode's start rather than resetting it, or
    // every alert would look brand new every five minutes.
    const firstSince = state!.firingSince!.getTime();
    await app.get(AlertsService).sweep();
    const again = await owner.alertState.findUnique({ where: { check: 'scheduler.stale_claim' } });
    expect(again?.firingSince?.getTime()).toBe(firstSince);

    await owner.scheduledJobRun.deleteMany({ where: { job: STALE_JOB } });
  });
});

/* ── 4. it is a scheduled job, not a second scheduler ─────────────────────── */

describe('Alerting rides the scheduler (docs/42 §3)', () => {
  it('can be forced like any other job, and leaves a run row', async () => {
    const res = await api('/api/v1/platform/scheduler/run', {
      method: 'POST',
      token: platform,
      body: JSON.stringify({ job: 'alert.sweep' }),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const run = await owner.scheduledJobRun.findFirst({
      where: { job: 'alert.sweep' },
      orderBy: { createdAt: 'desc' },
    });
    expect(run, 'forcing the sweep left no row — it is not really a scheduled job').toBeTruthy();
    expect(run!.status).toBe('succeeded');
    expect(
      run!.outcome,
      'the run says nothing about what the sweep found; "it ran" is not an answer',
    ).toBeTruthy();
    expect(run!.tenantId, 'alerting is platform-wide and belongs to no tenant').toBeNull();
  });
});
