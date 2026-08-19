/**
 * One person, several workspaces (spec §7, MVP DoD "one user can belong to
 * multiple tenants").
 *
 * This is the claim the whole identity model exists for: User is global,
 * Member is participation inside one tenant, and the two must not blur. The
 * same login therefore carries different roles, different memberships and
 * different data per tenant — and switching tenants must switch all of it.
 *
 * NOTE: stop any locally running API — the outbox relay is cross-tenant.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import * as argon2 from 'argon2';
import { createOwnerClient, ensureAppRole, type PrismaClient } from '@aviora/db';
import { ENTITLEMENTS, PERMISSIONS } from '@aviora/shared';
import { createApp } from '../../src/app.factory';

const RUN = `m${Date.now().toString(36)}`;
const PLATFORM_EMAIL = `e2e-platform-${RUN}@test.local`;
const PW = 'e2e-password-123456';
/** The person who exists in both workspaces. */
const PERSON = `nomad-${RUN}@test.local`;

let app: INestApplication;
let base: string;
let owner: PrismaClient;

let tenantAlpha: string;
let tenantBeta: string;
let alphaPlanId: string;
let betaPlanId: string;
let personToken: string;
let alphaTeamId: string;

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

async function inviteAndAccept(
  adminToken: string,
  tenant: string,
  planId: string,
  email: string,
  displayName: string,
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
    { method: 'POST', body: JSON.stringify({ displayName, password: PW }) },
  );
  expect(accepted.status).toBe(201);
  return accepted.body.memberId;
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

  // Alpha: the person is the TENANT OWNER (created with the tenant)
  const alpha = await api('/api/v1/platform/tenants', {
    method: 'POST',
    token: platform,
    body: JSON.stringify({
      code: `e2e_mt_alpha_${RUN}`,
      name: 'Alpha Wellness',
      slug: `e2e-mt-alpha-${RUN}`,
      adminEmail: PERSON,
      adminDisplayName: 'Nomad (owner)',
      adminPassword: PW,
    }),
  });
  expect(alpha.status).toBe(201);
  tenantAlpha = alpha.body.tenant.id;

  // Beta: a different admin runs it; the same person joins later as a MEMBER
  const beta = await api('/api/v1/platform/tenants', {
    method: 'POST',
    token: platform,
    body: JSON.stringify({
      code: `e2e_mt_beta_${RUN}`,
      name: 'Beta Club',
      slug: `e2e-mt-beta-${RUN}`,
      adminEmail: `beta-admin-${RUN}@test.local`,
      adminDisplayName: 'Beta Admin',
      adminPassword: PW,
    }),
  });
  expect(beta.status).toBe(201);
  tenantBeta = beta.body.tenant.id;

  personToken = await login(PERSON);
  alphaPlanId = (
    await api('/api/v1/membership-plans', {
      method: 'POST',
      token: personToken,
      tenant: tenantAlpha,
      body: JSON.stringify({
        code: 'alpha-plan',
        name: 'Alpha Plan',
        entitlementKeys: [ENTITLEMENTS.COURSE_ACCESS],
      }),
    })
  ).body.plan.id;

  const betaAdmin = await login(`beta-admin-${RUN}@test.local`);
  betaPlanId = (
    await api('/api/v1/membership-plans', {
      method: 'POST',
      token: betaAdmin,
      tenant: tenantBeta,
      body: JSON.stringify({ code: 'beta-plan', name: 'Beta Plan', entitlementKeys: [] }),
    })
  ).body.plan.id;

  // the same person accepts an invitation into Beta — same credentials
  await inviteAndAccept(betaAdmin, tenantBeta, betaPlanId, PERSON, 'Nomad (member)');

  // some Alpha-only data to prove separation
  alphaTeamId = (
    await api('/api/v1/teams', {
      method: 'POST',
      token: personToken,
      tenant: tenantAlpha,
      body: JSON.stringify({ code: 'alpha-team', name: 'Alpha Team' }),
    })
  ).body.team.id;
  await api('/api/v1/goals', {
    method: 'POST',
    token: personToken,
    tenant: tenantAlpha,
    body: JSON.stringify({ title: 'Alpha-only goal', category: 'health' }),
  });
}, 240_000);

afterAll(async () => {
  await app?.close();
  await owner?.$disconnect();
});

