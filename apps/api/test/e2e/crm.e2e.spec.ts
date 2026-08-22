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

/**
 * The relay drains the outbox oldest-first in bounded batches, and a shared dev
 * database accumulates events from earlier runs — so one tick is not enough to
 * reach this run's events. Drain until this tenant has nothing pending.
 */
async function drainOutbox(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const pending = await owner.domainEvent.count({ where: { tenantId, processedAt: null } });
    if (pending === 0) return;
    await relay.tick();
  }
  throw new Error('outbox did not drain for this tenant');
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
  it('seeds the default pipeline from the summary endpoint too (empty-screen guard)', async () => {
    const seller = await login(`seller-${RUN}@test.local`);
    const res = await api('/api/v1/crm/pipeline', { token: seller, tenant: tenantId });
    expect(res.status).toBe(200);
    expect(res.body.stages.length).toBeGreaterThanOrEqual(5);
  });

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

/**
 * Sprint 37 — duplicate leads (docs/55).
 *
 * The check runs tenant-wide on purpose: the duplicate worth catching is
 * usually a colleague's, and a check scoped to your own book would miss
 * exactly that and still answer "no duplicate" with a straight face.
 */
describe('Sprint 37 — duplicate leads', () => {
  const dupEmail = `dup-${RUN}@test.local`;

  it('refuses a second open lead for the same contact, and says who has it', async () => {
    const seller = await login(`seller-${RUN}@test.local`);
    const first = await api('/api/v1/crm/leads', {
      method: 'POST',
      token: seller,
      tenant: tenantId,
      body: JSON.stringify({ name: 'Ada Original', email: dupEmail, phone: '081-234-5678' }),
    });
    expect(first.status).toBe(201);

    const again = await api('/api/v1/crm/leads', {
      method: 'POST',
      token: seller,
      tenant: tenantId,
      body: JSON.stringify({ name: 'Ada Again', email: dupEmail }),
    });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('CONFLICT');
    // Naming the owner is the point — "it is a duplicate" without "and Somchai
    // has it" leaves the caller with nothing to do about it.
    expect(again.body.error.details.ownerName).toBeTruthy();
  });

  it('matches the contact however it was typed', async () => {
    const seller = await login(`seller-${RUN}@test.local`);
    // Wrong case and stray spaces: the shape a real second entry actually
    // arrives in, and the one plain equality misses.
    const messy = await api('/api/v1/crm/leads', {
      method: 'POST',
      token: seller,
      tenant: tenantId,
      body: JSON.stringify({ name: 'Ada Messy', email: `  ${dupEmail.toUpperCase()} ` }),
    });
    expect(messy.status).toBe(409);

    // Same phone, written the other way round. This half needs the blind
    // index: the plaintext fallback compares phones exactly, so without a key
    // this passes a duplicate through and the failure reads as a bare status
    // mismatch. Say what is actually missing (docs/55 §2.1).
    expect(
      process.env.AVIORA_BLIND_INDEX_KEY,
      'AVIORA_BLIND_INDEX_KEY is unset, so the CRM is in its degraded mode and ' +
        'cannot match a phone written a different way',
    ).toBeTruthy();
    const byPhone = await api('/api/v1/crm/leads', {
      method: 'POST',
      token: seller,
      tenant: tenantId,
      body: JSON.stringify({ name: 'Ada By Phone', phone: '+66 81 234 5678' }),
    });
    expect(byPhone.status).toBe(409);
  });

  it('lets the caller override deliberately', async () => {
    const seller = await login(`seller-${RUN}@test.local`);
    const forced = await api('/api/v1/crm/leads', {
      method: 'POST',
      token: seller,
      tenant: tenantId,
      // Two people really do share a family phone or a shop address. The check
      // exists to stop the accidental double, not to overrule the person.
      body: JSON.stringify({ name: 'Ada Twin', email: dupEmail, allowDuplicate: true }),
    });
    expect(forced.status).toBe(201);
  });

  it('tells an outsider the contact is taken without handing over the lead', async () => {
    const outsider = await login(`outsider-${RUN}@test.local`);
    const found = await api(`/api/v1/crm/leads/duplicates?email=${encodeURIComponent(dupEmail)}`, {
      token: outsider,
      tenant: tenantId,
    });
    expect(found.status).toBe(200);
    expect(found.body.duplicates.length).toBeGreaterThan(0);
    for (const dup of found.body.duplicates) {
      // They may not read the seller's book, so they get the owner's name and
      // nothing they could use to open the record.
      expect(dup.visible).toBe(false);
      expect(dup.id).toBeNull();
      expect(dup.name).toBeNull();
      expect(dup.ownerName).toBeTruthy();
    }
  });

  it('gives the owner the lead itself', async () => {
    const seller = await login(`seller-${RUN}@test.local`);
    const found = await api(`/api/v1/crm/leads/duplicates?email=${encodeURIComponent(dupEmail)}`, {
      token: seller,
      tenant: tenantId,
    });
    expect(found.status).toBe(200);
    expect(found.body.duplicates.every((d: { visible: boolean }) => d.visible)).toBe(true);
    expect(found.body.duplicates[0].id).toBeTruthy();
  });

  it('does not treat a lead with no contact details as a duplicate of another', async () => {
    const seller = await login(`seller-${RUN}@test.local`);
    // Nothing to match on must match NOTHING. An unguarded OR over two null
    // keys matches every row with a blank email, which would block every
    // walk-in with only a name.
    for (const name of ['Walk-in One', 'Walk-in Two']) {
      const created = await api('/api/v1/crm/leads', {
        method: 'POST',
        token: seller,
        tenant: tenantId,
        body: JSON.stringify({ name }),
      });
      expect(created.status).toBe(201);
    }
  });

  it('lets a closed lead be re-entered', async () => {
    const seller = await login(`seller-${RUN}@test.local`);
    const email = `requote-${RUN}@test.local`;
    const first = await api('/api/v1/crm/leads', {
      method: 'POST',
      token: seller,
      tenant: tenantId,
      body: JSON.stringify({ name: 'Old Enquiry', email }),
    });
    await api(`/api/v1/crm/leads/${first.body.lead.id}`, {
      method: 'PATCH',
      token: seller,
      tenant: tenantId,
      body: JSON.stringify({ status: 'lost' }),
    });
    // A person who enquired last year and comes back is a new lead, not a
    // duplicate — only OPEN leads block.
    const returning = await api('/api/v1/crm/leads', {
      method: 'POST',
      token: seller,
      tenant: tenantId,
      body: JSON.stringify({ name: 'Returning Enquiry', email }),
    });
    expect(returning.status).toBe(201);
  });

  it('follows the contact when a lead is edited', async () => {
    const seller = await login(`seller-${RUN}@test.local`);
    const moved = `moved-${RUN}@test.local`;
    const created = await api('/api/v1/crm/leads', {
      method: 'POST',
      token: seller,
      tenant: tenantId,
      body: JSON.stringify({ name: 'Typo Email', email: `typo-${RUN}@test.local` }),
    });
    await api(`/api/v1/crm/leads/${created.body.lead.id}`, {
      method: 'PATCH',
      token: seller,
      tenant: tenantId,
      body: JSON.stringify({ email: moved }),
    });

    // The index has to move with the correction, or the check keeps guarding
    // an address nobody has and stops guarding the one they do.
    const atNew = await api('/api/v1/crm/leads', {
      method: 'POST',
      token: seller,
      tenant: tenantId,
      body: JSON.stringify({ name: 'Same Person', email: moved }),
    });
    expect(atNew.status).toBe(409);

    const atOld = await api('/api/v1/crm/leads', {
      method: 'POST',
      token: seller,
      tenant: tenantId,
      body: JSON.stringify({ name: 'Nobody', email: `typo-${RUN}@test.local` }),
    });
    expect(atOld.status).toBe(201);
  });
});

