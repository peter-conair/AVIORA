import { Injectable } from '@nestjs/common';
import { PermissionScope } from '@aviora/shared';
import type { Tx } from '@aviora/db';

export type AccessibleTeams = 'ALL' | Set<string>;

/** The acting caller for team-scoped operations. */
export interface TeamActor {
  memberId: string | null;
  /** Platform admins and TENANT_ALL grants bypass team scoping. */
  platformBypass: boolean;
}

/**
 * Resolves WHICH teams a member may touch for a permission key (docs/07 §scopes,
 * docs/05 §rollup). Scope anchors:
 *   TENANT_ALL        → every team
 *   DESCENDANT_TEAMS  → teams the member actively leads + their whole subtree
 *   DIRECT_TEAM       → teams the member leads or belongs to
 *   SELF              → no team access
 * SPECIFIC_TEAMS is reserved (needs a grant table — Phase 2+).
 */
@Injectable()
export class TeamScopeService {
  async accessibleTeamIds(tx: Tx, actor: TeamActor, permKey: string): Promise<AccessibleTeams> {
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

    const ids = new Set<string>();
    const needsLed =
      scopes.has(PermissionScope.DESCENDANT_TEAMS) || scopes.has(PermissionScope.DIRECT_TEAM);
    if (needsLed) {
      const led = await tx.teamLeadership.findMany({
        where: { memberId: actor.memberId, status: 'active' },
        select: { teamId: true },
      });
      for (const l of led) ids.add(l.teamId);
      if (scopes.has(PermissionScope.DESCENDANT_TEAMS) && led.length > 0) {
        const desc = await tx.teamClosure.findMany({
          where: { ancestorTeamId: { in: led.map((l) => l.teamId) } },
          select: { descendantTeamId: true },
        });
        for (const d of desc) ids.add(d.descendantTeamId);
      }
    }
    if (scopes.has(PermissionScope.DIRECT_TEAM)) {
      const mine = await tx.teamMembership.findMany({
        where: { memberId: actor.memberId, status: 'active' },
        select: { teamId: true },
      });
      for (const m of mine) ids.add(m.teamId);
    }
    return ids;
  }

  canAccess(allowed: AccessibleTeams, teamId: string): boolean {
    return allowed === 'ALL' || allowed.has(teamId);
  }
}
