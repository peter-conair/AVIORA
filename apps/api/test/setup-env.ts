import * as path from 'node:path';
import * as dotenv from 'dotenv';

// Load repo-root .env for local runs; CI provides env directly.
dotenv.config({
  path: [path.resolve(process.cwd(), '.env'), path.resolve(process.cwd(), '../../.env')],
});

/**
 * Tests never get the developer sign-in door, whatever the local .env says.
 *
 * Two reasons, and the second is the one that matters. The obvious one: the
 * route sweep enumerates every registered route and holds each to the isolation
 * contract, so a bypass mounted only on somebody's laptop would fail the suite
 * there and pass in CI. The real one: these tests are the description of how
 * the product behaves, and the product does not have this door. A suite that
 * runs with it open is testing a build nobody ships.
 */
delete process.env.AVIORA_DEV_LOGIN;

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
