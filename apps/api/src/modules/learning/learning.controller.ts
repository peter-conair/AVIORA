import {
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { ENTITLEMENTS, ERROR_CODES, EVENTS, PERMISSIONS } from '@aviora/shared';
import { appendEvent } from '@aviora/db';
import {
  CurrentUser,
  RequireEntitlements,
  RequirePermissions,
  type AuthenticatedUser,
} from '../../common/auth/decorators';
import { CLS_MEMBER_ID } from '../../common/auth/permissions.guard';
import { TenantDb } from '../../common/db/tenant-db.service';
import { LearningReleaseService } from './learning-release.service';

@Controller()
export class LearningController {
  constructor(
    private readonly db: TenantDb,
    private readonly cls: ClsService,
    private readonly release: LearningReleaseService,
  ) {}

  /**
   * The library, with what the caller may see YET marked on it (docs/73 §5).
   *
   * A course they cannot open is still LISTED, with the reason. docs/37 §4
   * answers 404 for another team's article because confirming it exists leaks
   * something about that team; this is the caller's own curriculum, and
   * pretending a lesson does not exist is how a leader hides the path from the
   * person walking it.
   */
  @Get('courses')
  @RequirePermissions(PERMISSIONS.LEARNING_VIEW)
  async listCourses() {
    const memberId = (this.cls.get(CLS_MEMBER_ID) as string | undefined) ?? null;
    return this.db.tx(async (tx) => {
      const courses = await tx.course.findMany({
        where: { status: 'published' },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          code: true,
          title: true,
          description: true,
          releasePolicy: true,
          releaseRule: true,
          // `content` is null for most lessons — the seed lays out headings and
          // leaves the words to the tenant (docs/67 §2). It travels with the
          // list rather than behind a detail route because a lesson nobody can
          // read is a lesson that may as well not have been written.
          lessons: {
            select: {
              id: true,
              order: true,
              title: true,
              content: true,
              // Metadata only. The bytes are a separate, range-aware route and
              // the storage key never leaves the API (docs/71).
              // `externalId` IS the link (docs/74 §3). It only ships for a
              // course this member may see, which the blanking below is what
              // guarantees — a locked course hands out no ids at all, and that
              // is the one protection an unlisted link leaves us.
              assets: {
                select: {
                  kind: true,
                  locale: true,
                  provider: true,
                  externalId: true,
                  durationSeconds: true,
                },
              },
            },
            orderBy: { order: 'asc' },
          },
        },
      });

      const releases = memberId
        ? await this.release.forMember(tx, memberId, courses)
        : new Map<string, { visible: boolean; lock: unknown; dueAt: Date | null }>();

      return {
        courses: courses.map((course) => {
          const release = releases.get(course.id);
          return {
            ...course,
            // No member (a platform reader) sees the library as it is authored,
            // not as anybody's release state — there is no member to resolve.
            visible: release?.visible ?? true,
            lock: release?.lock ?? { state: 'open' },
            dueAt: release?.dueAt ?? null,
            // The lesson list itself is withheld when the course is not
            // released. Titles alone can give away a programme's whole shape,
            // and the course row already tells the member it exists and why it
            // is shut.
            lessons: release && !release.visible ? [] : course.lessons,
          };
        }),
      };
    });
  }

  /** Start a course — entitlement-gated (course.access via the member's plan). */
  @Post('courses/:id/start')
  @RequirePermissions(PERMISSIONS.LEARNING_VIEW)
  @RequireEntitlements(ENTITLEMENTS.COURSE_ACCESS)
  async startCourse(
    @Param('id', ParseUUIDPipe) courseId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const memberId = this.requireMemberId();
    const progress = await this.db.tx(async (tx) => {
      const course = await tx.course.findFirst({ where: { id: courseId, status: 'published' } });
      if (!course) {
        throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Course not found' });
      }
      const existing = await tx.learningProgress.findFirst({ where: { memberId, courseId } });
      if (existing) return existing;
      const created = await tx.learningProgress.create({
        data: { tenantId: this.db.tenantId, memberId, courseId },
      });
      await appendEvent(tx, {
        eventName: EVENTS.CourseStarted,
        tenantId: this.db.tenantId,
        aggregateType: 'course',
        aggregateId: courseId,
        actorUserId: user.userId,
        payload: { memberId, courseCode: course.code },
      });
      return created;
    });
    return { progress };
  }

  /** Complete one lesson; completing the last lesson completes the course. */
  @Post('lessons/:id/complete')
  @RequirePermissions(PERMISSIONS.LEARNING_VIEW)
  @RequireEntitlements(ENTITLEMENTS.COURSE_ACCESS)
  async completeLesson(
    @Param('id', ParseUUIDPipe) lessonId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const memberId = this.requireMemberId();
    const progress = await this.db.tx(async (tx) => {
      const lesson = await tx.lesson.findFirst({ where: { id: lessonId } });
      if (!lesson) {
        throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Lesson not found' });
      }
      const prog = await tx.learningProgress.findFirst({
        where: { memberId, courseId: lesson.courseId },
      });
      if (!prog) {
        throw new NotFoundException({
          code: ERROR_CODES.NOT_FOUND,
          message: 'Start the course before completing lessons',
        });
      }
      const done = new Set((prog.completedLessonIds as string[]) ?? []);
      done.add(lessonId);
      const totalLessons = await tx.lesson.count({ where: { courseId: lesson.courseId } });
      const courseComplete = done.size >= totalLessons;
      const updated = await tx.learningProgress.update({
        where: { id: prog.id },
        data: {
          completedLessonIds: [...done],
          status: courseComplete ? 'completed' : 'in_progress',
          completedAt: courseComplete && !prog.completedAt ? new Date() : undefined,
        },
      });
      if (courseComplete && prog.status !== 'completed') {
        await appendEvent(tx, {
          eventName: EVENTS.CourseCompleted,
          tenantId: this.db.tenantId,
          aggregateType: 'course',
          aggregateId: lesson.courseId,
          actorUserId: user.userId,
          payload: { memberId },
        });
      }
      return updated;
    });
    return { progress };
  }

  @Get('learning/progress')
  @RequirePermissions(PERMISSIONS.LEARNING_VIEW)
  async myProgress() {
    const memberId = this.requireMemberId();
    const progress = await this.db.tx((tx) =>
      tx.learningProgress.findMany({ where: { memberId }, orderBy: { startedAt: 'desc' } }),
    );
    return { progress };
  }

  private requireMemberId(): string {
    const memberId = this.cls.get(CLS_MEMBER_ID) as string | undefined;
    if (!memberId) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'You are not a member of this tenant',
      });
    }
    return memberId;
  }
}
