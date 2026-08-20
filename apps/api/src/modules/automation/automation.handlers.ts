import { Injectable, OnModuleInit } from '@nestjs/common';
import { EVENTS } from '@aviora/shared';
import { EventBus } from '../../common/events/event-bus';
import { AutomationEngine } from './automation.engine';

/** One handler name for every trigger: the bus's processed_events ledger keys
 *  on (event, handler), so the automation pass is recorded once per event. */
const HANDLER = 'automation.rules';

/**
 * Automation subscribes to EVERY event in the catalog (docs/27 §1) — which
 * trigger matters is the tenant's rules to say, not this file's. Registering
 * per event rather than intercepting the bus keeps automation exactly as
 * isolated as every other handler: it fails alone.
 */
@Injectable()
export class AutomationHandlers implements OnModuleInit {
  constructor(
    private readonly bus: EventBus,
    private readonly engine: AutomationEngine,
  ) {}

  onModuleInit() {
    for (const eventName of Object.values(EVENTS)) {
      this.bus.on(eventName, HANDLER, (event) => this.engine.run(event));
    }
  }
}
