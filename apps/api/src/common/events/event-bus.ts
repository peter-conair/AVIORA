import { Injectable, Logger } from '@nestjs/common';
import type { DomainEventEnvelope } from '@aviora/shared';

export type DomainEventHandler = (event: DomainEventEnvelope) => Promise<void>;

/**
 * In-process subscription registry for outbox-relayed domain events.
 * Modules register handlers by event name; unknown events are just logged.
 * (BullMQ-backed dispatch is the Phase-2 upgrade path — docs/11.)
 */
@Injectable()
export class EventBus {
  private readonly logger = new Logger(EventBus.name);
  private readonly handlers = new Map<string, DomainEventHandler[]>();

  on(eventName: string, handler: DomainEventHandler): void {
    const list = this.handlers.get(eventName) ?? [];
    list.push(handler);
    this.handlers.set(eventName, list);
  }

  async dispatch(event: DomainEventEnvelope): Promise<void> {
    const list = this.handlers.get(event.eventName) ?? [];
    if (list.length === 0) {
      this.logger.log(`event ${event.eventName} (${event.eventId}) — no handlers, logged only`);
      return;
    }
    for (const handler of list) {
      await handler(event);
    }
  }
}
