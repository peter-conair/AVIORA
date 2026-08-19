/**
 * Healthy Living OS (spec §27) and, above all, health-data privacy (spec §59).
 *
 * The promise being tested: no role reaches a member's health data. Not their
 * team leader, not a coach, not the tenant owner. Only a grant the member
 * created — and can revoke — opens it, and it opens READ only.
 *
 * NOTE: stop any locally running API — the outbox relay is cross-tenant.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import * as argon2 from 'argon2';
import { createOwnerClient, ensureAppRole, type PrismaClient } from '@aviora/db';
import { ENTITLEMENTS, PERMISSIONS } from '@aviora/shared';
import { createApp } from '../../src/app.factory';

const RUN = `h${Date.now().toString(36)}`;
const PLATFORM_EMAIL = `e2e-platform-${RUN}@test.local`;
const PW = 'e2e-password-123456';

let app: INestApplication;
let base: string;
let owner: PrismaClient;

let tenantId: string;
let planId: string;
let teamId: string;
const member: Record<'person' | 'leader' | 'stranger', string> = {} as never;
let habitId: string;

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

async function addMember(adminToken: string, email: string, name: string): Promise<string> {
  const inv = await api('/api/v1/invitations', {
    method: 'POST',
    token: adminToken,
    tenant: tenantId,
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

  const platform = await login(PLATFORM_EMAIL);
  const created = await api('/api/v1/platform/tenants', {
    method: 'POST',
    token: platform,
    body: JSON.stringify({
      code: `e2e_hl_${RUN}`,
      name: 'Healthy Co',
      slug: `e2e-hl-${RUN}`,
      adminEmail: `admin-${RUN}@test.local`,
      adminDisplayName: 'Admin',
      adminPassword: PW,
    }),
  });
  expect(created.status).toBe(201);
  tenantId = created.body.tenant.id;

  const admin = await login(`admin-${RUN}@test.local`);
  planId = (
    await api('/api/v1/membership-plans', {
      method: 'POST',
      token: admin,
      tenant: tenantId,
      body: JSON.stringify({ code: 'std', name: 'Standard', entitlementKeys: [] }),
    })
  ).body.plan.id;

  member.person = await addMember(admin, `person-${RUN}@test.local`, 'Person');
  member.leader = await addMember(admin, `leader-${RUN}@test.local`, 'Leader');
  member.stranger = await addMember(admin, `stranger-${RUN}@test.local`, 'Stranger');

  // the leader genuinely leads the team the person belongs to
  teamId = (
    await api('/api/v1/teams', {
      method: 'POST',
      token: admin,
      tenant: tenantId,
      body: JSON.stringify({ code: 'wellness', name: 'Wellness Team' }),
    })
  ).body.team.id;
  await api(`/api/v1/teams/${teamId}/leaders`, {
    method: 'POST',
    token: admin,
    tenant: tenantId,
    body: JSON.stringify({ memberId: member.leader }),
  });
  await api(`/api/v1/teams/${teamId}/members`, {
    method: 'POST',
    token: admin,
    tenant: tenantId,
    body: JSON.stringify({ memberId: member.person }),
  });
}, 240_000);

afterAll(async () => {
  await app?.close();
  await owner?.$disconnect();
});

describe('Healthy Living — a member tracking their own life', () => {
  it('saves a health profile and encrypts the free text at rest', async () => {
    const person = await login(`person-${RUN}@test.local`);
    const res = await api('/api/v1/health/me', {
      method: 'PUT',
      token: person,
      tenant: tenantId,
      body: JSON.stringify({ lifestyleNotes: 'Sleeps badly on work nights.' }),
    });
    expect(res.status).toBe(200);
    expect(res.body.profile.lifestyleNotes).toBe('Sleeps badly on work nights.');

    // the row itself must not contain the plaintext
    const row = await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return tx.healthProfile.findFirst({ where: { memberId: member.person } });
    });
    expect(row!.lifestyleNotes).not.toContain('Sleeps badly');
    expect(row!.lifestyleNotes).toMatch(/^enc\.v1\./);
  });

  it('tracks habits and metrics, idempotently per day', async () => {
    const person = await login(`person-${RUN}@test.local`);
    const habit = await api('/api/v1/health/habits', {
      method: 'POST',
      token: person,
      tenant: tenantId,
      body: JSON.stringify({
        code: 'water',
        name: 'Drink water',
        targetUnit: 'ml',
        targetValue: 2000,
      }),
    });
    expect(habit.status).toBe(201);
    habitId = habit.body.habit.id;

    const first = await api(`/api/v1/health/habits/${habitId}/log`, {
      method: 'POST',
      token: person,
      tenant: tenantId,
      body: JSON.stringify({ value: 1500 }),
    });
    expect(first.status).toBe(201);
    const again = await api(`/api/v1/health/habits/${habitId}/log`, {
      method: 'POST',
      token: person,
      tenant: tenantId,
      body: JSON.stringify({ value: 2100 }),
    });
    expect(again.status).toBe(201);
    expect(again.body.log.id).toBe(first.body.log.id); // same day, one row

    const metric = await api('/api/v1/health/metrics', {
      method: 'POST',
      token: person,
      tenant: tenantId,
      body: JSON.stringify({ metric: 'sleep_hours', value: 6.5, unit: 'h' }),
    });
    expect(metric.status).toBe(201);
  });

  it('summarises what was logged without scoring the person', async () => {
    const person = await login(`person-${RUN}@test.local`);
    const res = await api('/api/v1/health/me/summary', { token: person, tenant: tenantId });
    expect(res.status).toBe(200);
    expect(res.body.habits[0]).toMatchObject({ code: 'water', daysLogged: 1 });
    expect(res.body.latestMetrics).toContainEqual(
      expect.objectContaining({ metric: 'sleep_hours', value: 6.5 }),
    );
    // no wellness score, grade, or interpretation — just a stated boundary
    expect(res.body.note).toMatch(/not a health assessment/i);
    expect(JSON.stringify(res.body)).not.toMatch(/score|grade|risk/i);
  });

  it('states the safety note in the reader language', async () => {
    const person = await login(`person-${RUN}@test.local`);
    const res = await fetch(`${base}/api/v1/health/me/summary`, {
      headers: {
        authorization: `Bearer ${person}`,
        'x-tenant-id': tenantId,
        'accept-language': 'th-TH,th;q=0.9',
      },
    });
    const body = (await res.json()) as { note: string };
    // an English disclaimer on a Thai screen is the one fallback that is not
    // acceptable in this domain
    expect(body.note).toMatch(/ไม่ใช่การประเมินสุขภาพ/);
  });
});

describe('Health privacy — no role is a substitute for consent (spec §59)', () => {
  it("the member's own team leader cannot read their health data", async () => {
    const leader = await login(`leader-${RUN}@test.local`);
    const res = await api(`/api/v1/health/members/${member.person}/summary`, {
      token: leader,
      tenant: tenantId,
    });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/has not shared/i);
  });

  it('the tenant owner cannot read it either — there is no admin override', async () => {
    const admin = await login(`admin-${RUN}@test.local`);
    const res = await api(`/api/v1/health/members/${member.person}/summary`, {
      token: admin,
      tenant: tenantId,
    });
    expect(res.status).toBe(403);
  });

  it('after the member grants access, the leader can read the summary', async () => {
    const person = await login(`person-${RUN}@test.local`);
    const grant = await api(`/api/v1/health/grants/${member.leader}`, {
      method: 'POST',
      token: person,
      tenant: tenantId,
    });
    expect(grant.status).toBe(201);

    const leader = await login(`leader-${RUN}@test.local`);
    const res = await api(`/api/v1/health/members/${member.person}/summary`, {
      token: leader,
      tenant: tenantId,
    });
    expect(res.status).toBe(200);
    expect(res.body.habits[0].code).toBe('water');
  });

  it('a grant is read-only: the grantee still cannot write', async () => {
    const leader = await login(`leader-${RUN}@test.local`);
    const res = await api(`/api/v1/health/habits/${habitId}/log`, {
      method: 'POST',
      token: leader,
      tenant: tenantId,
      body: JSON.stringify({ value: 9999 }),
    });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/only be edited by the member/i);
  });

  it('a grant to one person does not open the door to anyone else', async () => {
    const stranger = await login(`stranger-${RUN}@test.local`);
    const res = await api(`/api/v1/health/members/${member.person}/summary`, {
      token: stranger,
      tenant: tenantId,
    });
    expect(res.status).toBe(403);
  });

  it('revoking closes access immediately', async () => {
    const person = await login(`person-${RUN}@test.local`);
    const revoke = await api(`/api/v1/health/grants/${member.leader}`, {
      method: 'DELETE',
      token: person,
      tenant: tenantId,
    });
    expect(revoke.status).toBe(200);

    const leader = await login(`leader-${RUN}@test.local`);
    const res = await api(`/api/v1/health/members/${member.person}/summary`, {
      token: leader,
      tenant: tenantId,
    });
    expect(res.status).toBe(403);
  });

  it('the member can see who they shared with', async () => {
    const person = await login(`person-${RUN}@test.local`);
    // re-grant so the list has content, then read it back
    await api(`/api/v1/health/grants/${member.leader}`, {
      method: 'POST',
      token: person,
      tenant: tenantId,
    });
    const res = await api('/api/v1/health/grants', { token: person, tenant: tenantId });
    expect(res.status).toBe(200);
    expect(res.body.given.map((g: { granteeMemberId: string }) => g.granteeMemberId)).toContain(
      member.leader,
    );
  });

  it('audit records that health data changed, never what it says', async () => {
    const rows = await owner.auditLog.findMany({
      where: { tenantId, action: { startsWith: 'health.' } },
    });
    expect(rows.length).toBeGreaterThan(0);
    const serialised = JSON.stringify(rows);
    expect(serialised).not.toContain('Sleeps badly');
    expect(rows.some((r) => r.action === 'health.grant.create')).toBe(true);
    expect(rows.some((r) => r.action === 'health.grant.revoke')).toBe(true);
  });
});
