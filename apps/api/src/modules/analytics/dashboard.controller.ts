import { Controller, ForbiddenException, Get } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { ERROR_CODES, PERMISSIONS } from '@aviora/shared';
import { RequirePermissions } from '../../common/auth/decorators';
import { CLS_MEMBER_ID } from '../../common/auth/permissions.guard';
import { TenantDb } from '../../common/db/tenant-db.service';

/** Personal dashboard (spec §72 final step): goals + learning + teams + membership. */
@Controller('dashboard')
export class DashboardController {
  constructor(
    private readonly db: TenantDb,
    private readonly cls: ClsService,
  ) {}

  /** Leader dashboard (spec §21): my led teams with direct vs organization counts. */
  @Get('leader')
  @RequirePermissions(PERMISSIONS.TEAM_ANALYTICS_VIEW)
  async leader() {
    const memberId = this.cls.get(CLS_MEMBER_ID) as string | undefined;
    if (!memberId) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'You are not a member of this tenant',
      });
    }
    return this.db.tx(async (tx) => {
      const led = await tx.teamLeadership.findMany({
        where: { memberId, status: 'active' },
        select: { teamId: true, leadershipRole: true, effectiveFrom: true },
      });
      const teams = await tx.team.findMany({
        where: { id: { in: led.map((l) => l.teamId) }, status: 'active' },
        select: { id: true, code: true, name: true },
      });
      const teamById = new Map(teams.map((t) => [t.id, t]));
      const result = await Promise.all(
        led
          .filter((l) => teamById.has(l.teamId))
          .map(async (l) => {
            const sub = await tx.teamClosure.findMany({
              where: { ancestorTeamId: l.teamId },
              select: { descendantTeamId: true },
            });
            const [directRows, orgRows] = await Promise.all([
              tx.teamMembership.findMany({
                where: { teamId: l.teamId, status: 'active' },
                select: { memberId: true },
              }),
              tx.teamMembership.findMany({
                where: { teamId: { in: sub.map((s) => s.descendantTeamId) }, status: 'active' },
                select: { memberId: true },
              }),
            ]);
            return {
              team: teamById.get(l.teamId)!,
              leadershipRole: l.leadershipRole,
              since: l.effectiveFrom,
              directMembers: new Set(directRows.map((r) => r.memberId)).size,
              organizationMembers: new Set(orgRows.map((r) => r.memberId)).size,
              childTeams: sub.length - 1,
            };
          }),
      );
      return { teams: result };
    });
  }

  @Get('me')
  @RequirePermissions(PERMISSIONS.GOAL_VIEW)
  async me() {
    const memberId = this.cls.get(CLS_MEMBER_ID) as string | undefined;
    if (!memberId) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'You are not a member of this tenant',
      });
    }
    return this.db.tx(async (tx) => {
      const [goals, goalCounts, progress, teamRows, membership] = await Promise.all([
        tx.goal.findMany({
          where: { memberId },
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: { id: true, title: true, status: true, category: true, targetDate: true },
        }),
        tx.goal.groupBy({ by: ['status'], where: { memberId }, _count: true }),
        tx.learningProgress.findMany({
          where: { memberId },
          select: {
            courseId: true,
            status: true,
            completedLessonIds: true,
            startedAt: true,
            completedAt: true,
          },
        }),
        tx.teamMembership.findMany({
          where: { memberId, status: 'active' },
          select: { teamId: true, joinedAt: true },
        }),
        tx.membership.findFirst({
          where: { memberId, status: 'active' },
          orderBy: { startedAt: 'desc' },
          select: {
            status: true,
            trialEndsAt: true,
            startedAt: true,
            plan: { select: { name: true, code: true } },
          },
        }),
      ]);

      const courseIds = progress.map((p) => p.courseId);
      const teamIds = teamRows.map((t) => t.teamId);
      const [courses, lessonCounts, teams] = await Promise.all([
        courseIds.length
          ? tx.course.findMany({
              where: { id: { in: courseIds } },
              select: { id: true, title: true, code: true },
            })
          : Promise.resolve([]),
        courseIds.length
          ? tx.lesson.groupBy({
              by: ['courseId'],
              where: { courseId: { in: courseIds } },
              _count: true,
            })
          : Promise.resolve([]),
        teamIds.length
          ? tx.team.findMany({
              where: { id: { in: teamIds } },
              select: { id: true, name: true, code: true },
            })
          : Promise.resolve([]),
      ]);
      const courseById = new Map(courses.map((c) => [c.id, c]));
      const lessonsByCourse = new Map(lessonCounts.map((l) => [l.courseId, l._count]));
      const teamById = new Map(teams.map((t) => [t.id, t]));

      return {
        membership: membership
          ? {
              planName: membership.plan.name,
              planCode: membership.plan.code,
              status: membership.status,
              trialEndsAt: membership.trialEndsAt,
              startedAt: membership.startedAt,
            }
          : null,
        goals: {
          recent: goals,
          counts: Object.fromEntries(goalCounts.map((g) => [g.status, g._count])),
        },
        learning: progress.map((p) => ({
          courseId: p.courseId,
          courseTitle: courseById.get(p.courseId)?.title ?? null,
          status: p.status,
          completedLessons: ((p.completedLessonIds as string[]) ?? []).length,
          totalLessons: lessonsByCourse.get(p.courseId) ?? 0,
          startedAt: p.startedAt,
          completedAt: p.completedAt,
        })),
        teams: teamRows.map((t) => ({
          teamId: t.teamId,
          name: teamById.get(t.teamId)?.name ?? null,
          joinedAt: t.joinedAt,
        })),
      };
    });
  }
}