/**
 * Sprint 38 — the prospecting workbook (docs/56).
 *
 * The paper sheet is the requirement, so these assert what the sheet does:
 * twenty rows to fill, two lists with different columns, and a Memory Jogger
 * whose whole job is producing names you would not have thought of.
 */
describe('Sprint 38 — name lists and the memory jogger', () => {
  let scoredId = '';

  it('starts empty, and says how far off twenty it is', async () => {
    const seller = await login(`seller-${RUN}@test.local`);
    const res = await api('/api/v1/crm/name-list/sponsor', { token: seller, tenant: tenantId });
    expect(res.status).toBe(200);
    expect(res.body.target).toBe(20);
    // "Filling the sheet" is the exercise, so the gap has to be a number the
    // screen can show — not something the salesperson counts by eye.
    expect(res.body.remaining).toBe(20 - res.body.filled);
    expect(res.body.criteria.map((c: { key: string }) => c.key)).toEqual([
      'active',
      'friendly',
      'money',
      'relation',
      'age',
    ]);
  });

  it('gives the customer list its own columns', async () => {
    const seller = await login(`seller-${RUN}@test.local`);
    const res = await api('/api/v1/crm/name-list/customer', { token: seller, tenant: tenantId });
    expect(res.body.criteria.map((c: { key: string }) => c.key)).toEqual([
      'money',
      'authority',
      'relation',
    ]);
    // Three criteria, not five — a customer total and a sponsor total are not
    // the same number and must not be compared.
    expect(res.body.scoreMax).toBe(15);
  });

  it('refuses a list that is not on the sheet', async () => {
    const seller = await login(`seller-${RUN}@test.local`);
    // Otherwise this reaches the query as "on neither list" and answers 200
    // with an empty sheet, which reads as "you have no names".
    const res = await api('/api/v1/crm/name-list/friends', { token: seller, tenant: tenantId });
    expect(res.status).toBe(400);
  });

  it('adds a name from a memory jogger prompt and keeps which prompt it was', async () => {
    const seller = await login(`seller-${RUN}@test.local`);
    const created = await api('/api/v1/crm/leads', {
      method: 'POST',
      token: seller,
      tenant: tenantId,
      body: JSON.stringify({
        name: `ช่างทำผม ${RUN}`,
        onSponsorList: true,
        onCustomerList: true,
        joggerPrompt: 'beauty_therapist',
      }),
    });
    expect(created.status).toBe(201);
    scoredId = created.body.lead.id;

    const jogger = await api('/api/v1/crm/memory-jogger', { token: seller, tenant: tenantId });
    const shops = jogger.body.categories.find((c: { key: string }) => c.key === 'regular_shops');
    const prompt = shops.prompts.find((p: { key: string }) => p.key === 'beauty_therapist');
    // A count, not a tick: six names from one prompt reads differently from
    // one, and the paper cannot say so.
    expect(prompt.named).toBe(1);
  });

  it('refuses a prompt that is not in the catalogue', async () => {
    const seller = await login(`seller-${RUN}@test.local`);
    const res = await api('/api/v1/crm/leads', {
      method: 'POST',
      token: seller,
      tenant: tenantId,
      body: JSON.stringify({ name: `Bad ${RUN}`, joggerPrompt: 'from_a_dream' }),
    });
    // Stored loose, it would appear in the report as a category nobody can
    // find on the sheet.
    expect(res.status).toBe(400);
  });

  it('scores a name and ranks the list by it', async () => {
    const seller = await login(`seller-${RUN}@test.local`);
    const scored = await api(`/api/v1/crm/leads/${scoredId}/scores`, {
      method: 'PATCH',
      token: seller,
      tenant: tenantId,
      body: JSON.stringify({ scores: { active: 5, friendly: 5, money: 4, relation: 5, age: 3 } }),
    });
    expect(scored.status).toBe(200);
    expect(scored.body.lead.sponsorScore).toBe(22);
    // money + relation only: the customer total counts ITS OWN columns, or a
    // name rated on five criteria would always outrank one rated on three.
    expect(scored.body.lead.customerScore).toBe(9);

    const list = await api('/api/v1/crm/name-list/sponsor', { token: seller, tenant: tenantId });
    expect(list.body.entries[0].id).toBe(scoredId);
    expect(list.body.entries[0].score).toBe(22);
    expect(list.body.entries[0].rated).toBe(true);
  });

  it('shares a rating that both lists ask for', async () => {
    const seller = await login(`seller-${RUN}@test.local`);
    // `money` is a column on both sheets. Rating it as a customer has to move
    // the sponsor total too, or one of the two goes quietly stale.
    const before = await api(`/api/v1/crm/name-list/sponsor`, { token: seller, tenant: tenantId });
    const was = before.body.entries.find((e: { id: string }) => e.id === scoredId).score;
    await api(`/api/v1/crm/leads/${scoredId}/scores`, {
      method: 'PATCH',
      token: seller,
      tenant: tenantId,
      body: JSON.stringify({ scores: { money: 1 } }),
    });
    const after = await api(`/api/v1/crm/name-list/sponsor`, { token: seller, tenant: tenantId });
    expect(after.body.entries.find((e: { id: string }) => e.id === scoredId).score).toBe(was - 3);
  });

  it('refuses a rating that is not on the scale', async () => {
    const seller = await login(`seller-${RUN}@test.local`);
    // A 9 in a 1..5 column would sort a name to the top of a list it never
    // earned.
    const res = await api(`/api/v1/crm/leads/${scoredId}/scores`, {
      method: 'PATCH',
      token: seller,
      tenant: tenantId,
      body: JSON.stringify({ scores: { active: 9 } }),
    });
    expect(res.status).toBe(400);
  });

  it('reports the gap, who to call, and where names come from', async () => {
    const seller = await login(`seller-${RUN}@test.local`);
    const res = await api('/api/v1/crm/prospecting/report', { token: seller, tenant: tenantId });
    expect(res.status).toBe(200);

    const sponsor = res.body.lists.find((l: { list: string }) => l.list === 'sponsor');
    expect(sponsor.target).toBe(20);
    expect(sponsor.top[0].name).toContain('ช่างทำผม');

    // Every prompt, including the ones that produced nothing. A report listing
    // only what worked cannot tell you what you have not tried.
    expect(res.body.prompts.length).toBeGreaterThan(40);
    expect(res.body.prompts.some((p: { named: number }) => p.named === 0)).toBe(true);
    expect(res.body.prompts.find((p: { key: string }) => p.key === 'beauty_therapist').named).toBe(
      1,
    );
  });

  it("does not show another member's book", async () => {
    const outsider = await login(`outsider-${RUN}@test.local`);
    const res = await api('/api/v1/crm/name-list/sponsor', { token: outsider, tenant: tenantId });
    expect(res.status).toBe(200);
    // A name list is one person's own book. Somebody else's twenty names
    // appearing on it would be both wrong and useless.
    expect(res.body.entries).toHaveLength(0);
  });
});

