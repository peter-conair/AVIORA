import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
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
import { TrackerService } from './tracker.service';

const entrySchema = z.object({
  subjectId: z.string().uuid(),
  groupLabel: z.string().max(60).nullish(),
});

const markSchema = z.object({
  stepId: z.string().uuid(),
  done: z.boolean(),
});

@Controller('tracker')
export class TrackerController {
  constructor(
    private readonly tracker: TrackerService,
    private readonly cls: ClsService,
  ) {}

  private actor(user: AuthenticatedUser): TeamActor {
    return {
      memberId: (this.cls.get(CLS_MEMBER_ID) as string | undefined) ?? null,
      platformBypass: !!user.platformRole && PLATFORM_BYPASS.has(user.platformRole),
    };
  }

  private locale(value?: string): 'en' | 'th' {
    return value === 'en' ? 'en' : 'th';
  }

  @Get('sheets')
  @RequirePermissions(PERMISSIONS.TRACKER_VIEW)
  async sheets(@Query('locale') locale?: string) {
    return this.tracker.listTemplates(this.locale(locale));
  }

  /** Deliberately before `sheets/:code` — a literal path must not be read as one. */
  @Get('stalled')
  @RequirePermissions(PERMISSIONS.TRACKER_VIEW)
  async stalled(
    @CurrentUser() user: AuthenticatedUser,
    @Query('days') days?: string,
    @Query('locale') locale?: string,
  ) {
    // `days=0` means "everything still open", which is a real question and
    // not the same as "no value given". Treating 0 as absent silently answered
    // a different question than the one asked — and `Number('')` is 0, so the
    // empty case has to be checked before parsing rather than after.
    const parsed = days === undefined || days.trim() === '' ? NaN : Number(days);
    const window = Number.isFinite(parsed) && parsed >= 0 ? Math.min(parsed, 365) : 14;
    return this.tracker.stalled(this.actor(user), window, this.locale(locale));
  }

  @Get('sheets/:code')
  @RequirePermissions(PERMISSIONS.TRACKER_VIEW)
  async sheet(
    @CurrentUser() user: AuthenticatedUser,
    @Param('code') code: string,
    @Query('locale') locale?: string,
  ) {
    return this.tracker.sheet(this.actor(user), code, this.locale(locale));
  }

  @Post('sheets/:code/entries')
  @RequirePermissions(PERMISSIONS.TRACKER_MANAGE)
  async addEntry(
    @Param('code') code: string,
    @Body(new ZodPipe(entrySchema)) body: z.infer<typeof entrySchema>,
    @CurrentUser() user: AuthenticatedUser,
    @Query('locale') locale?: string,
  ) {
    return {
      entry: await this.tracker.addEntry(this.actor(user), code, body, this.locale(locale)),
    };
  }

  @Put('entries/:id/marks')
  @RequirePermissions(PERMISSIONS.TRACKER_MANAGE)
  async setMark(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(markSchema)) body: z.infer<typeof markSchema>,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return { entry: await this.tracker.setMark(this.actor(user), id, body.stepId, body.done) };
  }
}
