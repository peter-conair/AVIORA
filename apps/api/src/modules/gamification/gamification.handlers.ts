import { Injectable, OnModuleInit } from '@nestjs/common';
import { EVENTS } from '@aviora/shared';
import { EventBus } from '../../common/events/event-bus';
import { GamificationService } from './gamification.service';

/** Events that can earn points, and where the earning member is in the payload. */
const EARNING_EVENTS: Array<{ event: string; memberKey: string }> = [
  { event: EVENTS.HabitLogged, memberKey: 'memberId' },
  { event: EVENTS.GoalCompleted, memberKey: 'memberId' },
  { event: EVENTS.CourseCompleted, memberKey: 'memberId' },
  { event: EVENTS.ChallengeCompleted, memberKey: 'memberId' },
  { event: EVENTS.MemberJoinedTeam, memberKey: 'memberId' },
  { event: EVENTS.CustomerConverted, memberKey: 'ownerMemberId' },
  { event: EVENTS.PostPublished, memberKey: 'memberId' },
];

/**
 * Points are awarded from the outbox, like every other reaction in the
 * platform: the domain that emitted the event knows nothing about scoring, and
 * a tenant with no rules configured simply earns nothing.
 */
@Injectable()
export class GamificationHandlers implements OnModuleInit {
  constructor(
    private readonly bus: EventBus,
    private readonly gamification: GamificationService,
  ) {}

  onModuleInit() {
    for (const { event, memberKey } of EARNING_EVENTS) {
      this.bus.on(event, `points.${event}`, async (envelope) => {
        if (!envelope.tenantId) return;
        const payload = envelope.payload as Record<string, unknown>;
        const memberId = payload[memberKey];
        if (typeof memberId !== 'string') return;
        await this.gamification.award({
          tenantId: envelope.tenantId,
          memberId,
          eventName: event,
          // the event id makes the award idempotent across retries
          referenceId: envelope.eventId,
        });
      });
    }
  }
}
