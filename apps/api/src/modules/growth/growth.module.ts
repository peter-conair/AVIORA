import { Module } from '@nestjs/common';
import { RankController } from './rank.controller';
import { RankService } from './rank.service';
import { ReferralController } from './referral.controller';
import { ReferralService } from './referral.service';

/**
 * Growth layer (docs/25). Referrals and ranks are OPTIONAL: a tenant that runs
 * neither never grants `growth.ranks`, and its members never see any of it.
 *
 * Nothing in this module reads or writes a team table. Spec §17 is mandatory —
 * the operational team tree must not equal the referral tree — so the two
 * graphs are kept apart by construction, not by convention.
 */
@Module({
  controllers: [ReferralController, RankController],
  providers: [ReferralService, RankService],
  // The scheduler's `rank.evaluate` calls the tenant-wide evaluate (docs/35 §3).
  exports: [RankService],
})
export class GrowthModule {}
