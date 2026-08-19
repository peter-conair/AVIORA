import * as path from 'node:path';
import * as dotenv from 'dotenv';
// Load root .env when running from apps/api (dev) or repo root (compose/CI).
dotenv.config({
  path: [path.resolve(process.cwd(), '.env'), path.resolve(process.cwd(), '../../.env')],
});

import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/http/all-exceptions.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz'] });
  app.useGlobalFilters(app.get(AllExceptionsFilter));
  app.enableCors({
    origin: [/^http:\/\/localhost:\d+$/, /^http:\/\/.*\.localhost:\d+$/],
    credentials: true,
  });
  app.enableShutdownHooks();

  const port = Number(process.env.AVIORA_API_PORT ?? 3001);
  await app.listen(port);
}

void bootstrap();
