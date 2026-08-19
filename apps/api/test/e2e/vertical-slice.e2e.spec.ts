/**
 * Vertical Slice 1 E2E (spec §72, docs/15 §slice-1):
 * Platform Admin → Tenant → Plan(+entitlements) → Tenant Admin → Team A →
 * Invite → Register+Activate → Join Team → Goal → Course → Dashboard —
 * plus tenant-isolation and entitlement-gate negatives, outbox + audit proofs.
 *
 * Boots the real Nest app on an ephemeral port and talks HTTP.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import * as argon2 from 'argon2';
import { createOwnerClient, ensureAppRole, type PrismaClient } from '@aviora/db';
import { ENTITLEMENTS, PERMISSIONS } from '@aviora/shared';
import { createApp } from '../../src/app.factory';

const RUN = Date.now().toString(36);
const PLATFORM_EMAIL = `e2e-platform-${RUN}@test.local`;
const PW = 'e2e-password-123456';

let app: INestApplication;
let base: string;
let owner: PrismaClient;

// journey state
let tenantId: string;
let nokMemberId: string;
let starterPlanId: string;
let basicPlanId: string;
let inviteTokenPong: string;
let inviteTokenBasic: string;
let pongMemberId: string;
let teamAId: string;
let courseId: string;
let lessonIds: string[] = [];
let betaTenantId: string;

async function api(
  path: string,
  init: RequestInit & { token?: string; tenant?: string } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
    ...(init.tenant ? { 'x-tenant-id': init.tenant } : {}),
  };
  const res = await fetch(`${base}${path}`, { ...init, headers });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  expect(res.status).toBe(200);
  const setCookie = res.headers.getSetCookie();
  const access = setCookie.find((c) => c.startsWith('aviora_access='));
  expect(access).toBeDefined();
  return decodeURIComponent(access!.split(';')[0]!.split('=')[1]!);
}

beforeAll(async () => {
  process.env.AVIORA_OUTBOX_DISABLED = 'true'; // events asserted in the outbox itself
  owner = createOwnerClient();
  await ensureAppRole(owner);

  // minimal platform seed (idempotent — mirrors prisma/seed.ts)
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
  const url = await app.getUrl();
  base = url.replace('[::1]', '127.0.0.1');
}, 120_000);

afterAll(async () => {
  await app?.close();
  await owner?.$disconnect();
});

describe('Slice 1 — the §72 journey', () => {
  it('platform admin logs in and creates tenant "Wellness One"', async () => {
    const token = await login(PLATFORM_EMAIL, PW);
    const res = await api('/api/v1/platform/tenants', {
      method: 'POST',
      token,
      body: JSON.stringify({
        code: `e2e_w1_${RUN}`,
        name: 'Wellness One',
        slug: `e2e-w1-${RUN}`,
        defaultLanguage: 'th',
        timezone: 'Asia/Bangkok',
        adminEmail: `nok-${RUN}@test.local`,
        adminDisplayName: 'Nok',
        adminPassword: PW,
      }),
    });
    expect(res.status).toBe(201);
    tenantId = res.body.tenant.id;
    nokMemberId = res.body.adminMemberId;
    expect(tenantId).toBeTruthy();
  });

  it("Nok's /auth/me lists Wellness One (cross-tenant auth query, pre-selection)", async () => {
    const nok = await login(`nok-${RUN}@test.local`, PW);
    const res = await api('/api/v1/auth/me', { token: nok });
    expect(res.status).toBe(200);
    expect(res.body.tenants.map((t: { tenantId: string }) => t.tenantId)).toContain(tenantId);
  });

  it('healthz and readyz are public', async () => {
    const [h, r] = await Promise.all([api('/healthz'), api('/readyz')]);
    expect(h.status).toBe(200);
    expect(r.status).toBe(200);
  });

  it('a non-platform user cannot create tenants', async () => {
    const nok = await login(`nok-${RUN}@test.local`, PW);
    const res = await api('/api/v1/platform/tenants', {
      method: 'POST',
      token: nok,
      body: JSON.stringify({
        code: `e2e_h4x_${RUN}`,
        name: 'Nope',
        slug: `e2e-h4x-${RUN}`,
        adminEmail: 'x@test.local',
        adminDisplayName: 'X',
        adminPassword: PW,
      }),
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('tenant admin creates the Starter plan with course.access', async () => {
    const nok = await login(`nok-${RUN}@test.local`, PW);
    const res = await api('/api/v1/membership-plans', {
      method: 'POST',
      token: nok,
      tenant: tenantId,
      body: JSON.stringify({
        code: 'starter',
        name: 'Starter',
        trialDays: 14,
        entitlementKeys: [ENTITLEMENTS.COURSE_ACCESS],
      }),
    });
    expect(res.status).toBe(201);
    starterPlanId = res.body.plan.id;

    // and a Basic plan WITHOUT course access (for the entitlement negative)
    const res2 = await api('/api/v1/membership-plans', {
      method: 'POST',
      token: nok,
      tenant: tenantId,
      body: JSON.stringify({ code: 'basic', name: 'Basic', entitlementKeys: [] }),
    });
    expect(res2.status).toBe(201);
    basicPlanId = res2.body.plan.id;
  });

  it('tenant admin creates Team A and assigns herself leader', async () => {
    const nok = await login(`nok-${RUN}@test.local`, PW);
    const created = await api('/api/v1/teams', {
      method: 'POST',
      token: nok,
      tenant: tenantId,
      body: JSON.stringify({ code: 'team-a', name: 'Team A' }),
    });
    expect(created.status).toBe(201);
    teamAId = created.body.team.id;

    const led = await api(`/api/v1/teams/${teamAId}/leaders`, {
      method: 'POST',
      token: nok,
      tenant: tenantId,
      body: JSON.stringify({ memberId: nokMemberId }),
    });
    expect(led.status).toBe(201);
    expect(led.body.leadership.isPrimary).toBe(true);
  });

  it('tenant admin invites Pong on the Starter plan (event → outbox)', async () => {
    const nok = await login(`nok-${RUN}@test.local`, PW);
    const res = await api('/api/v1/invitations', {
      method: 'POST',
      token: nok,
      tenant: tenantId,
      body: JSON.stringify({ email: `pong-${RUN}@test.local`, planId: starterPlanId }),
    });
    expect(res.status).toBe(201);

    const evt = await owner.domainEvent.findFirst({
      where: { eventName: 'MemberInvited', tenantId },
      orderBy: { occurredAt: 'desc' },
    });
    expect(evt).toBeTruthy();
    inviteTokenPong = (evt!.payload as { token: string }).token;
    expect(inviteTokenPong).toBeTruthy();
  });

  it('the public invitation page shows tenant and plan', async () => {
    const res = await api(`/api/v1/invitations/${inviteTokenPong}`);
    expect(res.status).toBe(200);
    expect(res.body.invitation.tenantName).toBe('Wellness One');
    expect(res.body.invitation.planName).toBe('Starter');
    expect(res.body.invitation.trialDays).toBe(14);
  });

  it('Pong accepts → member + membership activated (trial)', async () => {
    const res = await api(`/api/v1/invitations/${inviteTokenPong}/accept`, {
      method: 'POST',
      body: JSON.stringify({ displayName: 'Pong', password: PW }),
    });
    expect(res.status).toBe(201);
    pongMemberId = res.body.memberId;
    expect(res.body.membershipId).toBeTruthy();

    const membershipEvt = await owner.domainEvent.count({
      where: { eventName: 'MembershipActivated', tenantId },
    });
    expect(membershipEvt).toBe(1);

    const invitation = await owner.invitation.findFirst({
      where: { tenantId, email: `pong-${RUN}@test.local` },
    });
    expect(invitation?.status).toBe('accepted');
  });

  it('accepting the same invitation twice fails', async () => {
    const res = await api(`/api/v1/invitations/${inviteTokenPong}/accept`, {
      method: 'POST',
      body: JSON.stringify({ displayName: 'Pong2', password: PW }),
    });
    expect(res.status).toBe(404);
  });

  it('Nok adds Pong to Team A', async () => {
    const nok = await login(`nok-${RUN}@test.local`, PW);
    const res = await api(`/api/v1/teams/${teamAId}/members`, {
      method: 'POST',
      token: nok,
      tenant: tenantId,
      body: JSON.stringify({ memberId: pongMemberId }),
    });
    expect(res.status).toBe(201);
  });

  it('Pong creates the goal "Sleep 7 hours"', async () => {
    const pong = await login(`pong-${RUN}@test.local`, PW);
    const res = await api('/api/v1/goals', {
      method: 'POST',
      token: pong,
      tenant: tenantId,
      body: JSON.stringify({ title: 'Sleep 7 hours', category: 'health' }),
    });
    expect(res.status).toBe(201);
    expect(res.body.goal.title).toBe('Sleep 7 hours');
  });

  it('Pong starts the seeded course and completes all lessons', async () => {
    const pong = await login(`pong-${RUN}@test.local`, PW);
    const courses = await api('/api/v1/courses', { token: pong, tenant: tenantId });
    expect(courses.status).toBe(200);
    expect(courses.body.courses).toHaveLength(1);
    courseId = courses.body.courses[0].id;
    lessonIds = courses.body.courses[0].lessons.map((l: { id: string }) => l.id);
    expect(lessonIds).toHaveLength(3);

    const start = await api(`/api/v1/courses/${courseId}/start`, {
      method: 'POST',
      token: pong,
      tenant: tenantId,
    });
    expect(start.status).toBe(201);

    for (const lessonId of lessonIds) {
      const done = await api(`/api/v1/lessons/${lessonId}/complete`, {
        method: 'POST',
        token: pong,
        tenant: tenantId,
      });
      expect(done.status).toBe(201);
    }
    const progress = await api('/api/v1/learning/progress', { token: pong, tenant: tenantId });
    expect(progress.body.progress[0].status).toBe('completed');
  });

  it("Pong's dashboard shows goal, completed course, and Team A", async () => {
    const pong = await login(`pong-${RUN}@test.local`, PW);
    const res = await api('/api/v1/dashboard/me', { token: pong, tenant: tenantId });
    expect(res.status).toBe(200);
    expect(res.body.membership.planName).toBe('Starter');
    expect(res.body.membership.trialEndsAt).toBeTruthy();
    expect(res.body.goals.recent[0].title).toBe('Sleep 7 hours');
    expect(res.body.learning[0]).toMatchObject({
      status: 'completed',
      completedLessons: 3,
      totalLessons: 3,
    });
    expect(res.body.teams.map((t: { name: string }) => t.name)).toContain('Team A');
  });
});

describe('Slice 1 — permission & entitlement gates', () => {
  it('Pong (MEMBER role) cannot create plans or invite members', async () => {
    const pong = await login(`pong-${RUN}@test.local`, PW);
    const plan = await api('/api/v1/membership-plans', {
      method: 'POST',
      token: pong,
      tenant: tenantId,
      body: JSON.stringify({ code: 'nope', name: 'Nope' }),
    });
    expect(plan.status).toBe(403);
    const invite = await api('/api/v1/invitations', {
      method: 'POST',
      token: pong,
      tenant: tenantId,
      body: JSON.stringify({ email: 'x@test.local', planId: starterPlanId }),
    });
    expect(invite.status).toBe(403);
  });

  it('a member on a plan WITHOUT course.access is blocked from starting a course', async () => {
    const nok = await login(`nok-${RUN}@test.local`, PW);
    await api('/api/v1/invitations', {
      method: 'POST',
      token: nok,
      tenant: tenantId,
      body: JSON.stringify({ email: `basic-${RUN}@test.local`, planId: basicPlanId }),
    });
    const evt = await owner.domainEvent.findFirst({
      where: { eventName: 'MemberInvited', tenantId },
      orderBy: { occurredAt: 'desc' },
    });
    inviteTokenBasic = (evt!.payload as { token: string }).token;
    const accepted = await api(`/api/v1/invitations/${inviteTokenBasic}/accept`, {
      method: 'POST',
      body: JSON.stringify({ displayName: 'Basic Member', password: PW }),
    });
    expect(accepted.status).toBe(201);

    const basic = await login(`basic-${RUN}@test.local`, PW);
    const start = await api(`/api/v1/courses/${courseId}/start`, {
      method: 'POST',
      token: basic,
      tenant: tenantId,
    });
    expect(start.status).toBe(403);
    expect(start.body.error.code).toBe('ENTITLEMENT_REQUIRED');
  });

  it('rotates refresh tokens, and reuse of an old one kills the family', async () => {
    // This path had no test and was broken in production: the rotation wrote a
    // truncated hash into a uuid column, so every refresh 500'd once an access
    // token expired.
    const loginRes = await fetch(`${base}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `pong-${RUN}@test.local`, password: PW }),
    });
    expect(loginRes.status).toBe(200);
    const firstRefresh = loginRes.headers
      .getSetCookie()
      .find((c) => c.startsWith('aviora_refresh='))!
      .split(';')[0]!
      .split('=')[1]!;

    const rotated = await fetch(`${base}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: { cookie: `aviora_refresh=${firstRefresh}` },
    });
    expect(rotated.status).toBe(200);
    const secondRefresh = rotated.headers
      .getSetCookie()
      .find((c) => c.startsWith('aviora_refresh='))!
      .split(';')[0]!
      .split('=')[1]!;
    expect(secondRefresh).not.toBe(firstRefresh);

    // the new one works
    const again = await fetch(`${base}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: { cookie: `aviora_refresh=${secondRefresh}` },
    });
    expect(again.status).toBe(200);

    // replaying the first one is treated as theft: every session is revoked
    const replay = await fetch(`${base}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: { cookie: `aviora_refresh=${firstRefresh}` },
    });
    expect(replay.status).toBe(401);
    const afterReuse = await fetch(`${base}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: { cookie: `aviora_refresh=${secondRefresh}` },
    });
    expect(afterReuse.status).toBe(401);
  });

  it('unauthenticated requests get 401 with the standard envelope', async () => {
    const res = await api('/api/v1/goals', { tenant: tenantId });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
    expect(res.body.error.request_id).toBeTruthy();
  });
});

describe('Slice 1 — tenant isolation at the API level', () => {
  it('a second tenant exists with its own admin', async () => {
    const token = await login(PLATFORM_EMAIL, PW);
    const res = await api('/api/v1/platform/tenants', {
      method: 'POST',
      token,
      body: JSON.stringify({
        code: `e2e_beta_${RUN}`,
        name: 'Beta Club',
        slug: `e2e-beta-${RUN}`,
        adminEmail: `beta-admin-${RUN}@test.local`,
        adminDisplayName: 'Beta Admin',
        adminPassword: PW,
      }),
    });
    expect(res.status).toBe(201);
    betaTenantId = res.body.tenant.id;
  });

  it("Beta's admin cannot see Wellness One's team, members, or plans", async () => {
    const beta = await login(`beta-admin-${RUN}@test.local`, PW);
    const team = await api(`/api/v1/teams/${teamAId}`, { token: beta, tenant: betaTenantId });
    expect(team.status).toBe(404);

    const members = await api('/api/v1/members', { token: beta, tenant: betaTenantId });
    expect(members.status).toBe(200);
    const emails = members.body.members.map((m: { email: string }) => m.email);
    expect(emails).not.toContain(`pong-${RUN}@test.local`);

    const plans = await api('/api/v1/membership-plans', { token: beta, tenant: betaTenantId });
    const codes = plans.body.plans.map((p: { code: string }) => p.code);
    expect(codes).not.toContain('starter');
  });

  it('Pong gets 403 when pointing at Beta Club (not a member there)', async () => {
    const pong = await login(`pong-${RUN}@test.local`, PW);
    const res = await api('/api/v1/goals', { token: pong, tenant: betaTenantId });
    expect(res.status).toBe(403);
  });

  it("Nok cannot smuggle a team into Beta's tenant via header", async () => {
    const nok = await login(`nok-${RUN}@test.local`, PW);
    const res = await api('/api/v1/teams', {
      method: 'POST',
      token: nok,
      tenant: betaTenantId,
      body: JSON.stringify({ code: 'smuggled', name: 'Smuggled' }),
    });
    expect(res.status).toBe(403); // Nok is not a member of Beta Club
  });
});

describe('Slice 1 — outbox and audit proofs', () => {
  it('each journey event was written to the outbox exactly once', async () => {
    const expected: Record<string, number> = {
      TenantCreated: 1,
      TeamCreated: 1,
      LeaderAssigned: 1,
      MemberJoinedTeam: 1,
      GoalCreated: 1,
      CourseStarted: 1,
      CourseCompleted: 1,
      MemberInvited: 2, // Pong + basic member
      MemberRegistered: 2,
      MembershipActivated: 2,
    };
    for (const [eventName, count] of Object.entries(expected)) {
      const actual = await owner.domainEvent.count({ where: { eventName, tenantId } });
      expect(actual, `${eventName} count`).toBe(count);
    }
  });

  it('sensitive mutations have audit rows with request ids', async () => {
    const actions = [
      'platform.tenant.create',
      'membership.plan.create',
      'member.invite',
      'member.register',
      'team.create',
      'team.leader.assign',
      'team.member.join',
      'goal.create',
    ];
    for (const action of actions) {
      const row = await owner.auditLog.findFirst({ where: { action, tenantId } });
      expect(row, `audit row for ${action}`).toBeTruthy();
      expect(row!.requestId).toBeTruthy();
    }
  });
});
