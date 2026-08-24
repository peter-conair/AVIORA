import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ERROR_CODES } from '@aviora/shared';
import { Prisma, type Tx } from '@aviora/db';
import { TenantDb } from '../../common/db/tenant-db.service';
import { AuditService } from '../../common/audit/audit.service';

export interface CreateCourseInput {
  code: string;
  title: string;
  description?: string | null;
  status: 'draft' | 'published';
  releasePolicy: 'open' | 'on_assignment';
  releaseRule?: { after: string } | null;
  lessons: Array<{ title: string; content?: string | null }>;
}

export interface AddLessonInput {
  title: string;
  content?: string | null;
  order?: number;
}

/**
 * Creating courses and lessons (docs/10 rows 84–89, unbuilt until now).
 *
 * The gap this closes is not convenience. Course content belongs to the TENANT
 * — docs/67 §2 and docs/62 §2 both say the platform supplies the structure and
 * the business supplies the words — and without these routes the only way to
 * get a real curriculum into a tenant was to write it into this codebase's
 * seed, which is the thing those two paragraphs forbid.
 */
@Injectable()
export class LearningAuthoringService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
  ) {}

  async createCourse(input: CreateCourseInput) {
    const course = await this.db
      .tx(async (tx) => {
        const created = await tx.course.create({
          data: {
            tenantId: this.db.tenantId,
            code: input.code,
            title: input.title,
            description: input.description ?? null,
            status: input.status,
            releasePolicy: input.releasePolicy,
            releaseRule: input.releaseRule ?? undefined,
          },
        });
        if (input.lessons.length > 0) {
          await tx.lesson.createMany({
            data: input.lessons.map((lesson, index) => ({
              tenantId: this.db.tenantId,
              courseId: created.id,
              order: index + 1,
              title: lesson.title,
              content: lesson.content ?? null,
            })),
          });
        }
        return this.withLessons(tx, created.id);
      })
      .catch((e: unknown) => {
        if ((e as { code?: string } | null)?.code !== 'P2002') throw e;
        throw new ConflictException({
          code: ERROR_CODES.CONFLICT,
          message: `A course with the code "${input.code}" already exists`,
        });
      });

    await this.audit.record({
      action: 'learning.course.create',
      entityType: 'course',
      entityId: course.id,
      after: {
        code: course.code,
        status: course.status,
        releasePolicy: course.releasePolicy,
        lessons: course.lessons.length,
      },
    });
    return course;
  }

  async updateCourse(
    id: string,
    input: {
      title?: string;
      description?: string | null;
      status?: 'draft' | 'published';
      releasePolicy?: 'open' | 'on_assignment';
      releaseRule?: { after: string } | null;
    },
  ) {
    const { before, after } = await this.db.tx(async (tx) => {
      const existing = await tx.course.findFirst({ where: { id } });
      if (!existing) {
        throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Course not found' });
      }
      await tx.course.update({
        where: { id },
        data: {
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.releasePolicy === undefined ? {} : { releasePolicy: input.releasePolicy }),
          // An explicit null CLEARS the rule; absent leaves it alone. Without
          // that distinction there is no way to say "from now on a person
          // decides", which is a thing a tenant will want to say.
          ...(input.releaseRule === undefined
            ? {}
            : { releaseRule: input.releaseRule ?? Prisma.DbNull }),
        },
      });
      return { before: existing, after: await this.withLessons(tx, id) };
    });

    await this.audit.record({
      action: 'learning.course.update',
      entityType: 'course',
      entityId: id,
      before: { status: before.status, releasePolicy: before.releasePolicy },
      after: { status: after.status, releasePolicy: after.releasePolicy },
    });
    return after;
  }

  /**
   * Appends by default. An explicit order is honoured, and a collision is
   * refused rather than quietly renumbering the lessons around it — a course
   * whose weeks reorder themselves because somebody added one is worse than an
   * error message.
   */
  async addLesson(courseId: string, input: AddLessonInput) {
    const lesson = await this.db
      .tx(async (tx) => {
        const course = await tx.course.findFirst({
          where: { id: courseId },
          select: { id: true },
        });
        if (!course) {
          throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Course not found' });
        }
        const last = await tx.lesson.findFirst({
          where: { courseId },
          orderBy: { order: 'desc' },
          select: { order: true },
        });
        return tx.lesson.create({
          data: {
            tenantId: this.db.tenantId,
            courseId,
            order: input.order ?? (last?.order ?? 0) + 1,
            title: input.title,
            content: input.content ?? null,
          },
        });
      })
      .catch((e: unknown) => {
        if ((e as { code?: string } | null)?.code !== 'P2002') throw e;
        throw new ConflictException({
          code: ERROR_CODES.CONFLICT,
          message: 'This course already has a lesson at that position',
        });
      });

    await this.audit.record({
      action: 'learning.lesson.create',
      entityType: 'course',
      entityId: courseId,
      after: { lessonId: lesson.id, order: lesson.order },
    });
    return lesson;
  }

  private withLessons(tx: Tx, id: string) {
    return tx.course.findFirstOrThrow({
      where: { id },
      include: { lessons: { orderBy: { order: 'asc' } } },
    });
  }
}
