import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';
import { PERMISSIONS } from '@aviora/shared';
import {
  CurrentUser,
  RequirePermissions,
  type AuthenticatedUser,
} from '../../common/auth/decorators';
import { CLS_MEMBER_ID, PLATFORM_BYPASS } from '../../common/auth/permissions.guard';
import { ZodPipe } from '../../common/validation/zod.pipe';
import type { TeamActor } from '../team/team-scope.service';
import { LearningAssignmentService } from './learning-assignment.service';

const assignSchema = z.object({
  // A list, always. The leader's real unit of work is "these six people", and
  // an endpoint that took one member would be called six times by a screen
  // that already knows all six.
  memberIds: z.array(z.string().uuid()).min(1).max(500),
  courseId: z.string().uuid(),
  dueAt: z.coerce.date().nullish(),
  reason: z.string().max(500).nullish(),
});

const holdSchema = z.object({
  memberIds: z.array(z.string().uuid()).min(1).max(500),
  courseId: z.string().uuid(),
  // Required, and the database says so too. A hold the member cannot see the
  // reason for is how this feature becomes a way of keeping somebody dependent
  // (docs/73 §5).
  reason: z.string().min(1).max(500),
});

/**
 * The leader's side of releasing training (docs/73 §9) — docs/10 rows 93–94,
 * finally built, plus the board that makes them usable for a real team.
 */
@Controller('learning/assignments')
export class LearningAssignmentController {
  constructor(
    private readonly assignments: LearningAssignmentService,
    private readonly cls: ClsService,
  ) {}

  private actor(user: AuthenticatedUser): TeamActor {
    return {
      memberId: (this.cls.get(CLS_MEMBER_ID) as string | undefined) ?? null,
      platformBypass: !!user.platformRole && PLATFORM_BYPASS.has(user.platformRole),
    };
  }

  @Get('board')
  @RequirePermissions(PERMISSIONS.LEARNING_ASSIGN)
  async board(@CurrentUser() user: AuthenticatedUser) {
    return this.assignments.board(this.actor(user));
  }

  @Get()
  @RequirePermissions(PERMISSIONS.LEARNING_ASSIGN)
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('memberId', ParseUUIDPipe) memberId: string,
  ) {
    return { assignments: await this.assignments.forMember(this.actor(user), memberId) };
  }

  @Post()
  @RequirePermissions(PERMISSIONS.LEARNING_ASSIGN)
  async assign(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodPipe(assignSchema)) body: z.infer<typeof assignSchema>,
  ) {
    return {
      assignments: await this.assignments.assign(this.actor(user), {
        memberIds: body.memberIds,
        courseId: body.courseId,
        dueAt: body.dueAt ?? null,
        reason: body.reason ?? null,
      }),
    };
  }

  @Post('hold')
  @RequirePermissions(PERMISSIONS.LEARNING_ASSIGN)
  async hold(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodPipe(holdSchema)) body: z.infer<typeof holdSchema>,
  ) {
    return { assignments: await this.assignments.hold(this.actor(user), body) };
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.LEARNING_ASSIGN)
  async withdraw(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.assignments.withdraw(this.actor(user), id);
  }
}
