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
import { CommunityService } from './community.service';

const PLATFORM_BYPASS = new Set(['PLATFORM_OWNER', 'SUPER_ADMIN']);
const bodySchema = z.object({ body: z.string().min(1).max(4000) });
const reactionSchema = z.object({ kind: z.enum(['like', 'celebrate', 'support']).optional() });

@Controller('community')
export class CommunityController {
  constructor(
    private readonly community: CommunityService,
    private readonly cls: ClsService,
  ) {}

  private actor(user: AuthenticatedUser): TeamActor {
    return {
      memberId: (this.cls.get(CLS_MEMBER_ID) as string | undefined) ?? null,
      platformBypass: !!user.platformRole && PLATFORM_BYPASS.has(user.platformRole),
    };
  }

  @Get()
  @RequirePermissions(PERMISSIONS.COMMUNITY_VIEW)
  async list(@CurrentUser() user: AuthenticatedUser) {
    return { communities: await this.community.list(this.actor(user)) };
  }

  @Get('teams/:teamId')
  @RequirePermissions(PERMISSIONS.COMMUNITY_VIEW)
  async forTeam(
    @Param('teamId', ParseUUIDPipe) teamId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return { community: await this.community.forTeam(teamId, this.actor(user)) };
  }

  @Get(':id/feed')
  @RequirePermissions(PERMISSIONS.COMMUNITY_VIEW)
  async feed(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return await this.community.feed(id, this.actor(user));
  }

  @Post(':id/posts')
  @RequirePermissions(PERMISSIONS.COMMUNITY_POST)
  async post(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(bodySchema)) body: z.infer<typeof bodySchema>,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return { post: await this.community.post(id, body.body, this.actor(user), user.userId) };
  }

  @Post('posts/:postId/comments')
  @RequirePermissions(PERMISSIONS.COMMUNITY_POST)
  async comment(
    @Param('postId', ParseUUIDPipe) postId: string,
    @Body(new ZodPipe(bodySchema)) body: z.infer<typeof bodySchema>,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return { comment: await this.community.comment(postId, body.body, this.actor(user)) };
  }

  @Post('posts/:postId/reactions')
  @RequirePermissions(PERMISSIONS.COMMUNITY_VIEW)
  async react(
    @Param('postId', ParseUUIDPipe) postId: string,
    @Body(new ZodPipe(reactionSchema)) body: z.infer<typeof reactionSchema>,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return await this.community.react(postId, body.kind ?? 'like', this.actor(user));
  }

  @Delete('posts/:postId/reactions')
  @RequirePermissions(PERMISSIONS.COMMUNITY_VIEW)
  async unreact(
    @Param('postId', ParseUUIDPipe) postId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return await this.community.unreact(postId, 'like', this.actor(user));
  }

  @Delete('posts/:postId')
  @RequirePermissions(PERMISSIONS.COMMUNITY_VIEW)
  async removePost(
    @Param('postId', ParseUUIDPipe) postId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.community.removePost(postId, this.actor(user));
    return { removed: true };
  }
}
