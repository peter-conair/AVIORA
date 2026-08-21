/**
 * Running more than one instance (Sprint 19, docs/38).
 *
 * Three claims in docs/33 §3 were the same sentence in different words:
 * nothing had ever run two API processes at once. Two of them — the scheduler
 * and the outbox relay — are designs built for concurrency that were never
 * made to prove it, which is a particular kind of risk: they are probably
 * right, and "probably" is not what a subscription charge deserves.
 *
 * So this file starts TWO Nest applications against ONE database and makes
 * them race. It is slower and stranger than the rest of the suite, and it is
 * worth it: the alternative is finding out on the day somebody scales the
 * deployment that "exactly once" meant "exactly once per process".
 *
 * The third claim — the rate limiter — was simply wrong, and is tested
 * against a real Redis in `redis-rate-limit.spec.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import * as argon2 from 'argon2';
import { createOwnerClient, ensureAppRole, type PrismaClient } from '@aviora/db';
import { ENTITLEMENTS, EVENTS, PERMISSIONS } from '@aviora/shared';
import { createApp } from '../../src/app.factory';
import { OutboxRelayService } from '../../src/common/events/outbox-relay.service';
import { SchedulerService } from '../../src/modules/scheduler/scheduler.service';

const RUN = `s${Date.now().toString(36)}`;
const PLATFORM_EMAIL = `e2e-si-platform-${RUN}@test.local`;
const PW = 'e2e-password-123456';

let one: INestApplication;
let two: INestApplication;
let base: string;
let owner: PrismaClient;
let tenant: string;

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

beforeAll(async () => {
  // Both instances are driven by hand. A timer firing underneath a test that
  // is trying to observe a race would make the result unreadable.
  process.env.AVIORA_SCHEDULER_DISABLED = 'true';
  process.env.AVIORA_OUTBOX_DISABLED = 'true';
  process.env.AVIORA_PII_ENCRYPTION_KEY ??= Buffer.alloc(32, 11).toString('base64');

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
      displayName: 'E2E Second Instance',
      platformRole: 'PLATFORM_OWNER',
    },
    update: {},
  });

  // Two applications, one database — the shape of a scaled deployment.
  one = await createApp({ logger: false });
  await one.listen(0);
  base = (await one.getUrl()).replace('[::1]', '127.0.0.1');
  two = await createApp({ logger: false });
  await two.init();

  const platform = await login(PLATFORM_EMAIL);
  const created = await api('/api/v1/platform/tenants', {
    method: 'POST',
    token: platform,
    body: JSON.stringify({
      code: `e2e_si_${RUN}`,
      name: 'Scaled Co',
      slug: `e2e-si-${RUN}`,
      adminEmail: `si-admin-${RUN}@test.local`,
      adminDisplayName: 'Admin',
      adminPassword: PW,
    }),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  tenant = created.body.tenant.id;
}, 240_000);

afterAll(async () => {
  await Promise.allSettled([one?.close(), two?.close()]);
  await owner?.$disconnect();
});

/* ── the scheduler ────────────────────────────────────────────────────────── */

