import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ClsMiddleware, ClsModule } from 'nestjs-cls';
import { LoggerModule } from 'nestjs-pino';
import { newId } from '@aviora/shared';
import { PrismaService } from './common/db/prisma.service';
import { AllExceptionsFilter } from './common/http/all-exceptions.filter';
import { TenantContextMiddleware } from './common/tenant/tenant-context.middleware';
import { TenantContextAccessor } from './common/tenant/tenant-context.accessor';
import { HealthController } from './common/health/health.controller';

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
    LoggerModule.forRootAsync({
      useFactory: () => ({
        pinoHttp: {
          level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
          transport:
            process.env.NODE_ENV === 'production'
              ? undefined
              : { target: 'pino-pretty', options: { singleLine: true } },
          genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? newId(),
          redact: ['req.headers.authorization', 'req.headers.cookie'],
          autoLogging: { ignore: (req) => req.url === '/healthz' || req.url === '/readyz' },
        },
      }),
    }),
  ],
  controllers: [HealthController],
  providers: [PrismaService, AllExceptionsFilter, TenantContextMiddleware, TenantContextAccessor],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(ClsMiddleware, TenantContextMiddleware).forRoutes('{*path}');
  }
}
