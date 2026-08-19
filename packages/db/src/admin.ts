import type { PrismaClient } from '@prisma/client';

/**
 * Ensures the non-owner `aviora_app` role exists, can log in, and uses the
 * password from AVIORA_APP_DATABASE_URL. Idempotent. Owner connection required.
 * (The migration creates the role NOLOGIN + grants; the password never lives in
 * migration SQL — it comes from the environment.)
 */
export async function ensureAppRole(owner: PrismaClient, appDatabaseUrl?: string): Promise<void> {
  const url = appDatabaseUrl ?? process.env.AVIORA_APP_DATABASE_URL;
  if (!url) throw new Error('AVIORA_APP_DATABASE_URL not set');
  const password = new URL(url).password;
  if (!password) throw new Error('AVIORA_APP_DATABASE_URL has no password');
  if (password.includes("'")) throw new Error('app role password must not contain single quotes');

  await owner.$executeRawUnsafe(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aviora_app') THEN
        CREATE ROLE aviora_app NOLOGIN;
      END IF;
    END $$;
  `);
  await owner.$executeRawUnsafe(
    `ALTER ROLE aviora_app WITH LOGIN PASSWORD '${decodeURIComponent(password)}' NOBYPASSRLS`,
  );
}
