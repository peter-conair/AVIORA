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
import { OrderService } from './order.service';

const PLATFORM_BYPASS = new Set(['PLATFORM_OWNER', 'SUPER_ADMIN']);

const paymentSchema = z.object({
  provider: z
    .string()
    .regex(/^[a-z0-9_-]{2,40}$/)
    .default('manual'),
  amountMinor: z.number().int().positive().max(1_000_000_000),
  providerRef: z.string().max(200).optional(),
});

// No entitlement here: a member whose plan changes must still be able to read
// what they already bought, and recording payments is an administrator's job.
@Controller('orders')
export class OrderController {
  constructor(
    private readonly orders: OrderService,
    private readonly cls: ClsService,
  ) {}

  private actor(user: AuthenticatedUser): TeamActor {
    return {
      memberId: (this.cls.get(CLS_MEMBER_ID) as string | undefined) ?? null,
      platformBypass: !!user.platformRole && PLATFORM_BYPASS.has(user.platformRole),
    };
  }

  @Get()
  @RequirePermissions(PERMISSIONS.COMMERCE_ORDER_VIEW)
  async list(@CurrentUser() user: AuthenticatedUser) {
    return { orders: await this.orders.list(this.actor(user)) };
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.COMMERCE_ORDER_VIEW)
  async get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return { order: await this.orders.get(id, this.actor(user)) };
  }

  @Post(':id/payments')
  @RequirePermissions(PERMISSIONS.COMMERCE_ORDER_MANAGE)
  async recordPayment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(paymentSchema)) body: z.infer<typeof paymentSchema>,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const { payment, order } = await this.orders.recordPayment(
      id,
      this.actor(user),
      body,
      user.userId,
    );
    return { payment, order };
  }

  @Post(':id/cancel')
  @RequirePermissions(PERMISSIONS.COMMERCE_ORDER_MANAGE)
  async cancel(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return { order: await this.orders.cancel(id, this.actor(user)) };
  }
}
