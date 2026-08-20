import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';
import { ENTITLEMENTS, ERROR_CODES, PERMISSIONS } from '@aviora/shared';
import {
  CurrentUser,
  RequireEntitlements,
  RequirePermissions,
  type AuthenticatedUser,
} from '../../common/auth/decorators';
import { CLS_MEMBER_ID } from '../../common/auth/permissions.guard';
import { ZodPipe } from '../../common/validation/zod.pipe';
import {
  DEFAULT_REFERRAL_TYPE,
  MAX_REFERRAL_DEPTH,
  REFERRAL_TYPES,
  ReferralService,
} from './referral.service';

const createSchema = z.object({
  referrerMemberId: z.string().uuid(),
  referredMemberId: z.string().uuid(),
  type: z.enum(REFERRAL_TYPES).default(DEFAULT_REFERRAL_TYPE),
  metadata: z.record(z.unknown()).optional(),
});

/**
 * `growth.ranks` gates the MEMBER-facing views only. Administration stays
 * permission-scoped: entitlements are resolved from a member's plan and a
 * tenant owner holds none, so gating `referral.manage` on one would lock an
 * owner out of the graph they configure (docs/24 §2, docs/25 §4).
 */
@Controller('referrals')
export class ReferralController {
  constructor(
    private readonly referrals: ReferralService,
    private readonly cls: ClsService,
  ) {}

  private memberId(): string {
    const id = this.cls.get(CLS_MEMBER_ID) as string | undefined;
    if (!id) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'You are not a member of this tenant',
      });
    }
    return id;
  }

  @Get()
  @RequirePermissions(PERMISSIONS.REFERRAL_MANAGE)
  async list(
    @Query('includeEnded') includeEnded?: string,
    @Query('type') type?: string,
    @Query('limit') limit?: string,
  ) {
    const parsedLimit = Number.parseInt(limit ?? '', 10);
    return {
      referrals: await this.referrals.list({
        includeEnded: includeEnded === 'true',
        relationshipType: type ? referralType(type) : undefined,
        limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
      }),
    };
  }

  @Get('me')
  @RequirePermissions(PERMISSIONS.REFERRAL_VIEW)
  @RequireEntitlements(ENTITLEMENTS.RANKS)
  async me() {
    return await this.referrals.me(this.memberId());
  }

  @Get('downline')
  @RequirePermissions(PERMISSIONS.REFERRAL_VIEW)
  @RequireEntitlements(ENTITLEMENTS.RANKS)
  async downline(@Query('type') type?: string, @Query('maxDepth') maxDepth?: string) {
    const parsed = Number.parseInt(maxDepth ?? '', 10);
    return await this.referrals.downline(
      this.memberId(),
      referralType(type),
      Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), MAX_REFERRAL_DEPTH) : undefined,
    );
  }

  @Post()
  @RequirePermissions(PERMISSIONS.REFERRAL_MANAGE)
  async create(
    @Body(new ZodPipe(createSchema)) body: z.infer<typeof createSchema>,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return {
      referral: await this.referrals.create(
        {
          referrerMemberId: body.referrerMemberId,
          referredMemberId: body.referredMemberId,
          relationshipType: body.type,
          metadata: body.metadata,
        },
        user.userId,
      ),
    };
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.REFERRAL_MANAGE)
  async end(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return { referral: await this.referrals.end(id, user.userId) };
  }
}

function referralType(value?: string): string {
  return REFERRAL_TYPES.includes(value as never) ? (value as string) : DEFAULT_REFERRAL_TYPE;
}