/**
 * Sprint 40 — the tracking sheets (docs/59).
 *
 * Three of the paper sheets are one primitive, so what these assert is the
 * primitive: the columns are data, a tick carries a date, and the sheet can
 * answer the question paper cannot — who stopped moving.
 */
describe('Sprint 40 — tracking sheets', () => {
  let entryId = '';
  let firstStepId = '';
  let leadId = '';

  it('gives a brand-new tenant working sheets without anybody configuring one', async () => {
    const seller = await login(`seller-${RUN}@test.local`);
    const res = await api('/api/v1/tracker/sheets', { token: seller, tenant: tenantId });
    expect(res.status).toBe(200);
    const codes = res.body.templates.map((t: { code: string }) => t.code);
    expect(codes).toEqual(expect.arrayContaining(['follow_up', 'diamond', 'follow_up_6wny']));
  });

  it('keeps the stages the paper draws bands over', async () => {
    const seller = await login(`seller-${RUN}@test.local`);
    const res = await api('/api/v1/tracker/sheets/follow_up_6wny', {
      token: seller,
      tenant: tenantId,
    });
    expect(res.status).toBe(200);
    // Five stages, in column order — a grid that sorted them alphabetically
    // would put "day 14" before "day 4".
    expect(res.body.stages).toEqual([
      'ก่อนเริ่มคอร์ส',
      '4 วัน',
      '7 วัน',
      '14 วัน',
      'สัปดาห์ที่ 3 เป็นต้นไป',
    ]);
  });

  it('puts a person on a sheet and ticks a box', async () => {
    const seller = await login(`seller-${RUN}@test.local`);
    const lead = await api('/api/v1/crm/leads', {
      method: 'POST',
      token: seller,
      tenant: tenantId,
      body: JSON.stringify({ name: `ติดตาม ${RUN}` }),
    });
    leadId = lead.body.lead.id;

    const added = await api('/api/v1/tracker/sheets/follow_up/entries', {
      method: 'POST',
      token: seller,
      tenant: tenantId,
      body: JSON.stringify({ subjectId: leadId }),
    });
    expect(added.status).toBe(201);
    entryId = added.body.entry.id;

    const sheet = await api('/api/v1/tracker/sheets/follow_up', {
      token: seller,
      tenant: tenantId,
    });
    firstStepId = sheet.body.steps[0].id;
    const row = sheet.body.entries.find((e: { id: string }) => e.id === entryId);
    // The row knows whose it is without a second lookup, or the grid renders a
    // column of uuids.
    expect(row.subjectName).toBe(`ติดตาม ${RUN}`);
    expect(row.doneCount).toBe(0);
    expect(row.stepCount).toBeGreaterThan(40);

    const marked = await api(`/api/v1/tracker/entries/${entryId}/marks`, {
      method: 'PUT',
      token: seller,
      tenant: tenantId,
      body: JSON.stringify({ stepId: firstStepId, done: true }),
    });
    expect(marked.status).toBe(200);
    expect(marked.body.entry.lastMarkedAt).toBeTruthy();
  });

  it('treats ticking twice as the same tick, and keeps the first date', async () => {
    const seller = await login(`seller-${RUN}@test.local`);
    const first = await api('/api/v1/tracker/sheets/follow_up', {
      token: seller,
      tenant: tenantId,
    });
    const before = first.body.entries.find((e: { id: string }) => e.id === entryId);

    await api(`/api/v1/tracker/entries/${entryId}/marks`, {
      method: 'PUT',
      token: seller,
      tenant: tenantId,
      body: JSON.stringify({ stepId: firstStepId, done: true }),
    });

    const after = await api('/api/v1/tracker/sheets/follow_up', {
      token: seller,
      tenant: tenantId,
    });
    const row = after.body.entries.find((e: { id: string }) => e.id === entryId);
    // WHEN it happened is the fact being recorded; a second tick must not
    // reset it and make a stalled row look fresh.
    expect(row.doneCount).toBe(before.doneCount);
    expect(row.lastMarkedAt).toBe(before.lastMarkedAt);
  });

  it('takes a tick back', async () => {
    const seller = await login(`seller-${RUN}@test.local`);
    await api(`/api/v1/tracker/entries/${entryId}/marks`, {
      method: 'PUT',
      token: seller,
      tenant: tenantId,
      body: JSON.stringify({ stepId: firstStepId, done: false }),
    });
    const sheet = await api('/api/v1/tracker/sheets/follow_up', {
      token: seller,
      tenant: tenantId,
    });
    const row = sheet.body.entries.find((e: { id: string }) => e.id === entryId);
    expect(row.doneCount).toBe(0);
    expect(row.lastMarkedAt).toBeNull();
  });

  it('refuses the same person twice on one sheet', async () => {
    const seller = await login(`seller-${RUN}@test.local`);
    const again = await api('/api/v1/tracker/sheets/follow_up/entries', {
      method: 'POST',
      token: seller,
      tenant: tenantId,
      body: JSON.stringify({ subjectId: leadId }),
    });
    // Two rows would let one person be half-ticked in two places and neither
    // would be the truth.
    expect(again.status).toBe(409);
  });

  it('refuses a column from a different sheet', async () => {
    const seller = await login(`seller-${RUN}@test.local`);
    const diamond = await api('/api/v1/tracker/sheets/diamond', {
      token: seller,
      tenant: tenantId,
    });
    const foreignStep = diamond.body.steps[0].id;
    const res = await api(`/api/v1/tracker/entries/${entryId}/marks`, {
      method: 'PUT',
      token: seller,
      tenant: tenantId,
      body: JSON.stringify({ stepId: foreignStep, done: true }),
    });
    // Otherwise a Diamond milestone lands on a Follow Up row and the counts on
    // both sheets stop meaning anything.
    expect(res.status).toBe(404);
  });

  it('names who has stopped moving, including who never started', async () => {
    const seller = await login(`seller-${RUN}@test.local`);
    // Zero days = everything not finished counts as stalled, which is the only
    // way to assert this without waiting a fortnight.
    const res = await api('/api/v1/tracker/stalled?days=0', { token: seller, tenant: tenantId });
    expect(res.status).toBe(200);
    const mine = res.body.stalled.find((s: { entryId: string }) => s.entryId === entryId);
    expect(mine).toBeTruthy();
    // Started and never touched is the worst kind of stalled, and a plain
    // "lastMarkedAt < cutoff" filter would miss it — the column is still null.
    expect(mine.neverStarted).toBe(true);
    expect(mine.subjectName).toBe(`ติดตาม ${RUN}`);
  });

  it("does not put another member's rows on your sheet", async () => {
    const outsider = await login(`outsider-${RUN}@test.local`);
    const res = await api('/api/v1/tracker/sheets/follow_up', {
      token: outsider,
      tenant: tenantId,
    });
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(0);
  });
});

describe('Sprint 3 — notification center', () => {
  it('delivers in-app notifications from relayed domain events', async () => {
    await drainOutbox(); // push this tenant's events through the handlers

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
    await drainOutbox();

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
