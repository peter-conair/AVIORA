import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ClsMiddleware, ClsModule } from 'nestjs-cls';
import { LoggerModule } from 'nestjs-pino';
import { newId } from '@aviora/shared';

import { PrismaService } from './common/db/prisma.service';
import { TenantDb } from './common/db/tenant-db.service';
import { AllExceptionsFilter } from './common/http/all-exceptions.filter';
import { TenantContextMiddleware } from './common/tenant/tenant-context.middleware';
import { TenantContextAccessor } from './common/tenant/tenant-context.accessor';
import { HealthController } from './common/health/health.controller';
import { JwtAuthGuard } from './common/auth/jwt-auth.guard';
import { PermissionsGuard } from './common/auth/permissions.guard';
import { EntitlementsGuard } from './common/auth/entitlements.guard';
import { AuditService } from './common/audit/audit.service';
import { EventBus } from './common/events/event-bus';
import { OutboxRelayService } from './common/events/outbox-relay.service';
import { EmailService } from './common/email/email.service';

import { AuthController } from './modules/identity/auth.controller';
import { AuthService } from './modules/identity/auth.service';
import { MembersController } from './modules/identity/members.controller';
import { PlatformController } from './modules/platform/platform.controller';
import { ProvisioningService } from './modules/platform/provisioning.service';
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
import { NotificationHandlers } from './modules/notification/notification.handlers';

@Module({
  imports: [
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
  ],
  controllers: [
    HealthController,
    AuthController,
    MembersController,
    PlatformController,
    PlansController,
    InvitationsController,
    TeamsController,
    GoalsController,
    LearningController,
    DashboardController,
  ],
  providers: [
    PrismaService,
    TenantDb,
    AllExceptionsFilter,
    TenantContextMiddleware,
    TenantContextAccessor,
    AuditService,
    EventBus,
    OutboxRelayService,
    EmailService,
    AuthService,
    ProvisioningService,
    PlansService,
    InvitationsService,
    TeamsService,
    TeamScopeService,
    NotificationHandlers,
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
