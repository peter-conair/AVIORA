import cookieParser from 'cookie-parser';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/http/all-exceptions.filter';

/** Shared app assembly — used by main.ts and by API E2E tests. */
export async function createApp(options?: { logger?: boolean }): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    abortOnError: false, // surface init errors as exceptions (tests need this)
    ...(options?.logger === false ? { logger: false } : {}),
  });
  app.use(cookieParser());
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz'] });
  app.useGlobalFilters(app.get(AllExceptionsFilter));
  app.enableCors({
    origin: [/^http:\/\/localhost:\d+$/, /^http:\/\/.*\.localhost:\d+$/],
    credentials: true,
  });
  app.enableShutdownHooks();
  return app;
}
