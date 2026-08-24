import { Body, Controller, Get, Put, Query } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';
import { CurrentUser, type AuthenticatedUser } from '../../common/auth/decorators';
import { CLS_MEMBER_ID, PLATFORM_BYPASS } from '../../common/auth/permissions.guard';
import { ZodPipe } from '../../common/validation/zod.pipe';
import type { TeamActor } from '../team/team-scope.service';
import { PlanService } from './plan.service';

const percent = z.number().int().min(1).max(100).nullish();

const assumptionsSchema = z.object({
  assumedOrderValueMinor: z.number().int().min(1).max(100_000_000).nullish(),
  assumedContactRate: percent,
  assumedConversionRate: percent,
});

/**
 * A member's own plan. Like the start path, no permission beyond membership:
 * the screen that says what to do today should not be the one behind a grant.
 */
@Controller('plan')
export class PlanController {
  constructor(
    private readonly plan: PlanService,
    private readonly cls: ClsService,
  ) {}

  private actor(user: AuthenticatedUser): TeamActor {
    return {
      memberId: (this.cls.get(CLS_MEMBER_ID) as string | undefined) ?? null,
      platformBypass: !!user.platformRole && PLATFORM_BYPASS.has(user.platformRole),
    };
  }

  @Get()
  async mine(@CurrentUser() user: AuthenticatedUser, @Query('month') month?: string) {
    return this.plan.forMember(this.actor(user), month);
  }

  @Put('assumptions')
  async assumptions(
    @Body(new ZodPipe(assumptionsSchema)) body: z.infer<typeof assumptionsSchema>,
    @CurrentUser() user: AuthenticatedUser,
    @Query('month') month?: string,
  ) {
    return { goal: await this.plan.setAssumptions(this.actor(user), month, body) };
  }
}
