/**
 * One-shot: ensure the non-owner login roles exist with their env passwords.
 *
 * Both roles are created here rather than in a migration because a password
 * belongs in an env var, never in a file that is committed. The POLICIES that
 * bind them live in migrations, where they are reviewed like any other schema
 * change.
 */
import { PrismaClient } from '@prisma/client';
import { ensureAppRole, ensurePlatformRole } from '../src/admin';

const owner = new PrismaClient({ datasourceUrl: process.env.AVIORA_DATABASE_URL });

async function main(): Promise<void> {
  await ensureAppRole(owner);
  console.log('✓ aviora_app role ensured');
  // Optional so an existing checkout without the new DSN still provisions the
  // app role rather than failing outright (docs/53).
  if (process.env.AVIORA_PLATFORM_DATABASE_URL) {
    await ensurePlatformRole(owner);
    console.log('✓ aviora_platform role ensured');
  } else {
    console.log('– aviora_platform skipped: AVIORA_PLATFORM_DATABASE_URL not set');
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => owner.$disconnect());
