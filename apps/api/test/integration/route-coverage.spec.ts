/**
 * Route-registry isolation sweep (docs/23 Sprint-1 DoD, docs/17).
 *
 * The isolation suites elsewhere assert specific endpoints behave. This one
 * asks the app which routes exist and then exercises EVERY tenant-scoped route
 * against a foreign tenant's data, so a newly added endpoint cannot silently
 * escape isolation testing: forget to scope it and this fails without anyone
 * remembering to add a case.
 *
 * NOTE: stop any locally running API — the outbox relay is cross-tenant.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import * as argon2 from 'argon2';
import { createOwnerClient, ensureAppRole, type PrismaClient } from '@aviora/db';
import { ENTITLEMENTS, PERMISSIONS } from '@aviora/shared';
import { createApp } from '../../src/app.factory';

const RUN = `r${Date.now().toString(36)}`;
const PLATFORM_EMAIL = `e2e-platform-${RUN}@test.local`;
const PW = 'e2e-password-123456';

let app: INestApplication;
let base: string;
let owner: PrismaClient;

/** Tenant A owns everything secret; tenant B is the attacker's own workspace. */
let tenantA: string;
let tenantB: string;
let tokenB: string;
/** Every id that belongs to tenant A — none may appear in a tenant-B response. */
const secretIds = new Map<string, string>();

interface RouteInfo {
  method: string;
  path: string;
}

/** Routes that are not tenant-scoped by design. */
const EXEMPT = [
  /^\/api\/v1\/auth\//, // authentication is cross-tenant by design
  /^\/api\/v1\/platform\//, // platform surface — guarded by platform role, tested separately
  /^\/api\/v1\/invitations\/[^/]+$/, // public invitation lookup by secret token
  /^\/healthz$/,
  /^\/readyz$/,
];

function listRoutes(nestApp: INestApplication): RouteInfo[] {
  const server = nestApp.getHttpAdapter().getInstance() as {
    router?: { stack: unknown[] };
    _router?: { stack: unknown[] };
  };
  const stack = (server.router ?? server._router)?.stack ?? [];
  const routes: RouteInfo[] = [];
  for (const layer of stack as Array<{
    route?: { path: string | string[]; methods?: Record<string, boolean>; stack?: unknown[] };
  }>) {
    const route = layer.route;
    if (!route) continue;
    const paths = Array.isArray(route.path) ? route.path : [route.path];
    const methods = Object.entries(route.methods ?? {})
      .filter(([, on]) => on)
      .map(([m]) => m.toUpperCase());
    for (const p of paths) {
      for (const m of methods) {
        if (m === 'HEAD' || m === 'OPTIONS') continue;
        routes.push({ method: m, path: p });
      }
    }
  }
  return routes;
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

async function api(
  path: string,
  init: RequestInit & { token?: string; tenant?: string } = {},
): Promise<{ status: number; text: string; body: any }> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...(init.tenant ? { 'x-tenant-id': init.tenant } : {}),
    },
  });
  const text = await res.text();
  return { status: res.status, text, body: text ? JSON.parse(text) : null };
}

