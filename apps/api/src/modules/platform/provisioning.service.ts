import { ConflictException, Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { ERROR_CODES, EVENTS, PermissionScope, newId } from '@aviora/shared';
import { appendEvent, SYSTEM_ROLES } from '@aviora/db';
import { PrismaService } from '../../common/db/prisma.service';
import { AuditService } from '../../common/audit/audit.service';

export interface CreateTenantInput {
  code: string;
  name: string;
  slug: string;
  tenantType?: string;
  defaultLanguage?: string;
  timezone?: string;
  adminEmail: string;
  adminDisplayName: string;
  adminPassword?: string; // omitted when the admin user already exists
}

/**
 * System roles and their scopes come from @aviora/db SYSTEM_ROLES — the same
 * definition the seed's repair pass applies to already-provisioned tenants.
 * Never derive scope from permission.defaultScope: that is catalog metadata
 * which may predate a scope change and would silently over-grant.
 */

/**
 * Tenant provisioning saga (docs/03 §6): tenant → system roles → admin user →
 * member + role → demo course → TenantCreated to outbox — one transaction.
 * Runs on the owner client (platform-scope), with app.tenant_id set so the
 * flow also works when the owner is not RLS-exempt in production.
 */
@Injectable()
export class ProvisioningService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async createTenant(input: CreateTenantInput, actorUserId: string) {
    const owner = this.prisma.owner;
    const dup = await owner.tenant.findFirst({
      where: { OR: [{ code: input.code }, { slug: input.slug }] },
      select: { id: true },
    });
    if (dup) {
      throw new ConflictException({
        code: ERROR_CODES.CONFLICT,
        message: 'Tenant code or slug already in use',
      });
    }
    const permissions = await owner.permission.findMany({
      select: { id: true, key: true, defaultScope: true },
    });
    const adminPasswordHash = input.adminPassword
      ? await argon2.hash(input.adminPassword, { type: argon2.argon2id })
      : null;

    const result = await owner.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: {
          code: input.code,
          name: input.name,
          slug: input.slug,
          tenantType: input.tenantType ?? 'wellness_business',
          defaultLanguage: input.defaultLanguage ?? 'th',
          timezone: input.timezone ?? 'Asia/Bangkok',
        },
      });
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenant.id}, true)`;

      // system roles (canonical definition — see SYSTEM_ROLES)
      const permByKey = new Map(permissions.map((p) => [p.key, p]));
      const roleIdByCode = new Map<string, string>();
      for (const def of SYSTEM_ROLES) {
        const role = await tx.role.create({
          data: { tenantId: tenant.id, code: def.code, name: def.name, isSystem: true },
        });
        roleIdByCode.set(def.code, role.id);
        await tx.rolePermission.createMany({
          data:
            def.grants === null
              ? permissions.map((p) => ({
                  tenantId: tenant.id,
                  roleId: role.id,
                  permissionId: p.id,
                  scope: PermissionScope.TENANT_ALL,
                }))
              : def.grants.flatMap((g) => {
                  const p = permByKey.get(g.key);
                  return p
                    ? [
                        {
                          tenantId: tenant.id,
                          roleId: role.id,
                          permissionId: p.id,
                          scope: g.scope,
                        },
                      ]
                    : [];
                }),
        });
      }
      const ownerRole = { id: roleIdByCode.get('TENANT_OWNER')! };

      // tenant admin (existing global user is linked, new one is created)
      let adminUser = await tx.user.findUnique({
        where: { email: input.adminEmail.toLowerCase().trim() },
      });
      if (!adminUser) {
        if (!adminPasswordHash) {
          throw new ConflictException({
            code: ERROR_CODES.VALIDATION_FAILED,
            message: 'adminPassword is required when the admin user does not exist yet',
          });
        }
        adminUser = await tx.user.create({
          data: {
            email: input.adminEmail.toLowerCase().trim(),
            passwordHash: adminPasswordHash,
            displayName: input.adminDisplayName,
            locale: input.defaultLanguage ?? 'th',
          },
        });
      }
      await tx.tenantMembership.create({
        data: { tenantId: tenant.id, userId: adminUser.id },
      });
      const adminMember = await tx.member.create({
        data: {
          tenantId: tenant.id,
          userId: adminUser.id,
          displayName: input.adminDisplayName,
        },
      });
      await tx.memberRole.create({
        data: { tenantId: tenant.id, memberId: adminMember.id, roleId: ownerRole.id },
      });

      // seeded demo course (Slice-1 learning journey)
      const course = await tx.course.create({
        data: {
          tenantId: tenant.id,
          code: 'getting-started',
          title: 'Getting Started with Healthy Living',
          description: 'A short introduction journey for new members.',
        },
      });
      await tx.lesson.createMany({
        data: [
          { tenantId: tenant.id, courseId: course.id, order: 1, title: 'Welcome & your goals' },
          { tenantId: tenant.id, courseId: course.id, order: 2, title: 'Daily healthy habits' },
          { tenantId: tenant.id, courseId: course.id, order: 3, title: 'Joining your community' },
        ].map((l) => ({ ...l, id: newId() })),
      });

      await appendEvent(tx, {
        eventName: EVENTS.TenantCreated,
        tenantId: tenant.id,
        aggregateType: 'tenant',
        aggregateId: tenant.id,
        actorUserId,
        payload: { code: tenant.code, name: tenant.name, slug: tenant.slug },
      });

      return { tenant, adminUserId: adminUser.id, adminMemberId: adminMember.id };
    });

    await this.audit.record({
      action: 'platform.tenant.create',
      entityType: 'tenant',
      entityId: result.tenant.id,
      after: { code: result.tenant.code, name: result.tenant.name, slug: result.tenant.slug },
      tenantId: result.tenant.id,
    });
    return result;
  }

  listTenants() {
    return this.prisma.owner.tenant.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        code: true,
        name: true,
        slug: true,
        tenantType: true,
        status: true,
        defaultLanguage: true,
        timezone: true,
        createdAt: true,
      },
    });
  }
}
