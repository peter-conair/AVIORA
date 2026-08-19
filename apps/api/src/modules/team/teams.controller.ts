import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { z } from 'zod';
import { PERMISSIONS } from '@aviora/shared';
import {
  CurrentUser,
  RequirePermissions,
  type AuthenticatedUser,
} from '../../common/auth/decorators';
import { ZodPipe } from '../../common/validation/zod.pipe';
import { TeamsService } from './teams.service';

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

@Controller('teams')
export class TeamsController {
  constructor(private readonly teams: TeamsService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.TEAM_VIEW)
  async list() {
    return { teams: await this.teams.list() };
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.TEAM_VIEW)
  async get(@Param('id', ParseUUIDPipe) id: string) {
    return { team: await this.teams.get(id) };
  }

  @Get(':id/members')
  @RequirePermissions(PERMISSIONS.TEAM_MEMBER_VIEW)
  async members(@Param('id', ParseUUIDPipe) id: string) {
    return { members: await this.teams.members(id) };
  }

  @Post()
  @RequirePermissions(PERMISSIONS.TEAM_CREATE)
  async create(
    @Body(new ZodPipe(createSchema)) body: z.infer<typeof createSchema>,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return { team: await this.teams.create(body, user.userId) };
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
    return { membership: await this.teams.join(id, body.memberId, user.userId) };
  }
}
