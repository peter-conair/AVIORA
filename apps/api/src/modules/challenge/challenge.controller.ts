import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
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
import { CHALLENGE_SOURCES, ChallengeService } from './challenge.service';

const PLATFORM_BYPASS = new Set(['PLATFORM_OWNER', 'SUPER_ADMIN']);

const createSchema = z.object({
  code: z.string().regex(/^[a-z0-9-]{2,40}$/),
  name: z.string().min(1).max(160),
  description: z.string().max(2000).optional(),
  source: z.enum(CHALLENGE_SOURCES),
  sourceRef: z.string().max(80).optional(),
  targetValue: z.number().int().positive().max(10_000),
  startsOn: z.coerce.date(),
  endsOn: z.coerce.date(),
  communityId: z.string().uuid().optional(),
});

@Controller('challenges')
export class ChallengeController {
  constructor(
    private readonly challenges: ChallengeService,
    private readonly cls: ClsService,
  ) {}

  private actor(user: AuthenticatedUser): TeamActor {
    return {
      memberId: (this.cls.get(CLS_MEMBER_ID) as string | undefined) ?? null,
      platformBypass: !!user.platformRole && PLATFORM_BYPASS.has(user.platformRole),
    };
  }

  @Get()
  @RequirePermissions(PERMISSIONS.CHALLENGE_VIEW)
  async list(@CurrentUser() user: AuthenticatedUser) {
    return { challenges: await this.challenges.list(this.actor(user)) };
  }

  @Post()
  @RequirePermissions(PERMISSIONS.CHALLENGE_MANAGE)
  async create(@Body(new ZodPipe(createSchema)) body: z.infer<typeof createSchema>) {
    return { challenge: await this.challenges.create(body) };
  }

  @Get(':id/leaderboard')
  @RequirePermissions(PERMISSIONS.CHALLENGE_VIEW)
  async leaderboard(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return await this.challenges.leaderboard(id, this.actor(user));
  }

  @Post(':id/join')
  @RequirePermissions(PERMISSIONS.CHALLENGE_JOIN)
  async join(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return {
      participant: await this.challenges.join(id, this.actor(user), user.userId),
    };
  }

  @Delete(':id/join')
  @RequirePermissions(PERMISSIONS.CHALLENGE_JOIN)
  async leave(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return { participant: await this.challenges.leave(id, this.actor(user)) };
  }

  /** Recompute completions — normally a scheduled job; exposed for admins. */
  @Post(':id/settle')
  @RequirePermissions(PERMISSIONS.CHALLENGE_MANAGE)
  async settle(@Param('id', ParseUUIDPipe) id: string) {
    return { completed: await this.challenges.settle(id) };
  }
}
