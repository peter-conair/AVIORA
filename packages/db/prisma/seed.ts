/**
 * AVIORA idempotent seed (Sprint 0 skeleton — docs/23 E00-S8).
 * Safe to run any number of times; running twice yields identical state.
 * Creates: permission catalog, platform admin user (from env).
 * Tenant-scoped data (roles per tenant, plans, entitlements) is created by the
 * tenant-provisioning flow, not here.
 *
 * Run: pnpm --filter @aviora/db db:seed  (owner connection required)
 */
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import { PERMISSIONS, PermissionScope } from '@aviora/shared';

const prisma = new PrismaClient({ datasourceUrl: process.env.AVIORA_DATABASE_URL });

const SCOPED_DEFAULTS: Record<string, PermissionScope> = {
  // keys whose sensible default scope is narrower than TENANT_ALL
  [PERMISSIONS.GOAL_VIEW]: PermissionScope.SELF,
  [PERMISSIONS.GOAL_MANAGE]: PermissionScope.SELF,
  [PERMISSIONS.HEALTH_PROFILE_VIEW]: PermissionScope.SELF,
  [PERMISSIONS.HEALTH_PROFILE_EDIT]: PermissionScope.SELF,
  [PERMISSIONS.TEAM_MEMBER_VIEW]: PermissionScope.DIRECT_TEAM,
  [PERMISSIONS.TEAM_MEMBER_MANAGE]: PermissionScope.DIRECT_TEAM,
  [PERMISSIONS.TEAM_ANALYTICS_VIEW]: PermissionScope.DIRECT_TEAM,
};

async function seedPermissions(): Promise<number> {
  let count = 0;
  for (const key of Object.values(PERMISSIONS)) {
    await prisma.permission.upsert({
      where: { key },
      create: { key, defaultScope: SCOPED_DEFAULTS[key] ?? PermissionScope.TENANT_ALL },
      update: {}, // catalog rows are append-only; scope changes go through migrations
    });
    count++;
  }
  return count;
}

async function seedPlatformAdmin(): Promise<string | null> {
  const email = process.env.AVIORA_SEED_PLATFORM_ADMIN_EMAIL;
  const password = process.env.AVIORA_SEED_PLATFORM_ADMIN_PASSWORD;
  if (!email || !password) {
    console.warn('⚠ AVIORA_SEED_PLATFORM_ADMIN_EMAIL/PASSWORD not set — skipping platform admin');
    return null;
  }
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    if (existing.platformRole !== 'PLATFORM_OWNER') {
      await prisma.user.update({
        where: { email },
        data: { platformRole: 'PLATFORM_OWNER' },
      });
    }
    return existing.id; // never overwrite an existing password on re-seed
  }
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      displayName: 'Platform Admin',
      platformRole: 'PLATFORM_OWNER',
      locale: 'en',
    },
  });
  return user.id;
}

async function main() {
  const permCount = await seedPermissions();
  console.log(`✓ permissions: ${permCount} keys ensured`);

  const adminId = await seedPlatformAdmin();
  console.log(adminId ? `✓ platform admin ensured (${adminId})` : '– platform admin skipped');

  console.log('Seed complete (idempotent).');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
