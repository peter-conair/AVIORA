import { Module } from '@nestjs/common';
import { PlacementController } from './placement.controller';
import { PlacementService } from './placement.service';
import { PlanController } from './plan.controller';
import { PlanService } from './plan.service';
import { RunController } from './run.controller';
import { RunService } from './run.service';

/**
 * Compensation OS (docs/26). Spec §42: compensation must be OPTIONAL and
 * tenant configurable, never one hard-coded network plan — so the eleven
 * bonuses of spec §43 are rows in `compensation_rules`, and a tenant that runs
 * none simply has no plan and never grants `growth.compensation`.
 *
 * The placement graph is the THIRD graph (spec §17). Nothing here reads
 * `team_closure` or `referral_relationships`: a member may be referred by one
 * person and paid under another, which is the normal case in a plan with
 * placement, and the only durable guarantee is that neither graph can read the
 * other.
 */
@Module({
  controllers: [PlacementController, PlanController, RunController],
  providers: [PlacementService, PlanService, RunService],
  // The scheduler's `commission.draft` calls `create`, which drafts and stops
  // — approval is not exported and not reachable from a timer (docs/35 §3).
  exports: [RunService],
})
export class CompensationModule {}
