import { PrismaClient } from '@prisma/client';

/**
 * Owner client — connects as the table owner (migrations, seeding, platform module).
 * RLS does not apply to the owner; NEVER use this for tenant-scoped request handling.
 */
export function createOwnerClient(): PrismaClient {
  return new PrismaClient({ datasourceUrl: requireEnv('AVIORA_DATABASE_URL') });
}

/**
 * App client — connects as the non-owner `aviora_app` role. RLS is FORCED on
 * tenant-owned tables; combine with `withTenant()` so `app.tenant_id` is set.
 */
export function createAppClient(): PrismaClient {
  return new PrismaClient({ datasourceUrl: requireEnv('AVIORA_APP_DATABASE_URL') });
}

/**
 * A client on an explicitly given DSN — the dedicated-database path (ADR-002,
 * docs/31 §2). Connects as whatever role the DSN names, so a dedicated tenant
 * gets the same RLS treatment as the shared one when the DSN is the app role's.
 * Nothing in the request path builds one of these except the tenant-database
 * resolver, which is the single routing seam.
 */
export function createClientForDsn(dsn: string): PrismaClient {
  return new PrismaClient({ datasourceUrl: dsn });
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

export { PrismaClient } from '@prisma/client';
export { Prisma } from '@prisma/client';
