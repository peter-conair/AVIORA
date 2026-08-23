import { Body, Controller, Get, Put, Query } from '@nestjs/common';
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
import { WeeklyUpdateService } from './weekly-update.service';

const note = z.string().max(4000).nullish();
const updateSchema = z.object({
  progressionNote: note,
  prospectNote: note,
  planNote: note,
  questionNote: note,
});

@Controller('weekly-update')
export class WeeklyUpdateController {
  constructor(
    private readonly weekly: WeeklyUpdateService,
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
  async get(
    @CurrentUser() user: AuthenticatedUser,
    @Query('weekOf') weekOf?: string,
    @Query('memberId') memberId?: string,
  ) {
    return this.weekly.get(this.actor(user), weekOf, memberId);
  }

  @Put()
  @RequirePermissions(PERMISSIONS.TRACKER_MANAGE)
  async put(
    @Body(new ZodPipe(updateSchema)) body: z.infer<typeof updateSchema>,
    @CurrentUser() user: AuthenticatedUser,
    @Query('weekOf') weekOf?: string,
  ) {
    return { update: await this.weekly.upsert(this.actor(user), weekOf, body) };
  }
}
