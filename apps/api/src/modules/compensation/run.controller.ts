import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';
import { ENTITLEMENTS, ERROR_CODES, PERMISSIONS } from '@aviora/shared';
import {
  CurrentUser,
  RequireEntitlements,
  RequirePermissions,
  type AuthenticatedUser,
} from '../../common/auth/decorators';
import { CLS_MEMBER_ID } from '../../common/auth/permissions.guard';
import { ZodPipe } from '../../common/validation/zod.pipe';
import { RunService } from './run.service';

const createSchema = z
  .object({
    planId: z.string().uuid(),
    periodStart: z.coerce.date(),
    periodEnd: z.coerce.date(),
  })
  .refine((v) => v.periodEnd > v.periodStart, {
    message: 'periodEnd must be after periodStart',
    path: ['periodEnd'],
  });

/**
 * Running and approving are permission-scoped; `growth.compensation` gates the
 * member-facing earnings view only, so a tenant that never configured a plan
 * shows its members no compensation surface at all (docs/26 §6).
 */
@Controller('compensation')
export class RunController {
  constructor(
    private readonly runs: RunService,
    private readonly cls: ClsService,
  ) {}

  private memberId(): string {
    const id = this.cls.get(CLS_MEMBER_ID) as string | undefined;
    if (!id) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'You are not a member of this tenant',
      });
    }
    return id;
  }

  @Get('runs')
  @RequirePermissions(PERMISSIONS.COMPENSATION_MANAGE)
  async list() {
    return { runs: await this.runs.list() };
  }

  @Post('runs')
  @RequirePermissions(PERMISSIONS.COMPENSATION_MANAGE)
  async create(
    @Body(new ZodPipe(createSchema)) body: z.infer<typeof createSchema>,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return await this.runs.create(body, user.userId);
  }

  @Post('runs/:id/recompute')
  @RequirePermissions(PERMISSIONS.COMPENSATION_MANAGE)
  async recompute(@Param('id', ParseUUIDPipe) id: string) {
    return { run: await this.runs.recompute(id) };
  }

  @Post('runs/:id/approve')
  @RequirePermissions(PERMISSIONS.COMPENSATION_MANAGE)
  async approve(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return { run: await this.runs.approve(id, user.userId) };
  }

  @Get('runs/:id/entries')
  @RequirePermissions(PERMISSIONS.COMPENSATION_MANAGE)
  async entries(@Param('id', ParseUUIDPipe) id: string) {
    return await this.runs.entries(id);
  }

  @Get('me')
  @RequirePermissions(PERMISSIONS.COMPENSATION_VIEW)
  @RequireEntitlements(ENTITLEMENTS.COMPENSATION)
  async me() {
    return await this.runs.me(this.memberId());
  }
}
