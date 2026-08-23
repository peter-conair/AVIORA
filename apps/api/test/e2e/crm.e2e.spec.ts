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
  // The index card encrypts identity numbers and the service fails closed, so
  // without a key the save throws. CI deliberately carries no PII key, and
  // every suite that needs one sets its own — this one did not until the card
  // arrived, and the omission surfaced as three unrelated-looking assertions.
  process.env.AVIORA_PII_ENCRYPTION_KEY ??= Buffer.alloc(32, 41).toString('base64');
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

/**
 * Sprint 44 — starting the business (docs/63).
 *
 * Spec §25 asks for an onboarding journey and docs/33 recorded it as covered by
 * the learning module, which it was not: a new member met a dashboard of empty
 * cards with nothing saying which to touch first.
 *
 * What is worth testing is that the path READS most of itself. A checklist that
 * asks somebody to tick a box the system could have looked up stops being
 * believed on about the third day.
 */
describe('Sprint 44 — the start path', () => {
  it('gives a new member one thing to do, not eight empty cards', async () => {
    const outsider = await login(`outsider-${RUN}@test.local`);
    const res = await api('/api/v1/start', { token: outsider, tenant: tenantId });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(8);
    expect(res.body.complete).toBe(false);
    // The whole point: what to do NEXT.
    expect(res.body.next.key).toBe('dream');
  });

  it('reads the steps it can see instead of asking', async () => {
    const seller = await login(`seller-${RUN}@test.local`);
    const before = await api('/api/v1/start', { token: seller, tenant: tenantId });
    expect(before.body.steps.find((s: { key: string }) => s.key === 'goal').done).toBe(false);

    await api('/api/v1/goals/business', {
      method: 'PUT',
      token: seller,
      tenant: tenantId,
      body: JSON.stringify({ lifeGoal: 'เกษียณใน 5 ปี', volumeTargetMinor: 3_000_000 }),
    });

    const after = await api('/api/v1/start', { token: seller, tenant: tenantId });
    // Nobody ticked anything. The goal row exists, so the step is done.
    expect(after.body.steps.find((s: { key: string }) => s.key === 'goal').done).toBe(true);
    expect(after.body.steps.find((s: { key: string }) => s.key === 'dream').done).toBe(true);
  });

  it('says which steps it measured and which it is asking about', async () => {
    const seller = await login(`seller-${RUN}@test.local`);
    const res = await api('/api/v1/start', { token: seller, tenant: tenantId });
    const byKey = Object.fromEntries(
      res.body.steps.map((s: { key: string; source: string }) => [s.key, s.source]),
    );
    expect(byKey.goal).toBe('computed');
    expect(byKey.customer).toBe('computed');
    // The paper says "Meet Coach for Script" and no table records a
    // conversation, so this one is asked rather than guessed.
    expect(byKey.meet_coach).toBe('manual');
  });

  it('lets a member tick the step nothing can observe', async () => {
    const seller = await login(`seller-${RUN}@test.local`);
    const res = await api('/api/v1/start/meet_coach', {
      method: 'PUT',
      token: seller,
      tenant: tenantId,
      body: JSON.stringify({ done: true }),
    });
    expect(res.status).toBe(200);

    const after = await api('/api/v1/start', { token: seller, tenant: tenantId });
    expect(after.body.steps.find((s: { key: string }) => s.key === 'meet_coach').done).toBe(true);
  });

  it('refuses to let anybody tick a step the records decide', async () => {
    const seller = await login(`seller-${RUN}@test.local`);
    // Otherwise a member could claim a first customer they do not have, and
    // the path would say something the data flatly contradicts.
    const res = await api('/api/v1/start/customer', {
      method: 'PUT',
      token: seller,
      tenant: tenantId,
      body: JSON.stringify({ done: true }),
    });
    expect(res.status).toBe(403);
  });

  it('does not stop the real sheets from ever seeding', async () => {
    // The order matters and is the whole bug: the start path creates a tracker
    // template, and the tracker's "only seed an empty tenant" guard counted it.
    // A member who opened the dashboard before the workbook got NO follow-up
    // sheets, permanently.
    const platform = await login(PLATFORM_EMAIL);
    const email = `startfirst-${RUN}@test.local`;
    const made = await api('/api/v1/platform/tenants', {
      method: 'POST',
      token: platform,
      body: JSON.stringify({
        code: `e2e_sf_${RUN}`,
        name: 'Start First',
        slug: `e2e-sf-${RUN}`,
        adminEmail: email,
        adminDisplayName: 'Admin',
        adminPassword: PW,
      }),
    });
    expect(made.status).toBe(201);
    const freshTenant = made.body.tenant.id;
    const token = await login(email);

    // Dashboard first, workbook second.
    await api('/api/v1/start', { token, tenant: freshTenant });
    const sheets = await api('/api/v1/tracker/sheets', { token, tenant: freshTenant });
    const codes = sheets.body.templates.map((t: { code: string }) => t.code);
    expect(codes).toEqual(expect.arrayContaining(['follow_up', 'diamond', 'follow_up_6wny']));
  });

  it('does not put the start path among the sheets people fill in for others', async () => {
    const seller = await login(`seller-${RUN}@test.local`);
    const sheets = await api('/api/v1/tracker/sheets', { token: seller, tenant: tenantId });
    const codes = sheets.body.templates.map((t: { code: string }) => t.code);
    // It borrows the tracker engine to store two ticks; it is not a sheet a
    // coach works through for somebody else.
    expect(codes).not.toContain('start');
  });
});

