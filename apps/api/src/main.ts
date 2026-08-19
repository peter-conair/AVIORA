import * as path from 'node:path';
import * as dotenv from 'dotenv';
// Load root .env when running from apps/api (dev) or repo root (compose/CI).
dotenv.config({
  path: [path.resolve(process.cwd(), '.env'), path.resolve(process.cwd(), '../../.env')],
});

import { Logger } from 'nestjs-pino';
import { createApp } from './app.factory';

async function bootstrap() {
  const app = await createApp();
  app.useLogger(app.get(Logger));
  const port = Number(process.env.AVIORA_API_PORT ?? 3021);
  await app.listen(port);
}

void bootstrap();
