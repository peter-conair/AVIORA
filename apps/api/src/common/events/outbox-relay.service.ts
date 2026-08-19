import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { DomainEventEnvelope, EventName } from '@aviora/shared';
import { PrismaService } from '../db/prisma.service';
import { EventBus } from './event-bus';

const POLL_MS = 2000;
const BATCH = 20;
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

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.prisma.owner.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<OutboxRow[]>`
          SELECT id, event_name, tenant_id, aggregate_type, aggregate_id,
                 actor_user_id, payload, occurred_at, attempts
          FROM domain_events
          WHERE processed_at IS NULL AND attempts < ${MAX_ATTEMPTS}
            AND next_attempt_at <= now()
          ORDER BY occurred_at
          LIMIT ${BATCH}
          FOR UPDATE SKIP LOCKED`;

        for (const row of rows) {
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
        }
      });
    } catch (e) {
      this.logger.error('outbox tick failed', e as Error);
    } finally {
      this.running = false;
    }
  }
}
