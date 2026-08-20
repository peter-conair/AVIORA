import { Controller, Get, Headers, Query } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';
import { PERMISSIONS } from '@aviora/shared';
import {
  CurrentUser,
  RequirePermissions,
  RequirePlatformRoles,
  type AuthenticatedUser,
} from '../../common/auth/decorators';
import { CLS_MEMBER_ID } from '../../common/auth/permissions.guard';
import { ZodPipe } from '../../common/validation/zod.pipe';
import type { TeamActor } from '../team/team-scope.service';
import { AnalyticsService } from './analytics.service';
import { ANALYTICS_WINDOWS, DEFAULT_ANALYTICS_WINDOW, type AnalyticsWindow } from './window';

const PLATFORM_BYPASS = new Set(['PLATFORM_OWNER', 'SUPER_ADMIN']);

const windowSchema = z.enum(ANALYTICS_WINDOWS).default(DEFAULT_ANALYTICS_WINDOW);

/** Analytics OS (docs/28 §5). Four scopes, one set of measures. */
@Controller('analytics')
export class AnalyticsController {
  constructor(
    private readonly analytics: AnalyticsService,
    private readonly cls: ClsService,
  ) {}

  private actor(user: AuthenticatedUser): TeamActor {
    return {
      memberId: (this.cls.get(CLS_MEMBER_ID) as string | undefined) ?? null,
      platformBypass: !!user.platformRole && PLATFORM_BYPASS.has(user.platformRole),
    };
  }

  @Get('me')
  @RequirePermissions(PERMISSIONS.ANALYTICS_SELF_VIEW)
  async me(
    @CurrentUser() user: AuthenticatedUser,
    @Query('window', new ZodPipe(windowSchema)) window: AnalyticsWindow,
    @Headers('accept-language') acceptLanguage?: string,
  ) {
    const locale = acceptLanguage?.split(',')[0]?.trim().slice(0, 2).toLowerCase();
    return await this.analytics.me(this.actor(user), window, locale === 'th' ? 'th' : 'en');
  }

  @Get('team')
  @RequirePermissions(PERMISSIONS.TEAM_ANALYTICS_VIEW)
  async team(
    @CurrentUser() user: AuthenticatedUser,
    @Query('window', new ZodPipe(windowSchema)) window: AnalyticsWindow,
  ) {
    return await this.analytics.team(this.actor(user), window);
  }

  @Get('tenant')
  @RequirePermissions(PERMISSIONS.ANALYTICS_TENANT_VIEW)
  async tenant(@Query('window', new ZodPipe(windowSchema)) window: AnalyticsWindow) {
    return await this.analytics.tenant(window);
  }

  /**
   * Cross-tenant, so the platform ROLE is the gate, not the permission key
   * alone: `TENANT_OWNER` is seeded with every permission in the catalog at
   * TENANT_ALL, `platform.metrics.view` included, and a tenant owner reading
   * other tenants' numbers is the isolation breach the whole platform is built
   * to prevent. The key is still declared — it is what docs/28 §5 names, and
   * it is what a future non-owner platform analyst role will carry.
   */
  @Get('platform')
  @RequirePlatformRoles('PLATFORM_OWNER', 'SUPER_ADMIN')
  @RequirePermissions(PERMISSIONS.PLATFORM_METRICS_VIEW)
  async platform(@Query('window', new ZodPipe(windowSchema)) window: AnalyticsWindow) {
    return await this.analytics.platform(window);
  }
}
