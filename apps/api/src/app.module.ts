import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ClsMiddleware, ClsModule } from 'nestjs-cls';
import { LoggerModule } from 'nestjs-pino';
import { newId } from '@aviora/shared';

import { CoreModule } from './common/core.module';
import { AllExceptionsFilter } from './common/http/all-exceptions.filter';
import { TenantContextMiddleware } from './common/tenant/tenant-context.middleware';
import { TenantContextAccessor } from './common/tenant/tenant-context.accessor';
import { HealthController as HealthCheckController } from './common/health/health.controller';
import { JwtAuthGuard } from './common/auth/jwt-auth.guard';
import { PermissionsGuard } from './common/auth/permissions.guard';
import { EntitlementsGuard } from './common/auth/entitlements.guard';
import { TenantDatabaseGuard } from './common/db/tenant-database.guard';
import { EventBus } from './common/events/event-bus';
import { OutboxRelayService } from './common/events/outbox-relay.service';
import { EmailModule } from './common/email/email.module';

import { AuthController } from './modules/identity/auth.controller';
import { AuthService } from './modules/identity/auth.service';
import { MembersController } from './modules/identity/members.controller';
import { PlatformController } from './modules/platform/platform.controller';
import { ProvisioningService } from './modules/platform/provisioning.service';
import { TenantDatabaseController } from './modules/platform/tenant-database.controller';
import { TenantDatabaseService } from './modules/platform/tenant-database.service';
import { PlansController } from './modules/membership/plans.controller';
import { PlansService } from './modules/membership/plans.service';
import { InvitationsController } from './modules/membership/invitations.controller';
import { InvitationsService } from './modules/membership/invitations.service';
import { TeamsController } from './modules/team/teams.controller';
import { TeamsService } from './modules/team/teams.service';
import { TeamScopeService } from './modules/team/team-scope.service';
import { GoalsController } from './modules/goal/goals.controller';
import { LearningController } from './modules/learning/learning.controller';
import { DashboardController } from './modules/analytics/dashboard.controller';
import { AnalyticsController } from './modules/analytics/analytics.controller';
import { AnalyticsService } from './modules/analytics/analytics.service';
import { CoachController } from './modules/analytics/coach.controller';
import { CoachService } from './modules/analytics/coach.service';
import { NotificationHandlers } from './modules/notification/notification.handlers';
import { NotificationsController } from './modules/notification/notifications.controller';
import { NotificationsService } from './modules/notification/notifications.service';
import { CrmController } from './modules/crm/crm.controller';
import { CrmService } from './modules/crm/crm.service';
import { CrmScopeService } from './modules/crm/crm-scope.service';
import { AuditController } from './modules/audit/audit.controller';
import { KnowledgeController } from './modules/knowledge/knowledge.controller';
import { KnowledgeService } from './modules/knowledge/knowledge.service';
import { HealthController } from './modules/health/health.controller';
import { HealthService } from './modules/health/health.service';
import { HealthAccessService } from './modules/health/health-access.service';
import { FieldEncryptionService } from './common/crypto/field-encryption.service';
import { CommunityController } from './modules/community/community.controller';
import { CommunityService } from './modules/community/community.service';
import { ChallengeController } from './modules/challenge/challenge.controller';
import { ChallengeService } from './modules/challenge/challenge.service';
import { GamificationController } from './modules/gamification/gamification.controller';
import { GamificationService } from './modules/gamification/gamification.service';
import { GamificationHandlers } from './modules/gamification/gamification.handlers';
import { AiController } from './modules/ai/ai.controller';
import { AiService } from './modules/ai/ai.service';
import { AnthropicProvider } from './modules/ai/anthropic.provider';
import { GroundedProvider } from './modules/ai/grounded.provider';
import { RuleController } from './modules/automation/rule.controller';
import { RuleService } from './modules/automation/rule.service';
import { AutomationEngine } from './modules/automation/automation.engine';
import { AutomationHandlers } from './modules/automation/automation.handlers';
import { ActionAdapters } from './modules/automation/action-adapters';
import { RewardController } from './modules/reward/reward.controller';
import { RewardService } from './modules/reward/reward.service';
import { CommerceModule } from './modules/commerce/commerce.module';
import { GrowthModule } from './modules/growth/growth.module';
import { CompensationModule } from './modules/compensation/compensation.module';
import { TenantConfigModule } from './modules/tenant-config/tenant-config.module';
import { IntegrationModule } from './modules/integration/integration.module';
import { SsoModule } from './modules/sso/sso.module';
import { LogContextInterceptor } from './common/observability/log-context.interceptor';
import { SchedulerModule } from './modules/scheduler/scheduler.module';
import { ObservabilityModule } from './modules/observability/observability.module';
import { WebhookHandlers } from './modules/integration/webhook.handlers';

