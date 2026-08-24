import { ForbiddenException, Injectable } from '@nestjs/common';
import {
  ERROR_CODES,
  LEARNING_PATH,
  START_NAMES_TARGET,
  pathCourses,
  type PathStageSeed,
} from '@aviora/shared';
import type { Tx } from '@aviora/db';
import { TenantDb } from '../../common/db/tenant-db.service';
import type { TeamActor } from '../team/team-scope.service';
import { BusinessGoalService } from '../goals-business/business-goal.service';

type Locale = 'en' | 'th';

/**
 * The learning path (docs/67).
 *
 * Answers two questions at once — what to know and what to do — and derives
 * where somebody is from the same evidence the start path reads, so no two
 * screens can tell a member they are at different places.
 */
@Injectable()
export class LearningPathService {
  constructor(private readonly db: TenantDb) {}

  private requireMember(actor: TeamActor): string {
    if (!actor.memberId) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'You are not a member of this tenant',
      });
    }
    return actor.memberId;
  }

  /**
   * The path's courses, created on first read.
   *
   * Titles and lesson headings, mostly — a spine for the business to hang its
   * own material on. An empty lesson is honest about being empty; inventing
   * the words would put this codebase's opinions in a tenant's training.
   *
   * `path-plan` is the exception and carries its body text, because how a
   * differential is computed is a fact about the plan FAMILY rather than an
   * opinion about any one plan, and a member who cannot read their own payout
   * is not equipped by a heading (docs/69). It still sets no threshold: the
   * numbers on each rung stay the tenant's to enter (docs/62 §2).
   */
  private async ensureCourses(tx: Tx, locale: Locale) {
    const codes = pathCourses().map((c) => c.code);
    const existing = await tx.course.findMany({
      where: { code: { in: codes } },
      select: { code: true },
    });
    const have = new Set(existing.map((c) => c.code));
    for (const seed of pathCourses()) {
      if (have.has(seed.code)) continue;
      const course = await tx.course.create({
        data: {
          tenantId: this.db.tenantId,
          code: seed.code,
          title: seed.title[locale],
        },
      });
      await tx.lesson.createMany({
        data: seed.lessons.map((lesson, index) => ({
          tenantId: this.db.tenantId,
          courseId: course.id,
          order: index + 1,
          title: lesson[locale],
          // Almost always null, and only written on creation: a tenant who has
          // rewritten a lesson keeps their words on the next read.
          content: lesson.body?.[locale] ?? null,
        })),
      });
    }
  }

  /**
   * Everything the system can prove about this member, in one pass.
   *
   * Public because the release rules in docs/73 §4 gate on the same facts, and
   * a second computation of "has this member had a first customer" is a second
   * answer waiting to disagree with this one. docs/67 §5 is the whole argument;
   * it applies to a locked video exactly as it applies to a stage tick.
   */
  async evidence(tx: Tx, memberId: string): Promise<Record<string, boolean>> {
    const month = BusinessGoalService.monthOf();
    const [goal, thisMonth, names, courses, customers, directs] = await Promise.all([
      tx.businessGoal.findFirst({ where: { memberId } }),
      tx.businessGoal.findFirst({ where: { memberId, month } }),
      tx.lead.count({
        where: { ownerMemberId: memberId, OR: [{ onSponsorList: true }, { onCustomerList: true }] },
      }),
      tx.learningProgress.count({ where: { memberId } }),
      tx.customer.count({ where: { ownerMemberId: memberId } }),
      tx.referralRelationship.findMany({
        where: { referrerMemberId: memberId, effectiveTo: null },
        select: { referredMemberId: true },
      }),
    ]);

    // Duplication: somebody YOU sponsored has sponsored somebody themselves.
    // It is the only stage that cannot be reached by working harder alone,
    // which is exactly why the path names it (docs/67 §3).
    const grandchildren = directs.length
      ? await tx.referralRelationship.count({
          where: {
            referrerMemberId: { in: directs.map((d) => d.referredMemberId) },
            effectiveTo: null,
          },
        })
      : 0;

    return {
      dream: !!goal?.lifeGoal?.trim(),
      goal:
        !!thisMonth &&
        ((thisMonth.volumeTargetMinor ?? 0) > 0 || (thisMonth.newPartnersTarget ?? 0) > 0),
      names: names >= START_NAMES_TARGET,
      course: courses > 0,
      customer: customers > 0,
      partner: directs.length > 0,
      duplicated: grandchildren > 0,
    };
  }

  async forMember(actor: TeamActor, locale: Locale = 'th') {
    const memberId = this.requireMember(actor);
    return this.db.tx(async (tx) => {
      await this.ensureCourses(tx, locale);
      const evidence = await this.evidence(tx, memberId);

      const codes = pathCourses().map((c) => c.code);
      const courses = await tx.course.findMany({
        where: { code: { in: codes } },
        select: { id: true, code: true, title: true, lessons: { select: { id: true } } },
      });
      const byCode = new Map(courses.map((c) => [c.code, c]));
      const progress = await tx.learningProgress.findMany({
        where: { memberId, courseId: { in: courses.map((c) => c.id) } },
        select: { courseId: true, status: true },
      });
      const progressByCourse = new Map(progress.map((p) => [p.courseId, p.status]));

      const stages = LEARNING_PATH.map((stage: PathStageSeed) => {
        const cleared = stage.clearedBy === 'never' ? false : (evidence[stage.clearedBy] ?? false);
        return {
          key: stage.key,
          label: stage.label[locale],
          cleared,
          know: stage.courses.map((seed) => {
            const course = byCode.get(seed.code);
            const status = course ? progressByCourse.get(course.id) : undefined;
            return {
              courseId: course?.id ?? null,
              code: seed.code,
              title: seed.title[locale],
              lessonCount: course?.lessons.length ?? 0,
              status: status ?? 'not_started',
            };
          }),
          do: stage.actions.map((action) => ({
            key: action.key,
            label: action.label[locale],
            href: action.href,
            done: action.derived ? (evidence[action.derived] ?? false) : false,
            source: action.derived ? ('computed' as const) : ('manual' as const),
          })),
        };
      });

      // The first stage not yet cleared. Everything before it is history and
      // everything after is not the question today.
      const current = stages.find((s) => !s.cleared) ?? null;
      return {
        stages,
        currentStageKey: current?.key ?? null,
        clearedCount: stages.filter((s) => s.cleared).length,
        total: stages.length,
      };
    });
  }
}
