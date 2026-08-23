import { Body, Controller, Get, Param, ParseUUIDPipe, Put, Query } from '@nestjs/common';
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
import { ChecklistService } from './checklist.service';

const logSchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  done: z.boolean(),
});

/**
 * The daily checklist (docs/60). Reuses `tracker.*` permissions rather than
 * minting a pair of its own: both are the coaching sheets, held by the same
 * people, and a third permission nobody can tell apart from the second is a
 * cost with no reader.
 */
@Controller('checklist')
export class ChecklistController {
  constructor(
    private readonly checklist: ChecklistService,
    private readonly cls: ClsService,
  ) {}

  private actor(user: AuthenticatedUser): TeamActor {
    return {
      memberId: (this.cls.get(CLS_MEMBER_ID) as string | undefined) ?? null,
      platformBypass: !!user.platformRole && PLATFORM_BYPASS.has(user.platformRole),
    };
  }

  @Get()
  @RequirePermissions(PERMISSIONS.TRACKER_VIEW)
  async week(
    @CurrentUser() user: AuthenticatedUser,
    @Query('weekOf') weekOf?: string,
    @Query('memberId') memberId?: string,
    @Query('locale') locale?: string,
  ) {
    return this.checklist.week(this.actor(user), weekOf, memberId, locale === 'en' ? 'en' : 'th');
  }

  @Put('items/:id')
  @RequirePermissions(PERMISSIONS.TRACKER_MANAGE)
  async setLog(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(logSchema)) body: z.infer<typeof logSchema>,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.checklist.setLog(this.actor(user), id, body.date, body.done);
  }
}