/**
 * Sprint 45 — 6WNY as a measured programme (docs/64).
 *
 * The 6WNY sheet says "ชั่งน้ำหนัก (kg.)" at every stage. Recorded as a tick it
 * says the scales were used and throws away what they said — which is the only
 * thing the customer came for.
 */
describe('Sprint 45 — columns that ask for a number', () => {
  let entryId = '';
  let steps: { id: string; key: string; captureUnit: string | null }[] = [];

  it('marks the weigh-in columns as measurements, and the rest as ticks', async () => {
    const seller = await login(`seller-${RUN}@test.local`);
    const sheet = await api('/api/v1/tracker/sheets/follow_up_6wny', {
      token: seller,
      tenant: tenantId,
    });
    expect(sheet.status).toBe(200);
    steps = sheet.body.steps;
    const weighIns = steps.filter((s) => s.captureUnit === 'kg');
    // One at every stage: before, day 4, day 7, day 14, week 3.
    expect(weighIns).toHaveLength(5);
    expect(steps.filter((s) => s.captureUnit === 'cm')).toHaveLength(5);
    // Everything else stays a tick — a unit on every column would turn a
    // checklist into a form.
    expect(steps.filter((s) => s.captureUnit === null).length).toBeGreaterThan(20);
  });

  it('keeps the reading, not just the fact that somebody weighed them', async () => {
    const seller = await login(`seller-${RUN}@test.local`);
    const customers = await api('/api/v1/crm/customers', { token: seller, tenant: tenantId });
    const subjectId = customers.body.customers[0].id;

    const added = await api('/api/v1/tracker/sheets/follow_up_6wny/entries', {
      method: 'POST',
      token: seller,
      tenant: tenantId,
      body: JSON.stringify({ subjectId }),
    });
    expect(added.status).toBe(201);
    entryId = added.body.entry.id;

    const before = steps.find((s) => s.key === 'before_weight')!;
    const res = await api(`/api/v1/tracker/entries/${entryId}/marks`, {
      method: 'PUT',
      token: seller,
      tenant: tenantId,
      body: JSON.stringify({ stepId: before.id, done: true, value: 82.4 }),
    });
    expect(res.status).toBe(200);

    const sheet = await api('/api/v1/tracker/sheets/follow_up_6wny', {
      token: seller,
      tenant: tenantId,
    });
    const row = sheet.body.entries.find((e: { id: string }) => e.id === entryId);
    expect(row.values[before.id]).toBe(82.4);
  });

  it('gives back before and after without storing a second copy of either', async () => {
    const seller = await login(`seller-${RUN}@test.local`);
    for (const [key, value] of [
      ['d7_weight', 79.8],
      ['w3_weight', 76.5],
    ] as const) {
      const step = steps.find((s) => s.key === key)!;
      await api(`/api/v1/tracker/entries/${entryId}/marks`, {
        method: 'PUT',
        token: seller,
        tenant: tenantId,
        body: JSON.stringify({ stepId: step.id, done: true, value }),
      });
    }
    const sheet = await api('/api/v1/tracker/sheets/follow_up_6wny', {
      token: seller,
      tenant: tenantId,
    });
    const row = sheet.body.entries.find((e: { id: string }) => e.id === entryId);
    // 82.4 → 76.5. Derived from the marks in column order, which on a staged
    // sheet IS chronological, so it cannot drift from what was recorded.
    expect(row.change.kg.first).toBe(82.4);
    expect(row.change.kg.latest).toBe(76.5);
    expect(row.change.kg.delta).toBe(-5.9);
  });

  it('takes a corrected reading, unlike a corrected tick', async () => {
    const seller = await login(`seller-${RUN}@test.local`);
    const step = steps.find((s) => s.key === 'w3_weight')!;
    await api(`/api/v1/tracker/entries/${entryId}/marks`, {
      method: 'PUT',
      token: seller,
      tenant: tenantId,
      body: JSON.stringify({ stepId: step.id, done: true, value: 75.9 }),
    });
    const sheet = await api('/api/v1/tracker/sheets/follow_up_6wny', {
      token: seller,
      tenant: tenantId,
    });
    const row = sheet.body.entries.find((e: { id: string }) => e.id === entryId);
    // Ticking twice keeps the first DATE, because when it happened is the fact.
    // Somebody re-reading the scales is different: the new number is the true
    // one, and refusing it would leave a wrong weight on the record for ever.
    expect(row.change.kg.latest).toBe(75.9);
  });

  it('seeds the programme the sheet follows up on', async () => {
    const seller = await login(`seller-${RUN}@test.local`);
    // A sheet tracking a programme nobody can learn or buy is a checklist
    // wearing a programme's name — which is all 6WNY was after Sprint 40.
    const courses = await api('/api/v1/courses', { token: seller, tenant: tenantId });
    const course = courses.body.courses.find((c: { code: string }) => c.code === '6wny');
    expect(course).toBeTruthy();
    expect(course.lessons).toHaveLength(6);
  });

  it('will not sell the pack until somebody prices it', async () => {
    const seller = await login(`seller-${RUN}@test.local`);
    const offerings = await api('/api/v1/offerings', { token: seller, tenant: tenantId });
    // What 6WNY costs is the business's number, so it seeds at zero as a draft
    // — and a pack that could be bought for nothing is worse than one that
    // cannot be bought yet.
    expect(offerings.body.offerings.some((o: { code: string }) => o.code === '6wny-pack')).toBe(
      false,
    );

    const raw = await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return tx.offering.findFirst({ where: { code: '6wny-pack' } });
    });
    expect(raw).toBeTruthy();
    expect(raw!.status).toBe('draft');
    expect(raw!.priceMinor).toBe(0);

    // Deliberately NOT asserted through the cart here: this suite's seller has
    // no commerce entitlement, so the cart refuses at the earlier gate and the
    // assertion would pass without the draft status doing any of the work.
    // The cart's own guard is `status: 'active'` in cart.service.ts, which
    // commerce.e2e covers.
  });

  it('ignores a number sent for a column that only wants a tick', async () => {
    const seller = await login(`seller-${RUN}@test.local`);
    const plain = steps.find((s) => s.captureUnit === null)!;
    await api(`/api/v1/tracker/entries/${entryId}/marks`, {
      method: 'PUT',
      token: seller,
      tenant: tenantId,
      body: JSON.stringify({ stepId: plain.id, done: true, value: 999 }),
    });
    const sheet = await api('/api/v1/tracker/sheets/follow_up_6wny', {
      token: seller,
      tenant: tenantId,
    });
    const row = sheet.body.entries.find((e: { id: string }) => e.id === entryId);
    // Otherwise a stray number lands on a column with no unit and the
    // before-and-after starts counting things that are not measurements.
    expect(row.values[plain.id]).toBeUndefined();
  });
});

