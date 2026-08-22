import { Body, Controller, Get, Put, Query } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';
import { PERMISSIONS } from '@aviora/shared';
import {
  CurrentUser,
  RequirePermissions,
  type AuthenticatedUser,
} from '../../common/auth/decorators';
import { CLS_MEMBER_ID, PLATFORM_BYPASS } from '../../common/auth/permissions.guard';
import { ZodPipe } from '../../common/validation/zod.pipe';
import type { TeamActor } from '../team/team-scope.service';
import { BusinessGoalService } from './business-goal.service';

const text = z.string().max(2000).nullish();
const count = z.number().int().min(0).max(1_000_000).nullish();

const goalSchema = z.object({
  shortTerm: text,
  midTerm: text,
  longTerm: text,
  lifeGoal: text,
  volumeTargetMinor: z.number().int().min(0).nullish(),
  newPartnersTarget: count,
  developCustomersTarget: count,
  developPartnersTarget: count,
  // The manual half (docs/58 §3). Typed, because "5+3" is the business's
  // convention and a number invented here would look measured.
  developCustomersActual: z.number().int().min(0).max(1_000_000).optional(),
  developPartnersActual: z.number().int().min(0).max(1_000_000).optional(),
});

@Controller('goals/business')
export class BusinessGoalController {
  constructor(
    private readonly goals: BusinessGoalService,
    private readonly cls: ClsService,
  ) {}

  private actor(user: AuthenticatedUser): TeamActor {
    return {
      memberId: (this.cls.get(CLS_MEMBER_ID) as string | undefined) ?? null,
      platformBypass: !!user.platformRole && PLATFORM_BYPASS.has(user.platformRole),
    };
  }

  @Get()
  @RequirePermissions(PERMISSIONS.GOAL_VIEW)
  async get(
    @CurrentUser() user: AuthenticatedUser,
    @Query('month') month?: string,
    @Query('memberId') memberId?: string,
  ) {
    return this.goals.get(this.actor(user), month, memberId);
  }

  @Put()
  @RequirePermissions(PERMISSIONS.GOAL_MANAGE)
  async put(
    @Body(new ZodPipe(goalSchema)) body: z.infer<typeof goalSchema>,
    @CurrentUser() user: AuthenticatedUser,
    @Query('month') month?: string,
  ) {
    return { goal: await this.goals.upsert(this.actor(user), month, body) };
  }
}
