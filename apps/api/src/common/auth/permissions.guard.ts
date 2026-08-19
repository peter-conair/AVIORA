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
    if (!required?.length) return true;
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
}
