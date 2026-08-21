/**
 * Corporate wellness sponsorship (Sprint 26, docs/45).
 *
 * The accounting is the easy half. The half worth testing is docs/45 §1: an
 * employer has paid for these memberships and wants to know it is working, and
 * the honest answer is participation and never health. Health is SELF-scoped
 * with no admin override (docs/13), and paying for somebody's membership is not
 * consent to see their sleep.
 *
 * So the sharpest test here arranges a sponsored member whose ONLY activity is
 * health, and requires the sponsor's view to show nothing about them — not the
 * value, not the fact, not a count they contribute to. That is a real cost to a
 * real customer, and it is the product rather than a gap in it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import * as argon2 from 'argon2';
import { createOwnerClient, ensureAppRole, withTenant, type PrismaClient } from '@aviora/db';
import { ENTITLEMENTS, PERMISSIONS } from '@aviora/shared';
import { createApp } from '../../src/app.factory';
import { OutboxRelayService } from '../../src/common/events/outbox-relay.service';

const RUN = `w${Date.now().toString(36)}`;
const PLATFORM_EMAIL = `e2e-cw-platform-${RUN}@test.local`;
const PW = 'e2e-password-123456';

let app: INestApplication;
let base: string;
let owner: PrismaClient;
let tenant: string;
let admin: string;
let planId: string;
let poolId: string;

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

/** Sends the invitation and accepts it, returning the new member's id. */
async function joinVia(pool: string, email: string): Promise<string> {
  const invited = await api(`/api/v1/sponsorships/${pool}/invitations`, {
    method: 'POST',
    token: admin,
    tenant,
    body: JSON.stringify({ email }),
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
    { method: 'POST', body: JSON.stringify({ displayName: 'Employee', password: PW }) },
  );
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);

  // The seat is assigned by an outbox handler, so the relay has to run for the
  // reservation to become an assignment.
  await app.get(OutboxRelayService).tick();
  return accepted.body.memberId;
}

const poolNow = async () => {
  const res = await api('/api/v1/sponsorships', { token: admin, tenant });
  return res.body.sponsorships.find((p: { id: string }) => p.id === poolId);
};

beforeAll(async () => {
  process.env.AVIORA_SCHEDULER_DISABLED = 'true';
  process.env.AVIORA_OUTBOX_DISABLED = 'true';
  process.env.AVIORA_PII_ENCRYPTION_KEY ??= Buffer.alloc(32, 23).toString('base64');

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
      displayName: 'E2E CW Platform',
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
      code: `e2e_cw_${RUN}`,
      name: 'Wellworks',
      slug: `e2e-cw-${RUN}`,
      adminEmail: `cw-admin-${RUN}@test.local`,
      adminDisplayName: 'Admin',
      adminPassword: PW,
    }),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  tenant = created.body.tenant.id;
  admin = await login(`cw-admin-${RUN}@test.local`);

  const plan = await api('/api/v1/membership-plans', {
    method: 'POST',
    token: admin,
    tenant,
    body: JSON.stringify({ code: 'emp', name: 'Employee', entitlementKeys: [] }),
  });
  expect(plan.status).toBe(201);
  planId = plan.body.plan.id;

  const pool = await api('/api/v1/sponsorships', {
    method: 'POST',
    token: admin,
    tenant,
    body: JSON.stringify({
      code: `acme-${RUN}`,
      name: 'Acme Corp wellness',
      planId,
      seats: 3,
      sponsorName: 'Acme Corp',
    }),
  });
  expect(pool.status, JSON.stringify(pool.body)).toBe(201);
  poolId = pool.body.sponsorship.id;
}, 240_000);

afterAll(async () => {
  await app?.close();
  await owner?.$disconnect();
});

/* ── 1. seats ─────────────────────────────────────────────────────────────── */