@Module({
  imports: [
    CoreModule,
    ClsModule.forRoot({
      global: true,
      middleware: {
        // Mounted manually below so it also covers routes excluded from the
        // global prefix (/healthz, /readyz) and always runs before TenantContext.
        mount: false,
        generateId: true,
        idGenerator: (req) => (req.headers['x-request-id'] as string | undefined) ?? newId(),
      },
    }),
    JwtModule.register({ global: true }),
    LoggerModule.forRootAsync({
      useFactory: () => ({
        pinoHttp: {
          level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
          // pino-pretty runs a worker thread — dev terminals only; never in
          // production or test processes (crashes under vitest forks).
          transport:
            process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'test'
              ? undefined
              : { target: 'pino-pretty', options: { singleLine: true } },
          genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? newId(),
          redact: ['req.headers.authorization', 'req.headers.cookie'],
          autoLogging: { ignore: (req) => req.url === '/healthz' || req.url === '/readyz' },
        },
      }),
    }),
    CommerceModule,
    GrowthModule,
    CompensationModule,
    TenantConfigModule,
    IntegrationModule,
    SsoModule,
    SchedulerModule,
    EmailModule,
    ObservabilityModule,
  ],
  controllers: [
    HealthCheckController,
    AuthController,
    MembersController,
    PlatformController,
    // The tenant-database map and dry run live beside the other platform
    // routes because they need the owner client and the platform-role guard,
    // both of which are AppModule-scoped (docs/31 §4).
    TenantDatabaseController,
    PlansController,
    InvitationsController,
    TeamsController,
    GoalsController,
    LearningController,
    DashboardController,
    NotificationsController,
    CrmController,
    AuditController,
    KnowledgeController,
    AiController,
    HealthController,
    CommunityController,
    ChallengeController,
    GamificationController,
    // Automation and rewards are registered here rather than as their own
    // modules because both reach for AppModule-scoped collaborators: the
    // engine subscribes to EventBus, and rewards delegate points and badges to
    // GamificationService (docs/27 §1, §2).
    RuleController,
    RewardController,
    // Analytics and the team coach stay here for the same reason: the coach
    // reaches for AiService, and the analytics service for HealthService and
    // TeamScopeService, all AppModule-scoped (docs/28 §1, §4).
    AnalyticsController,
    CoachController,
  ],
  providers: [
    AllExceptionsFilter,
    TenantContextMiddleware,
    TenantContextAccessor,
    EventBus,
    OutboxRelayService,
    AuthService,
    ProvisioningService,
    TenantDatabaseService,
    PlansService,
    InvitationsService,
    TeamsService,
    TeamScopeService,
    NotificationHandlers,
    NotificationsService,
    // A webhook is one more handler on the existing relay (docs/30 §1), so its
    // registration sits here beside the bus with every other *Handlers class;
    // the dispatcher it calls is owned by IntegrationModule.
    WebhookHandlers,
    CrmService,
    CrmScopeService,
    KnowledgeService,
    HealthService,
    HealthAccessService,
    CommunityService,
    ChallengeService,
    GamificationService,
    GamificationHandlers,
    RuleService,
    AutomationEngine,
    AutomationHandlers,
    ActionAdapters,
    RewardService,
    FieldEncryptionService,
    AiService,
    AnthropicProvider,
    GroundedProvider,
    AnalyticsService,
    CoachService,
    // First in the chain on purpose: "read-only at the API edge" (docs/31 §2)
    // means the refusal happens before authentication, permissions or any
    // handler gets a chance to write something the migration would discard.
    // After the guards, so what it logs is what the platform RESOLVED rather
    // than what the caller claimed in a header (docs/36 §2).
    { provide: APP_INTERCEPTOR, useClass: LogContextInterceptor },
    { provide: APP_GUARD, useClass: TenantDatabaseGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_GUARD, useClass: EntitlementsGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(ClsMiddleware, TenantContextMiddleware).forRoutes('{*path}');
  }
}
