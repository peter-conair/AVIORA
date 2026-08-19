import { Body, Controller, ForbiddenException, Get, Post } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';
import { ERROR_CODES, PERMISSIONS } from '@aviora/shared';
import { RequirePermissions } from '../../common/auth/decorators';
import { CLS_MEMBER_ID } from '../../common/auth/permissions.guard';
import { ZodPipe } from '../../common/validation/zod.pipe';
import { GamificationService } from './gamification.service';

const ruleSchema = z.object({
  eventName: z.string().min(1).max(80),
  points: z.number().int().min(0).max(10_000),
  badgeCode: z
    .string()
    .regex(/^[a-z0-9-]{2,40}$/)
    .optional(),
  badgeName: z.string().max(80).optional(),
});

@Controller('gamification')
export class GamificationController {
  constructor(
    private readonly gamification: GamificationService,
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

  @Get('me')
  @RequirePermissions(PERMISSIONS.CHALLENGE_VIEW)
  async standing() {
    return await this.gamification.standing(this.memberId());
  }

  @Get('leaderboard')
  @RequirePermissions(PERMISSIONS.CHALLENGE_VIEW)
  async leaderboard() {
    return { leaderboard: await this.gamification.leaderboard() };
  }

  @Get('rules')
  @RequirePermissions(PERMISSIONS.GAMIFICATION_MANAGE)
  async rules() {
    return { rules: await this.gamification.rules() };
  }

  @Post('rules')
  @RequirePermissions(PERMISSIONS.GAMIFICATION_MANAGE)
  async setRule(@Body(new ZodPipe(ruleSchema)) body: z.infer<typeof ruleSchema>) {
    return { rule: await this.gamification.setRule(body) };
  }
}
