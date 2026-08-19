/**
 * Community, Challenges and Gamification (spec §36–§38).
 *
 * The interesting part is where they meet health data. A habit-sourced
 * challenge derives progress from the most private records in the platform, so
 * this suite pins the rule down: joining is the consent, only the derived count
 * is ever shared, someone who did not join does not appear at all, and leaving
 * removes them again. The event that drives points carries no health content.
 *
 * NOTE: stop any locally running API — the outbox relay is cross-tenant.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import * as argon2 from 'argon2';
import { createOwnerClient, ensureAppRole, type PrismaClient } from '@aviora/db';
import { ENTITLEMENTS, PERMISSIONS } from '@aviora/shared';
import { createApp } from '../../src/app.factory';
import { OutboxRelayService } from '../../src/common/events/outbox-relay.service';
import { EventBus } from '../../src/common/events/event-bus';

const RUN = `g${Date.now().toString(36)}`;
const PLATFORM_EMAIL = `e2e-platform-${RUN}@test.local`;
const PW = 'e2e-password-123456';

let app: INestApplication;
let base: string;
let owner: PrismaClient;
let relay: OutboxRelayService;

let tenantId: string;
let planId: string;
let teamId: string;
let communityId: string;
let challengeId: string;
const member: Record<'joiner' | 'lurker' | 'leader', string> = {} as never;

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

async function drainOutbox(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const pending = await owner.domainEvent.count({ where: { tenantId, processedAt: null } });
    if (pending === 0) return;
    await relay.tick();
  }
  throw new Error('outbox did not drain for this tenant');
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

/** Logs a habit on a specific day for a member. */
async function logHabit(token: string, habitId: string, daysAgo: number) {
  const d = new Date(Date.now() - daysAgo * 86_400_000);
  const res = await api(`/api/v1/health/habits/${habitId}/log`, {
    method: 'POST',
    token,
    tenant: tenantId,
    body: JSON.stringify({ logDate: d.toISOString(), value: 2000 }),
  });
  expect(res.status).toBe(201);
}

