import { Injectable, OnModuleInit } from '@nestjs/common';
import { EVENTS } from '@aviora/shared';
import { EventBus } from '../../common/events/event-bus';
import { PartnerService } from './partner.service';

/**
 * Attributes a referral when a partner's invitation is accepted (docs/46 §2).
 *
 * The tenant comes from the EVENT: a handler runs on the relay's clock, where
 * there is no tenant in CLS for a request-scoped helper to read.
 */
@Injectable()
export class PartnerHandlers implements OnModuleInit {
  constructor(
    private readonly bus: EventBus,
    private readonly partners: PartnerService,
  ) {}

  onModuleInit(): void {
    this.bus.on(EVENTS.MemberRegistered, 'partner.referral', async (event) => {
      const payload = event.payload as { invitationId?: string; memberId?: string };
      // Most registrations came from nobody's partner. Nothing to do.
      if (!payload.invitationId || !payload.memberId || !event.tenantId) return;
      await this.partners.attribute(event.tenantId, payload.invitationId, payload.memberId);
    });
  }
}
