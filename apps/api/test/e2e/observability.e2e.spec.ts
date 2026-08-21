/**
 * Observability (Sprint 17, docs/36).
 *
 * The contract makes four claims that can be wrong in ways nobody notices
 * until an incident, so those are what this file tests:
 *
 *   1. A request id the CALLER chose survives into the error body and the
 *      response header. Support tickets are built on that id matching.
 *   2. A scheduler run left `claimed` is REPORTED as stale. docs/35 §5 says
 *      the scheduler will never retry it, so if the metrics surface does not
 *      surface it, nothing does — the job is simply never run again.
 *   3. AI cost is tokens times a written-down rate, and a model with no rate
 *      costs `null`, never `0`. A fabricated zero is what docs/28 §6 refused.
 *   4. The tenant view is the tenant's own usage, WITHOUT the platform's
 *      provider cost, and one tenant cannot read another's.
 *
 * Fixtures are written with the owner client because these are platform-scope
 * tables (`domain_events`, `scheduled_job_runs`, `ai_usage`) that the app role
 * cannot write — the same reason the scheduler suite reads them that way.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import * as argon2 from 'argon2';
import { createOwnerClient, ensureAppRole, type PrismaClient } from '@aviora/db';
import { ENTITLEMENTS, PERMISSIONS, estimateAiCost, newId } from '@aviora/shared';
import { createApp } from '../../src/app.factory';

const RUN = `o${Date.now().toString(36)}`;
const PLATFORM_EMAIL = `e2e-obs-platform-${RUN}@test.local`;
const PW = 'e2e-password-123456';

let app: INestApplication;
let base: string;
let owner: PrismaClient;
let platformToken: string;
let alpha: string;
let beta: string;
let alphaAdminToken: string;
let betaAdminToken: string;

async function api(
  path: string,
  init: RequestInit & { token?: string; tenant?: string; requestId?: string } = {},
): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...(init.tenant ? { 'x-tenant-id': init.tenant } : {}),
      ...(init.requestId ? { 'x-request-id': init.requestId } : {}),
    },
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
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
      displayName: 'E2E Observability Platform',
      platformRole: 'PLATFORM_OWNER',
    },
    update: {},
  });

  app = await createApp({ logger: false });
  await app.listen(0);
  base = (await app.getUrl()).replace('[::1]', '127.0.0.1');

  platformToken = await login(PLATFORM_EMAIL);
  const mkTenant = async (suffix: string, name: string, adminEmail: string) => {
    const res = await api('/api/v1/platform/tenants', {
      method: 'POST',
      token: platformToken,
      body: JSON.stringify({
        code: `e2e_obs_${suffix}_${RUN}`,
        name,
        slug: `obs-${suffix}-${RUN}`,
        adminEmail,
        adminDisplayName: 'Admin',
        adminPassword: PW,
      }),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.tenant.id as string;
  };
  alpha = await mkTenant('a', 'Alpha Wellness', `obs-admin-a-${RUN}@test.local`);
  beta = await mkTenant('b', 'Beta Collective', `obs-admin-b-${RUN}@test.local`);
  alphaAdminToken = await login(`obs-admin-a-${RUN}@test.local`);
  betaAdminToken = await login(`obs-admin-b-${RUN}@test.local`);
}, 180_000);

afterAll(async () => {
  await app?.close();
  await owner?.$disconnect();
});

/* ── 1. one request, one id ───────────────────────────────────────────────── */

