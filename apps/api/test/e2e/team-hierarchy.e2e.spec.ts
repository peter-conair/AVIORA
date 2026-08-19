/**
 * Vertical Slice 2 E2E (spec §73, docs/05):
 * recursive teams A → A1 → A1.1 → A1.1.1 with different leaders.
 * Proves: parent leader sees authorized descendants; child leader cannot see
 * ancestors/siblings; metrics roll up (direct vs organization, de-duplicated);
 * subtree move rewrites closure correctly and re-scopes access; leadership
 * history is preserved; scoped LEADER role is granted automatically.
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
let ownerMemberId: string; // tenant owner (Org)
let planId: string;
const team: Record<'A' | 'A1' | 'A11' | 'A111' | 'B', string> = {} as never;
const member: Record<'leadA' | 'leadA11' | 'deep', string> = {} as never;

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

/** Invite + accept in one step; returns memberId. */
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

  // tenant + plan + members
  const platform = await login(PLATFORM_EMAIL);
  const created = await api('/api/v1/platform/tenants', {
    method: 'POST',
    token: platform,
    body: JSON.stringify({
      code: `e2e_org_${RUN}`,
      name: 'Org Co',
      slug: `e2e-org-${RUN}`,
      adminEmail: `org-${RUN}@test.local`,
      adminDisplayName: 'Org Owner',
      adminPassword: PW,
    }),
  });
  expect(created.status).toBe(201);
  tenantId = created.body.tenant.id;
  ownerMemberId = created.body.adminMemberId;

  const admin = await login(`org-${RUN}@test.local`);
  const plan = await api('/api/v1/membership-plans', {
    method: 'POST',
    token: admin,
    tenant: tenantId,
    body: JSON.stringify({ code: 'std', name: 'Standard', entitlementKeys: [] }),
  });
  planId = plan.body.plan.id;

  member.leadA = await addMember(admin, `lead-a-${RUN}@test.local`, 'Leader A');
  member.leadA11 = await addMember(admin, `lead-a11-${RUN}@test.local`, 'Leader A11');
  member.deep = await addMember(admin, `deep-${RUN}@test.local`, 'Deep Member');
}, 180_000);

afterAll(async () => {
  await app?.close();
  await owner?.$disconnect();
});

