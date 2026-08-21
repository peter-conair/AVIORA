import { Global, Module } from '@nestjs/common';
import { EventBus } from './event-bus';

/**
 * The event bus, as one instance for the whole process.
 *
 * `@Global` rather than an import every module repeats, and the reason matters:
 * EventBus holds the HANDLER REGISTRY. A second instance would accept
 * `on()` registrations that the relay's `dispatch()` never reaches — handlers
 * that look wired, run in no test, and silently never fire in production.
 * Duplicating this provider is not a style question.
 */
@Global()
@Module({
  providers: [EventBus],
  exports: [EventBus],
})
export class EventsModule {}