describe('A seat is taken when the invitation is sent (docs/45 §2)', () => {
  it('reserves on invitation and assigns on acceptance', async () => {
    expect(await poolNow()).toMatchObject({
      seats: 3,
      seatsAssigned: 0,
      seatsReserved: 0,
      seatsFree: 3,
    });

    const invited = await api(`/api/v1/sponsorships/${poolId}/invitations`, {
      method: 'POST',
      token: admin,
      tenant,
      body: JSON.stringify({ email: `emp1-${RUN}@test.local` }),
    });
    expect(invited.status).toBe(201);

    const reserved = await poolNow();
    expect(
      reserved,
      'the seat was not taken until acceptance, which lets a sponsor with 100 ' +
        'seats invite 200 people and refuse the second hundred at the door',
    ).toMatchObject({ seatsAssigned: 0, seatsReserved: 1, seatsFree: 2 });

    const evt = await owner.domainEvent.findFirst({
      where: {
        eventName: 'MemberInvited',
        tenantId: tenant,
        aggregateId: invited.body.invitation.id,
      },
    });
    const accepted = await api(
      `/api/v1/invitations/${(evt!.payload as { token: string }).token}/accept`,
      { method: 'POST', body: JSON.stringify({ displayName: 'Employee One', password: PW }) },
    );
    expect(accepted.status).toBe(201);
    await app.get(OutboxRelayService).tick();

    expect(
      await poolNow(),
      'accepting did not turn the reservation into an assignment',
    ).toMatchObject({ seatsAssigned: 1, seatsReserved: 0, seatsFree: 2 });
  }, 120_000);

  it('refuses to invite past the seats that were paid for', async () => {
    await joinVia(poolId, `emp2-${RUN}@test.local`);
    await joinVia(poolId, `emp3-${RUN}@test.local`);
    expect(await poolNow()).toMatchObject({ seatsAssigned: 3, seatsFree: 0 });

    const over = await api(`/api/v1/sponsorships/${poolId}/invitations`, {
      method: 'POST',
      token: admin,
      tenant,
      body: JSON.stringify({ email: `emp4-${RUN}@test.local` }),
    });
    expect(over.status).toBe(400);
    expect(over.body.error.message).toMatch(/no seats left/i);
    // and the refusal says WHY, with the numbers
    expect(over.body.error.message).toMatch(/3 paid for/i);
  }, 180_000);

  it('will not shrink a pool below the seats already in use', async () => {
    const res = await api(`/api/v1/sponsorships/${poolId}`, {
      method: 'PATCH',
      token: admin,
      tenant,
      body: JSON.stringify({ seats: 1 }),
    });
    expect(
      res.status,
      'shrinking below what is in use would silently invalidate somebody’s membership',
    ).toBe(400);
    expect(res.body.error.message).toMatch(/release seats first/i);
  });

  it('frees a seat when one is released', async () => {
    const seat = await withTenant(owner, tenant, (tx) =>
      tx.sponsoredSeat.findFirst({ where: { poolId, releasedAt: null, memberId: { not: null } } }),
    );
    const res = await api(`/api/v1/sponsorships/seats/${seat!.id}`, {
      method: 'DELETE',
      token: admin,
      tenant,
    });
    expect(res.status).toBe(200);
    expect(await poolNow()).toMatchObject({ seatsAssigned: 2, seatsFree: 1 });
  });

  it('lets a member hold only one active seat, enforced by the database', async () => {
    const held = await withTenant(owner, tenant, (tx) =>
      tx.sponsoredSeat.findFirst({ where: { poolId, releasedAt: null, memberId: { not: null } } }),
    );
    await expect(
      withTenant(owner, tenant, (tx) =>
        tx.sponsoredSeat.create({
          data: { tenantId: tenant, poolId, memberId: held!.memberId, assignedAt: new Date() },
        }),
      ),
      'two sponsors paying for one person is a billing argument nobody can settle ' +
        'after the fact, so the index refuses it rather than a service remembering to',
    ).rejects.toThrow();
  });
});

