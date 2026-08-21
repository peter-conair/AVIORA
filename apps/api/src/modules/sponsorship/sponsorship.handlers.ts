import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EVENTS } from '@aviora/shared';
import { EventBus } from '../../common/events/event-bus';
import { SponsorshipService } from './sponsorship.service';

/**
 * Assigns a reserved seat when the employee accepts (docs/45 §2).
 *
 * Driven by the outbox rather than by the invitation service calling into this
 * module: membership creation should not have to know that sponsorship exists,
 * and the `processed_events` ledger already makes the assignment idempotent
 * across retries.
 */
@Injectable()
export class SponsorshipHandlers implements OnModuleInit {
  private readonly logger = new Logger(SponsorshipHandlers.name);

  constructor(
    private readonly bus: EventBus,
    private readonly sponsorship: SponsorshipService,
  ) {}

  onModuleInit(): void {
    this.bus.on(EVENTS.MemberRegistered, 'sponsorship.seat', async (event) => {
      const payload = event.payload as { invitationId?: string; memberId?: string };
      // Most registrations are not sponsored. Nothing to do, and nothing to say.
      if (!payload.invitationId || !payload.memberId || !event.tenantId) return;
      const assigned = await this.sponsorship.assignFromInvitation(
        event.tenantId,
        payload.invitationId,
        payload.memberId,
      );
      if (assigned) {
        this.logger.log(`sponsored seat assigned to member ${payload.memberId}`);
      }
    });
  }
}