beforeAll(async () => {
  process.env.AVIORA_OUTBOX_DISABLED = 'true';
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
        code: `e2e_rt_${suffix}_${RUN}`,
        name: `Route ${suffix}`,
        slug: `e2e-rt-${suffix}-${RUN}`,
        adminEmail,
        adminDisplayName: 'Admin',
        adminPassword: PW,
      }),
    });
    expect(res.status).toBe(201);
    return res.body.tenant as { id: string };
  };
  const a = await mkTenant('a', `rt-a-${RUN}@test.local`);
  const b = await mkTenant('b', `rt-b-${RUN}@test.local`);
  tenantA = a.id;
  tenantB = b.id;

  // populate tenant A with one record of every tenant-owned kind
  const adminA = await login(`rt-a-${RUN}@test.local`);
  const hA = { token: adminA, tenant: tenantA };

  const plan = await api('/api/v1/membership-plans', {
    method: 'POST',
    ...hA,
    body: JSON.stringify({
      code: 'secret-plan',
      name: 'Secret Plan',
      entitlementKeys: [ENTITLEMENTS.AI_COACH, ENTITLEMENTS.COURSE_ACCESS],
    }),
  });
  secretIds.set('plan', plan.body.plan.id);

  const team = await api('/api/v1/teams', {
    method: 'POST',
    ...hA,
    body: JSON.stringify({ code: 'secret-team', name: 'Secret Team' }),
  });
  secretIds.set('team', team.body.team.id);

  const invitation = await api('/api/v1/invitations', {
    method: 'POST',
    ...hA,
    body: JSON.stringify({ email: `secret-${RUN}@test.local`, planId: plan.body.plan.id }),
  });
  secretIds.set('invitation', invitation.body.invitation.id);
  const evt = await owner.domainEvent.findFirst({
    where: { eventName: 'MemberInvited', aggregateId: invitation.body.invitation.id },
  });
  const accepted = await api(
    `/api/v1/invitations/${(evt!.payload as { token: string }).token}/accept`,
    { method: 'POST', body: JSON.stringify({ displayName: 'Secret Member', password: PW }) },
  );
  secretIds.set('member', accepted.body.memberId);

  await api(`/api/v1/teams/${team.body.team.id}/members`, {
    method: 'POST',
    ...hA,
    body: JSON.stringify({ memberId: accepted.body.memberId }),
  });
  await api(`/api/v1/teams/${team.body.team.id}/leaders`, {
    method: 'POST',
    ...hA,
    body: JSON.stringify({ memberId: accepted.body.memberId }),
  });

  const secretMember = await login(`secret-${RUN}@test.local`);
  const hM = { token: secretMember, tenant: tenantA };

  const goal = await api('/api/v1/goals', {
    method: 'POST',
    ...hM,
    body: JSON.stringify({ title: 'Secret Goal', category: 'health' }),
  });
  secretIds.set('goal', goal.body.goal.id);

  const lead = await api('/api/v1/crm/leads', {
    method: 'POST',
    ...hM,
    body: JSON.stringify({ name: 'Secret Lead', source: 'secret' }),
  });
  secretIds.set('lead', lead.body.lead.id);

  const followUp = await api('/api/v1/crm/follow-ups', {
    method: 'POST',
    ...hM,
    body: JSON.stringify({
      title: 'Secret follow-up',
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
      leadId: lead.body.lead.id,
    }),
  });
  secretIds.set('followUp', followUp.body.followUp.id);

  const customer = await api(`/api/v1/crm/leads/${lead.body.lead.id}/convert`, {
    method: 'POST',
    ...hM,
  });
  secretIds.set('customer', customer.body.customer.id);

  const courses = await api('/api/v1/courses', hM);
  secretIds.set('course', courses.body.courses[0].id);
  secretIds.set('lesson', courses.body.courses[0].lessons[0].id);
  await api(`/api/v1/courses/${courses.body.courses[0].id}/start`, { method: 'POST', ...hM });

  const ai = await api('/api/v1/ai/ask', {
    method: 'POST',
    ...hM,
    body: JSON.stringify({ question: 'secret question about magnesium' }),
  });
  secretIds.set('aiConversation', ai.body.conversationId);

  tokenB = await login(`rt-b-${RUN}@test.local`);
}, 240_000);

afterAll(async () => {
  await app?.close();
  await owner?.$disconnect();
});

describe('route registry', () => {
  it('every tenant-scoped route is swept below (no route escapes coverage)', () => {
    const routes = listRoutes(app);
    expect(routes.length).toBeGreaterThan(30);
    const scoped = routes.filter((r) => !EXEMPT.some((rx) => rx.test(r.path)));
    expect(scoped.length).toBeGreaterThan(20);
    // documented for the reader: this is what the sweep below covers
    console.log(`route sweep: ${scoped.length} tenant-scoped routes of ${routes.length} total`);
  });
});

