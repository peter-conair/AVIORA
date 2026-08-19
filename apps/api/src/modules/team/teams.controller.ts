import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
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
import { TeamsService } from './teams.service';
import type { TeamActor } from './team-scope.service';

const PLATFORM_BYPASS = new Set(['PLATFORM_OWNER', 'SUPER_ADMIN']);

const createSchema = z.object({
  code: z.string().regex(/^[a-z0-9-]{2,40}$/),
  name: z.string().min(1).max(160),
  description: z.string().max(2000).optional(),
  parentTeamId: z.string().uuid().optional(),
});

const leaderSchema = z.object({
  memberId: z.string().uuid(),
  leadershipRole: z.enum(['PRIMARY_LEADER', 'CO_LEADER', 'MANAGER', 'COACH', 'MENTOR']).optional(),
});

const joinSchema = z.object({ memberId: z.string().uuid() });

const moveSchema = z.object({ newParentId: z.string().uuid().nullable() });

@Controller('teams')
export class TeamsController {
  constructor(
    private readonly teams: TeamsService,
    private readonly cls: ClsService,
  ) {}

  private actor(user: AuthenticatedUser): TeamActor {
    return {
      memberId: (this.cls.get(CLS_MEMBER_ID) as string | undefined) ?? null,
      platformBypass: !!user.platformRole && PLATFORM_BYPASS.has(user.platformRole),
    };
  }

  @Get()
  @RequirePermissions(PERMISSIONS.TEAM_VIEW)
  async list(@CurrentUser() user: AuthenticatedUser) {
    return { teams: await this.teams.list(this.actor(user)) };
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.TEAM_VIEW)
  async get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return { team: await this.teams.get(id, this.actor(user)) };
  }

  @Get(':id/descendants')
  @RequirePermissions(PERMISSIONS.TEAM_VIEW)
  async descendants(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return { teams: await this.teams.descendants(id, this.actor(user)) };
  }

  @Get(':id/members')
  @RequirePermissions(PERMISSIONS.TEAM_MEMBER_VIEW)
  async members(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return { members: await this.teams.members(id, this.actor(user)) };
  }

  @Get(':id/dashboard')
  @RequirePermissions(PERMISSIONS.TEAM_ANALYTICS_VIEW)
  async dashboard(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return await this.teams.dashboard(id, this.actor(user));
  }

  @Get(':id/leadership-history')
  @RequirePermissions(PERMISSIONS.TEAM_VIEW)
  async leadershipHistory(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return { leaderships: await this.teams.leadershipHistory(id, this.actor(user)) };
  }

  @Post()
  @RequirePermissions(PERMISSIONS.TEAM_CREATE)
  async create(
    @Body(new ZodPipe(createSchema)) body: z.infer<typeof createSchema>,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return { team: await this.teams.create(body, user.userId) };
  }

  @Patch(':id/move')
  @RequirePermissions(PERMISSIONS.TEAM_MANAGE)
  async move(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(moveSchema)) body: z.infer<typeof moveSchema>,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return { team: await this.teams.move(id, body.newParentId, user.userId, this.actor(user)) };
  }

  @Post(':id/leaders')
  @RequirePermissions(PERMISSIONS.TEAM_LEADER_ASSIGN)
  async assignLeader(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(leaderSchema)) body: z.infer<typeof leaderSchema>,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return { leadership: await this.teams.assignLeader(id, body, user.userId) };
  }

  @Post(':id/members')
  @RequirePermissions(PERMISSIONS.TEAM_MEMBER_MANAGE)
  async join(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(joinSchema)) body: z.infer<typeof joinSchema>,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return {
      membership: await this.teams.join(id, body.memberId, user.userId, this.actor(user)),
    };
  }
}
