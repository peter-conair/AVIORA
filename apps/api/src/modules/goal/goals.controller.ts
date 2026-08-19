import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';
import { ERROR_CODES, EVENTS, PERMISSIONS } from '@aviora/shared';
import { appendEvent } from '@aviora/db';
import {
  CurrentUser,
  RequirePermissions,
  type AuthenticatedUser,
} from '../../common/auth/decorators';
import { CLS_MEMBER_ID } from '../../common/auth/permissions.guard';
import { TenantDb } from '../../common/db/tenant-db.service';
import { AuditService } from '../../common/audit/audit.service';
import { ZodPipe } from '../../common/validation/zod.pipe';

const createSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  category: z.enum(['personal', 'health', 'learning', 'business', 'family']).optional(),
  targetDate: z.coerce.date().optional(),
});

const updateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  status: z.enum(['active', 'completed', 'archived']).optional(),
});

/** Goals are SELF-scoped: a member sees and manages only their own (docs/07). */
@Controller('goals')
export class GoalsController {
  constructor(
    private readonly db: TenantDb,
    private readonly cls: ClsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions(PERMISSIONS.GOAL_VIEW)
  async list() {
    const memberId = this.requireMemberId();
    const goals = await this.db.tx((tx) =>
      tx.goal.findMany({ where: { memberId }, orderBy: { createdAt: 'desc' } }),
    );
    return { goals };
  }

  @Post()
  @RequirePermissions(PERMISSIONS.GOAL_MANAGE)
  async create(
    @Body(new ZodPipe(createSchema)) body: z.infer<typeof createSchema>,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const memberId = this.requireMemberId();
    const goal = await this.db.tx(async (tx) => {
      const created = await tx.goal.create({
        data: {
          tenantId: this.db.tenantId,
          memberId,
          title: body.title,
          description: body.description,
          category: body.category ?? 'personal',
          targetDate: body.targetDate,
        },
      });
      await appendEvent(tx, {
        eventName: EVENTS.GoalCreated,
        tenantId: this.db.tenantId,
        aggregateType: 'goal',
        aggregateId: created.id,
        actorUserId: user.userId,
        payload: { memberId, title: created.title, category: created.category },
      });
      return created;
    });
    await this.audit.record({
      action: 'goal.create',
      entityType: 'goal',
      entityId: goal.id,
      after: { title: goal.title, category: goal.category },
    });
    return { goal };
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.GOAL_MANAGE)
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateSchema)) body: z.infer<typeof updateSchema>,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const memberId = this.requireMemberId();
    const goal = await this.db.tx(async (tx) => {
      const existing = await tx.goal.findFirst({ where: { id, memberId } });
      if (!existing) {
        throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Goal not found' });
      }
      const completingNow = body.status === 'completed' && existing.status !== 'completed';
      const updated = await tx.goal.update({
        where: { id },
        data: {
          title: body.title,
          description: body.description,
          status: body.status,
          completedAt: completingNow ? new Date() : undefined,
        },
      });
      if (completingNow) {
        await appendEvent(tx, {
          eventName: EVENTS.GoalCompleted,
          tenantId: this.db.tenantId,
          aggregateType: 'goal',
          aggregateId: id,
          actorUserId: user.userId,
          payload: { memberId, title: updated.title },
        });
      }
      return updated;
    });
    return { goal };
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
