/**
 * The partner portal (Sprint 27, docs/46).
 *
 * A partner is a THIRD kind of principal — not a platform role, not a member —
 * and introducing one is exactly the change that turns a guard into a
 * suggestion. So most of this file is about what a partner cannot do, and the
 * assertions are written as attacks rather than as features:
 *
 *   · reach a member route
 *   · see who their referrals are
 *   · see another partner's numbers
 *   · act as a partner in a tenant that never granted them access
 *
 * The one positive claim is that their own numbers are right, and even that is
 * asserted as counts, because counts are all they may have.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import * as argon2 from 'argon2';
import { createOwnerClient, ensureAppRole, withTenant, type PrismaClient } from '@aviora/db';
import { ENTITLEMENTS, PERMISSIONS } from '@aviora/shared';
import { createApp } from '../../src/app.factory';
import { OutboxRelayService } from '../../src/common/events/outbox-relay.service';

const RUN = `p${Date.now().toString(36)}`;
const PLATFORM_EMAIL = `e2e-pp-platform-${RUN}@test.local`;
const PW = 'e2e-password-123456';

let app: INestApplication;
let base: string;
let owner: PrismaClient;
let tenant: string;
let otherTenant: string;
let admin: string;
let planId: string;
let gymId: string;
let clinicId: string;
let gymToken: string;
let clinicToken: string;
let memberToken: string;

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
  expect(res.status, `login failed for ${email}`).toBe(200);
  const access = res.headers.getSetCookie().find((c) => c.startsWith('aviora_access='));
  return decodeURIComponent(access!.split(';')[0]!.split('=')[1]!);
}

/** A person with an account and no membership anywhere — what partner staff are. */
async function makeUser(email: string, name: string): Promise<string> {
  const user = await owner.user.upsert({
    where: { email },
    create: {
      email,
      passwordHash: await argon2.hash(PW, { type: argon2.argon2id }),
      displayName: name,
    },
    update: {},
  });
  return user.id;
}

async function partnerInvites(token: string, email: string): Promise<string> {
  const invited = await api('/api/v1/partner/invitations', {
    method: 'POST',
    token,
    tenant,
    body: JSON.stringify({ email, planId }),
  });
  expect(invited.status, JSON.stringify(invited.body)).toBe(201);
  const evt = await owner.domainEvent.findFirst({
    where: {
      eventName: 'MemberInvited',
      tenantId: tenant,
      aggregateId: invited.body.invitation.id,
    },
  });
  const accepted = await api(
    `/api/v1/invitations/${(evt!.payload as { token: string }).token}/accept`,
    { method: 'POST', body: JSON.stringify({ displayName: 'Customer', password: PW }) },
  );
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
  await app.get(OutboxRelayService).tick();
  return accepted.body.memberId;
}