beforeAll(async () => {
  process.env.AVIORA_OUTBOX_DISABLED = 'true';
  process.env.AVIORA_PII_ENCRYPTION_KEY ??= Buffer.alloc(32, 5).toString('base64');
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
  // no SMTP here; handlers are independent so dropping email changes nothing else
  const registry = (app.get(EventBus) as unknown as { handlers: Map<string, { name: string }[]> })
    .handlers;
  registry.forEach((list, key) =>
    registry.set(
      key,
      list.filter((r) => !r.name.startsWith('email.')),
    ),
  );

  const platform = await login(PLATFORM_EMAIL);
  const created = await api('/api/v1/platform/tenants', {
    method: 'POST',
    token: platform,
    body: JSON.stringify({
      code: `e2e_cg_${RUN}`,
      name: 'Community Co',
      slug: `e2e-cg-${RUN}`,
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

  member.joiner = await addMember(admin, `joiner-${RUN}@test.local`, 'Joiner');
  member.lurker = await addMember(admin, `lurker-${RUN}@test.local`, 'Lurker');
  member.leader = await addMember(admin, `leader-${RUN}@test.local`, 'Leader');

  teamId = (
    await api('/api/v1/teams', {
      method: 'POST',
      token: admin,
      tenant: tenantId,
      body: JSON.stringify({ code: 'wellness', name: 'Wellness Team' }),
    })
  ).body.team.id;
  for (const id of [member.joiner, member.lurker, member.leader]) {
    await api(`/api/v1/teams/${teamId}/members`, {
      method: 'POST',
      token: admin,
      tenant: tenantId,
      body: JSON.stringify({ memberId: id }),
    });
  }
  await api(`/api/v1/teams/${teamId}/leaders`, {
    method: 'POST',
    token: admin,
    tenant: tenantId,
    body: JSON.stringify({ memberId: member.leader }),
  });
}, 240_000);

afterAll(async () => {
  await app?.close();
  await owner?.$disconnect();
});

describe('Community — a team gets a private space', () => {
  it('creates the team community on first access', async () => {
    const joiner = await login(`joiner-${RUN}@test.local`);
    const res = await api(`/api/v1/community/teams/${teamId}`, {
      token: joiner,
      tenant: tenantId,
    });
    expect(res.status).toBe(200);
    expect(res.body.community.teamId).toBe(teamId);
    communityId = res.body.community.id;

    // calling again returns the same one, not a second
    const again = await api(`/api/v1/community/teams/${teamId}`, {
      token: joiner,
      tenant: tenantId,
    });
    expect(again.body.community.id).toBe(communityId);
  });

  it('carries posts, comments and reactions', async () => {
    const joiner = await login(`joiner-${RUN}@test.local`);
    const post = await api(`/api/v1/community/${communityId}/posts`, {
      method: 'POST',
      token: joiner,
      tenant: tenantId,
      body: JSON.stringify({ body: 'Logged my water three days running.' }),
    });
    expect(post.status).toBe(201);
    const postId = post.body.post.id;

    const lurker = await login(`lurker-${RUN}@test.local`);
    const comment = await api(`/api/v1/community/posts/${postId}/comments`, {
      method: 'POST',
      token: lurker,
      tenant: tenantId,
      body: JSON.stringify({ body: 'Nice one.' }),
    });
    expect(comment.status).toBe(201);

    const react = await api(`/api/v1/community/posts/${postId}/reactions`, {
      method: 'POST',
      token: lurker,
      tenant: tenantId,
      body: JSON.stringify({ kind: 'like' }),
    });
    expect(react.status).toBe(201);
    // reacting twice stays one reaction
    await api(`/api/v1/community/posts/${postId}/reactions`, {
      method: 'POST',
      token: lurker,
      tenant: tenantId,
      body: JSON.stringify({ kind: 'like' }),
    });

    const feed = await api(`/api/v1/community/${communityId}/feed`, {
      token: joiner,
      tenant: tenantId,
    });
    expect(feed.body.posts).toHaveLength(1);
    expect(feed.body.posts[0].reactionCount).toBe(1);
    expect(feed.body.posts[0].comments[0].author.displayName).toBe('Lurker');
  });

  it('a member of another team cannot read the feed', async () => {
    const admin = await login(`admin-${RUN}@test.local`);
    const otherTeam = await api('/api/v1/teams', {
      method: 'POST',
      token: admin,
      tenant: tenantId,
      body: JSON.stringify({ code: 'other', name: 'Other Team' }),
    });
    const outsiderMember = await addMember(admin, `outsider-${RUN}@test.local`, 'Outsider');
    await api(`/api/v1/teams/${otherTeam.body.team.id}/members`, {
      method: 'POST',
      token: admin,
      tenant: tenantId,
      body: JSON.stringify({ memberId: outsiderMember }),
    });

    const outsider = await login(`outsider-${RUN}@test.local`);
    const res = await api(`/api/v1/community/${communityId}/feed`, {
      token: outsider,
      tenant: tenantId,
    });
    expect(res.status).toBe(403);
  });

  it('withdraws a post without erasing history', async () => {
    const joiner = await login(`joiner-${RUN}@test.local`);
    const post = await api(`/api/v1/community/${communityId}/posts`, {
      method: 'POST',
      token: joiner,
      tenant: tenantId,
      body: JSON.stringify({ body: 'A post to withdraw.' }),
    });
    const postId = post.body.post.id;

    const lurker = await login(`lurker-${RUN}@test.local`);
    const notMine = await api(`/api/v1/community/posts/${postId}`, {
      method: 'DELETE',
      token: lurker,
      tenant: tenantId,
    });
    expect(notMine.status).toBe(403);

    const mine = await api(`/api/v1/community/posts/${postId}`, {
      method: 'DELETE',
      token: joiner,
      tenant: tenantId,
    });
    expect(mine.status).toBe(200);

    const feed = await api(`/api/v1/community/${communityId}/feed`, {
      token: joiner,
      tenant: tenantId,
    });
    expect(feed.body.posts.map((p: { id: string }) => p.id)).not.toContain(postId);
    // the row survives with a deletion timestamp
    const row = await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return tx.post.findFirst({ where: { id: postId } });
    });
    expect(row?.deletedAt).toBeTruthy();
  });
});

describe('Challenges — progress derived from records that already exist', () => {
  it('an admin creates a habit-sourced challenge', async () => {
    const admin = await login(`admin-${RUN}@test.local`);
    const res = await api('/api/v1/challenges', {
      method: 'POST',
      token: admin,
      tenant: tenantId,
      body: JSON.stringify({
        code: 'water-week',
        name: 'Drink water for 3 days',
        source: 'habit',
        sourceRef: 'water',
        targetValue: 3,
        startsOn: new Date(Date.now() - 7 * 86_400_000).toISOString(),
        endsOn: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      }),
    });
    expect(res.status).toBe(201);
    challengeId = res.body.challenge.id;

    const member1 = await login(`joiner-${RUN}@test.local`);
    const denied = await api('/api/v1/challenges', {
      method: 'POST',
      token: member1,
      tenant: tenantId,
      body: JSON.stringify({
        code: 'sneaky',
        name: 'Sneaky',
        source: 'goal',
        targetValue: 1,
        startsOn: new Date().toISOString(),
        endsOn: new Date().toISOString(),
      }),
    });
    expect(denied.status).toBe(403);
  });

  it('counts habit days for members who joined', async () => {
    const joiner = await login(`joiner-${RUN}@test.local`);
    const habit = await api('/api/v1/health/habits', {
      method: 'POST',
      token: joiner,
      tenant: tenantId,
      body: JSON.stringify({ code: 'water', name: 'Drink water' }),
    });
    expect(habit.status).toBe(201);
    for (const daysAgo of [0, 1, 2]) {
      await logHabit(joiner, habit.body.habit.id, daysAgo);
    }

    const join = await api(`/api/v1/challenges/${challengeId}/join`, {
      method: 'POST',
      token: joiner,
      tenant: tenantId,
    });
    expect(join.status).toBe(201);

    const board = await api(`/api/v1/challenges/${challengeId}/leaderboard`, {
      token: joiner,
      tenant: tenantId,
    });
    expect(board.status).toBe(200);
    const me = board.body.leaderboard.find((r: { isMe: boolean }) => r.isMe);
    expect(me.progress).toBe(3);
  });

  it('a member who logged habits but never joined is absent from the board', async () => {
    // the lurker tracks the same habit but did not join the challenge
    const lurker = await login(`lurker-${RUN}@test.local`);
    const habit = await api('/api/v1/health/habits', {
      method: 'POST',
      token: lurker,
      tenant: tenantId,
      body: JSON.stringify({ code: 'water', name: 'Drink water' }),
    });
    for (const daysAgo of [0, 1, 2, 3]) {
      await logHabit(lurker, habit.body.habit.id, daysAgo);
    }

    const joiner = await login(`joiner-${RUN}@test.local`);
    const board = await api(`/api/v1/challenges/${challengeId}/leaderboard`, {
      token: joiner,
      tenant: tenantId,
    });
    const ids = board.body.leaderboard.map((r: { memberId: string }) => r.memberId);
    // not present at all — not present with a zero
    expect(ids).not.toContain(member.lurker);
    expect(board.body.privacyNote).toMatch(/only their progress count/i);

    // the same sentence, in the reader's language — a privacy explanation
    // nobody can read explains nothing
    const thai = await fetch(`${base}/api/v1/challenges/${challengeId}/leaderboard`, {
      headers: {
        authorization: `Bearer ${joiner}`,
        'x-tenant-id': tenantId,
        'accept-language': 'th-TH,th;q=0.9',
      },
    });
    const thaiBody = (await thai.json()) as { privacyNote: string };
    expect(thaiBody.privacyNote).toMatch(/แสดงเฉพาะสมาชิกที่เข้าร่วม/);
  });

  it('the leaderboard exposes counts only, never the underlying health records', async () => {
    const leader = await login(`leader-${RUN}@test.local`);
    const board = await api(`/api/v1/challenges/${challengeId}/leaderboard`, {
      token: leader,
      tenant: tenantId,
    });
    expect(board.status).toBe(200);
    const serialised = JSON.stringify(board.body);
    // no habit ids, no log dates, no metric values
    expect(serialised).not.toMatch(/logDate|habitId|value|2000/);

    // and the leader still cannot open the member's health summary
    const health = await api(`/api/v1/health/members/${member.joiner}/summary`, {
      token: leader,
      tenant: tenantId,
    });
    expect(health.status).toBe(403);
  });

  it('leaving removes the member from the board', async () => {
    const joiner = await login(`joiner-${RUN}@test.local`);
    const left = await api(`/api/v1/challenges/${challengeId}/join`, {
      method: 'DELETE',
      token: joiner,
      tenant: tenantId,
    });
    expect(left.status).toBe(200);

    const board = await api(`/api/v1/challenges/${challengeId}/leaderboard`, {
      token: joiner,
      tenant: tenantId,
    });
    expect(board.body.leaderboard).toHaveLength(0);

    // re-join for the settlement test
    await api(`/api/v1/challenges/${challengeId}/join`, {
      method: 'POST',
      token: joiner,
      tenant: tenantId,
    });
  });

  it('settling marks members who reached the target', async () => {
    const admin = await login(`admin-${RUN}@test.local`);
    const res = await api(`/api/v1/challenges/${challengeId}/settle`, {
      method: 'POST',
      token: admin,
      tenant: tenantId,
    });
    expect(res.status).toBe(201);
    expect(res.body.completed.map((c: { memberId: string }) => c.memberId)).toContain(
      member.joiner,
    );
  });
});

describe('Gamification — points are configuration', () => {
  it('awards nothing until a tenant configures a rule', async () => {
    await drainOutbox();
    const joiner = await login(`joiner-${RUN}@test.local`);
    const before = await api('/api/v1/gamification/me', { token: joiner, tenant: tenantId });
    expect(before.status).toBe(200);
    expect(before.body.points).toBe(0);
  });

  it('awards points and a badge once a rule exists', async () => {
    const admin = await login(`admin-${RUN}@test.local`);
    const rule = await api('/api/v1/gamification/rules', {
      method: 'POST',
      token: admin,
      tenant: tenantId,
      body: JSON.stringify({
        eventName: 'HabitLogged',
        points: 10,
        badgeCode: 'first-log',
        badgeName: 'First log',
      }),
    });
    expect(rule.status).toBe(201);

    // a new log after the rule exists earns points
    const joiner = await login(`joiner-${RUN}@test.local`);
    const habits = await api('/api/v1/health/habits', { token: joiner, tenant: tenantId });
    await logHabit(joiner, habits.body.habits[0].id, 4);
    await drainOutbox();

    const standing = await api('/api/v1/gamification/me', { token: joiner, tenant: tenantId });
    expect(standing.body.points).toBe(10);
    expect(standing.body.level).toBe(1);
    expect(standing.body.badges.map((b: { badgeCode: string }) => b.badgeCode)).toContain(
      'first-log',
    );
  });

  it('never pays twice for the same event, even if it is relayed again', async () => {
    const joiner = await login(`joiner-${RUN}@test.local`);
    const replayAll = async () => {
      const events = await owner.domainEvent.findMany({
        where: { tenantId, eventName: 'HabitLogged' },
        select: { id: true },
      });
      await owner.processedEvent.deleteMany({
        where: { eventId: { in: events.map((e) => e.id) } },
      });
      await owner.domainEvent.updateMany({
        where: { tenantId, eventName: 'HabitLogged' },
        data: { processedAt: null },
      });
      await drainOutbox();
    };

    // The first replay legitimately pays for logs made BEFORE the rule existed,
    // so the idempotency question is what a SECOND replay does.
    await replayAll();
    const afterFirst = await api('/api/v1/gamification/me', { token: joiner, tenant: tenantId });
    await replayAll();
    const afterSecond = await api('/api/v1/gamification/me', { token: joiner, tenant: tenantId });

    expect(afterSecond.body.points).toBe(afterFirst.body.points);
    // and the ledger holds one entry per event, not one per delivery
    const entries = await owner.pointEntry.count({
      where: { tenantId, memberId: member.joiner, eventName: 'HabitLogged' },
    });
    const events = await owner.domainEvent.count({
      // the joiner's own events only — the lurker logs habits too
      where: {
        tenantId,
        eventName: 'HabitLogged',
        payload: { path: ['memberId'], equals: member.joiner },
      },
    });
    expect(entries).toBe(events);
  });

  it('ranks members on the tenant leaderboard', async () => {
    const joiner = await login(`joiner-${RUN}@test.local`);
    const res = await api('/api/v1/gamification/leaderboard', {
      token: joiner,
      tenant: tenantId,
    });
    expect(res.status).toBe(200);
    expect(res.body.leaderboard[0].rank).toBe(1);
    expect(res.body.leaderboard[0].points).toBeGreaterThan(0);
  });

  it('a plain member cannot rewrite the rules', async () => {
    const joiner = await login(`joiner-${RUN}@test.local`);
    const res = await api('/api/v1/gamification/rules', {
      method: 'POST',
      token: joiner,
      tenant: tenantId,
      body: JSON.stringify({ eventName: 'HabitLogged', points: 9999 }),
    });
    expect(res.status).toBe(403);
  });
});