/**
 * Sprint 46 — before/after photographs, gated on consent (docs/65).
 *
 * The most sensitive thing this product holds. Every test here is about the two
 * rules that make holding it defensible: nothing is stored without a live
 * consent, and withdrawing consent destroys what it permitted.
 */
describe('Sprint 46 — photographs and consent', () => {
  const ONE_PIXEL_PNG =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  let customerId = '';
  let photoId = '';

  beforeAll(async () => {
    const seller = await login(`seller-${RUN}@test.local`);
    const customers = await api('/api/v1/crm/customers', { token: seller, tenant: tenantId });
    customerId = customers.body.customers[0].id;
  });

  it('refuses to store a photograph nobody consented to', async () => {
    const seller = await login(`seller-${RUN}@test.local`);
    const res = await api(`/api/v1/crm/customers/${customerId}/photos`, {
      method: 'POST',
      token: seller,
      tenant: tenantId,
      body: JSON.stringify({
        stepKey: 'before_photo',
        contentType: 'image/png',
        dataBase64: ONE_PIXEL_PNG,
      }),
    });
    // Before anything else works, this must not.
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/consent/i);
  });

  it('records the consent, and who took it', async () => {
    const seller = await login(`seller-${RUN}@test.local`);
    const granted = await api(`/api/v1/crm/customers/${customerId}/photo-consent`, {
      method: 'POST',
      token: seller,
      tenant: tenantId,
      body: JSON.stringify({ note: 'เซ็นใบยินยอมแล้ว' }),
    });
    expect(granted.status).toBe(201);

    const read = await api(`/api/v1/crm/customers/${customerId}/photo-consent`, {
      token: seller,
      tenant: tenantId,
    });
    expect(read.body.granted).toBe(true);
    // How it was taken matters if anybody ever asks.
    expect(read.body.note).toBe('เซ็นใบยินยอมแล้ว');
  });

  it('stores it once there is consent, and hands the bytes back', async () => {
    const seller = await login(`seller-${RUN}@test.local`);
    const res = await api(`/api/v1/crm/customers/${customerId}/photos`, {
      method: 'POST',
      token: seller,
      tenant: tenantId,
      body: JSON.stringify({
        stepKey: 'before_photo',
        contentType: 'image/png',
        dataBase64: ONE_PIXEL_PNG,
      }),
    });
    expect(res.status).toBe(201);
    photoId = res.body.photo.id;

    const list = await api(`/api/v1/crm/customers/${customerId}/photos`, {
      token: seller,
      tenant: tenantId,
    });
    expect(list.body.photos).toHaveLength(1);
    // The storage key never leaves the server — it is the one thing that would
    // let somebody fetch the bytes without coming back through this API.
    expect(list.body.photos[0]).not.toHaveProperty('storageKey');
  });

  it('refuses a file that is not an image', async () => {
    const seller = await login(`seller-${RUN}@test.local`);
    const res = await api(`/api/v1/crm/customers/${customerId}/photos`, {
      method: 'POST',
      token: seller,
      tenant: tenantId,
      body: JSON.stringify({
        stepKey: 'before_photo',
        contentType: 'application/pdf',
        dataBase64: ONE_PIXEL_PNG,
      }),
    });
    expect(res.status).toBe(403);
  });

  it("does not show one member's customer photos to another", async () => {
    const outsider = await login(`outsider-${RUN}@test.local`);
    const list = await api(`/api/v1/crm/customers/${customerId}/photos`, {
      token: outsider,
      tenant: tenantId,
    });
    expect(list.status).toBe(404);

    const bytes = await api(`/api/v1/photos/${photoId}/content`, {
      token: outsider,
      tenant: tenantId,
    });
    expect(bytes.status).toBe(404);
  });

  it('destroys the photographs when consent is withdrawn', async () => {
    const seller = await login(`seller-${RUN}@test.local`);
    const revoked = await api(`/api/v1/crm/customers/${customerId}/photo-consent`, {
      method: 'DELETE',
      token: seller,
      tenant: tenantId,
    });
    expect(revoked.status).toBe(200);
    // Not hidden. Hiding would leave the customer's picture in a bucket
    // belonging to somebody they have told to stop.
    expect(revoked.body.photosDeleted).toBe(1);

    const list = await api(`/api/v1/crm/customers/${customerId}/photos`, {
      token: seller,
      tenant: tenantId,
    });
    expect(list.body.photos).toHaveLength(0);

    const bytes = await api(`/api/v1/photos/${photoId}/content`, {
      token: seller,
      tenant: tenantId,
    });
    expect(bytes.status).toBe(404);
  });

  it('keeps the record that consent was given and then withdrawn', async () => {
    const seller = await login(`seller-${RUN}@test.local`);
    const read = await api(`/api/v1/crm/customers/${customerId}/photo-consent`, {
      token: seller,
      tenant: tenantId,
    });
    // The photographs go; the record of what was agreed and when it ended is
    // exactly what somebody might later need.
    expect(read.body.granted).toBe(false);
    expect(read.body.grantedAt).toBeTruthy();
    expect(read.body.revokedAt).toBeTruthy();
  });

  it('will not take another photograph after the withdrawal', async () => {
    const seller = await login(`seller-${RUN}@test.local`);
    const res = await api(`/api/v1/crm/customers/${customerId}/photos`, {
      method: 'POST',
      token: seller,
      tenant: tenantId,
      body: JSON.stringify({
        stepKey: 'before_photo',
        contentType: 'image/png',
        dataBase64: ONE_PIXEL_PNG,
      }),
    });
    // Consent is checked live on every upload. "They consented last month" is
    // not a fact about now.
    expect(res.status).toBe(403);
  });
});

