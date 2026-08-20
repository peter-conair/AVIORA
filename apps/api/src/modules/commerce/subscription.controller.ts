import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';
import { PERMISSIONS } from '@aviora/shared';
import {
  CurrentUser,
  RequirePermissions,
  type AuthenticatedUser,
} from '../../common/auth/decorators';
import { CLS_MEMBER_ID } from '../../common/auth/permissions.guard';
import { ZodPipe } from '../../common/validation/zod.pipe';
import type { TeamActor } from '../team/team-scope.service';
import { todayUtc } from './billing';
import { SubscriptionService } from './subscription.service';

const PLATFORM_BYPASS = new Set(['PLATFORM_OWNER', 'SUPER_ADMIN']);

const runDueSchema = z.object({
  asOf: z.coerce.date().optional(),
});

// No entitlement here either: cancelling or pausing something you already pay
// for must not depend on still holding the entitlement that started it, and the
// scheduler is not a member at all.
@Controller('subscriptions')
export class SubscriptionController {
  constructor(
    private readonly subscriptions: SubscriptionService,
    private readonly cls: ClsService,
  ) {}

  private actor(user: AuthenticatedUser): TeamActor {
    return {
      memberId: (this.cls.get(CLS_MEMBER_ID) as string | undefined) ?? null,
      platformBypass: !!user.platformRole && PLATFORM_BYPASS.has(user.platformRole),
    };
  }

  @Get()
  @RequirePermissions(PERMISSIONS.COMMERCE_SUBSCRIPTION_MANAGE)
  async list(@CurrentUser() user: AuthenticatedUser) {
    return { subscriptions: await this.subscriptions.list(this.actor(user)) };
  }

  @Post(':id/pause')
  @RequirePermissions(PERMISSIONS.COMMERCE_SUBSCRIPTION_MANAGE)
  async pause(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return {
      subscription: await this.subscriptions.pause(id, this.actor(user), user.userId),
    };
  }

  @Post(':id/resume')
  @RequirePermissions(PERMISSIONS.COMMERCE_SUBSCRIPTION_MANAGE)
  async resume(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return {
      subscription: await this.subscriptions.resume(id, this.actor(user), user.userId),
    };
  }

  @Post(':id/skip')
  @RequirePermissions(PERMISSIONS.COMMERCE_SUBSCRIPTION_MANAGE)
  async skip(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return { subscription: await this.subscriptions.skip(id, this.actor(user)) };
  }

  @Post(':id/cancel')
  @RequirePermissions(PERMISSIONS.COMMERCE_SUBSCRIPTION_MANAGE)
  async cancel(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return {
      subscription: await this.subscriptions.cancel(id, this.actor(user), user.userId),
    };
  }

  /** Scheduler tick — normally a cron caller, exposed for admins and tests. */
  @Post('run-due')
  @RequirePermissions(PERMISSIONS.COMMERCE_ORDER_MANAGE)
  async runDue(
    @Body(new ZodPipe(runDueSchema)) body: z.infer<typeof runDueSchema>,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return await this.subscriptions.runDue(body.asOf ?? todayUtc(), user.userId);
  }
}