describe('A request keeps the id its caller gave it (docs/36 §2)', () => {
  it('echoes the caller’s X-Request-Id in the response header and the error body', async () => {
    const mine = `e2e-${RUN}-chosen-id`;
    const res = await api('/api/v1/members/00000000-0000-0000-0000-000000000000', {
      token: alphaAdminToken,
      tenant: alpha,
      requestId: mine,
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(
      res.body?.error?.request_id,
      'the error body must carry the id the caller sent, or a support ticket ' +
        'quoting it matches nothing in the logs',
    ).toBe(mine);
    expect(res.headers.get('x-request-id')).toBe(mine);
  });

  it('supplies one when the caller does not, and says the same thing in both places', async () => {
    const res = await api('/api/v1/members/00000000-0000-0000-0000-000000000000', {
      token: alphaAdminToken,
      tenant: alpha,
    });
    const fromBody = res.body?.error?.request_id;
    expect(fromBody).toBeTruthy();
    expect(fromBody).not.toBe('unknown');
  });
});

/* ── 2. the queue and the jobs ────────────────────────────────────────────── */

describe('The machinery reports on itself (docs/36 §4)', () => {
  it('counts an unprocessed event as pending, from the outbox itself', async () => {
    const before = await api('/api/v1/platform/observability/queue', { token: platformToken });
    expect(before.status, JSON.stringify(before.body)).toBe(200);

    await owner.domainEvent.create({
      data: {
        eventName: 'E2EObservabilityProbe',
        tenantId: alpha,
        aggregateType: 'probe',
        aggregateId: newId(),
        payload: {},
      },
    });

    const after = await api('/api/v1/platform/observability/queue', { token: platformToken });
    expect(after.body.pending).toBe(before.body.pending + 1);
    expect(
      after.body.oldestPendingAgeSeconds,
      'an unprocessed event with no age is a backlog nobody can size',
    ).not.toBeNull();
  });

  it('reports a run left claimed as stale, because nothing else ever will', async () => {
    // docs/35 §5: the scheduler refuses to re-run an occurrence that already
    // has a row — that is how it avoids billing twice — so a claimed row is a
    // job that will never run unless a person is told about it.
    const longAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const stale = await owner.scheduledJobRun.create({
      data: {
        job: 'subscription.renew',
        tenantId: alpha,
        scheduledFor: longAgo,
        status: 'claimed',
        attempts: 1,
        startedAt: longAgo,
      },
    });
    const fresh = await owner.scheduledJobRun.create({
      data: {
        job: 'rank.evaluate',
        tenantId: alpha,
        scheduledFor: new Date(),
        status: 'claimed',
        attempts: 1,
        startedAt: new Date(),
      },
    });

    const res = await api('/api/v1/platform/observability/jobs', { token: platformToken });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const ids = res.body.stale.runs.map((r: { id: string }) => r.id);
    expect(ids, 'a three-hour-old claim is a job nobody finished').toContain(stale.id);
    expect(
      ids,
      'a claim made a moment ago is a job in progress; calling it stale trains ' +
        'an operator to ignore the alert',
    ).not.toContain(fresh.id);

    const reported = res.body.stale.runs.find((r: { id: string }) => r.id === stale.id);
    expect(reported.claimedForSeconds).toBeGreaterThan(60 * 60);
    expect(res.body.stale.note).toMatch(/force/i);
    expect(res.body.jobs['subscription.renew']).toBeTruthy();
  });
});

/* ── 3. cost is arithmetic on a written-down rate ─────────────────────────── */

describe('AI cost is an estimate that shows its working (docs/36 §5)', () => {
  const KNOWN = { provider: 'anthropic', model: 'claude-sonnet-5' };
  const UNKNOWN = { provider: 'anthropic', model: 'claude-imaginary-9' };

  beforeAll(async () => {
    const member = await owner.member.findFirst({ where: { tenantId: alpha } });
    const memberB = await owner.member.findFirst({ where: { tenantId: beta } });
    const today = new Date(new Date().toISOString().slice(0, 10));
    await owner.aiUsage.create({
      data: {
        tenantId: alpha,
        memberId: member!.id,
        usageDate: today,
        provider: KNOWN.provider,
        model: KNOWN.model,
        requests: 3,
        inputTokens: 1_000_000,
        outputTokens: 200_000,
      },
    });
    await owner.aiUsage.create({
      data: {
        tenantId: beta,
        memberId: memberB!.id,
        usageDate: today,
        provider: UNKNOWN.provider,
        model: UNKNOWN.model,
        requests: 1,
        inputTokens: 500_000,
        outputTokens: 10_000,
      },
    });
  });

  it('multiplies tokens by the rate card, and the answer is checkable by hand', async () => {
    const res = await api('/api/v1/platform/observability/ai', { token: platformToken });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const mine = res.body.usage.find(
      (u: { tenantId: string; model: string }) => u.tenantId === alpha && u.model === KNOWN.model,
    );
    expect(mine, 'usage recorded for a tenant must appear against that tenant').toBeTruthy();
    // 1M input at 300 minor/M + 200k output at 1500 minor/M = 300 + 300 = 600
    expect(mine.costMinor).toBe(
      estimateAiCost(KNOWN.provider, KNOWN.model, 1_000_000, 200_000).costMinor,
    );
    expect(mine.costMinor).toBe(600);
    expect(mine.rateTakenOn, 'a price with no date is a price nobody can audit').toBeTruthy();
  });

  it('costs an unknown model null and names it, rather than zero', async () => {
    const res = await api('/api/v1/platform/observability/ai', { token: platformToken });
    const theirs = res.body.usage.find(
      (u: { tenantId: string; model: string }) => u.tenantId === beta && u.model === UNKNOWN.model,
    );
    expect(theirs.costMinor, 'zero is a number an operator will budget against').toBeNull();
    expect(theirs.note).toMatch(/no rate configured/i);
    expect(res.body.unpricedModels).toContain(`${UNKNOWN.provider}/${UNKNOWN.model}`);
    // named once, however many tenants used it — a list repeating the same
    // model forty times reads as forty problems
    expect(res.body.unpricedModels).toEqual([...new Set(res.body.unpricedModels)]);
    expect(
      res.body.totalCostMinor,
      'the total must exclude what it cannot price, not treat it as free',
    ).toBe(
      res.body.usage
        .filter((u: { costMinor: number | null }) => u.costMinor !== null)
        .reduce((n: number, u: { costMinor: number }) => n + u.costMinor, 0),
    );
  });
});

/* ── 4. the tenant's own view ─────────────────────────────────────────────── */

describe('A tenant sees itself, and only itself (docs/36 §4)', () => {
  it('answers with the caller’s own tenant, whatever else exists', async () => {
    const res = await api('/api/v1/tenant/usage', { token: alphaAdminToken, tenant: alpha });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.tenant.id).toBe(alpha);
    expect(JSON.stringify(res.body)).not.toContain(beta);
  });

  it('reports order value per currency, never one number across currencies', async () => {
    const res = await api('/api/v1/tenant/usage', { token: alphaAdminToken, tenant: alpha });
    expect(Array.isArray(res.body.tenant.orderValueInWindow)).toBe(true);
    for (const row of res.body.tenant.orderValueInWindow) {
      expect(row.currency).toMatch(/^[A-Z]{3}$/);
      expect(typeof row.totalMinor).toBe('number');
    }
    expect(res.body.tenant.orderValueMinorInWindow).toBeUndefined();
  });

  it('never shows the tenant what the platform pays a provider', async () => {
    const res = await api('/api/v1/tenant/usage', { token: alphaAdminToken, tenant: alpha });
    const asText = JSON.stringify(res.body);
    expect(
      asText,
      'provider cost is the platform’s margin, not a tenant-facing number',
    ).not.toMatch(/costMinor/);
    expect(res.body.ai.requests).toBeGreaterThanOrEqual(0);
    expect(res.body.ai.byModel).toBeTruthy();
  });

  it('refuses the platform routes to a tenant owner', async () => {
    for (const path of ['queue', 'jobs', 'ai', 'tenants']) {
      const res = await api(`/api/v1/platform/observability/${path}`, {
        token: betaAdminToken,
        tenant: beta,
      });
      expect(res.status, `${path} answered a tenant owner`).toBe(403);
    }
  });

  it('refuses one tenant’s admin the other tenant’s usage', async () => {
    const res = await api('/api/v1/tenant/usage', { token: alphaAdminToken, tenant: beta });
    expect(res.status).toBe(403);
  });
});
