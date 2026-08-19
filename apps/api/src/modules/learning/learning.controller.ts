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

@Controller()
export class LearningController {
  constructor(
    private readonly db: TenantDb,
    private readonly cls: ClsService,
  ) {}

  @Get('courses')
  @RequirePermissions(PERMISSIONS.LEARNING_VIEW)
  async listCourses() {
    const courses = await this.db.tx((tx) =>
      tx.course.findMany({
        where: { status: 'published' },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          code: true,
          title: true,
          description: true,
          lessons: { select: { id: true, order: true, title: true }, orderBy: { order: 'asc' } },
        },
      }),
    );
    return { courses };
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
