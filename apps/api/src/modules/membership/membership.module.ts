import { Module } from '@nestjs/common';
import { InvitationsController } from './invitations.controller';
import { InvitationsService } from './invitations.service';
import { PlansController } from './plans.controller';
import { PlansService } from './plans.service';

/**
 * Membership: plans, invitations, and the single path by which a member is
 * created.
 *
 * It became a module when sponsorship needed to send an invitation (docs/45
 * §3). A provider registered on AppModule is not visible to a module AppModule
 * imports, and the alternative — a second copy of InvitationsService in the
 * sponsorship module — would mean two services that both create members, which
 * is precisely the thing the sponsorship contract says not to build.
 */
@Module({
  controllers: [PlansController, InvitationsController],
  providers: [PlansService, InvitationsService],
  exports: [PlansService, InvitationsService],
})
export class MembershipModule {}
