import { Module } from '@nestjs/common';
import { MembershipModule } from '../membership/membership.module';
import { PartnerAdminController, PartnerPortalController } from './partner.controller';
import { PartnerHandlers } from './partner.handlers';
import { PartnerService } from './partner.service';

/**
 * The partner portal (docs/46). Imports membership because a partner invites
 * through the one invitation path that exists — a second way to create a member
 * would be a second answer to what a new member gets.
 */
@Module({
  imports: [MembershipModule],
  controllers: [PartnerAdminController, PartnerPortalController],
  providers: [PartnerService, PartnerHandlers],
  exports: [PartnerService],
})
export class PartnerModule {}