/* ── 2. the boundary this whole feature exists around ─────────────────────── */

describe('A sponsor sees participation, never health (docs/45 §1)', () => {
  it('shows nothing about a sponsored member whose only activity is health', async () => {
    const seats = await withTenant(owner, tenant, (tx) =>
      tx.sponsoredSeat.findMany({ where: { poolId, releasedAt: null, memberId: { not: null } } }),
    );
    const quiet = seats[0]!.memberId!;

    // This member does nothing but log a habit — the exact case docs/28 §3
    // reasoned about: counting them as "active" would tell the sponsor they are
    // somebody who tracks their health, which is the thing health privacy is.
    await withTenant(owner, tenant, async (tx) => {
      const habit = await tx.habit.create({
        data: { tenantId: tenant, memberId: quiet, code: `sleep-${RUN}`, name: 'Sleep 8h' },
      });
      await tx.habitLog.create({
        data: {
          tenantId: tenant,
          habitId: habit.id,
          memberId: quiet,
          logDate: new Date(),
          value: 8,
        },
      });
    });

    const res = await api(`/api/v1/sponsorships/${poolId}/participation`, {
      token: admin,
      tenant,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const asText = JSON.stringify(res.body);
    expect(asText, 'the sponsor’s view named a habit').not.toContain(`sleep-${RUN}`);
    expect(asText, 'the sponsor’s view named a member').not.toContain(quiet);
    expect(
      res.body.active,
      'a member whose only activity was a habit log was counted as active, which ' +
        'tells the sponsor they are somebody who tracks their health',
    ).toBe(0);
    expect(Object.keys(res.body)).not.toContain('health');
    expect(Object.keys(res.body)).not.toContain('habits');
  }, 120_000);

  it('says what it excludes, so a sponsor does not have to discover the gap', async () => {
    const res = await api(`/api/v1/sponsorships/${poolId}/participation`, { token: admin, tenant });
    expect(res.body.note).toMatch(/health/i);
    expect(res.body.note).toMatch(/not that grant|not consent/i);
  });

  it('counts non-health participation, and states its window', async () => {
    const seats = await withTenant(owner, tenant, (tx) =>
      tx.sponsoredSeat.findMany({ where: { poolId, releasedAt: null, memberId: { not: null } } }),
    );
    const doer = seats[seats.length - 1]!.memberId!;
    await withTenant(owner, tenant, (tx) =>
      tx.goal.create({
        data: {
          tenantId: tenant,
          memberId: doer,
          title: 'Walk daily',
          status: 'completed',
          category: 'health',
        },
      }),
    );

    const res = await api(`/api/v1/sponsorships/${poolId}/participation?days=30`, {
      token: admin,
      tenant,
    });
    expect(res.body.goals.completed).toBeGreaterThan(0);
    expect(res.body.active).toBeGreaterThan(0);
    expect(res.body.window.days).toBe(30);
    expect(res.body.sponsoredMembers).toBe(seats.length);
  }, 120_000);

  it('gives no per-member breakdown at any size', async () => {
    const res = await api(`/api/v1/sponsorships/${poolId}/participation`, { token: admin, tenant });
    const asText = JSON.stringify(res.body);
    // A named list of people who did not use the benefit is a
    // performance-management tool wearing a wellness badge (docs/45 §4).
    expect(asText).not.toMatch(/members"\s*:\s*\[/);
    expect(res.body.memberIds).toBeUndefined();
  });
});

/* ── 3. permission ────────────────────────────────────────────────────────── */

describe('Running a sponsorship is a permission, not a membership', () => {
  it('refuses a sponsored member their own sponsor’s pages', async () => {
    const employee = await login(`emp1-${RUN}@test.local`);
    const res = await api('/api/v1/sponsorships', { token: employee, tenant });
    expect(res.status).toBe(403);
  });
});