describe('Slice 2 — recursive hierarchy & scoped access', () => {
  it('builds A → A1 → A1.1 → A1.1.1 plus sibling B', async () => {
    const admin = await login(`org-${RUN}@test.local`);
    const mk = async (code: string, name: string, parentTeamId?: string) => {
      const res = await api('/api/v1/teams', {
        method: 'POST',
        token: admin,
        tenant: tenantId,
        body: JSON.stringify({ code, name, ...(parentTeamId ? { parentTeamId } : {}) }),
      });
      expect(res.status).toBe(201);
      return res.body.team.id as string;
    };
    team.A = await mk('ta', 'Team A');
    team.A1 = await mk('a1', 'Team A1', team.A);
    team.A11 = await mk('a11', 'Team A1.1', team.A1);
    team.A111 = await mk('a111', 'Team A1.1.1', team.A11);
    team.B = await mk('tb', 'Team B');

    // closure sanity straight from the DB
    const depths = await owner.teamClosure.findMany({
      where: { tenantId, ancestorTeamId: team.A },
      select: { descendantTeamId: true, depth: true },
    });
    const depthOf = Object.fromEntries(depths.map((d) => [d.descendantTeamId, d.depth]));
    expect(depthOf[team.A]).toBe(0);
    expect(depthOf[team.A1]).toBe(1);
    expect(depthOf[team.A11]).toBe(2);
    expect(depthOf[team.A111]).toBe(3);
  });

  it('assigns different leaders per level (LEADER role auto-granted)', async () => {
    const admin = await login(`org-${RUN}@test.local`);
    const assign = async (teamId: string, memberId: string) => {
      const res = await api(`/api/v1/teams/${teamId}/leaders`, {
        method: 'POST',
        token: admin,
        tenant: tenantId,
        body: JSON.stringify({ memberId }),
      });
      expect(res.status).toBe(201);
    };
    await assign(team.A, member.leadA);
    await assign(team.A11, member.leadA11);

    const leaderRole = await owner.role.findFirst({ where: { tenantId, code: 'LEADER' } });
    const granted = await owner.memberRole.findMany({
      where: { tenantId, roleId: leaderRole!.id },
      select: { memberId: true },
    });
    const ids = granted.map((g) => g.memberId);
    expect(ids).toContain(member.leadA);
    expect(ids).toContain(member.leadA11);
  });

  it('members join teams at various depths', async () => {
    const admin = await login(`org-${RUN}@test.local`);
    const join = async (teamId: string, memberId: string) => {
      const res = await api(`/api/v1/teams/${teamId}/members`, {
        method: 'POST',
        token: admin,
        tenant: tenantId,
        body: JSON.stringify({ memberId }),
      });
      expect(res.status).toBe(201);
    };
    await join(team.A1, member.leadA11); // leader A11 sits in A1
    await join(team.A111, member.deep); // deep member at depth 3
    await join(team.A, member.leadA);
  });

  it('leader of A sees the whole subtree; deep members visible from the top', async () => {
    const leadA = await login(`lead-a-${RUN}@test.local`);
    const list = await api('/api/v1/teams', { token: leadA, tenant: tenantId });
    const ids = list.body.teams.map((t: { id: string }) => t.id);
    expect(ids).toEqual(expect.arrayContaining([team.A, team.A1, team.A11, team.A111]));
    expect(ids).not.toContain(team.B);

    const desc = await api(`/api/v1/teams/${team.A}/descendants`, {
      token: leadA,
      tenant: tenantId,
    });
    expect(desc.status).toBe(200);
    expect(desc.body.teams).toHaveLength(4);

    const deepMembers = await api(`/api/v1/teams/${team.A111}/members`, {
      token: leadA,
      tenant: tenantId,
    });
    expect(deepMembers.status).toBe(200);
    expect(deepMembers.body.members.map((m: { memberId: string }) => m.memberId)).toContain(
      member.deep,
    );
  });

  it('leader of A1.1 cannot see ancestors or siblings', async () => {
    const leadA11 = await login(`lead-a11-${RUN}@test.local`);
    const list = await api('/api/v1/teams', { token: leadA11, tenant: tenantId });
    const ids = list.body.teams.map((t: { id: string }) => t.id);
    expect(ids).toEqual(expect.arrayContaining([team.A11, team.A111]));
    expect(ids).toContain(team.A1); // direct membership (they sit in A1)
    expect(ids).not.toContain(team.A); // ancestor hidden
    expect(ids).not.toContain(team.B); // sibling tree hidden

    const ancestor = await api(`/api/v1/teams/${team.A}/members`, {
      token: leadA11,
      tenant: tenantId,
    });
    expect(ancestor.status).toBe(403);

    const sibling = await api(`/api/v1/teams/${team.B}`, { token: leadA11, tenant: tenantId });
    expect(sibling.status).toBe(403);

    // member-manage is DIRECT_TEAM: allowed on A11, denied on A111
    const denied = await api(`/api/v1/teams/${team.A111}/members`, {
      method: 'POST',
      token: leadA11,
      tenant: tenantId,
      body: JSON.stringify({ memberId: member.leadA11 }),
    });
    expect(denied.status).toBe(403);
    const allowed = await api(`/api/v1/teams/${team.A11}/members`, {
      method: 'POST',
      token: leadA11,
      tenant: tenantId,
      body: JSON.stringify({ memberId: member.leadA11 }),
    });
    expect(allowed.status).toBe(201);
  });

  it('metrics roll up: direct vs organization, de-duplicated', async () => {
    const leadA = await login(`lead-a-${RUN}@test.local`);
    const res = await api(`/api/v1/teams/${team.A}/dashboard`, { token: leadA, tenant: tenantId });
    expect(res.status).toBe(200);
    // direct: only leadA sits in A itself
    expect(res.body.direct.members).toBe(1);
    // organization: leadA + leadA11 (in A1 and A11 — counted once) + deep = 3
    expect(res.body.organization.members).toBe(3);
    const child = res.body.children.find((c: { id: string }) => c.id === team.A1);
    expect(child.organizationMembers).toBe(2); // leadA11 (deduped) + deep
  });

  it('leader dashboard lists led teams with org counts', async () => {
    const leadA11 = await login(`lead-a11-${RUN}@test.local`);
    const res = await api('/api/v1/dashboard/leader', { token: leadA11, tenant: tenantId });
    expect(res.status).toBe(200);
    const entry = res.body.teams.find((t: { team: { id: string } }) => t.team.id === team.A11);
    expect(entry).toBeTruthy();
    expect(entry.organizationMembers).toBe(2); // leadA11 + deep
    expect(entry.childTeams).toBe(1); // A111
  });

  it('moving A1.1 under B rewrites the closure and re-scopes access', async () => {
    const admin = await login(`org-${RUN}@test.local`);
    const res = await api(`/api/v1/teams/${team.A11}/move`, {
      method: 'PATCH',
      token: admin,
      tenant: tenantId,
      body: JSON.stringify({ newParentId: team.B }),
    });
    expect(res.status).toBe(200);

    // closure: A111 now descends from B at depth 2; no longer from A
    const viaB = await owner.teamClosure.findFirst({
      where: { tenantId, ancestorTeamId: team.B, descendantTeamId: team.A111 },
    });
    expect(viaB?.depth).toBe(2);
    const viaA = await owner.teamClosure.findFirst({
      where: { tenantId, ancestorTeamId: team.A, descendantTeamId: team.A111 },
    });
    expect(viaA).toBeNull();

    // rollup follows the move: A org shrinks to 2, deep member gone from A's tree
    const leadA = await login(`lead-a-${RUN}@test.local`);
    const dash = await api(`/api/v1/teams/${team.A}/dashboard`, { token: leadA, tenant: tenantId });
    expect(dash.body.organization.members).toBe(2);

    // access follows the move: leader A can no longer read A111 members
    const gone = await api(`/api/v1/teams/${team.A111}/members`, {
      token: leadA,
      tenant: tenantId,
    });
    expect(gone.status).toBe(403);
    // ...while leader A11 keeps their subtree
    const leadA11 = await login(`lead-a11-${RUN}@test.local`);
    const kept = await api(`/api/v1/teams/${team.A111}/members`, {
      token: leadA11,
      tenant: tenantId,
    });
    expect(kept.status).toBe(200);
  });

  it('rejects cycle moves (team under its own descendant)', async () => {
    const admin = await login(`org-${RUN}@test.local`);
    const res = await api(`/api/v1/teams/${team.B}/move`, {
      method: 'PATCH',
      token: admin,
      tenant: tenantId,
      body: JSON.stringify({ newParentId: team.A111 }),
    });
    expect(res.status).toBe(400);
  });

  it('leadership history is preserved across reassignment', async () => {
    const admin = await login(`org-${RUN}@test.local`);
    const reassign = await api(`/api/v1/teams/${team.A11}/leaders`, {
      method: 'POST',
      token: admin,
      tenant: tenantId,
      body: JSON.stringify({ memberId: member.deep }),
    });
    expect(reassign.status).toBe(201);

    const history = await api(`/api/v1/teams/${team.A11}/leadership-history`, {
      token: admin,
      tenant: tenantId,
    });
    expect(history.status).toBe(200);
    const rows = history.body.leaderships;
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const ended = rows.find(
      (r: { memberId: string; status: string }) =>
        r.memberId === member.leadA11 && r.status === 'ended',
    );
    expect(ended).toBeTruthy();
    expect(ended.effectiveTo).toBeTruthy();
    const active = rows.find((r: { status: string }) => r.status === 'active');
    expect(active.memberId).toBe(member.deep);
  });

  it('TeamMoved event landed in the outbox exactly once', async () => {
    const count = await owner.domainEvent.count({ where: { eventName: 'TeamMoved', tenantId } });
    expect(count).toBe(1);
  });

  it('tenant owner still sees everything (TENANT_ALL)', async () => {
    const admin = await login(`org-${RUN}@test.local`);
    const list = await api('/api/v1/teams', { token: admin, tenant: tenantId });
    expect(list.body.teams).toHaveLength(5);
    expect(ownerMemberId).toBeTruthy();
  });
});
