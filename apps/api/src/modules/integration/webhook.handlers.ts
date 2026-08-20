import { Injectable, OnModuleInit } from '@nestjs/common';
import { EVENTS } from '@aviora/shared';
import { EventBus } from '../../common/events/event-bus';
import { WebhookDispatcher } from './webhook.dispatcher';

/**
 * One handler name for every event: the bus's processed_events ledger keys on
 * (event, handler), so the webhook pass is recorded once per event and a
 * retried event does not re-record deliveries.
 */
const HANDLER = 'webhook.deliveries';

/**
 * Webhooks are not a second event system (docs/30 §1). This file is the whole
 * of the wiring: one more subscriber on the existing bus, registered exactly
 * the way automation is. Which events matter is the tenant's subscriptions to
 * say, so the handler listens to all of them and the dispatcher decides —
 * except the ones on the health deny-list, which never reach an endpoint no
 * matter what a subscription asks for.
 */
@Injectable()
export class WebhookHandlers implements OnModuleInit {
  constructor(
    private readonly bus: EventBus,
    private readonly dispatcher: WebhookDispatcher,
  ) {}

  onModuleInit() {
    for (const eventName of Object.values(EVENTS)) {
      this.bus.on(eventName, HANDLER, (event) => this.dispatcher.record(event));
    }
  }
}
