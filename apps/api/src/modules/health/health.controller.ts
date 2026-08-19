import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';
import { PERMISSIONS } from '@aviora/shared';
import { RequirePermissions } from '../../common/auth/decorators';
import { CLS_MEMBER_ID } from '../../common/auth/permissions.guard';
import { ZodPipe } from '../../common/validation/zod.pipe';
import { HealthService, TRACKED_METRICS } from './health.service';

const profileSchema = z.object({
  lifestyleNotes: z.string().max(4000).optional(),
  focusGoalIds: z.array(z.string().uuid()).max(10).optional(),
});

const habitSchema = z.object({
  code: z.string().regex(/^[a-z0-9-]{2,40}$/),
  name: z.string().min(1).max(120),
  cadence: z.enum(['daily', 'weekly']).optional(),
  targetUnit: z.string().max(20).optional(),
  targetValue: z.number().positive().optional(),
});

const logSchema = z.object({
  logDate: z.coerce.date().optional(),
  value: z.number().optional(),
  completed: z.boolean().optional(),
});

const metricSchema = z.object({
  metric: z.enum(TRACKED_METRICS),
  value: z.number(),
  unit: z.string().min(1).max(20),
  measuredOn: z.coerce.date().optional(),
});

/**
 * Health routes carry their own permission namespace (health.profile.*) and,
 * unlike every other domain, no role grants access to another member's data —
 * only that member's explicit grant does (spec §59).
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthService,
    private readonly cls: ClsService,
  ) {}

  private memberId(): string | null {
    return (this.cls.get(CLS_MEMBER_ID) as string | undefined) ?? null;
  }

  private locale(acceptLanguage?: string): string {
    const first = acceptLanguage?.split(',')[0]?.trim().slice(0, 2).toLowerCase();
    return first === 'th' ? 'th' : 'en';
  }

  @Get('me')
  @RequirePermissions(PERMISSIONS.HEALTH_PROFILE_VIEW)
  async myProfile() {
    const me = this.memberId();
    return { profile: await this.health.profile(me, me ?? '') };
  }

  @Put('me')
  @RequirePermissions(PERMISSIONS.HEALTH_PROFILE_EDIT)
  async saveProfile(@Body(new ZodPipe(profileSchema)) body: z.infer<typeof profileSchema>) {
    return { profile: await this.health.saveProfile(this.memberId(), body) };
  }

  @Get('me/summary')
  @RequirePermissions(PERMISSIONS.HEALTH_PROFILE_VIEW)
  async mySummary(@Headers('accept-language') acceptLanguage?: string) {
    const me = this.memberId();
    return await this.health.summary(me, me ?? '', this.locale(acceptLanguage));
  }

  @Get('habits')
  @RequirePermissions(PERMISSIONS.HEALTH_PROFILE_VIEW)
  async habits() {
    const me = this.memberId();
    return { habits: await this.health.habits(me, me ?? '') };
  }

  @Post('habits')
  @RequirePermissions(PERMISSIONS.HEALTH_PROFILE_EDIT)
  async createHabit(@Body(new ZodPipe(habitSchema)) body: z.infer<typeof habitSchema>) {
    return { habit: await this.health.createHabit(this.memberId(), body) };
  }

  @Post('habits/:id/log')
  @RequirePermissions(PERMISSIONS.HEALTH_PROFILE_EDIT)
  async logHabit(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(logSchema)) body: z.infer<typeof logSchema>,
  ) {
    return { log: await this.health.logHabit(this.memberId(), id, body) };
  }

  @Post('metrics')
  @RequirePermissions(PERMISSIONS.HEALTH_PROFILE_EDIT)
  async recordMetric(@Body(new ZodPipe(metricSchema)) body: z.infer<typeof metricSchema>) {
    return { metric: await this.health.recordMetric(this.memberId(), body) };
  }

  /** A coach reads a member's summary — allowed only with an active grant. */
  @Get('members/:memberId/summary')
  @RequirePermissions(PERMISSIONS.HEALTH_COACH_VIEW)
  async memberSummary(
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Headers('accept-language') acceptLanguage?: string,
  ) {
    return await this.health.summary(this.memberId(), memberId, this.locale(acceptLanguage));
  }

  @Get('grants')
  @RequirePermissions(PERMISSIONS.HEALTH_PROFILE_VIEW)
  async grants() {
    return await this.health.grants(this.memberId());
  }

  @Post('grants/:granteeMemberId')
  @RequirePermissions(PERMISSIONS.HEALTH_PROFILE_EDIT)
  async grant(@Param('granteeMemberId', ParseUUIDPipe) granteeMemberId: string) {
    return { grant: await this.health.grantAccess(this.memberId(), granteeMemberId) };
  }

  @Delete('grants/:granteeMemberId')
  @RequirePermissions(PERMISSIONS.HEALTH_PROFILE_EDIT)
  async revoke(@Param('granteeMemberId', ParseUUIDPipe) granteeMemberId: string) {
    return { grant: await this.health.revokeAccess(this.memberId(), granteeMemberId) };
  }
}
