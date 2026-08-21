import { Module } from '@nestjs/common';
import { MembershipModule } from '../membership/membership.module';
import { SponsorshipController } from './sponsorship.controller';
import { SponsorshipHandlers } from './sponsorship.handlers';
import { SponsorshipService } from './sponsorship.service';

/**
 * Corporate wellness (docs/45). It imports membership rather than creating
 * members itself: a second acceptance path would be a second place a membership
 * is created, and the two would disagree about what a new member gets.
 */
@Module({
  imports: [MembershipModule],
  controllers: [SponsorshipController],
  providers: [SponsorshipService, SponsorshipHandlers],
  exports: [SponsorshipService],
})
export class SponsorshipModule {}
