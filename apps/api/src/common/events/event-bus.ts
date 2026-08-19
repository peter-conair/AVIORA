import { Injectable, Logger } from '@nestjs/common';
import type { DomainEventEnvelope } from '@aviora/shared';
import { PrismaService } from '../db/prisma.service';

export type DomainEventHandler = (event: DomainEventEnvelope) => Promise<void>;

interface Registration {
  name: string;
  handle: DomainEventHandler;
}

/**
 * In-process subscription registry for outbox-relayed domain events.
 *
 * Handlers are INDEPENDENT: each one runs on its own and its success is
 * recorded in the processed_events ledger (docs/11 §idempotency). One handler
 * failing must never stop the others, and a retried event must not re-run
 * handlers that already succeeded — e.g. an unreachable SMTP server delays the
 * welcome email without swallowing the in-app notification.
 */
@Injectable()
export class EventBus {
  private readonly logger = new Logger(EventBus.name);
  private readonly handlers = new Map<string, Registration[]>();

  constructor(private readonly prisma: PrismaService) {}

  on(eventName: string, handlerName: string, handle: DomainEventHandler): void {
    const list = this.handlers.get(eventName) ?? [];
    list.push({ name: handlerName, handle });
    this.handlers.set(eventName, list);
  }

  /** Runs every handler; throws only if at least one failed (so the outbox retries). */
  async dispatch(event: DomainEventEnvelope): Promise<void> {
    const list = this.handlers.get(event.eventName) ?? [];
    if (list.length === 0) {
      this.logger.log(`event ${event.eventName} (${event.eventId}) — no handlers, logged only`);
      return;
    }

    const done = await this.prisma.owner.processedEvent.findMany({
      where: { eventId: event.eventId },
      select: { handler: true },
    });
    const alreadyDone = new Set(done.map((d) => d.handler));
    const failures: string[] = [];

    for (const reg of list) {
      if (alreadyDone.has(reg.name)) continue;
      try {
        await reg.handle(event);
        await this.prisma.owner.processedEvent.create({
          data: { eventId: event.eventId, handler: reg.name },
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        this.logger.error(`handler ${reg.name} failed for ${event.eventName}: ${message}`);
        failures.push(`${reg.name}: ${message}`);
      }
    }

    if (failures.length > 0) {
      throw new Error(failures.join(' | '));
    }
  }
}
