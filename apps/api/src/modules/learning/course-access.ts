import type { Tx } from '@aviora/db';

export interface CourseAccessResult {
  progressId: string;
  /** False when the member was already on the course. */
  started: boolean;
}

/**
 * Puts a member on a course from outside a request — a reward of type
 * `course_access`, or an `assign_course` automation action (docs/27 §1, §2).
 *
 * Idempotent per (member, course): a rule that fires twice, or a reward granted
 * twice, must not reset progress the member has already made. No CourseStarted
 * event is appended: automation and reward actions emit nothing of their own
 * (docs/27 §6), so a course started this way earns no points.
 */
export async function ensureCourseAccess(
  tx: Tx,
  tenantId: string,
  memberId: string,
  courseId: string,
): Promise<CourseAccessResult> {
  const course = await tx.course.findFirst({ where: { id: courseId }, select: { id: true } });
  if (!course) throw new Error(`Course ${courseId} does not exist in this tenant`);

  const existing = await tx.learningProgress.findFirst({
    where: { memberId, courseId },
    select: { id: true },
  });
  if (existing) return { progressId: existing.id, started: false };

  const created = await tx.learningProgress.create({
    data: { tenantId, memberId, courseId },
    select: { id: true },
  });
  return { progressId: created.id, started: true };
}
