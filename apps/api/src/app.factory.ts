import cookieParser from 'cookie-parser';
import { raw } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/http/all-exceptions.filter';
import { MAX_LESSON_ASSET_BYTES } from './modules/learning/learning-media.service';

/** Shared app assembly — used by main.ts and by API E2E tests. */
export async function createApp(options?: { logger?: boolean }): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    abortOnError: false, // surface init errors as exceptions (tests need this)
    ...(options?.logger === false ? { logger: false } : {}),
  });
  app.use(cookieParser());
  /**
   * Lesson media arrives as raw bytes on ONE path (docs/73 §7).
   *
   * Two things this deliberately does not do. It does not raise the global JSON
   * limit — a 200 MB ceiling on every route in the API is a denial-of-service
   * surface bought to solve an upload problem. And it does not base64 the body
   * the way photo upload does: a third more bytes over the wire is tolerable
   * for a 4 MB photograph and is not for a video.
   *
   * The whole file is still buffered in memory here, which is the honest limit
   * of this approach. Authoring is done by administrators and is rare, so it is
   * survivable; multipart streaming is the follow-up, and the trigger for
   * building it is the first tenant who cannot upload the file they have.
   */
  const rawUpload = raw({ type: () => true, limit: MAX_LESSON_ASSET_BYTES });
  app.use('/api/v1/learning/assets', (req: Request, res: Response, next: NextFunction) => {
    // A mounted path matches its SUBPATHS too, and `…/assets/external` sends
    // JSON — it registers a video that lives on somebody else's server and has
    // no bytes at all. Without this guard the raw parser swallowed that body
    // and the route answered "lessonId Required" about a field that was right
    // there in the request. Only the exact path takes bytes.
    if (req.path !== '/') return next();
    return rawUpload(req, res, next);
  });
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
