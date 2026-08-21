import { Controller, ForbiddenException, Get, Query } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { ERROR_CODES, PERMISSIONS } from '@aviora/shared';
import { RequirePermissions, RequirePlatformRoles } from '../../common/auth/decorators';
import { CLS_TENANT_ID } from '../../common/tenant/tenant-context.middleware';
import { ObservabilityService } from './observability.service';
import { AlertsService } from './alerts.service';

const days = (raw?: string) => (raw ? Number(raw) : undefined);

/**
 * What an operator can ask about the machinery (docs/36 §4).
 *
 * Platform ROLE, not `platform.metrics.view`: permission keys are granted per
 * tenant, so no key can express "may see across all of them" — the argument
 * analytics settled in docs/28 §1.
 */
@RequirePlatformRoles('PLATFORM_OWNER', 'SUPER_ADMIN')
@Controller('platform/observability')
export class ObservabilityController {
  constructor(
    private readonly observability: ObservabilityService,
    private readonly alerts: AlertsService,
  ) {}

  /**
   * What is firing, and — always — when the checks last ran (docs/42 §1).
   *
   * `lastCheckedAt` is not decoration. "Nothing is firing" from a sweep ninety
   * seconds old means health; the same words from a sweep that last ran
   * yesterday mean the checking stopped, which is the more dangerous state and
   * the one that looks identical without this field.
   */
  @Get('alerts')
  async alerts_(): Promise<unknown> {
    const [checks, lastCheckedAt] = await Promise.all([
      this.alerts.evaluate(),
      this.alerts.lastCheckedAt(),
    ]);
    const firing = checks.filter((c) => c.firing);
    return {
      firing,
      quiet: checks.filter((c) => !c.firing),
      lastCheckedAt,
      thresholds: this.alerts.thresholds,
      note:
        lastCheckedAt === null
          ? 'the sweep has never run: this is what is firing NOW, but nothing is ' +
            'watching between requests'
          : 'firing is evaluated live; lastCheckedAt is when the sweep last ran and ' +
            'could have emailed somebody',
    };
  }

  @Get('queue')
  queue(@Query('days') d?: string) {
    return this.observability.queue(days(d));
  }

  @Get('jobs')
  jobs(@Query('days') d?: string) {
    return this.observability.jobs(days(d));
  }

  @Get('ai')
  ai(@Query('days') d?: string, @Query('tenantId') tenantId?: string) {
    return this.observability.ai(days(d), tenantId);
  }

  @Get('tenants')
  tenants(@Query('days') d?: string) {
    return this.observability.tenants(days(d));
  }
}

/**
 * A tenant asking how much of this they are using should not have to ask us.
 *
 * It is the same computation the platform view runs, narrowed to one tenant, so
 * the two cannot drift into telling different stories about the same tenant.
 */
@Controller('tenant/usage')
export class TenantUsageController {
  constructor(
    private readonly observability: ObservabilityService,
    private readonly cls: ClsService,
  ) {}

  @Get()
  @RequirePermissions(PERMISSIONS.TENANT_SETTINGS_MANAGE)
  async usage(@Query('days') d?: string) {
    const tenantId = this.cls.get<string | undefined>(CLS_TENANT_ID);
    if (!tenantId) {
      // Reachable only if a tenant-scoped route is called without a tenant,
      // which the guards refuse first. Answering "here is everyone's usage"
      // in that case is exactly the bug this check exists to prevent.
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'usage is per tenant, and this request resolved to none',
      });
    }
    const [usage, ai] = await Promise.all([
      this.observability.tenants(days(d), tenantId),
      this.observability.ai(days(d), tenantId),
    ]);
    return {
      window: usage.window,
      tenant: usage.tenants[0] ?? null,
      // Requests and tokens are the tenant's own usage. COST is deliberately
      // absent: it is what the PLATFORM pays a provider, and handing a tenant
      // our provider bill hands them our margin. If a tenant is ever charged
      // for AI, that price is a commercial decision with its own number — not
      // this one leaking out (docs/36 §5).
      ai: {
        requests: ai.usage.reduce((n, u) => n + u.requests, 0),
        inputTokens: ai.usage.reduce((n, u) => n + u.inputTokens, 0),
        outputTokens: ai.usage.reduce((n, u) => n + u.outputTokens, 0),
        byModel: ai.usage.map((u) => ({
          provider: u.provider,
          model: u.model,
          requests: u.requests,
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
        })),
        note: 'usage only — what the platform pays a provider is not a tenant-facing number',
      },
    };
  }
}
