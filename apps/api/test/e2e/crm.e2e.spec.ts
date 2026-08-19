/**
 * Sprint 3 E2E — CRM, notification center, audit viewer.
 * Proves: configurable pipeline, lead lifecycle → customer conversion,
 * follow-ups and interactions, CRM ownership scoping (a member sees only their
 * own book; a leader sees their org's; another member sees neither),
 * event-driven in-app notifications, and the audit viewer's filters.
 *
 * NOTE: the outbox relay is cross-tenant by design (FOR UPDATE SKIP LOCKED),
 * so a locally running API instance polling the same database will drain these
 * events before the test's own relay.tick() sees them. Stop any dev API server
 * before running the suite against the local database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import * as argon2 from 'argon2';
import { createOwnerClient, ensureAppRole, type PrismaClient } from '@aviora/db';
import { ENTITLEMENTS, PERMISSIONS } from '@aviora/shared';
import { createApp } from '../../src/app.factory';
import { EventBus } from '../../src/common/events/event-bus';
import { OutboxRelayService } from '../../src/common/events/outbox-relay.service';

const RUN = `c${Date.now().toString(36)}`;
const PLATFORM_EMAIL = `e2e-platform-${RUN}@test.local`;
const PW = 'e2e-password-123456';

let app: INestApplication;
let base: string;
let owner: PrismaClient;
let relay: OutboxRelayService;

let tenantId: string;
let planId: string;
let teamId: string;
const member: Record<'seller' | 'leader' | 'outsider', string> = {} as never;
let leadId: string;
let stageContactedId: string;

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
    where: { eventName: 'MemberInvited', tenantId, aggregateId: inv.body.invitation.id },
  });
  const token = (evt!.payload as { token: string }).token;
  const acc = await api(`/api/v1/invitations/${token}/accept`, {
    method: 'POST',
    body: JSON.stringify({ displayName: name, password: PW }),
  });
  expect(acc.status).toBe(201);
  return acc.body.memberId;
}

beforeAll(async () => {
  process.env.AVIORA_OUTBOX_DISABLED = 'true'; // relay driven manually in tests
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
  // Email delivery is not under test here (no SMTP in CI). Handlers are
  // independent, so dropping the email ones must not affect the notification
  // ones — which is exactly what the assertions below rely on.
  const bus = app.get(EventBus);
  const registry = (bus as unknown as { handlers: Map<string, { name: string }[]> }).handlers;
  registry.forEach((list, key) => {
    const kept = list.filter((r) => !r.name.startsWith('email.'));
    registry.set(key, kept);
  });

  const platform = await login(PLATFORM_EMAIL);
  const created = await api('/api/v1/platform/tenants', {
    method: 'POST',
    token: platform,
    body: JSON.stringify({
      code: `e2e_crm_${RUN}`,
      name: 'CRM Co',
      slug: `e2e-crm-${RUN}`,
      adminEmail: `admin-${RUN}@test.local`,
      adminDisplayName: 'CRM Admin',
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

  member.seller = await addMember(admin, `seller-${RUN}@test.local`, 'Seller');
  member.leader = await addMember(admin, `leader-${RUN}@test.local`, 'Leader');
  member.outsider = await addMember(admin, `outsider-${RUN}@test.local`, 'Outsider');

  // team with the seller inside and the leader leading it
  teamId = (
    await api('/api/v1/teams', {
      method: 'POST',
      token: admin,
      tenant: tenantId,
      body: JSON.stringify({ code: 'sales', name: 'Sales' }),
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
    body: JSON.stringify({ memberId: member.seller }),
  });
}, 180_000);

afterAll(async () => {
  await app?.close();
  await owner?.$disconnect();
});

describe('Sprint 3 — CRM pipeline', () => {
  it('seeds a default pipeline on first read and allows custom stages', async () => {
    const seller = await login(`seller-${RUN}@test.local`);
    const res = await api('/api/v1/crm/stages', { token: seller, tenant: tenantId });
    expect(res.status).toBe(200);
    expect(res.body.stages.length).toBeGreaterThanOrEqual(5);
    expect(res.body.stages[0].order).toBe(1);
    stageContactedId = res.body.stages.find((s: { code: string }) => s.code === 'contacted').id;

    // members cannot reshape the pipeline; admins can
    const denied = await api('/api/v1/crm/stages', {
      method: 'POST',
      token: seller,
      tenant: tenantId,
      body: JSON.stringify({ code: 'nurture', name: 'Nurture', order: 8 }),
    });
    expect(denied.status).toBe(403);

    const admin = await login(`admin-${RUN}@test.local`);
    const allowed = await api('/api/v1/crm/stages', {
      method: 'POST',
      token: admin,
      tenant: tenantId,
      body: JSON.stringify({ code: 'nurture', name: 'Nurture', order: 8 }),
    });
    expect(allowed.status).toBe(201);
  });

  it('seller creates a lead placed in the first stage', async () => {
    const seller = await login(`seller-${RUN}@test.local`);
    const res = await api('/api/v1/crm/leads', {
      method: 'POST',
      token: seller,
      tenant: tenantId,
      body: JSON.stringify({ name: 'Khun Nid', email: 'nid@example.com', source: 'referral' }),
    });
    expect(res.status).toBe(201);
    leadId = res.body.lead.id;
    expect(res.body.lead.ownerMemberId).toBe(member.seller);
    expect(res.body.lead.stageId).toBeTruthy();

    const evt = await owner.domainEvent.count({ where: { eventName: 'LeadCreated', tenantId } });
    expect(evt).toBe(1);
  });

  it('moving a stage emits LeadStageChanged and audits before/after', async () => {
    const seller = await login(`seller-${RUN}@test.local`);
    const res = await api(`/api/v1/crm/leads/${leadId}`, {
      method: 'PATCH',
      token: seller,
      tenant: tenantId,
      body: JSON.stringify({ stageId: stageContactedId }),
    });
    expect(res.status).toBe(200);
    expect(res.body.lead.stageId).toBe(stageContactedId);

    const evt = await owner.domainEvent.count({
      where: { eventName: 'LeadStageChanged', tenantId },
    });
    expect(evt).toBe(1);
    const audit = await owner.auditLog.findFirst({
      where: { tenantId, action: 'crm.lead.update' },
      orderBy: { createdAt: 'desc' },
    });
    expect((audit!.after as { stageId: string }).stageId).toBe(stageContactedId);
  });

  it('records follow-ups and interactions on the lead', async () => {
    const seller = await login(`seller-${RUN}@test.local`);
    const fu = await api('/api/v1/crm/follow-ups', {
      method: 'POST',
      token: seller,
      tenant: tenantId,
      body: JSON.stringify({
        title: 'Call back about sleep programme',
        dueAt: new Date(Date.now() + 86_400_000).toISOString(),
        leadId,
      }),
    });
    expect(fu.status).toBe(201);

    const interaction = await api('/api/v1/crm/interactions', {
      method: 'POST',
      token: seller,
      tenant: tenantId,
      body: JSON.stringify({ summary: 'Explained the programme', channel: 'call', leadId }),
    });
    expect(interaction.status).toBe(201);

    const detail = await api(`/api/v1/crm/leads/${leadId}`, { token: seller, tenant: tenantId });
    expect(detail.body.lead.followUps).toHaveLength(1);
    expect(detail.body.lead.interactions).toHaveLength(1);
    expect(detail.body.lead.lastContactAt).toBeTruthy();

    const list = await api('/api/v1/crm/follow-ups', { token: seller, tenant: tenantId });
    expect(list.body.followUps).toHaveLength(1);
    const done = await api(`/api/v1/crm/follow-ups/${list.body.followUps[0].id}/complete`, {
      method: 'PATCH',
      token: seller,
      tenant: tenantId,
    });
    expect(done.status).toBe(200);
    expect(done.body.followUp.status).toBe('completed');
    const openLeft = await api('/api/v1/crm/follow-ups', { token: seller, tenant: tenantId });
    expect(openLeft.body.followUps).toHaveLength(0);
  });

  it('converts the lead into a customer (idempotent)', async () => {
    const seller = await login(`seller-${RUN}@test.local`);
    const res = await api(`/api/v1/crm/leads/${leadId}/convert`, {
      method: 'POST',
      token: seller,
      tenant: tenantId,
    });
    expect(res.status).toBe(201);
    const customerId = res.body.customer.id;

    const again = await api(`/api/v1/crm/leads/${leadId}/convert`, {
      method: 'POST',
      token: seller,
      tenant: tenantId,
    });
    expect(again.status).toBe(201);
    expect(again.body.customer.id).toBe(customerId); // no duplicate customer

    const events = await owner.domainEvent.count({
      where: { eventName: 'CustomerConverted', tenantId },
    });
    expect(events).toBe(1);

    const lead = await api(`/api/v1/crm/leads/${leadId}`, { token: seller, tenant: tenantId });
    expect(lead.body.lead.status).toBe('converted');
    expect(lead.body.lead.stage.code).toBe('won');
  });

  it('pipeline summary reflects the caller book', async () => {
    const seller = await login(`seller-${RUN}@test.local`);
    const res = await api('/api/v1/crm/pipeline', { token: seller, tenant: tenantId });
    expect(res.status).toBe(200);
    expect(res.body.customers).toBe(1);
    expect(res.body.stages.every((s: { openLeads: number }) => s.openLeads === 0)).toBe(true);
  });
});

describe('Sprint 3 — CRM ownership scoping', () => {
  it('another member cannot see or touch the seller book', async () => {
    const outsider = await login(`outsider-${RUN}@test.local`);
    const list = await api('/api/v1/crm/leads', { token: outsider, tenant: tenantId });
    expect(list.status).toBe(200);
    expect(list.body.leads).toHaveLength(0);

    const read = await api(`/api/v1/crm/leads/${leadId}`, { token: outsider, tenant: tenantId });
    expect(read.status).toBe(403);

    const write = await api(`/api/v1/crm/leads/${leadId}`, {
      method: 'PATCH',
      token: outsider,
      tenant: tenantId,
      body: JSON.stringify({ notes: 'stolen' }),
    });
    expect(write.status).toBe(403);
  });

  it("a leader sees their org's leads but cannot edit them", async () => {
    const leader = await login(`leader-${RUN}@test.local`);
    const list = await api('/api/v1/crm/leads', { token: leader, tenant: tenantId });
    expect(list.status).toBe(200);
    expect(list.body.leads.map((l: { id: string }) => l.id)).toContain(leadId);

    const write = await api(`/api/v1/crm/leads/${leadId}`, {
      method: 'PATCH',
      token: leader,
      tenant: tenantId,
      body: JSON.stringify({ notes: 'leader edit' }),
    });
    expect(write.status).toBe(403); // view-only on the org's book
  });
});

describe('Sprint 3 — notification center', () => {
  it('delivers in-app notifications from relayed domain events', async () => {
    await relay.tick(); // drain the outbox through the in-process handlers

    const seller = await login(`seller-${RUN}@test.local`);
    const res = await api('/api/v1/notifications', { token: seller, tenant: tenantId });
    expect(res.status).toBe(200);
    const types = res.body.notifications.map((n: { type: string }) => n.type);
    expect(types).toContain('membership.activated');
    expect(types).toContain('team.joined');
    expect(types).toContain('crm.customer.converted');
    expect(res.body.unreadCount).toBeGreaterThan(0);
  });

  it('marks one and then all notifications read', async () => {
    const seller = await login(`seller-${RUN}@test.local`);
    const before = await api('/api/v1/notifications', { token: seller, tenant: tenantId });
    const first = before.body.notifications[0];
    const read = await api(`/api/v1/notifications/${first.id}/read`, {
      method: 'PATCH',
      token: seller,
      tenant: tenantId,
    });
    expect(read.status).toBe(200);
    expect(read.body.notification.readAt).toBeTruthy();

    const all = await api('/api/v1/notifications/read-all', {
      method: 'POST',
      token: seller,
      tenant: tenantId,
    });
    expect(all.status).toBe(201);
    const after = await api('/api/v1/notifications', { token: seller, tenant: tenantId });
    expect(after.body.unreadCount).toBe(0);
  });

  it('respects an opted-out preference for later deliveries', async () => {
    const leader = await login(`leader-${RUN}@test.local`);
    const pref = await api('/api/v1/notifications/preferences', {
      method: 'POST',
      token: leader,
      tenant: tenantId,
      body: JSON.stringify({ type: 'team.leader.assigned', inApp: false, email: false }),
    });
    expect(pref.status).toBe(201);

    // a second leadership assignment must NOT produce an in-app notification
    const admin = await login(`admin-${RUN}@test.local`);
    const t2 = await api('/api/v1/teams', {
      method: 'POST',
      token: admin,
      tenant: tenantId,
      body: JSON.stringify({ code: 'sales-2', name: 'Sales Two' }),
    });
    await api(`/api/v1/teams/${t2.body.team.id}/leaders`, {
      method: 'POST',
      token: admin,
      tenant: tenantId,
      body: JSON.stringify({ memberId: member.leader }),
    });
    await relay.tick();

    const list = await api('/api/v1/notifications', { token: leader, tenant: tenantId });
    const assigned = list.body.notifications.filter(
      (n: { type: string }) => n.type === 'team.leader.assigned',
    );
    expect(assigned).toHaveLength(1); // only the first (pre-opt-out) one
  });

  it("a member never sees another member's notifications", async () => {
    const outsider = await login(`outsider-${RUN}@test.local`);
    const res = await api('/api/v1/notifications', { token: outsider, tenant: tenantId });
    const types = res.body.notifications.map((n: { type: string }) => n.type);
    expect(types).not.toContain('crm.customer.converted');
  });
});

describe('Sprint 3 — audit viewer', () => {
  it('lists tenant audit entries newest first with cursor paging', async () => {
    const admin = await login(`admin-${RUN}@test.local`);
    const page1 = await api('/api/v1/audit-logs?limit=3', { token: admin, tenant: tenantId });
    expect(page1.status).toBe(200);
    expect(page1.body.auditLogs).toHaveLength(3);
    expect(page1.body.nextCursor).toBeTruthy();

    const page2 = await api(`/api/v1/audit-logs?limit=3&cursor=${page1.body.nextCursor}`, {
      token: admin,
      tenant: tenantId,
    });
    const ids1 = page1.body.auditLogs.map((r: { id: string }) => r.id);
    const ids2 = page2.body.auditLogs.map((r: { id: string }) => r.id);
    expect(ids1.some((id: string) => ids2.includes(id))).toBe(false);
  });

  it('filters by action and exposes the action catalog', async () => {
    const admin = await login(`admin-${RUN}@test.local`);
    const filtered = await api('/api/v1/audit-logs?action=crm.lead.convert', {
      token: admin,
      tenant: tenantId,
    });
    expect(filtered.body.auditLogs).toHaveLength(1);
    expect(filtered.body.auditLogs[0].entityType).toBe('customer');

    const actions = await api('/api/v1/audit-logs/actions', { token: admin, tenant: tenantId });
    const names = actions.body.actions.map((a: { action: string }) => a.action);
    expect(names).toEqual(expect.arrayContaining(['crm.lead.create', 'team.create']));
  });

  it('a plain member cannot read the audit log', async () => {
    const seller = await login(`seller-${RUN}@test.local`);
    const res = await api('/api/v1/audit-logs', { token: seller, tenant: tenantId });
    expect(res.status).toBe(403);
  });
});
