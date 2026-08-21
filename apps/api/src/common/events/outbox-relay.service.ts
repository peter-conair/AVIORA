import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { DomainEventEnvelope, EventName } from '@aviora/shared';
import { PrismaService } from '../db/prisma.service';
import { EventBus } from './event-bus';

/**
 * How often the relay looks for work, and how much it takes when it does.
 *
 * Exported because these two numbers ARE the deployed throughput ceiling —
 * BATCH/POLL_MS events per second per instance — and a measurement that did not
 * name them would report a number the deployment cannot reach (docs/41).
 */
export const POLL_MS = 2000;
export const BATCH = 20;
/**
 * How many batches one tick may take before yielding.
 *
 * Without a bound, an instance that meets a large backlog keeps working until
 * the backlog ends — holding a connection and looking, from outside, exactly
 * like a hang. With it, a pass is bounded and the next tick continues where
 * this one stopped.
 */
export const MAX_BATCHES_PER_TICK = 50;
const MAX_ATTEMPTS = 5;

interface OutboxRow {
  id: string;
  event_name: string;
  tenant_id: string | null;
  aggregate_type: string;
  aggregate_id: string;
  actor_user_id: string | null;
  payload: unknown;
  occurred_at: Date;
  attempts: number;
}

/**
 * Transactional-outbox relay (docs/11 §4): polls domain_events with
 * FOR UPDATE SKIP LOCKED (safe across multiple instances), dispatches to
 * in-process handlers, marks processed. Runs as the owner client — the relay
 * is a cross-tenant system actor. Disabled in tests via AVIORA_OUTBOX_DISABLED.
 */
@Injectable()
export class OutboxRelayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelayService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EventBus,
  ) {}

  onModuleInit() {
    if (process.env.AVIORA_OUTBOX_DISABLED === 'true') return;
    this.timer = setInterval(() => void this.tick(), POLL_MS);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * One pass over the backlog.
   *
   * It keeps taking batches until one comes back short, because `POLL_MS` is
   * meant to say "how soon is a new event noticed", not "how many events per
   * second are allowed". Taking a single batch per tick made the deployed
   * throughput BATCH/POLL_MS — 10 events a second — while the same code drains
   * 161 a second when asked to keep working (docs/41 §1). Nothing was broken;
   * it was throttled, and no test that checks correctness could have seen it.
   *
   * A short batch means the queue is empty, or another instance holds the rest
   * under SKIP LOCKED. Both mean stop.
   */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let pass = 0; pass < MAX_BATCHES_PER_TICK; pass += 1) {
        const taken = await this.drainBatch();
        if (taken < BATCH) break;
      }
    } catch (e) {
      this.logger.error('outbox tick failed', e as Error);
    } finally {
      this.running = false;
    }
  }

  /**
   * Takes up to BATCH events and returns how many it took. Each batch is its
   * own transaction: the drain loop above deliberately does NOT widen it, since
   * a longer transaction holds row locks across more handler I/O — the opposite
   * of what the loop is for (docs/41 §2).
   */
  private async drainBatch(): Promise<number> {
    // The ids first, in their own short transaction. Reading them here and
    // locking them one at a time below is what stops a slow handler from
    // holding nineteen other events' locks with it (docs/43 §2).
    let ids: string[];
    try {
      const rows = await this.prisma.owner.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM domain_events
         WHERE processed_at IS NULL AND attempts < ${MAX_ATTEMPTS}
           AND next_attempt_at <= now()
         ORDER BY occurred_at
         LIMIT ${BATCH}`;
      ids = rows.map((r) => r.id);
    } catch (e) {
      this.logger.error('outbox could not read the backlog', e as Error);
      return 0;
    }

    let taken = 0;
    for (const id of ids) {
      // One transaction per event. SKIP LOCKED still does the arbitration —
      // the row is locked here, so two relays cannot take the same event, which
      // is the property second-instance.e2e.spec.ts asserts. What changed is
      // how LONG a lock is held: one handler's wait, not twenty.
      const handled = await this.handleOne(id);
      if (handled) taken += 1;
    }
    return taken;
  }

  /** Returns whether this relay took the event (false when another one had it). */
  private async handleOne(id: string): Promise<boolean> {
    try {
      return await this.prisma.owner.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<OutboxRow[]>`
          SELECT id, event_name, tenant_id, aggregate_type, aggregate_id,
                 actor_user_id, payload, occurred_at, attempts
          FROM domain_events
          WHERE id = ${id}::uuid AND processed_at IS NULL
          FOR UPDATE SKIP LOCKED`;
        const row = rows[0];
        // Gone or held by another relay: not an error, and not ours.
        if (!row) return false;

        const envelope: DomainEventEnvelope = {
          eventId: row.id,
          eventName: row.event_name as EventName,
          tenantId: row.tenant_id,
          aggregateType: row.aggregate_type,
          aggregateId: row.aggregate_id,
          actorUserId: row.actor_user_id,
          payload: row.payload,
          occurredAt: row.occurred_at.toISOString(),
          version: 1,
        };
        try {
          await this.bus.dispatch(envelope);
          await tx.domainEvent.update({
            where: { id: row.id },
            data: { processedAt: new Date() },
          });
        } catch (e) {
          const err = e instanceof Error ? e.message : String(e);
          this.logger.error(`event ${row.event_name} (${row.id}) failed: ${err}`);
          const backoffMs = Math.min(2 ** row.attempts * 5_000, 10 * 60_000);
          await tx.domainEvent.update({
            where: { id: row.id },
            data: {
              attempts: row.attempts + 1,
              lastError: err.slice(0, 1000),
              nextAttemptAt: new Date(Date.now() + backoffMs),
            },
          });
        }
        return true;
      });
    } catch (e) {
      // A transaction that failed as a whole — a lost connection, a timeout.
      // The event stays unprocessed and the next pass picks it up.
      this.logger.error(`outbox transaction failed for ${id}`, e as Error);
      return false;
    }
  }
}
