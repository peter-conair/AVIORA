import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ERROR_CODES, EVENTS, PERMISSIONS } from '@aviora/shared';
import { appendEvent, type Tx } from '@aviora/db';
import { TenantDb } from '../../common/db/tenant-db.service';
import { TeamScopeService, type TeamActor } from '../team/team-scope.service';

/**
 * Community OS (spec §36). A community is attached to a team, so who may read
 * and post is answered by the team scope that already exists — a community is
 * not a second, parallel permission system.
 */
@Injectable()
export class CommunityService {
  constructor(
    private readonly db: TenantDb,
    private readonly teamScope: TeamScopeService,
  ) {}

  private requireMember(actor: TeamActor): string {
    if (!actor.memberId) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'You are not a member of this tenant',
      });
    }
    return actor.memberId;
  }

  /** Communities the caller may read, via their team scope. */
  list(actor: TeamActor) {
    return this.db.tx(async (tx) => {
      const teams = await this.teamScope.accessibleTeamIds(tx, actor, PERMISSIONS.COMMUNITY_VIEW);
      const communities = await tx.community.findMany({
        where: teams === 'ALL' ? {} : { teamId: { in: [...teams] } },
        orderBy: { createdAt: 'asc' },
        select: { id: true, code: true, name: true, description: true, teamId: true },
      });
      const counts = await tx.post.groupBy({
        by: ['communityId'],
        where: { communityId: { in: communities.map((c) => c.id) }, deletedAt: null },
        _count: true,
      });
      const byId = new Map(counts.map((c) => [c.communityId, c._count]));
      return communities.map((c) => ({ ...c, postCount: byId.get(c.id) ?? 0 }));
    });
  }

  /**
   * Every team gets a private community (spec §36) — created on first access
   * rather than by a migration, so teams made before this feature existed get
   * one too.
   */
  async forTeam(teamId: string, actor: TeamActor) {
    return this.db.tx(async (tx) => {
      const team = await tx.team.findFirst({ where: { id: teamId } });
      if (!team) {
        throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Team not found' });
      }
      await this.assertTeamAccess(tx, actor, teamId, PERMISSIONS.COMMUNITY_VIEW);
      const existing = await tx.community.findFirst({ where: { teamId } });
      if (existing) return existing;
      return tx.community.create({
        data: {
          tenantId: this.db.tenantId,
          teamId,
          code: `team-${team.code}`,
          name: team.name,
          visibility: 'team',
        },
      });
    });
  }

  async feed(communityId: string, actor: TeamActor) {
    return this.db.tx(async (tx) => {
      const community = await this.loadReadable(tx, communityId, actor);
      const posts = await tx.post.findMany({
        where: { communityId: community.id, deletedAt: null },
        orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
        take: 50,
        select: {
          id: true,
          body: true,
          kind: true,
          pinned: true,
          authorMemberId: true,
          createdAt: true,
          comments: {
            where: { deletedAt: null },
            orderBy: { createdAt: 'asc' },
            select: { id: true, body: true, authorMemberId: true, createdAt: true },
          },
          reactions: { select: { memberId: true, kind: true } },
        },
      });
      const authorIds = [
        ...new Set([
          ...posts.map((p) => p.authorMemberId),
          ...posts.flatMap((p) => p.comments.map((c) => c.authorMemberId)),
        ]),
      ];
      const members = await tx.member.findMany({
        where: { id: { in: authorIds } },
        select: { id: true, displayName: true },
      });
      const nameById = new Map(members.map((m) => [m.id, m.displayName]));
      const me = actor.memberId;
      return {
        community: { id: community.id, name: community.name, teamId: community.teamId },
        posts: posts.map((p) => ({
          id: p.id,
          body: p.body,
          kind: p.kind,
          pinned: p.pinned,
          createdAt: p.createdAt,
          author: { id: p.authorMemberId, displayName: nameById.get(p.authorMemberId) ?? null },
          reactionCount: p.reactions.length,
          reactedByMe: !!me && p.reactions.some((r) => r.memberId === me),
          comments: p.comments.map((c) => ({
            id: c.id,
            body: c.body,
            createdAt: c.createdAt,
            author: { id: c.authorMemberId, displayName: nameById.get(c.authorMemberId) ?? null },
          })),
        })),
      };
    });
  }

  async post(communityId: string, body: string, actor: TeamActor, actorUserId: string) {
    const memberId = this.requireMember(actor);
    return this.db.tx(async (tx) => {
      const community = await this.loadReadable(tx, communityId, actor, PERMISSIONS.COMMUNITY_POST);
      const created = await tx.post.create({
        data: {
          tenantId: this.db.tenantId,
          communityId: community.id,
          authorMemberId: memberId,
          body,
        },
      });
      await appendEvent(tx, {
        eventName: EVENTS.PostPublished,
        tenantId: this.db.tenantId,
        aggregateType: 'post',
        aggregateId: created.id,
        actorUserId,
        payload: { communityId: community.id, memberId },
      });
      return created;
    });
  }

  async comment(postId: string, body: string, actor: TeamActor) {
    const memberId = this.requireMember(actor);
    return this.db.tx(async (tx) => {
      const post = await tx.post.findFirst({ where: { id: postId, deletedAt: null } });
      if (!post) {
        throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Post not found' });
      }
      await this.loadReadable(tx, post.communityId, actor, PERMISSIONS.COMMUNITY_POST);
      return tx.comment.create({
        data: { tenantId: this.db.tenantId, postId, authorMemberId: memberId, body },
      });
    });
  }

  /** Reacting twice is the same as reacting once. */
  async react(postId: string, kind: string, actor: TeamActor) {
    const memberId = this.requireMember(actor);
    return this.db.tx(async (tx) => {
      const post = await tx.post.findFirst({ where: { id: postId, deletedAt: null } });
      if (!post) {
        throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Post not found' });
      }
      await this.loadReadable(tx, post.communityId, actor);
      const existing = await tx.reaction.findFirst({ where: { postId, memberId, kind } });
      if (existing) return { reacted: true };
      await tx.reaction.create({
        data: { tenantId: this.db.tenantId, postId, memberId, kind },
      });
      return { reacted: true };
    });
  }

  async unreact(postId: string, kind: string, actor: TeamActor) {
    const memberId = this.requireMember(actor);
    return this.db.tx(async (tx) => {
      await tx.reaction.deleteMany({ where: { postId, memberId, kind } });
      return { reacted: false };
    });
  }

  /** Authors remove their own posts; moderators remove any in their team. */
  async removePost(postId: string, actor: TeamActor) {
    const memberId = this.requireMember(actor);
    return this.db.tx(async (tx) => {
      const post = await tx.post.findFirst({ where: { id: postId, deletedAt: null } });
      if (!post) {
        throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Post not found' });
      }
      if (post.authorMemberId !== memberId) {
        const community = await tx.community.findFirst({ where: { id: post.communityId } });
        if (!community?.teamId) {
          throw new ForbiddenException({
            code: ERROR_CODES.FORBIDDEN,
            message: 'Only the author can remove this post',
          });
        }
        await this.assertTeamAccess(
          tx,
          actor,
          community.teamId,
          PERMISSIONS.COMMUNITY_MODERATE,
          'Only the author or a moderator can remove this post',
        );
      }
      // history is preserved: posts are withdrawn, not erased
      return tx.post.update({ where: { id: postId }, data: { deletedAt: new Date() } });
    });
  }

  private async loadReadable(
    tx: Tx,
    communityId: string,
    actor: TeamActor,
    permKey: string = PERMISSIONS.COMMUNITY_VIEW,
  ) {
    const community = await tx.community.findFirst({ where: { id: communityId } });
    if (!community) {
      throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Community not found' });
    }
    if (community.teamId) {
      await this.assertTeamAccess(tx, actor, community.teamId, permKey);
    }
    return community;
  }

  private async assertTeamAccess(
    tx: Tx,
    actor: TeamActor,
    teamId: string,
    permKey: string,
    message = 'This community is outside your teams',
  ) {
    const allowed = await this.teamScope.accessibleTeamIds(tx, actor, permKey);
    if (!this.teamScope.canAccess(allowed, teamId)) {
      throw new ForbiddenException({ code: ERROR_CODES.FORBIDDEN, message });
    }
  }
}

/** Re-exported for the controller's error mapping. */
export const COMMUNITY_CONFLICT = ConflictException;