/**
 * Sprint 47 — the customer index card (docs/66).
 *
 * ABO#, expiry, ID#, date of birth, a note, and twelve boxes for the year. The
 * boxes are the only thing on the card a computer answers better than the
 * person holding it, and the identity number is the thing it must be most
 * careful with.
 */
describe('Sprint 47 — the customer index card', () => {
  let customerId = '';
  const YEAR = 2031;

  beforeAll(async () => {
    const seller = await login(`seller-${RUN}@test.local`);
    const customers = await api('/api/v1/crm/customers', { token: seller, tenant: tenantId });
    customerId = customers.body.customers[0].id;
  });

  it('saves the card', async () => {
    const seller = await login(`seller-${RUN}@test.local`);
    const res = await api(`/api/v1/crm/customers/${customerId}/card`, {
      method: 'PUT',
      token: seller,
      tenant: tenantId,
      body: JSON.stringify({
        externalCode: 'ABO-771203',
        membershipExpiresAt: '2032-01-31',
        birthDate: '1988-04-17',
        note: 'ชอบ Breakfast Set',
      }),
    });
    expect(res.status).toBe(200);

    const card = await api(`/api/v1/crm/customers/${customerId}/card?year=${YEAR}`, {
      token: seller,
      tenant: tenantId,
    });
    expect(card.body.customer.externalCode).toBe('ABO-771203');
    expect(card.body.customer.note).toBe('ชอบ Breakfast Set');
  });

  it('never puts the identity number on the card', async () => {
    const seller = await login(`seller-${RUN}@test.local`);
    const saved = await api(`/api/v1/crm/customers/${customerId}/card`, {
      method: 'PUT',
      token: seller,
      tenant: tenantId,
      body: JSON.stringify({ idNumber: '1103700123456' }),
    });
    // Asserted so a refused save fails HERE rather than as three puzzling
    // assertions further down about a number that was never stored.
    expect(saved.status).toBe(200);

    const card = await api(`/api/v1/crm/customers/${customerId}/card`, {
      token: seller,
      tenant: tenantId,
    });
    // Whether one is on file, never what it is. Returning it with the card
    // would put an identity number on somebody's screen every time they
    // glanced at a customer, with nothing recording that it happened.
    expect(card.body.customer.hasIdNumber).toBe(true);
    expect(card.body.customer).not.toHaveProperty('idNumber');
    expect(JSON.stringify(card.body)).not.toContain('1103700123456');
  });

  it('stores the identity number encrypted, and hands it back on request', async () => {
    const row = await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return tx.customer.findFirst({ where: { id: customerId } });
    });
    // The row itself must not contain it.
    expect(row!.idNumberEncrypted).not.toContain('1103700123456');
    expect(row!.idNumberEncrypted).toMatch(/^enc\.v1\./);

    const seller = await login(`seller-${RUN}@test.local`);
    const revealed = await api(`/api/v1/crm/customers/${customerId}/id-number`, {
      method: 'POST',
      token: seller,
      tenant: tenantId,
    });
    expect(revealed.status).toBe(201);
    expect(revealed.body.idNumber).toBe('1103700123456');
  });

  it('records that somebody read it', async () => {
    const admin = await login(`admin-${RUN}@test.local`);
    const audit = await api('/api/v1/audit-logs?action=crm.customer.id_number.read', {
      token: admin,
      tenant: tenantId,
    });
    // Reading an identity number is an act, and an act nobody can see happening
    // is one nobody can question.
    expect(audit.status).toBe(200);
    expect(audit.body.auditLogs.length).toBeGreaterThan(0);
    // The row must not carry the number it recorded somebody reading.
    expect(JSON.stringify(audit.body)).not.toContain('1103700123456');
  });

  it('gives twelve boxes and says which the system saw for itself', async () => {
    const seller = await login(`seller-${RUN}@test.local`);
    const card = await api(`/api/v1/crm/customers/${customerId}/card?year=${YEAR}`, {
      token: seller,
      tenant: tenantId,
    });
    expect(card.body.months).toHaveLength(12);
    expect(card.body.months.map((m: { month: number }) => m.month)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    // Nothing is ordered in a year nothing happened in.
    expect(card.body.orderedCount).toBe(0);
  });

  it('lets a month the system cannot see be ticked by hand', async () => {
    const seller = await login(`seller-${RUN}@test.local`);
    const res = await api(`/api/v1/crm/customers/${customerId}/months`, {
      method: 'PUT',
      token: seller,
      tenant: tenantId,
      body: JSON.stringify({ year: YEAR, month: 3, ordered: true }),
    });
    expect(res.status).toBe(200);

    const card = await api(`/api/v1/crm/customers/${customerId}/card?year=${YEAR}`, {
      token: seller,
      tenant: tenantId,
    });
    const march = card.body.months.find((m: { month: number }) => m.month === 3);
    expect(march.ordered).toBe(true);
    // A lot of this business happens outside the system; a grid that could only
    // see what the system sold would be blank for most customers.
    expect(march.source).toBe('manual');
    expect(card.body.orderedCount).toBe(1);
  });

  it('takes a hand tick back', async () => {
    const seller = await login(`seller-${RUN}@test.local`);
    await api(`/api/v1/crm/customers/${customerId}/months`, {
      method: 'PUT',
      token: seller,
      tenant: tenantId,
      body: JSON.stringify({ year: YEAR, month: 3, ordered: false }),
    });
    const card = await api(`/api/v1/crm/customers/${customerId}/card?year=${YEAR}`, {
      token: seller,
      tenant: tenantId,
    });
    expect(card.body.orderedCount).toBe(0);
  });

  it("does not show one member's card to another", async () => {
    const outsider = await login(`outsider-${RUN}@test.local`);
    const res = await api(`/api/v1/crm/customers/${customerId}/card`, {
      token: outsider,
      tenant: tenantId,
    });
    expect(res.status).toBe(404);
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
