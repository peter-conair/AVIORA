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
import { ENTITLEMENTS, PERMISSIONS, PermissionScope } from '@aviora/shared';
import { SCOPES, SYSTEM_ROLES } from '../src/system-roles';
import { seedGlobalKnowledge } from '../src/knowledge-seeder';

const prisma = new PrismaClient({ datasourceUrl: process.env.AVIORA_DATABASE_URL });

const SCOPED_DEFAULTS: Record<string, PermissionScope> = {
  // keys whose sensible default scope is narrower than TENANT_ALL
  [PERMISSIONS.GOAL_VIEW]: PermissionScope.SELF,
  [PERMISSIONS.GOAL_MANAGE]: PermissionScope.SELF,
  [PERMISSIONS.HEALTH_PROFILE_VIEW]: PermissionScope.SELF,
  [PERMISSIONS.HEALTH_PROFILE_EDIT]: PermissionScope.SELF,
  [PERMISSIONS.TEAM_VIEW]: PermissionScope.DIRECT_TEAM,
  [PERMISSIONS.TEAM_MEMBER_VIEW]: PermissionScope.DIRECT_TEAM,
  [PERMISSIONS.TEAM_MEMBER_MANAGE]: PermissionScope.DIRECT_TEAM,
  [PERMISSIONS.TEAM_ANALYTICS_VIEW]: PermissionScope.DIRECT_TEAM,
  [PERMISSIONS.COMMERCE_ORDER_VIEW]: PermissionScope.SELF,
  [PERMISSIONS.COMMERCE_SUBSCRIPTION_MANAGE]: PermissionScope.SELF,
  [PERMISSIONS.RANK_VIEW]: PermissionScope.SELF,
  [PERMISSIONS.REFERRAL_VIEW]: PermissionScope.SELF,
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

async function seedEntitlements(): Promise<number> {
  let count = 0;
  for (const key of Object.values(ENTITLEMENTS)) {
    await prisma.entitlement.upsert({ where: { key }, create: { key }, update: {} });
    count++;
  }
  return count;
}

/**
 * Repair pass: brings every existing tenant's SYSTEM roles in line with
 * SYSTEM_ROLES (creates missing roles, fixes drifted scopes, removes grants no
 * longer in the definition). Custom tenant roles are never touched.
 */
async function repairSystemRoles(): Promise<{ tenants: number; changes: number }> {
  const permissions = await prisma.permission.findMany({ select: { id: true, key: true } });
  const permByKey = new Map(permissions.map((p) => [p.key, p]));
  const tenants = await prisma.tenant.findMany({ select: { id: true } });
  let changes = 0;

  for (const tenant of tenants) {
    for (const def of SYSTEM_ROLES) {
      let role = await prisma.role.findFirst({
        where: { tenantId: tenant.id, code: def.code },
        select: { id: true },
      });
      if (!role) {
        role = await prisma.role.create({
          data: { tenantId: tenant.id, code: def.code, name: def.name, isSystem: true },
          select: { id: true },
        });
        changes++;
      }
      const desired = new Map<string, string>(
        def.grants === null
          ? permissions.map((p) => [p.id, SCOPES.TENANT_ALL])
          : def.grants.flatMap((g) => {
              const p = permByKey.get(g.key);
              return p ? ([[p.id, g.scope]] as Array<[string, string]>) : [];
            }),
      );
      const current = await prisma.rolePermission.findMany({
        where: { roleId: role.id },
        select: { permissionId: true, scope: true },
      });
      const currentById = new Map(current.map((c) => [c.permissionId, c.scope]));

      for (const [permissionId, scope] of desired) {
        const existing = currentById.get(permissionId);
        if (existing === undefined) {
          await prisma.rolePermission.create({
            data: { tenantId: tenant.id, roleId: role.id, permissionId, scope },
          });
          changes++;
        } else if (existing !== scope) {
          await prisma.rolePermission.update({
            where: { roleId_permissionId: { roleId: role.id, permissionId } },
            data: { scope },
          });
          changes++;
        }
      }
      for (const c of current) {
        if (!desired.has(c.permissionId)) {
          await prisma.rolePermission.delete({
            where: { roleId_permissionId: { roleId: role.id, permissionId: c.permissionId } },
          });
          changes++;
        }
      }
    }
  }
  // Backfill: anyone holding an active leadership must carry the LEADER role.
  // (Leaders assigned before the role existed would otherwise have no scope.)
  for (const tenant of tenants) {
    const leaderRole = await prisma.role.findFirst({
      where: { tenantId: tenant.id, code: 'LEADER' },
      select: { id: true },
    });
    if (!leaderRole) continue;
    const leaderships = await prisma.teamLeadership.findMany({
      where: { tenantId: tenant.id, status: 'active' },
      select: { memberId: true },
      distinct: ['memberId'],
    });
    for (const l of leaderships) {
      const has = await prisma.memberRole.findFirst({
        where: { memberId: l.memberId, roleId: leaderRole.id },
      });
      if (!has) {
        await prisma.memberRole.create({
          data: { tenantId: tenant.id, memberId: l.memberId, roleId: leaderRole.id },
        });
        changes++;
      }
    }
  }

  return { tenants: tenants.length, changes };
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

  const entCount = await seedEntitlements();
  console.log(`✓ entitlements: ${entCount} keys ensured`);

  const knowledge = await seedGlobalKnowledge(prisma);
  console.log(
    `✓ global knowledge: ${knowledge.nodes} nodes, ${knowledge.products} products (2 brands)`,
  );

  const repaired = await repairSystemRoles();
  console.log(
    `✓ system roles: ${repaired.tenants} tenant(s) checked, ${repaired.changes} grant change(s)`,
  );

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
