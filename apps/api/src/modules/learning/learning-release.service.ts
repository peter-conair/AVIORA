import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { Tx } from '@aviora/db';
import { TenantDb } from '../../common/db/tenant-db.service';
import { LearningPathService } from '../learning-path/learning-path.service';

/**
 * Who may see a course YET (docs/73 §3).
 *
 * The single most important property of this file: **it can only ever say no.**
 * Every course it reports is one the caller was already permitted to see; the
 * question here is whether it has been released to them, which is a sequencing
 * decision and not a permission one. docs/37 §6 refused a second permission
 * system and was right to; this is not one.
 *
 * The test of that claim is executable, and `learning-release.spec.ts` runs it:
 * delete every row of `learning_assignments` and no member gains access to
 * anything. A grant table would fail that test.
 *
 * Entitlement (`course.access`) is deliberately NOT re-checked here. It is
 * enforced by the guard on the routes that serve content, and resolving it a
 * second time in this service would be exactly the duplicated-authorization
 * problem the paragraph above is about.
 */

/** `{ after: 'course:path-basics' | 'stage:first_customer' | 'days:14' }`. */
export const releaseRuleSchema = z.object({
  after: z.string().regex(/^(course:[a-z0-9-]{1,60}|stage:[a-z_]{1,40}|days:\d{1,4})$/),
});
export type ReleaseRule = z.infer<typeof releaseRuleSchema>;

