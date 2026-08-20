import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';
import { ERROR_CODES, PERMISSIONS } from '@aviora/shared';
import {
  CurrentUser,
  RequirePermissions,
  type AuthenticatedUser,
} from '../../common/auth/decorators';
import { CLS_MEMBER_ID } from '../../common/auth/permissions.guard';
import { TenantDb } from '../../common/db/tenant-db.service';
import { ZodPipe } from '../../common/validation/zod.pipe';
import { RewardService } from './reward.service';
import { REWARD_TYPES } from './rewards';

const definitionSchema = z.object({
  code: z.string().regex(/^[a-z0-9-]{2,40}$/),
  name: z.string().min(1).max(160),
  type: z.enum(REWARD_TYPES),
  config: z.record(z.unknown()).optional(),
  status: z.enum(['active', 'archived']).optional(),
});

const grantSchema = z.object({
  rewardCode: z.string().regex(/^[a-z0-9-]{2,40}$/),
  memberId: z.string().uuid(),
});

/**
 * Rewards are configuration and recognition, so management is permission-scoped
 * and nothing here is entitlement-gated (docs/27 §4): a member sees what they
 * were given, an owner decides what there is to give.
 */
@Controller('rewards')
export class RewardController {
  constructor(
    private readonly rewards: RewardService,
    private readonly db: TenantDb,
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

  @Get('definitions')
  @RequirePermissions(PERMISSIONS.REWARD_MANAGE)
  async listDefinitions() {
    return { definitions: await this.rewards.listDefinitions() };
  }

  @Post('definitions')
  @RequirePermissions(PERMISSIONS.REWARD_MANAGE)
  async createDefinition(
    @Body(new ZodPipe(definitionSchema)) body: z.infer<typeof definitionSchema>,
  ) {
    return { definition: await this.rewards.createDefinition(body) };
  }

  @Post('grants')
  @RequirePermissions(PERMISSIONS.REWARD_MANAGE)
  async grant(
    @Body(new ZodPipe(grantSchema)) body: z.infer<typeof grantSchema>,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return {
      grant: await this.rewards.grant({
        tenantId: this.db.tenantId,
        rewardCode: body.rewardCode,
        memberId: body.memberId,
        sourceType: 'manual',
        sourceRef: user.userId,
        actorUserId: user.userId,
      }),
    };
  }

  /** Revokes; the row stays (docs/27 §5). */
  @Delete('grants/:id')
  @RequirePermissions(PERMISSIONS.REWARD_MANAGE)
  async revoke(@Param('id', ParseUUIDPipe) id: string) {
    return { grant: await this.rewards.revoke(id) };
  }

  @Get('me')
  @RequirePermissions(PERMISSIONS.REWARD_VIEW)
  async mine() {
    return { grants: await this.rewards.mine(this.memberId()) };
  }
}
