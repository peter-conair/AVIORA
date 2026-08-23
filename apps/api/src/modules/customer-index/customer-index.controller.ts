import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
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
import { RateTier } from '../../common/rate/rate-tier.guard';
import type { TeamActor } from '../team/team-scope.service';
import { CustomerIndexService } from './customer-index.service';

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullish();

const cardSchema = z.object({
  externalCode: z.string().max(60).nullish(),
  membershipExpiresAt: date,
  birthDate: date,
  idNumber: z.string().max(40).nullish(),
  note: z.string().max(4000).nullish(),
});

const monthSchema = z.object({
  year: z.number().int().min(2000).max(2200),
  month: z.number().int().min(1).max(12),
  ordered: z.boolean(),
});

@Controller('crm/customers/:id')
export class CustomerIndexController {
  constructor(
    private readonly index: CustomerIndexService,
    private readonly cls: ClsService,
  ) {}

  private actor(user: AuthenticatedUser): TeamActor {
    return {
      memberId: (this.cls.get(CLS_MEMBER_ID) as string | undefined) ?? null,
      platformBypass: !!user.platformRole && PLATFORM_BYPASS.has(user.platformRole),
    };
  }

  @Get('card')
  @RequirePermissions(PERMISSIONS.CRM_CUSTOMER_VIEW)
  async card(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query('year') year?: string,
  ) {
    const parsed = Number(year);
    const resolved =
      Number.isInteger(parsed) && parsed >= 2000 && parsed <= 2200
        ? parsed
        : new Date().getUTCFullYear();
    return this.index.card(this.actor(user), id, resolved);
  }

  @Put('card')
  @RequirePermissions(PERMISSIONS.CRM_CUSTOMER_MANAGE)
  async save(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(cardSchema)) body: z.infer<typeof cardSchema>,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return { customer: await this.index.saveCard(this.actor(user), id, body) };
  }

  /**
   * POST, not GET: reading an identity number is an act, it is audited, and a
   * GET invites a browser or a proxy to repeat it without anybody asking.
   */
  @Post('id-number')
  @RequirePermissions(PERMISSIONS.CRM_CUSTOMER_MANAGE)
  @RateTier('expensive')
  async reveal(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.index.revealIdNumber(this.actor(user), id);
  }

  @Put('months')
  @RequirePermissions(PERMISSIONS.CRM_CUSTOMER_MANAGE)
  async setMonth(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(monthSchema)) body: z.infer<typeof monthSchema>,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.index.setMonth(this.actor(user), id, body.year, body.month, body.ordered);
  }
}