describe('one user, two tenants', () => {
  it('is a single global user with two tenant memberships and two members', async () => {
    const user = await owner.user.findUniqueOrThrow({ where: { email: PERSON } });
    const memberships = await owner.tenantMembership.findMany({ where: { userId: user.id } });
    const members = await owner.member.findMany({ where: { userId: user.id } });

    expect(memberships.map((m) => m.tenantId).sort()).toEqual([tenantAlpha, tenantBeta].sort());
    expect(members).toHaveLength(2);
    // distinct Member rows — participation is per tenant, identity is not
    expect(new Set(members.map((m) => m.id)).size).toBe(2);
    expect(members.map((m) => m.displayName).sort()).toEqual(['Nomad (member)', 'Nomad (owner)']);
  });

  it('lists both workspaces from one session (the tenant switcher source)', async () => {
    const res = await api('/api/v1/auth/me', { token: personToken });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(PERSON);
    expect(res.body.tenants.map((t: { tenantId: string }) => t.tenantId).sort()).toEqual(
      [tenantAlpha, tenantBeta].sort(),
    );
  });

  it('carries different roles per tenant with the same token', async () => {
    // owner in Alpha: may manage plans
    const alphaPlans = await api('/api/v1/membership-plans', {
      token: personToken,
      tenant: tenantAlpha,
    });
    expect(alphaPlans.status).toBe(200);
    const alphaCreate = await api('/api/v1/teams', {
      method: 'POST',
      token: personToken,
      tenant: tenantAlpha,
      body: JSON.stringify({ code: 'another-team', name: 'Another Team' }),
    });
    expect(alphaCreate.status).toBe(201);

    // plain member in Beta: same person, same token, no admin rights
    const betaPlans = await api('/api/v1/membership-plans', {
      method: 'POST',
      token: personToken,
      tenant: tenantBeta,
      body: JSON.stringify({ code: 'sneaky', name: 'Sneaky' }),
    });
    expect(betaPlans.status).toBe(403);

    const betaTeam = await api('/api/v1/teams', {
      method: 'POST',
      token: personToken,
      tenant: tenantBeta,
      body: JSON.stringify({ code: 'sneaky-team', name: 'Sneaky Team' }),
    });
    expect(betaTeam.status).toBe(403);
  });

  it('switching tenants switches the data, not just the label', async () => {
    const alphaGoals = await api('/api/v1/goals', { token: personToken, tenant: tenantAlpha });
    expect(alphaGoals.body.goals.map((g: { title: string }) => g.title)).toContain(
      'Alpha-only goal',
    );

    // the same person in Beta is a different member: their Alpha goals are not theirs here
    const betaGoals = await api('/api/v1/goals', { token: personToken, tenant: tenantBeta });
    expect(betaGoals.status).toBe(200);
    expect(betaGoals.body.goals).toHaveLength(0);

    const betaTeams = await api('/api/v1/teams', { token: personToken, tenant: tenantBeta });
    expect(betaTeams.body.teams.map((t: { id: string }) => t.id)).not.toContain(alphaTeamId);
  });

  it('a goal created in Beta stays in Beta', async () => {
    const created = await api('/api/v1/goals', {
      method: 'POST',
      token: personToken,
      tenant: tenantBeta,
      body: JSON.stringify({ title: 'Beta-only goal', category: 'learning' }),
    });
    expect(created.status).toBe(201);

    const alphaGoals = await api('/api/v1/goals', { token: personToken, tenant: tenantAlpha });
    const titles = alphaGoals.body.goals.map((g: { title: string }) => g.title);
    expect(titles).toContain('Alpha-only goal');
    expect(titles).not.toContain('Beta-only goal');
  });

  it('membership and entitlements are per tenant', async () => {
    // Alpha's plan grants course.access; Beta's does not
    const alphaMember = await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantAlpha}, true)`;
      const user = await tx.user.findUniqueOrThrow({ where: { email: PERSON } });
      return tx.member.findFirst({ where: { tenantId: tenantAlpha, userId: user.id } });
    });
    expect(alphaMember).toBeTruthy();
    expect(alphaPlanId).toBeTruthy();

    const courses = await api('/api/v1/courses', { token: personToken, tenant: tenantBeta });
    expect(courses.status).toBe(200);
    const start = await api(`/api/v1/courses/${courses.body.courses[0].id}/start`, {
      method: 'POST',
      token: personToken,
      tenant: tenantBeta,
    });
    // Beta's plan has no course.access — the entitlement is a property of the
    // membership in THAT tenant, not of the person
    expect(start.status).toBe(403);
    expect(start.body.error.code).toBe('ENTITLEMENT_REQUIRED');
  });

  it('rejects a tenant the person does not belong to', async () => {
    const platform = await login(PLATFORM_EMAIL);
    const third = await api('/api/v1/platform/tenants', {
      method: 'POST',
      token: platform,
      body: JSON.stringify({
        code: `e2e_mt_third_${RUN}`,
        name: 'Third Party',
        slug: `e2e-mt-third-${RUN}`,
        adminEmail: `third-${RUN}@test.local`,
        adminDisplayName: 'Third Admin',
        adminPassword: PW,
      }),
    });
    expect(third.status).toBe(201);

    const res = await api('/api/v1/goals', {
      token: personToken,
      tenant: third.body.tenant.id,
    });
    expect(res.status).toBe(403);
  });
});