beforeAll(async () => {
  process.env.AVIORA_SCHEDULER_DISABLED = 'true';
  process.env.AVIORA_OUTBOX_DISABLED = 'true';
  process.env.AVIORA_PII_ENCRYPTION_KEY ??= Buffer.alloc(32, 29).toString('base64');

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
      displayName: 'E2E PP Platform',
      platformRole: 'PLATFORM_OWNER',
    },
    update: {},
  });

  app = await createApp({ logger: false });
  await app.listen(0);
  base = (await app.getUrl()).replace('[::1]', '127.0.0.1');

  const platform = await login(PLATFORM_EMAIL);
  const mkTenant = async (suffix: string, name: string): Promise<string> => {
    const res = await api('/api/v1/platform/tenants', {
      method: 'POST',
      token: platform,
      body: JSON.stringify({
        code: `e2e_pp_${suffix}_${RUN}`,
        name,
        slug: `e2e-pp-${suffix}-${RUN}`,
        adminEmail: `pp-${suffix}-admin-${RUN}@test.local`,
        adminDisplayName: 'Admin',
        adminPassword: PW,
      }),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.tenant.id;
  };
  tenant = await mkTenant('a', 'Studio Co');
  otherTenant = await mkTenant('b', 'Rival Co');
  admin = await login(`pp-a-admin-${RUN}@test.local`);

  const plan = await api('/api/v1/membership-plans', {
    method: 'POST',
    token: admin,
    tenant,
    body: JSON.stringify({ code: 'std', name: 'Standard', entitlementKeys: [] }),
  });
  expect(plan.status).toBe(201);
  planId = plan.body.plan.id;

  const mkPartner = async (code: string, name: string): Promise<string> => {
    const res = await api('/api/v1/partners', {
      method: 'POST',
      token: admin,
      tenant,
      body: JSON.stringify({ code, name }),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.partner.id;
  };
  gymId = await mkPartner(`gym-${RUN}`, 'Northside Gym');
  clinicId = await mkPartner(`clinic-${RUN}`, 'Eastgate Clinic');

  await makeUser(`gym-staff-${RUN}@test.local`, 'Gym Staff');
  await makeUser(`clinic-staff-${RUN}@test.local`, 'Clinic Staff');
  for (const [id, email] of [
    [gymId, `gym-staff-${RUN}@test.local`],
    [clinicId, `clinic-staff-${RUN}@test.local`],
  ] as const) {
    const res = await api(`/api/v1/partners/${id}/users`, {
      method: 'POST',
      token: admin,
      tenant,
      body: JSON.stringify({ email }),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  }
  gymToken = await login(`gym-staff-${RUN}@test.local`);
  clinicToken = await login(`clinic-staff-${RUN}@test.local`);

  // Two customers via the gym, one via the clinic.
  await partnerInvites(gymToken, `cust1-${RUN}@test.local`);
  await partnerInvites(gymToken, `cust2-${RUN}@test.local`);
  await partnerInvites(clinicToken, `cust3-${RUN}@test.local`);
  memberToken = await login(`cust1-${RUN}@test.local`);
}, 300_000);

afterAll(async () => {
  await app?.close();
  await owner?.$disconnect();
});

/* ── 1. what a partner cannot do ──────────────────────────────────────────── */

describe('A partner is not a member, and no route lets them behave like one (docs/46 §1)', () => {
  it('refuses every member-facing route', async () => {
    for (const path of ['/api/v1/members', '/api/v1/goals', '/api/v1/offerings', '/api/v1/teams']) {
      const res = await api(path, { token: gymToken, tenant });
      expect(
        [401, 403].includes(res.status),
        `${path} answered ${res.status} to partner staff. They are not a member of ` +
          `this tenant and every tenant-scoped route must say so.`,
      ).toBe(true);
    }
  });

  it('refuses the tenant’s own partner administration', async () => {
    const res = await api('/api/v1/partners', { token: gymToken, tenant });
    expect(res.status).toBe(403);
  });

  it('refuses a partner in a tenant that never granted them access', async () => {
    const res = await api('/api/v1/partner/me', { token: gymToken, tenant: otherTenant });
    expect(
      res.status,
      'partner access in one tenant became partner access in another by changing a header',
    ).toBe(403);
  });

  it('refuses a member who is not partner staff', async () => {
    const res = await api('/api/v1/partner/performance', { token: memberToken, tenant });
    expect(res.status).toBe(403);
  });

  it('refuses a platform owner too — a platform role is not a partner', async () => {
    const platform = await login(PLATFORM_EMAIL);
    const res = await api('/api/v1/partner/me', { token: platform, tenant });
    expect(
      res.status,
      'the platform bypass reached a partner route, which would make "you see only ' +
        'your own numbers" depend on who is asking',
    ).toBe(403);
  });
});

/* ── 2. what a partner sees ───────────────────────────────────────────────── */

describe('Counts, never people (docs/46 §3)', () => {
  it('reports its own referrals and nothing about who they are', async () => {
    const res = await api('/api/v1/partner/performance', { token: gymToken, tenant });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.referred).toBe(2);

    const asText = JSON.stringify(res.body);
    const members = await withTenant(owner, tenant, (tx) =>
      tx.member.findMany({ select: { id: true, displayName: true } }),
    );
    for (const m of members) {
      expect(asText, 'a member id reached the partner portal').not.toContain(m.id);
      if (m.displayName) {
        expect(asText, 'a member name reached the partner portal').not.toContain(m.displayName);
      }
    }
    expect(asText).not.toMatch(/@test\.local/);
  });

  it('sees only its own numbers, not the other partner’s', async () => {
    const gym = await api('/api/v1/partner/performance', { token: gymToken, tenant });
    const clinic = await api('/api/v1/partner/performance', { token: clinicToken, tenant });
    expect(gym.body.referred).toBe(2);
    expect(clinic.body.referred, 'one partner’s portal counted another partner’s referrals').toBe(
      1,
    );
  });

  it('separates people who joined from invitations nobody accepted', async () => {
    const before = await api('/api/v1/partner/performance', { token: gymToken, tenant });
    const invited = await api('/api/v1/partner/invitations', {
      method: 'POST',
      token: gymToken,
      tenant,
      body: JSON.stringify({ email: `never-${RUN}@test.local`, planId }),
    });
    expect(invited.status).toBe(201);

    const after = await api('/api/v1/partner/performance', { token: gymToken, tenant });
    expect(
      after.body.referred,
      'an invitation nobody accepted was counted as somebody the partner brought',
    ).toBe(before.body.referred);
    expect(after.body.invitationsOutstanding).toBe(before.body.invitationsOutstanding + 1);
  });

  it('states the window and says what it excludes', async () => {
    const res = await api('/api/v1/partner/performance?days=90', { token: gymToken, tenant });
    expect(res.body.window.days).toBe(90);
    expect(res.body.note).toMatch(/health/i);
    expect(res.body.note).toMatch(/no name, no email, no id/i);
  });

  it('shows the partner their own profile', async () => {
    const res = await api('/api/v1/partner/me', { token: gymToken, tenant });
    expect(res.status).toBe(200);
    expect(res.body.partner.name).toBe('Northside Gym');
  });
});

/* ── 3. attribution is earned ─────────────────────────────────────────────── */

describe('Attribution is earned, never claimed (docs/46 §2)', () => {
  it('attributes a member to the partner who invited them, once', async () => {
    const rows = await withTenant(owner, tenant, (tx) =>
      tx.partnerReferral.findMany({ where: { partnerId: gymId, memberId: { not: null } } }),
    );
    expect(rows.length).toBe(2);
    for (const r of rows) expect(r.joinedAt).toBeTruthy();

    // Replaying the event changes nothing — the ledger and the null-guard both
    // hold, and a partner's numbers are the basis of what they get paid.
    const relay = app.get(OutboxRelayService);
    await relay.tick();
    const after = await withTenant(owner, tenant, (tx) =>
      tx.partnerReferral.count({ where: { partnerId: gymId, memberId: { not: null } } }),
    );
    expect(after).toBe(2);
  });

  it('refuses to make an existing member into partner staff', async () => {
    const res = await api(`/api/v1/partners/${gymId}/users`, {
      method: 'POST',
      token: admin,
      tenant,
      body: JSON.stringify({ email: `cust1-${RUN}@test.local` }),
    });
    expect(
      res.status,
      'a member became partner staff, so one person now has two identities in one tenant',
    ).toBe(400);
    expect(res.body.error.message).toMatch(/already a member/i);
  });

  it('revoking access closes the portal immediately', async () => {
    const link = await withTenant(owner, tenant, (tx) =>
      tx.partnerUser.findFirst({ where: { partnerId: clinicId, status: 'active' } }),
    );
    const revoked = await api(`/api/v1/partners/users/${link!.id}`, {
      method: 'DELETE',
      token: admin,
      tenant,
    });
    expect(revoked.status).toBe(200);

    const res = await api('/api/v1/partner/me', { token: clinicToken, tenant });
    expect(
      res.status,
      'a revoked partner user still reached the portal with the token they already had',
    ).toBe(403);
  });
});