describe('Two instances, one occurrence (docs/38 §3)', () => {
  it('both tick at the same moment and exactly one run row exists per occurrence', async () => {
    const before = await owner.scheduledJobRun.count();

    // Started together, deliberately: the interesting window is the one where
    // both are inside `claim` for the same occurrence at the same time.
    await Promise.all([one.get(SchedulerService).tick(), two.get(SchedulerService).tick()]);

    const runs = await owner.scheduledJobRun.findMany({
      orderBy: { createdAt: 'desc' },
      take: Math.max((await owner.scheduledJobRun.count()) - before, 0) + 20,
      select: { job: true, tenantId: true, scheduledFor: true, status: true, attempts: true },
    });

    // One row per (job, tenant, occurrence) — the unique key is the arbiter for
    // tenant jobs, and the advisory lock covers the platform job where
    // tenant_id is NULL and Postgres counts NULLs as distinct (docs/35 §2).
    const seen = new Map<string, number>();
    for (const r of runs) {
      const key = `${r.job}|${r.tenantId ?? 'platform'}|${r.scheduledFor.toISOString()}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    // Not vacuous: the concurrent tick has to have produced occurrences to
    // race over, or "no duplicates" is a statement about an empty set.
    expect(
      seen.size,
      'the two ticks produced no occurrences at all, so this test proves nothing',
    ).toBeGreaterThan(0);

    const duplicated = [...seen.entries()].filter(([, n]) => n > 1);
    expect(
      duplicated,
      `two instances produced more than one row for the same occurrence: ${duplicated
        .map(([k, n]) => `${k} ×${n}`)
        .join(', ')}. Each extra row is a job that ran twice — for renewals, a ` + `second charge.`,
    ).toEqual([]);

    // and nothing was left half-claimed by the instance that lost the race
    const stuck = runs.filter((r) => r.status === 'claimed');
    expect(
      stuck,
      'an instance claimed an occurrence and never settled it — the loser of the ' +
        'race must record nothing, not a row nobody will finish',
    ).toEqual([]);
  }, 180_000);

  it('a second concurrent pass adds no rows and no attempts', async () => {
    const before = await owner.scheduledJobRun.findMany({
      select: { id: true, attempts: true },
    });

    await Promise.all([one.get(SchedulerService).tick(), two.get(SchedulerService).tick()]);

    const after = await owner.scheduledJobRun.findMany({ select: { id: true, attempts: true } });
    expect(after.length, 'a repeat tick created new occurrence rows').toBe(before.length);

    const attemptsBefore = new Map(before.map((r) => [r.id, r.attempts]));
    const bumped = after.filter((r) => (attemptsBefore.get(r.id) ?? 0) !== r.attempts);
    expect(
      bumped,
      'an occurrence that already has a row was re-attempted without anyone ' +
        'forcing it — that is the double-run the unique key exists to prevent',
    ).toEqual([]);
  }, 180_000);
});

/* ── the outbox ───────────────────────────────────────────────────────────── */

describe('Two relays, one backlog (docs/38 §3)', () => {
  it('drains concurrently, and every event ends processed exactly once', async () => {
    // A backlog worth racing over. `MemberInvited` has real handlers, so this
    // exercises the ledger rather than an empty loop.
    const ids: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const row = await owner.domainEvent.create({
        data: {
          eventName: EVENTS.MemberInvited,
          tenantId: tenant,
          aggregateType: 'invitation',
          aggregateId: crypto.randomUUID(),
          payload: { token: `probe-${RUN}-${i}`, email: `probe-${i}@test.local` },
        },
      });
      ids.push(row.id);
    }

    // Both relays, at once, over the same backlog.
    for (let pass = 0; pass < 4; pass += 1) {
      await Promise.all([one.get(OutboxRelayService).tick(), two.get(OutboxRelayService).tick()]);
    }

    const rows = await owner.domainEvent.findMany({
      where: { id: { in: ids } },
      select: { id: true, processedAt: true, attempts: true, lastError: true },
    });
    const unprocessed = rows.filter((r) => !r.processedAt);
    expect(
      unprocessed.map((r) => r.id),
      'events were left undelivered after both relays ran — SKIP LOCKED must ' +
        'hand a row to one relay, not hide it from both',
    ).toEqual([]);

    // The ledger is what makes "exactly once" checkable: one row per
    // (handler, event), and a unique key behind it.
    const ledger = await owner.processedEvent.groupBy({
      by: ['eventId', 'handler'],
      where: { eventId: { in: ids } },
      _count: { _all: true },
    });
    // Same guard on the other side: a handler that never ran cannot have run
    // twice, and an empty ledger would pass the check below in silence.
    expect(
      ledger.length,
      'no handler recorded any of these events, so "exactly once" was not tested',
    ).toBeGreaterThan(0);

    const twice = ledger.filter((l) => l._count._all > 1);
    expect(
      twice,
      'a handler ran twice for one event across two relays: ' +
        twice.map((t) => `${t.handler}@${t.eventId}`).join(', '),
    ).toEqual([]);
  }, 180_000);
});
