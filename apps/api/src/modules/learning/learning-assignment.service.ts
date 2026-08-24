import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ERROR_CODES, PERMISSIONS } from '@aviora/shared';
import type { Tx } from '@aviora/db';
import { TenantDb } from '../../common/db/tenant-db.service';
import { AuditService } from '../../common/audit/audit.service';
import { TeamScopeService, type TeamActor } from '../team/team-scope.service';
import { LearningReleaseService } from './learning-release.service';

export interface AssignInput {
  memberIds: string[];
  courseId: string;
  dueAt?: Date | null;
  reason?: string | null;
}

export interface HoldInput {
  memberIds: string[];
  courseId: string;
  reason: string;
}

/**
 * Releasing courses to individual members (docs/73 §4, §9).
 *
 * Who a leader may act on is `TeamScopeService.accessibleTeamIds` and nothing
 * else — the same call `knowledge.team.manage` uses, for the same reason: two
 * answers to "which members may this person act on" is two answers waiting to
 * disagree, and the one that disagrees quietly is the one that leaks.
 */
@Injectable()
export class LearningAssignmentService {
  constructor(
    private readonly db: TenantDb,
    private readonly teamScope: TeamScopeService,
    private readonly release: LearningReleaseService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The members this leader may release to: everybody in the teams they lead
   * and, with `DESCENDANT_TEAMS`, everything beneath them.
   *
   * Returns `'ALL'` for a tenant-wide grant rather than materialising every
   * member id, so a large tenant does not pay for a set it will not read.
   */
  private async membersInScope(tx: Tx, actor: TeamActor): Promise<'ALL' | Set<string>> {
    const teams = await this.teamScope.accessibleTeamIds(tx, actor, PERMISSIONS.LEARNING_ASSIGN);
    if (teams === 'ALL') return 'ALL';
    if (teams.size === 0) return new Set();
    const rows = await tx.teamMembership.findMany({
      where: { teamId: { in: [...teams] }, status: 'active' },
      select: { memberId: true },
    });
    return new Set(rows.map((r) => r.memberId));
  }

  private assertInScope(scope: 'ALL' | Set<string>, memberIds: string[]): void {
    if (scope === 'ALL') return;
    const outside = memberIds.filter((id) => !scope.has(id));
    if (outside.length > 0) {
      // Named rather than silently dropped. A bulk assign that quietly skipped
      // four of thirty people would look like it worked, and the leader would
      // find out from the four.
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: `${outside.length} of these members are not in a team you lead`,
      });
    }
  }

  private requireActor(actor: TeamActor): string {
    if (!actor.memberId) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'You are not a member of this tenant',
      });
    }
    return actor.memberId;
  }

  private async course(tx: Tx, courseId: string) {
    const found = await tx.course.findFirst({
      where: { id: courseId },
      select: {
        id: true,
        code: true,
        title: true,
        status: true,
        releasePolicy: true,
        releaseRule: true,
      },
    });
    if (!found) {
      throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Course not found' });
    }
    return found;
  }

  /** Release a course to members who cannot see it yet. */
  async assign(actor: TeamActor, input: AssignInput) {
    const rows = await this.db.tx(async (tx) => {
      const scope = await this.membersInScope(tx, actor);
      this.assertInScope(scope, input.memberIds);
      await this.course(tx, input.courseId);
      const actorId = this.requireActor(actor);

      const saved = [];
      for (const memberId of input.memberIds) {
        const existing = await tx.learningAssignment.findFirst({
          where: { memberId, courseId: input.courseId },
        });
        const data = {
          state: 'assigned',
          source: 'manual',
          assignedByMemberId: actorId,
          dueAt: input.dueAt ?? null,
          reason: input.reason ?? null,
        };
        saved.push(
          existing
            ? await tx.learningAssignment.update({ where: { id: existing.id }, data })
            : await tx.learningAssignment.create({
                data: {
                  tenantId: this.db.tenantId,
                  memberId,
                  courseId: input.courseId,
                  ...data,
                },
              }),
        );
      }
      return saved;
    });

    await this.audit.record({
      action: 'learning.assignment.assign',
      entityType: 'course',
      entityId: input.courseId,
      after: { members: input.memberIds.length, dueAt: input.dueAt ?? null },
    });
    return rows;
  }

  /**
   * Keep a sequenced course shut for these members, with a reason they can see.
   *
   * An `open` course cannot be held. The tenant decided that course is open to
   * everyone, and a leader who could override that could close the library one
   * course at a time (docs/73 §2). The refusal names the fix, so an admin who
   * genuinely wants the course sequenced knows where to go.
   */
  async hold(actor: TeamActor, input: HoldInput) {
    const rows = await this.db.tx(async (tx) => {
      const scope = await this.membersInScope(tx, actor);
      this.assertInScope(scope, input.memberIds);
      const course = await this.course(tx, input.courseId);
      if (course.releasePolicy !== 'on_assignment') {
        throw new ConflictException({
          code: ERROR_CODES.VALIDATION_FAILED,
          message:
            `"${course.title}" is open to everyone, so it cannot be held back from one member. ` +
            'Set the course to release on assignment first.',
        });
      }
      const actorId = this.requireActor(actor);

      const saved = [];
      for (const memberId of input.memberIds) {
        const existing = await tx.learningAssignment.findFirst({
          where: { memberId, courseId: input.courseId },
        });
        const data = {
          state: 'held',
          source: 'manual',
          assignedByMemberId: actorId,
          reason: input.reason,
        };
        saved.push(
          existing
            ? await tx.learningAssignment.update({ where: { id: existing.id }, data })
            : await tx.learningAssignment.create({
                data: {
                  tenantId: this.db.tenantId,
                  memberId,
                  courseId: input.courseId,
                  ...data,
                },
              }),
        );
      }
      return saved;
    });

    await this.audit.record({
      action: 'learning.assignment.hold',
      entityType: 'course',
      entityId: input.courseId,
      after: { members: input.memberIds.length, reason: input.reason },
    });
    return rows;
  }

  /**
   * Remove the row entirely, returning the course to whatever its own policy
   * and rule say. Withdrawing is not the same as holding: this forgets that a
   * decision was ever made, rather than recording the opposite one.
   */
  async withdraw(actor: TeamActor, id: string) {
    const removed = await this.db.tx(async (tx) => {
      const row = await tx.learningAssignment.findFirst({ where: { id } });
      if (!row) {
        throw new NotFoundException({
          code: ERROR_CODES.NOT_FOUND,
          message: 'Assignment not found',
        });
      }
      const scope = await this.membersInScope(tx, actor);
      this.assertInScope(scope, [row.memberId]);
      await tx.learningAssignment.delete({ where: { id } });
      return row;
    });

    await this.audit.record({
      action: 'learning.assignment.withdraw',
      entityType: 'course',
      entityId: removed.courseId,
      before: { memberId: removed.memberId, state: removed.state },
    });
    return { id, withdrawn: true };
  }

  /**
   * The leader's board: every member in scope against every course, with what
   * each of them can see and how far they have got.
   *
   * A grid rather than a member page, because the feature has to survive thirty
   * people: a leader reads down a column and assigns across a row, instead of
   * visiting thirty pages to make the same decision thirty times.
   *
   * What it does NOT carry is when anybody watched anything (docs/73 §8). A
   * completion state supports the conversation a leader should be having; a
   * viewing timestamp supports a different one, and this product does not make
   * that one easy.
   */
  async board(actor: TeamActor) {
    return this.db.tx(async (tx) => {
      const scope = await this.membersInScope(tx, actor);
      const members = await tx.member.findMany({
        where: {
          status: 'active',
          ...(scope === 'ALL' ? {} : { id: { in: [...scope] } }),
        },
        orderBy: { displayName: 'asc' },
        select: { id: true, displayName: true },
      });
      const courses = await tx.course.findMany({
        where: { status: 'published' },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          code: true,
          title: true,
          releasePolicy: true,
          releaseRule: true,
          _count: { select: { lessons: true } },
        },
      });
      if (members.length === 0 || courses.length === 0) {
        return { members, courses: courses.map(withAccessControl(new Set())), cells: [] };
      }

      // Which courses hold media this product does not serve (docs/74 §2).
      // Carried to the leader's screen so it can say plainly that releasing
      // one of these controls what the app shows and not what YouTube does —
      // a promise the board would otherwise appear to make.
      const external = await tx.lessonAsset.findMany({
        where: {
          provider: { not: 'storage' },
          lesson: { courseId: { in: courses.map((c) => c.id) } },
        },
        select: { lesson: { select: { courseId: true } } },
      });
      const advisory = new Set(external.map((a) => a.lesson.courseId));

      const progress = await tx.learningProgress.findMany({
        where: {
          memberId: { in: members.map((m) => m.id) },
          courseId: { in: courses.map((c) => c.id) },
        },
        select: { memberId: true, courseId: true, status: true, completedLessonIds: true },
      });
      const progressBy = new Map(progress.map((p) => [`${p.memberId}:${p.courseId}`, p]));

      const cells = [];
      for (const member of members) {
        const releases = await this.release.forMember(tx, member.id, courses);
        for (const course of courses) {
          const release = releases.get(course.id)!;
          const p = progressBy.get(`${member.id}:${course.id}`);
          const done = Array.isArray(p?.completedLessonIds) ? p.completedLessonIds.length : 0;
          cells.push({
            memberId: member.id,
            courseId: course.id,
            visible: release.visible,
            lock: release.lock,
            dueAt: release.dueAt,
            // Derived from `learning_progress`, the record the rest of the
            // product already treats as the answer to "did they finish". A
            // second tally computed from lesson views would be a second
            // answer, and the two would part company within a sprint.
            status: p?.status ?? 'not_started',
            completedLessons: done,
            totalLessons: course._count.lessons,
          });
        }
      }
      return { members, courses: courses.map(withAccessControl(advisory)), cells };
    });
  }

  /** One member's assignments — what a leader sees on a person. */
  async forMember(actor: TeamActor, memberId: string) {
    return this.db.tx(async (tx) => {
      const scope = await this.membersInScope(tx, actor);
      this.assertInScope(scope, [memberId]);
      return tx.learningAssignment.findMany({
        where: { memberId },
        orderBy: { assignedAt: 'desc' },
      });
    });
  }
}

/**
 * Says which promise a course's release actually makes.
 *
 * `enforced` — the bytes come through this API and a locked course serves
 * nothing. `advisory` — the media is embedded from somewhere else, so releasing
 * decides what this product shows and nothing about what a forwarded link does.
 * Naming it on the row means no screen has to work it out, and none can quietly
 * get it wrong.
 */
function withAccessControl(advisory: Set<string>) {
  return <T extends { id: string }>(course: T) => ({
    ...course,
    mediaAccessControl: advisory.has(course.id) ? ('advisory' as const) : ('enforced' as const),
  });
}
