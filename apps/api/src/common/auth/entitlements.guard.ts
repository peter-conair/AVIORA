import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import { ERROR_CODES } from '@aviora/shared';
import { TenantDb } from '../db/tenant-db.service';
import { REQUIRED_ENTITLEMENTS, type AuthenticatedUser } from './decorators';
import { CLS_MEMBER_ID } from './permissions.guard';

/**
 * Capability gate: the caller's ACTIVE membership plan must include all
 * required entitlement keys (docs/04 §resolution). Never branch on plan names.
 */
@Injectable()
export class EntitlementsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly cls: ClsService,
    private readonly db: TenantDb,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<string[]>(REQUIRED_ENTITLEMENTS, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required?.length) return true;

    const req = ctx.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    const user = req.user;
    if (!user) return false;

    const keys = await this.db.tx(async (tx) => {
      let memberId = this.cls.get(CLS_MEMBER_ID) as string | undefined;
      if (!memberId) {
        const member = await tx.member.findFirst({
          where: { userId: user.userId, status: 'active' },
          select: { id: true },
        });
        if (!member) return null;
        memberId = member.id;
        this.cls.set(CLS_MEMBER_ID, member.id);
      }
      const membership = await tx.membership.findFirst({
        where: { memberId, status: 'active' },
        orderBy: { startedAt: 'desc' },
        select: {
          plan: {
            select: {
              planEntitlements: { select: { entitlement: { select: { key: true } } } },
            },
          },
        },
      });
      if (!membership) return new Set<string>();
      return new Set(membership.plan.planEntitlements.map((pe) => pe.entitlement.key));
    });

    if (!keys || !required.every((k) => keys.has(k))) {
      throw new ForbiddenException({
        code: ERROR_CODES.ENTITLEMENT_REQUIRED,
        message: 'Your membership does not include this capability',
        details: { required },
      });
    }
    return true;
  }
}
