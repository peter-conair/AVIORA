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
  // The PWA manifest is a document of the SITE, not a call to the API: a
  // browser asks for /manifest.webmanifest at the web root and will not look
  // for it under a version prefix (docs/30 §5).
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz', 'manifest.webmanifest'] });
  app.useGlobalFilters(app.get(AllExceptionsFilter));
  app.enableCors({
    origin: [/^http:\/\/localhost:\d+$/, /^http:\/\/.*\.localhost:\d+$/],
    credentials: true,
  });
  app.enableShutdownHooks();
  return app;
}