export function parseReleaseRule(value: unknown): ReleaseRule | null {
  if (value === null || value === undefined) return null;
  const parsed = releaseRuleSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Why a course is shut. Carried to the member, not only to the leader — a lock
 * nobody can see is how this feature becomes a way of keeping somebody
 * dependent (docs/73 §5).
 */
export type Lock =
  | { state: 'open' }
  | { state: 'awaiting_rule'; after: string }
  | { state: 'awaiting_leader' }
  | { state: 'held'; reason: string };

export interface CourseRelease {
  courseId: string;
  visible: boolean;
  lock: Lock;
  /** Set when a leader released or held this by hand. */
  assignedAt: Date | null;
  dueAt: Date | null;
}

interface ReleasableCourse {
  id: string;
  code: string;
  releasePolicy: string;
  releaseRule: unknown;
}

@Injectable()
export class LearningReleaseService {
  constructor(
    private readonly db: TenantDb,
    private readonly path: LearningPathService,
  ) {}

  /**
   * Resolve every course for one member, in one pass.
   *
   * Batched rather than per-course because the evidence a rule reads — the name
   * list, customers, referral edges — costs the same to fetch once as to fetch
   * for one course, and a per-course call inside a render loop is how a screen
   * with twenty courses becomes twenty round trips.
   */
  async forMember(
    tx: Tx,
    memberId: string,
    courses: ReleasableCourse[],
  ): Promise<Map<string, CourseRelease>> {
    const out = new Map<string, CourseRelease>();
    if (courses.length === 0) return out;

    const assignments = await tx.learningAssignment.findMany({
      where: { memberId, courseId: { in: courses.map((c) => c.id) } },
      select: { courseId: true, state: true, reason: true, assignedAt: true, dueAt: true },
    });
    const byCourse = new Map(assignments.map((a) => [a.courseId, a]));

    // Only gathered if some course actually gates on it. A tenant with an open
    // library pays nothing for the existence of this feature.
    const rules = courses
      .filter((c) => c.releasePolicy === 'on_assignment')
      .map((c) => parseReleaseRule(c.releaseRule))
      .filter((r): r is ReleaseRule => r !== null);
    const facts = rules.length > 0 ? await this.facts(tx, memberId, rules) : null;

    for (const course of courses) {
      const assignment = byCourse.get(course.id);
      const assignedAt = assignment?.assignedAt ?? null;
      const dueAt = assignment?.dueAt ?? null;

      // An OPEN course is open, and a leader cannot shut it.
      //
      // This ordering is the separation of powers in this feature. The tenant
      // decides which courses are sequenced at all; the leader decides
      // sequencing within those. Letting a hold override an open policy would
      // let a leader close the whole library one course at a time, which is
      // precisely the behaviour docs/73 §2 says this product will not help
      // with. `LearningAssignmentService.hold` refuses it at the door too, so
      // the answer is the same whether you ask the API or read the rows.
      if (course.releasePolicy !== 'on_assignment') {
        out.set(course.id, {
          courseId: course.id,
          visible: true,
          lock: { state: 'open' },
          assignedAt,
          dueAt,
        });
        continue;
      }

      // Within a sequenced course, a hold outranks both a fired rule and an
      // earlier release — which is why the database insists it carry a reason.
      if (assignment?.state === 'held') {
        out.set(course.id, {
          courseId: course.id,
          visible: false,
          lock: { state: 'held', reason: assignment.reason ?? '' },
          assignedAt,
          dueAt,
        });
        continue;
      }

      // Released by hand. A leader may open a course before its rule fires;
      // that is the exception the rule exists to leave room for (docs/73 §4).
      if (assignment?.state === 'assigned') {
        out.set(course.id, {
          courseId: course.id,
          visible: true,
          lock: { state: 'open' },
          assignedAt,
          dueAt,
        });
        continue;
      }

      const rule = parseReleaseRule(course.releaseRule);
      if (rule && facts?.get(rule.after) === true) {
        out.set(course.id, {
          courseId: course.id,
          visible: true,
          lock: { state: 'open' },
          assignedAt,
          dueAt,
        });
        continue;
      }

      out.set(course.id, {
        courseId: course.id,
        visible: false,
        // A rule tells the member what to go and do. Without one, the honest
        // answer is that a person has not opened it yet — and saying so is the
        // point (docs/73 §5).
        lock: rule ? { state: 'awaiting_rule', after: rule.after } : { state: 'awaiting_leader' },
        assignedAt,
        dueAt,
      });
    }
    return out;
  }

  /** Convenience for the one-course case; the batch above is the real path. */
  async forOne(tx: Tx, memberId: string, course: ReleasableCourse): Promise<CourseRelease> {
    const map = await this.forMember(tx, memberId, [course]);
    return map.get(course.id)!;
  }

  /**
   * Answers only the rules actually in use, keyed by the rule string itself so
   * the caller does not re-parse.
   */
  private async facts(
    tx: Tx,
    memberId: string,
    rules: ReleaseRule[],
  ): Promise<Map<string, boolean>> {
    const wanted = new Set(rules.map((r) => r.after));
    const answers = new Map<string, boolean>();

    const courseCodes = [...wanted]
      .filter((a) => a.startsWith('course:'))
      .map((a) => a.slice('course:'.length));
    if (courseCodes.length > 0) {
      const done = await tx.course.findMany({
        where: { code: { in: courseCodes } },
        select: { id: true, code: true },
      });
      const progress = await tx.learningProgress.findMany({
        where: { memberId, courseId: { in: done.map((c) => c.id) }, status: 'completed' },
        select: { courseId: true },
      });
      const completed = new Set(progress.map((p) => p.courseId));
      for (const course of done) {
        answers.set(`course:${course.code}`, completed.has(course.id));
      }
      // A rule naming a course that does not exist stays false. Opening a
      // locked video because somebody mistyped a code is the wrong direction
      // to fail in.
      for (const code of courseCodes) {
        if (!answers.has(`course:${code}`)) answers.set(`course:${code}`, false);
      }
    }

    if ([...wanted].some((a) => a.startsWith('stage:'))) {
      // The same evidence the path screen reads (docs/67 §5). Two screens
      // telling a member they are at different places is worse than either
      // being wrong on its own.
      const evidence = await this.path.evidence(tx, memberId);
      for (const key of wanted) {
        if (!key.startsWith('stage:')) continue;
        answers.set(key, evidence[key.slice('stage:'.length)] === true);
      }
    }

    const dayRules = [...wanted].filter((a) => a.startsWith('days:'));
    if (dayRules.length > 0) {
      const member = await tx.member.findFirst({
        where: { id: memberId },
        select: { joinedAt: true },
      });
      const joined = member?.joinedAt?.getTime() ?? null;
      for (const key of dayRules) {
        const days = Number(key.slice('days:'.length));
        answers.set(key, joined !== null && Date.now() - joined >= days * 24 * 60 * 60 * 1000);
      }
    }
    return answers;
  }
}
