import { Injectable } from '@nestjs/common';
import { PermissionScope } from '@aviora/shared';
import type { Tx } from '@aviora/db';
import { TeamScopeService, type TeamActor } from '../team/team-scope.service';

/** Which members' CRM records the caller may read/act on. */
export type OwnerScope = 'ALL' | Set<string>;

/**
 * CRM records belong to the member who owns them (docs/07). A member works
 * their own book (SELF); a leader may review the books of members inside their
 * team scope (DESCENDANT_TEAMS); tenant admins see everything (TENANT_ALL).
 */
@Injectable()
export class CrmScopeService {
  constructor(private readonly teamScope: TeamScopeService) {}

  async ownerMemberIds(tx: Tx, actor: TeamActor, permKey: string): Promise<OwnerScope> {
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

    const owners = new Set<string>();
    if (scopes.has(PermissionScope.SELF)) owners.add(actor.memberId);

    if (scopes.has(PermissionScope.DESCENDANT_TEAMS) || scopes.has(PermissionScope.DIRECT_TEAM)) {
      const teams = await this.teamScope.accessibleTeamIds(tx, actor, permKey);
      if (teams === 'ALL') return 'ALL';
      if (teams.size > 0) {
        const memberships = await tx.teamMembership.findMany({
          where: { teamId: { in: [...teams] }, status: 'active' },
          select: { memberId: true },
        });
        for (const m of memberships) owners.add(m.memberId);
      }
    }
    return owners;
  }

  canAccess(scope: OwnerScope, ownerMemberId: string): boolean {
    return scope === 'ALL' || scope.has(ownerMemberId);
  }

  /** Prisma `where` fragment restricting rows to the accessible owners. */
  whereOwner(scope: OwnerScope): Record<string, unknown> {
    return scope === 'ALL' ? {} : { ownerMemberId: { in: [...scope] } };
  }
}