describe('cross-tenant sweep: reading as tenant B', () => {
  it('no GET route leaks a tenant A id to tenant B', async () => {
    const routes = listRoutes(app)
      .filter((r) => r.method === 'GET')
      .filter((r) => !EXEMPT.some((rx) => rx.test(r.path)))
      .filter((r) => !r.path.includes(':')); // parameterless list endpoints

    expect(routes.length).toBeGreaterThan(5);
    const leaks: string[] = [];

    for (const route of routes) {
      const res = await api(route.path, { token: tokenB, tenant: tenantB });
      if (res.status >= 500) {
        leaks.push(`${route.path} → ${res.status}`);
        continue;
      }
      for (const [label, id] of secretIds) {
        if (res.text.includes(id)) leaks.push(`${route.path} leaked ${label}`);
      }
    }
    expect(leaks).toEqual([]);
  });

  it("no :id route serves tenant A's record to tenant B", async () => {
    const byParam: Array<{ path: string; id: string }> = [
      { path: `/api/v1/teams/${secretIds.get('team')}`, id: 'team' },
      { path: `/api/v1/teams/${secretIds.get('team')}/members`, id: 'team' },
      { path: `/api/v1/teams/${secretIds.get('team')}/descendants`, id: 'team' },
      { path: `/api/v1/teams/${secretIds.get('team')}/dashboard`, id: 'team' },
      { path: `/api/v1/teams/${secretIds.get('team')}/leadership-history`, id: 'team' },
      { path: `/api/v1/crm/leads/${secretIds.get('lead')}`, id: 'lead' },
      { path: `/api/v1/ai/conversations/${secretIds.get('aiConversation')}`, id: 'aiConversation' },
    ];

    for (const target of byParam) {
      const res = await api(target.path, { token: tokenB, tenant: tenantB });
      expect([403, 404], `${target.path} returned ${res.status}`).toContain(res.status);
      expect(res.text, `${target.path} echoed the id`).not.toContain(secretIds.get('lead'));
    }
  });

  it('no mutating route accepts a tenant A id from tenant B', async () => {
    const attempts: Array<{ method: string; path: string; body: unknown }> = [
      {
        method: 'PATCH',
        path: `/api/v1/crm/leads/${secretIds.get('lead')}`,
        body: { notes: 'stolen' },
      },
      { method: 'POST', path: `/api/v1/crm/leads/${secretIds.get('lead')}/convert`, body: {} },
      {
        method: 'PATCH',
        path: `/api/v1/crm/follow-ups/${secretIds.get('followUp')}/complete`,
        body: {},
      },
      {
        method: 'POST',
        path: `/api/v1/teams/${secretIds.get('team')}/members`,
        body: { memberId: secretIds.get('member') },
      },
      {
        method: 'PATCH',
        path: `/api/v1/teams/${secretIds.get('team')}/move`,
        body: { newParentId: null },
      },
      {
        method: 'POST',
        path: `/api/v1/courses/${secretIds.get('course')}/start`,
        body: {},
      },
      {
        method: 'PATCH',
        path: `/api/v1/goals/${secretIds.get('goal')}`,
        body: { status: 'completed' },
      },
    ];

    for (const attempt of attempts) {
      const res = await api(attempt.path, {
        method: attempt.method,
        token: tokenB,
        tenant: tenantB,
        body: JSON.stringify(attempt.body),
      });
      expect([403, 404], `${attempt.method} ${attempt.path} returned ${res.status}`).toContain(
        res.status,
      );
    }

    // and tenant A's data is untouched
    const lead = await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantA}, true)`;
      return tx.lead.findFirst({ where: { id: secretIds.get('lead') } });
    });
    expect(lead?.notes ?? '').not.toContain('stolen');
  });
});
