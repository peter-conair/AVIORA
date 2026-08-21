/**
 * Outbox throughput (docs/41).
 *
 * docs/33 §3 says the relay's CONCURRENCY is proved — two relays race one
 * backlog and each handler still runs once — but its RATE has never been
 * measured. This measures it, and reports numbers rather than asserting a
 * threshold: a performance number that fails a build on a busy laptop teaches
 * people to ignore it.
 *
 * Two backlogs are drained separately, because they answer different questions:
 *
 *   · events WITH handlers  — what the platform actually achieves
 *   · events with NONE      — the poller's own overhead, work removed
 *
 * The gap between them says whether the relay is limited by the work it does or
 * by the way it goes looking for work.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { createOwnerClient, type PrismaClient } from '@aviora/db';
import { EVENTS } from '@aviora/shared';
import { createApp } from '../../src/app.factory';
import {
  OutboxRelayService,
  POLL_MS,
  BATCH,
  MAX_BATCHES_PER_TICK,
} from '../../src/common/events/outbox-relay.service';

const COUNT = Number(process.env.COUNT ?? 2000);

let app: INestApplication;
let owner: PrismaClient;
let tenantId: string;
let memberId: string;

beforeAll(async () => {
  // Nothing may run underneath a measurement of how fast something runs.
  process.env.AVIORA_OUTBOX_DISABLED = 'true';
  process.env.AVIORA_SCHEDULER_DISABLED = 'true';
  process.env.AVIORA_PII_ENCRYPTION_KEY ??= Buffer.alloc(32, 13).toString('base64');

  owner = createOwnerClient();
  app = await createApp({ logger: false });
  await app.init();

  const tenant = await owner.tenant.findFirst({
    where: { members: { some: {} } },
    select: { id: true, members: { select: { id: true }, take: 1 } },
  });
  if (!tenant?.members[0]) throw new Error('no tenant with a member to attribute events to');
  tenantId = tenant.id;
  memberId = tenant.members[0].id;
}, 600_000);

afterAll(async () => {
  await app?.close();
  await owner?.$disconnect();
});

async function drain(eventName: string): Promise<{ seconds: number; ticks: number }> {
  await owner.$executeRawUnsafe(
    `INSERT INTO domain_events
       (id, event_name, tenant_id, aggregate_type, aggregate_id, payload, occurred_at)
     SELECT gen_random_uuid(), $1, $2::uuid, 'load', gen_random_uuid(),
            jsonb_build_object('memberId', $3::text, 'goalId', gen_random_uuid()::text), now()
       FROM generate_series(1, $4::int)`,
    eventName,
    tenantId,
    memberId,
    COUNT,
  );

  const relay = app.get(OutboxRelayService);
  const pending = () => owner.domainEvent.count({ where: { eventName, processedAt: null } });

  let ticks = 0;
  const started = process.hrtime.bigint();
  // Back to back, with NO wait between ticks. Production waits POLL_MS between
  // them, so this is the generous reading: the ceiling the relay could reach if
  // it were asked to work continuously.
  while ((await pending()) > 0) {
    await relay.tick();
    ticks += 1;
    if (ticks > COUNT) throw new Error(`relay stopped draining ${eventName} after ${ticks} ticks`);
  }
  return { seconds: Number(process.hrtime.bigint() - started) / 1e9, ticks };
}

function report(label: string, r: { seconds: number; ticks: number }): void {
  console.log(
    `  ${label.padEnd(32)} ${r.seconds.toFixed(1)}s  ` +
      `${(COUNT / r.seconds).toFixed(0)} events/s  ` +
      `${r.ticks} ticks (${(COUNT / r.ticks).toFixed(1)} per tick)`,
  );
}

describe(`Outbox throughput — ${COUNT} events per backlog`, () => {
  it('drains a backlog whose events have handlers', async () => {
    const r = await drain(EVENTS.GoalCompleted);
    report('with handlers (GoalCompleted)', r);
    expect(
      await owner.domainEvent.count({
        where: { eventName: EVENTS.GoalCompleted, processedAt: null },
      }),
    ).toBe(0);
  });

  it('drains a backlog whose events have none', async () => {
    const r = await drain('load.noop');
    report('no handlers (load.noop)', r);
    expect(
      await owner.domainEvent.count({ where: { eventName: 'load.noop', processedAt: null } }),
    ).toBe(0);
  });

  it('clears more than one batch in a single tick', async () => {
    // The measurement that mattered. When a tick took ONE batch and then waited
    // POLL_MS, deployed throughput was BATCH/POLL_MS — 10 events a second —
    // while the same code drains 161 a second when asked to keep working. That
    // ceiling was arithmetic, invisible to every correctness test, and is what
    // docs/41 removed. This asserts the behaviour rather than the number:
    // one tick must clear more than one batch's worth.
    const many = BATCH * 3;
    await owner.$executeRawUnsafe(
      `INSERT INTO domain_events
         (id, event_name, tenant_id, aggregate_type, aggregate_id, payload, occurred_at)
       SELECT gen_random_uuid(), 'load.oneTick', $1::uuid, 'load', gen_random_uuid(),
              '{}'::jsonb, now()
         FROM generate_series(1, $2::int)`,
      tenantId,
      many,
    );

    await app.get(OutboxRelayService).tick();

    const left = await owner.domainEvent.count({
      where: { eventName: 'load.oneTick', processedAt: null },
    });
    expect(
      left,
      `one tick left ${left} of ${many} events. If a tick takes a single batch ` +
        `and waits, the deployed rate is BATCH/POLL_MS = ` +
        `${((BATCH / POLL_MS) * 1000).toFixed(0)}/s per instance regardless of ` +
        `how fast anything else is.`,
    ).toBe(0);
    console.log(
      `\n  one tick cleared ${many} events (bound: ${MAX_BATCHES_PER_TICK} batches ` +
        `= ${MAX_BATCHES_PER_TICK * BATCH} events per pass)\n`,
    );
  });
});
