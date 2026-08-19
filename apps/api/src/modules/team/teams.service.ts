import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ERROR_CODES, EVENTS } from '@aviora/shared';
import { appendEvent } from '@aviora/db';
import { TenantDb } from '../../common/db/tenant-db.service';
import { AuditService } from '../../common/audit/audit.service';

@Injectable()
export class TeamsService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
  ) {}

  async create(
    input: {
      code: string;
      name: string;
      description?: string;
      parentTeamId?: string;
    },
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

  list() {
    return this.db.tx((tx) =>
      tx.team.findMany({
        where: { status: 'active' },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          code: true,
          name: true,
          parentTeamId: true,
          description: true,
          createdAt: true,
        },
      }),
    );
  }

  async get(id: string) {
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

  async members(id: string) {
    return this.db.tx(async (tx) => {
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

  async join(teamId: string, memberId: string, actorUserId: string) {
    const membership = await this.db.tx(async (tx) => {
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
}
