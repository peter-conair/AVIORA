import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import { ERROR_CODES } from '@aviora/shared';
import { TenantDb } from '../db/tenant-db.service';
import {
  REQUIRED_PERMISSIONS,
  REQUIRED_PLATFORM_ROLES,
  type AuthenticatedUser,
} from './decorators';

export const CLS_MEMBER_ID = 'memberId';
/**
 * The permission keys this caller actually holds. The guard has already paid
 * for the lookup; a handler that needs to widen or narrow a RESPONSE (never a
 * decision about access — that is the guard's) can read it instead of asking
 * the database the same question again.
 */
export const CLS_PERMISSIONS = 'permissionKeys';
const PLATFORM_BYPASS = new Set(['PLATFORM_OWNER', 'SUPER_ADMIN']);

/**
 * Global authorization guard: platform-role routes and tenant permission-key
 * routes (docs/07). Resolves the caller's Member in the current tenant and
 * stores memberId in CLS for downstream services.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly cls: ClsService,
    private readonly db: TenantDb,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const platformRoles = this.reflector.getAllAndOverride<string[]>(REQUIRED_PLATFORM_ROLES, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    const req = ctx.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    const user = req.user;

    if (platformRoles?.length) {
      if (!user?.platformRole || !platformRoles.includes(user.platformRole)) {
        throw new ForbiddenException({
          code: ERROR_CODES.FORBIDDEN,
          message: 'Platform role required',
        });
      }
      return true;
    }

    const required = this.reflector.getAllAndOverride<string[]>(REQUIRED_PERMISSIONS, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    // A route that requires no permission still requires BELONGING when it is
    // tenant-scoped. Otherwise any signed-in person reads another tenant's data
    // by changing one header, and "no permission needed" quietly becomes "no
    // tenant needed". RLS does not save us: the request sets app.tenant_id to
    // whatever was asked for.
    if (!required?.length) {
      if (!user) return true; // public route — JwtAuthGuard already decided
      if (user.platformRole && PLATFORM_BYPASS.has(user.platformRole)) return true;
      if (!this.db.tenantIdOrNull) return true; // not tenant-scoped
      await this.assertMember(user);
      return true;
    }

    if (!user) return false; // JwtAuthGuard already rejected public-less routes

    if (user.platformRole && PLATFORM_BYPASS.has(user.platformRole)) return true;

    const tenantId = this.db.tenantIdOrNull;
    if (!tenantId) {
      throw new ForbiddenException({
        code: ERROR_CODES.TENANT_NOT_RESOLVED,
        message: 'Tenant context required for this operation',
      });
    }

    const granted = await this.db.tx(async (tx) => {
      const member = await tx.member.findFirst({
        where: { userId: user.userId, status: 'active' },
        select: { id: true },
      });
      if (!member) return null;
      this.cls.set(CLS_MEMBER_ID, member.id);
      const rows = await tx.memberRole.findMany({
        where: { memberId: member.id },
        select: {
          role: {
            select: {
              rolePermissions: { select: { permission: { select: { key: true } } } },
            },
          },
        },
      });
      const keys = new Set(
        rows.flatMap((r) => r.role.rolePermissions.map((rp) => rp.permission.key)),
      );
      this.cls.set(CLS_PERMISSIONS, keys);
      return keys;
    });

    if (!granted || !required.every((k) => granted.has(k))) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'Missing required permission',
        details: { required },
      });
    }
    return true;
  }

  /** Membership in the tenant this request names — belonging, not permission. */
  private async assertMember(user: AuthenticatedUser): Promise<void> {
    const member = await this.db.tx((tx) =>
      tx.member.findFirst({
        where: { userId: user.userId, status: 'active' },
        select: { id: true },
      }),
    );
    if (!member) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'You are not a member of this tenant',
      });
    }
    this.cls.set(CLS_MEMBER_ID, member.id);
  }
}
