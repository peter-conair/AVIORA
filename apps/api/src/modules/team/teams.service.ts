import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ERROR_CODES, EVENTS, PERMISSIONS } from '@aviora/shared';
import { appendEvent, type Tx } from '@aviora/db';
import { TenantDb } from '../../common/db/tenant-db.service';
import { AuditService } from '../../common/audit/audit.service';
import { TeamScopeService, type TeamActor } from './team-scope.service';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

@Injectable()
export class TeamsService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly scope: TeamScopeService,
  ) {}

  private async assertScope(tx: Tx, actor: TeamActor, permKey: string, teamId: string) {
    const allowed = await this.scope.accessibleTeamIds(tx, actor, permKey);
    if (!this.scope.canAccess(allowed, teamId)) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'This team is outside your authorized scope',
      });
    }
  }

  async create(
    input: { code: string; name: string; description?: string; parentTeamId?: string },
    actorUserId: string,
  ) {
    const team = await this.db.tx(async (tx) => {
      if (input.parentTeamId) {
        const parent = await tx.team.findFirst({ where: { id: input.parentTeamId } });
        if (!parent) {
          throw new NotFoundException({
            code: ERROR_CODES.NOT_FOUND,
            message: 'Parent team not found',
          });
        }
      }
      const dup = await tx.team.findFirst({ where: { code: input.code } });
      if (dup) {
        throw new ConflictException({
          code: ERROR_CODES.CONFLICT,
          message: 'Team code already in use',
        });
      }
      const created = await tx.team.create({
        data: {
          tenantId: this.db.tenantId,
          code: input.code,
          name: input.name,
          description: input.description,
          parentTeamId: input.parentTeamId ?? null,
        },
      });
      // closure: self row + one row per ancestor of the parent (docs/05 §3)
      await tx.teamClosure.create({
        data: {
          tenantId: this.db.tenantId,
          ancestorTeamId: created.id,
          descendantTeamId: created.id,
          depth: 0,
        },
      });
      if (input.parentTeamId) {
        await tx.$executeRaw`
          INSERT INTO team_closure (tenant_id, ancestor_team_id, descendant_team_id, depth)
          SELECT tenant_id, ancestor_team_id, ${created.id}::uuid, depth + 1
          FROM team_closure
          WHERE descendant_team_id = ${input.parentTeamId}::uuid`;
      }
      await appendEvent(tx, {
        eventName: EVENTS.TeamCreated,
        tenantId: this.db.tenantId,
        aggregateType: 'team',
        aggregateId: created.id,
        actorUserId,
        payload: { code: created.code, name: created.name, parentTeamId: created.parentTeamId },
      });
      return created;
    });
    await this.audit.record({
      action: 'team.create',
      entityType: 'team',
      entityId: team.id,
      after: { code: team.code, name: team.name, parentTeamId: team.parentTeamId },
    });
    return team;
  }

  /** Teams visible to the actor under team.view scope. */
  list(actor: TeamActor) {
    return this.db.tx(async (tx) => {
      const allowed = await this.scope.accessibleTeamIds(tx, actor, PERMISSIONS.TEAM_VIEW);
      return tx.team.findMany({
        where: {
          status: 'active',
          ...(allowed === 'ALL' ? {} : { id: { in: [...allowed] } }),
        },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          code: true,
          name: true,
          parentTeamId: true,
          description: true,
          createdAt: true,
        },
      });
    });
  }

  async get(id: string, actor: TeamActor) {
    return this.db.tx(async (tx) => {
      const team = await tx.team.findFirst({
        where: { id },
        include: {
          teamLeaderships: {
            where: { status: 'active' },
            select: { memberId: true, leadershipRole: true, isPrimary: true, effectiveFrom: true },
          },
        },
      });
      if (!team) {
        throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Team not found' });
      }
      await this.assertScope(tx, actor, PERMISSIONS.TEAM_VIEW, id);
      const [children, memberCount] = await Promise.all([
        tx.team.findMany({
          where: { parentTeamId: id, status: 'active' },
          select: { id: true, code: true, name: true },
        }),
        tx.teamMembership.count({ where: { teamId: id, status: 'active' } }),
      ]);
      return { ...team, children, memberCount };
    });
  }

  /** Whole subtree with depth (docs/05 §hierarchy queries). */
  async descendants(id: string, actor: TeamActor) {
    return this.db.tx(async (tx) => {
      await this.assertScope(tx, actor, PERMISSIONS.TEAM_VIEW, id);
      const closure = await tx.teamClosure.findMany({
        where: { ancestorTeamId: id },
        select: { descendantTeamId: true, depth: true },
        orderBy: { depth: 'asc' },
      });
      const teams = await tx.team.findMany({
        where: { id: { in: closure.map((c) => c.descendantTeamId) }, status: 'active' },
        select: { id: true, code: true, name: true, parentTeamId: true },
      });
      const depthByTeam = new Map(closure.map((c) => [c.descendantTeamId, c.depth]));
      return teams
        .map((t) => ({ ...t, depth: depthByTeam.get(t.id) ?? 0 }))
        .sort((a, b) => a.depth - b.depth);
    });
  }

  async members(id: string, actor: TeamActor) {
    return this.db.tx(async (tx) => {
      await this.assertScope(tx, actor, PERMISSIONS.TEAM_MEMBER_VIEW, id);
      const rows = await tx.teamMembership.findMany({
        where: { teamId: id, status: 'active' },
        select: { memberId: true, membershipType: true, joinedAt: true },
        orderBy: { joinedAt: 'asc' },
      });
      const members = await tx.member.findMany({
        where: { id: { in: rows.map((r) => r.memberId) } },
        select: { id: true, displayName: true, status: true },
      });
      const byId = new Map(members.map((m) => [m.id, m]));
      return rows.map((r) => ({ ...r, member: byId.get(r.memberId) ?? null }));
    });
  }

  /**
   * Team dashboard (docs/05 §rollup, spec §20): direct metrics vs organization
   * metrics over the whole subtree, members de-duplicated across teams.
   */
  async dashboard(id: string, actor: TeamActor) {
    return this.db.tx(async (tx) => {
      const team = await tx.team.findFirst({
        where: { id },
        select: { id: true, code: true, name: true, parentTeamId: true },
      });
      if (!team) {
        throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Team not found' });
      }
      await this.assertScope(tx, actor, PERMISSIONS.TEAM_ANALYTICS_VIEW, id);

      const closure = await tx.teamClosure.findMany({
        where: { ancestorTeamId: id },
        select: { descendantTeamId: true },
      });
      const subtreeIds = closure.map((c) => c.descendantTeamId);
      const since = new Date(Date.now() - THIRTY_DAYS_MS);

      const metricsFor = async (teamIds: string[]) => {
        const memberships = await tx.teamMembership.findMany({
          where: { teamId: { in: teamIds }, status: 'active' },
          select: { memberId: true, joinedAt: true },
        });
        const memberIds = [...new Set(memberships.map((m) => m.memberId))];
        const newMembers30d = new Set(
          memberships.filter((m) => m.joinedAt >= since).map((m) => m.memberId),
        ).size;
        const [goalsCompleted, coursesCompleted] = await Promise.all([
          memberIds.length
            ? tx.goal.count({ where: { memberId: { in: memberIds }, status: 'completed' } })
            : Promise.resolve(0),
          memberIds.length
            ? tx.learningProgress.count({
                where: { memberId: { in: memberIds }, status: 'completed' },
              })
            : Promise.resolve(0),
        ]);
        return { members: memberIds.length, newMembers30d, goalsCompleted, coursesCompleted };
      };

      const [direct, organization, children] = await Promise.all([
        metricsFor([id]),
        metricsFor(subtreeIds),
        tx.team.findMany({
          where: { parentTeamId: id, status: 'active' },
          select: { id: true, code: true, name: true },
        }),
      ]);

      // per-child organization member counts for drill-down
      const childOrg = await Promise.all(
        children.map(async (c) => {
          const sub = await tx.teamClosure.findMany({
            where: { ancestorTeamId: c.id },
            select: { descendantTeamId: true },
          });
          const rows = await tx.teamMembership.findMany({
            where: { teamId: { in: sub.map((s) => s.descendantTeamId) }, status: 'active' },
            select: { memberId: true },
          });
          return { ...c, organizationMembers: new Set(rows.map((r) => r.memberId)).size };
        }),
      );

      return { team, direct, organization, children: childOrg };
    });
  }

  /**
   * Move a subtree under a new parent (docs/05 §4): cycle-guarded closure
   * rewrite; adjacency stays source of truth; history via audit + event.
   */
  async move(teamId: string, newParentId: string | null, actorUserId: string, actor: TeamActor) {
    const result = await this.db.tx(async (tx) => {
      const team = await tx.team.findFirst({ where: { id: teamId } });
      if (!team) {
        throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Team not found' });
      }
      await this.assertScope(tx, actor, PERMISSIONS.TEAM_MANAGE, teamId);
      if (newParentId) {
        if (newParentId === teamId) {
          throw new BadRequestException({
            code: ERROR_CODES.VALIDATION_FAILED,
            message: 'A team cannot be its own parent',
          });
        }
        const parent = await tx.team.findFirst({ where: { id: newParentId, status: 'active' } });
        if (!parent) {
          throw new NotFoundException({
            code: ERROR_CODES.NOT_FOUND,
            message: 'New parent team not found',
          });
        }
        const wouldCycle = await tx.teamClosure.findFirst({
          where: { ancestorTeamId: teamId, descendantTeamId: newParentId },
        });
        if (wouldCycle) {
          throw new BadRequestException({
            code: ERROR_CODES.VALIDATION_FAILED,
            message: 'Cannot move a team under its own descendant',
          });
        }
      }
      if (team.parentTeamId === newParentId) return { team, moved: false };

      // 1) unlink: remove paths from OUTSIDE-ancestors into the subtree
      await tx.$executeRaw`
        DELETE FROM team_closure
        WHERE descendant_team_id IN (
                SELECT descendant_team_id FROM team_closure
                WHERE ancestor_team_id = ${teamId}::uuid)
          AND ancestor_team_id NOT IN (
                SELECT descendant_team_id FROM team_closure
                WHERE ancestor_team_id = ${teamId}::uuid)`;
      // 2) relink under the new parent's ancestor chain
      if (newParentId) {
        await tx.$executeRaw`
          INSERT INTO team_closure (tenant_id, ancestor_team_id, descendant_team_id, depth)
          SELECT supertree.tenant_id, supertree.ancestor_team_id,
                 subtree.descendant_team_id, supertree.depth + subtree.depth + 1
          FROM team_closure AS supertree
          CROSS JOIN team_closure AS subtree
          WHERE supertree.descendant_team_id = ${newParentId}::uuid
            AND subtree.ancestor_team_id = ${teamId}::uuid`;
      }
      const updated = await tx.team.update({
        where: { id: teamId },
        data: { parentTeamId: newParentId },
      });
      await appendEvent(tx, {
        eventName: EVENTS.TeamMoved,
        tenantId: this.db.tenantId,
        aggregateType: 'team',
        aggregateId: teamId,
        actorUserId,
        payload: { fromParentId: team.parentTeamId, toParentId: newParentId },
      });
      return { team: updated, moved: true, previousParentId: team.parentTeamId };
    });
    if (result.moved) {
      await this.audit.record({
        action: 'team.move',
        entityType: 'team',
        entityId: teamId,
        before: { parentTeamId: result.previousParentId ?? null },
        after: { parentTeamId: newParentId },
      });
    }
    return result.team;
  }

  async assignLeader(
    teamId: string,
    input: { memberId: string; leadershipRole?: string },
    actorUserId: string,
  ) {
    const leadership = await this.db.tx(async (tx) => {
      const [team, member] = await Promise.all([
        tx.team.findFirst({ where: { id: teamId } }),
        tx.member.findFirst({ where: { id: input.memberId, status: 'active' } }),
      ]);
      if (!team || !member) {
        throw new NotFoundException({
          code: ERROR_CODES.NOT_FOUND,
          message: !team ? 'Team not found' : 'Member not found',
        });
      }
      // history preserved: previous primary stays as a closed row (effective_to)
      await tx.teamLeadership.updateMany({
        where: { teamId, isPrimary: true, status: 'active' },
        data: { status: 'ended', effectiveTo: new Date() },
      });
      const created = await tx.teamLeadership.create({
        data: {
          tenantId: this.db.tenantId,
          teamId,
          memberId: input.memberId,
          leadershipRole: input.leadershipRole ?? 'PRIMARY_LEADER',
          isPrimary: true,
        },
      });
      // leaders automatically receive the scoped LEADER system role
      const leaderRole = await tx.role.findFirst({ where: { code: 'LEADER' } });
      if (leaderRole) {
        const hasRole = await tx.memberRole.findFirst({
          where: { memberId: input.memberId, roleId: leaderRole.id },
        });
        if (!hasRole) {
          await tx.memberRole.create({
            data: {
              tenantId: this.db.tenantId,
              memberId: input.memberId,
              roleId: leaderRole.id,
            },
          });
        }
      }
      await appendEvent(tx, {
        eventName: EVENTS.LeaderAssigned,
        tenantId: this.db.tenantId,
        aggregateType: 'team',
        aggregateId: teamId,
        actorUserId,
        payload: { memberId: input.memberId, leadershipRole: created.leadershipRole },
      });
      return created;
    });
    await this.audit.record({
      action: 'team.leader.assign',
      entityType: 'team_leadership',
      entityId: leadership.id,
      after: { teamId, memberId: input.memberId, role: leadership.leadershipRole },
    });
    return leadership;
  }

  async join(teamId: string, memberId: string, actorUserId: string, actor: TeamActor) {
    const membership = await this.db.tx(async (tx) => {
      await this.assertScope(tx, actor, PERMISSIONS.TEAM_MEMBER_MANAGE, teamId);
      const [team, member] = await Promise.all([
        tx.team.findFirst({ where: { id: teamId, status: 'active' } }),
        tx.member.findFirst({ where: { id: memberId, status: 'active' } }),
      ]);
      if (!team || !member) {
        throw new NotFoundException({
          code: ERROR_CODES.NOT_FOUND,
          message: !team ? 'Team not found' : 'Member not found',
        });
      }
      const existing = await tx.teamMembership.findFirst({ where: { teamId, memberId } });
      if (existing) {
        throw new ConflictException({
          code: ERROR_CODES.CONFLICT,
          message: 'Member already belongs to this team',
        });
      }
      const created = await tx.teamMembership.create({
        data: { tenantId: this.db.tenantId, teamId, memberId },
      });
      await appendEvent(tx, {
        eventName: EVENTS.MemberJoinedTeam,
        tenantId: this.db.tenantId,
        aggregateType: 'team',
        aggregateId: teamId,
        actorUserId,
        payload: { memberId },
      });
      return created;
    });
    await this.audit.record({
      action: 'team.member.join',
      entityType: 'team_membership',
      entityId: membership.id,
      after: { teamId, memberId },
    });
    return membership;
  }

  /** History of leadership for a team — closed rows included (spec §73). */
  async leadershipHistory(id: string, actor: TeamActor) {
    return this.db.tx(async (tx) => {
      await this.assertScope(tx, actor, PERMISSIONS.TEAM_VIEW, id);
      return tx.teamLeadership.findMany({
        where: { teamId: id },
        orderBy: { effectiveFrom: 'desc' },
        select: {
          memberId: true,
          leadershipRole: true,
          isPrimary: true,
          status: true,
          effectiveFrom: true,
          effectiveTo: true,
        },
      });
    });
  }
}
