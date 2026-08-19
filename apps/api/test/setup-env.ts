import * as path from 'node:path';
import * as dotenv from 'dotenv';

// Load repo-root .env for local runs; CI provides env directly.
dotenv.config({
  path: [path.resolve(process.cwd(), '.env'), path.resolve(process.cwd(), '../../.env')],
});

/**
 * The outbox relay is cross-tenant by design (FOR UPDATE SKIP LOCKED), so an
 * API server pointed at the same database will drain the events these tests
 * assert on — producing failures that look like product bugs. Fail fast with
 * the actual cause instead.
 */
export async function setup(): Promise<void> {
  const apiPort = Number(process.env.AVIORA_API_PORT ?? 3021);
  const probe = await fetch(`http://127.0.0.1:${apiPort}/healthz`, {
    signal: AbortSignal.timeout(400),
  }).catch(() => null);

  if (probe?.ok) {
    throw new Error(
      `An API server is running on port ${apiPort} against this database. Its outbox relay ` +
        `would drain the events these tests rely on. Stop it first:\n` +
        `  kill $(lsof -t -iTCP:${apiPort} -sTCP:LISTEN)`,
    );
  }
}
