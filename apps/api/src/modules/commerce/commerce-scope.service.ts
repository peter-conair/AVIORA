import { Injectable } from '@nestjs/common';
import { PermissionScope } from '@aviora/shared';
import type { Tx } from '@aviora/db';
import type { TeamActor } from '../team/team-scope.service';

/** Whose orders and subscriptions the caller may read or act on. */
export type MemberScope = 'ALL' | Set<string>;

/**
 * Orders and subscriptions belong to the member who placed them (docs/24 §2).
 * The catalogue is tenant-wide, but what a member buys is their own business:
 * only a TENANT_ALL grant widens the view beyond the caller.
 */
@Injectable()
export class CommerceScopeService {
  async memberIds(tx: Tx, actor: TeamActor, permKey: string): Promise<MemberScope> {
    if (actor.platformBypass) return 'ALL';
    if (!actor.memberId) return new Set();

    const rows = await tx.memberRole.findMany({
      where: { memberId: actor.memberId },
      select: {
        role: {
          select: {
            rolePermissions: {
              where: { permission: { key: permKey } },
              select: { scope: true },
            },
          },
        },
      },
    });
    const scopes = new Set(rows.flatMap((r) => r.role.rolePermissions.map((rp) => rp.scope)));
    if (scopes.has(PermissionScope.TENANT_ALL)) return 'ALL';
    // Team scopes mean nothing here — a leader is not entitled to a member's
    // purchase history — so every narrower grant resolves to SELF.
    return new Set([actor.memberId]);
  }

  canAccess(scope: MemberScope, memberId: string): boolean {
    return scope === 'ALL' || scope.has(memberId);
  }

  /** Prisma `where` fragment restricting rows to the accessible members. */
  whereMember(scope: MemberScope): Record<string, unknown> {
    return scope === 'ALL' ? {} : { memberId: { in: [...scope] } };
  }
}
