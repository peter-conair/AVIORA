import { Body, Controller, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { PERMISSIONS } from '@aviora/shared';
import { RequirePermissions } from '../../common/auth/decorators';
import { ZodPipe } from '../../common/validation/zod.pipe';
import { LearningAuthoringService } from './learning-authoring.service';

const releaseRule = z.object({
  after: z.string().regex(/^(course:[a-z0-9-]{1,60}|stage:[a-z_]{1,40}|days:\d{1,4})$/),
});

const courseSchema = z.object({
  code: z.string().regex(/^[a-z0-9-]{2,60}$/),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).nullish(),
  status: z.enum(['draft', 'published']).default('published'),
  releasePolicy: z.enum(['open', 'on_assignment']).default('open'),
  releaseRule: releaseRule.nullish(),
  lessons: z
    .array(
      z.object({ title: z.string().min(1).max(300), content: z.string().max(20_000).nullish() }),
    )
    .max(200)
    .default([]),
});

const patchSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullish(),
  status: z.enum(['draft', 'published']).optional(),
  releasePolicy: z.enum(['open', 'on_assignment']).optional(),
  releaseRule: releaseRule.nullish(),
});

const lessonSchema = z.object({
  title: z.string().min(1).max(300),
  content: z.string().max(20_000).nullish(),
  /** Appended when absent — the common case is "add the next one". */
  order: z.number().int().min(1).max(500).optional(),
});

/** Authoring courses (docs/10 rows 84–89). */
@Controller()
export class LearningAuthoringController {
  constructor(private readonly authoring: LearningAuthoringService) {}

  @Post('courses')
  @RequirePermissions(PERMISSIONS.LEARNING_MANAGE)
  async create(@Body(new ZodPipe(courseSchema)) body: z.infer<typeof courseSchema>) {
    return { course: await this.authoring.createCourse(body) };
  }

  @Patch('courses/:id')
  @RequirePermissions(PERMISSIONS.LEARNING_MANAGE)
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(patchSchema)) body: z.infer<typeof patchSchema>,
  ) {
    return { course: await this.authoring.updateCourse(id, body) };
  }

  @Post('courses/:id/lessons')
  @RequirePermissions(PERMISSIONS.LEARNING_MANAGE)
  async addLesson(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(lessonSchema)) body: z.infer<typeof lessonSchema>,
  ) {
    return { lesson: await this.authoring.addLesson(id, body) };
  }
}
