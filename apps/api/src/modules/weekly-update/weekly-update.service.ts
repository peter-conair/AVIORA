import { ForbiddenException, Injectable } from '@nestjs/common';
import { ERROR_CODES, PERMISSIONS, startOfWeekUtc } from '@aviora/shared';
import type { Tx } from '@aviora/db';
import { TenantDb } from '../../common/db/tenant-db.service';
import type { TeamActor } from '../team/team-scope.service';
import { CrmScopeService } from '../crm/crm-scope.service';
import { BusinessGoalService } from '../goals-business/business-goal.service';

export interface WeeklyUpdateInput {
  progressionNote?: string | null;
  prospectNote?: string | null;
  planNote?: string | null;
  questionNote?: string | null;
}

/**
 * The weekly review (docs/61).
 *
 * The sheet has four boxes and they are all prose. What makes this worth
 * building rather than printing is that the numbers those boxes discuss are
 * **computed at read time** — from the month's goal, the paid orders, the name
 * lists, the tracking sheets and the daily checklist.
 *
 * A member retyping last week's figure into this week's box is how a paper
 * system quietly loses touch with what happened, and the one thing a computer
 * can do here that paper cannot is simply look.
 */
@Injectable()
export class WeeklyUpdateService {
  constructor(
    private readonly db: TenantDb,
    private readonly scope: CrmScopeService,
    private readonly goals: BusinessGoalService,
  ) {}

  private requireMember(actor: TeamActor): string {
    if (!actor.memberId) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'You are not a member of this tenant',
      });
    }
    return actor.memberId;
  }

  private async readableMember(tx: Tx, actor: TeamActor, memberId?: string): Promise<string> {
    const self = this.requireMember(actor);
    if (!memberId || memberId === self) return self;
    const owners = await this.scope.ownerMemberIds(tx, actor, PERMISSIONS.TRACKER_VIEW);
    if (!this.scope.canAccess(owners, memberId)) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'That member is outside your scope',
      });
    }
    return memberId;
  }

  static weekOf(input?: string): Date {
    const asked = input ? new Date(`${input}T00:00:00Z`) : new Date();
    return startOfWeekUtc(Number.isNaN(asked.getTime()) ? new Date() : asked);
  }

  async upsert(actor: TeamActor, weekInput: string | undefined, input: WeeklyUpdateInput) {
    const memberId = this.requireMember(actor);
    const weekOf = WeeklyUpdateService.weekOf(weekInput);
    return this.db.tx((tx) =>
      tx.weeklyUpdate.upsert({
        where: { tenantId_memberId_weekOf: { tenantId: this.db.tenantId, memberId, weekOf } },
        create: { tenantId: this.db.tenantId, memberId, weekOf, ...input },
        update: input,
      }),
    );
  }

  async get(actor: TeamActor, weekInput?: string, memberIdInput?: string) {
    const weekOf = WeeklyUpdateService.weekOf(weekInput);
    const weekEnd = new Date(weekOf);
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);

    return this.db.tx(async (tx) => {
      const memberId = await this.readableMember(tx, actor, memberIdInput);

      // The month the week BELONGS to is the month its Sunday falls in. A week
      // straddling the turn belongs to one goal, not to whichever the reader
      // happened to have open.
      const month = BusinessGoalService.monthOf(weekOf);
      const monthEnd = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1));
      const goal = await this.goals.get(actor, month.toISOString().slice(0, 10), memberId);

      const update = await tx.weeklyUpdate.findFirst({ where: { memberId, weekOf } });

      /* ── what actually happened this week ─────────────────────────────── */
      const [namesAdded, ticks, checklistDone, staleTracked] = await Promise.all([
        tx.lead.count({
          where: { ownerMemberId: memberId, createdAt: { gte: weekOf, lt: weekEnd } },
        }),
        tx.trackerMark.count({
          where: {
            markedByMemberId: memberId,
            markedAt: { gte: weekOf, lt: weekEnd },
          },
        }),
        tx.habitLog.count({
          where: {
            memberId,
            completed: true,
            logDate: { gte: weekOf, lt: weekEnd },
            habit: { category: 'business' },
          },
        }),
        tx.trackerEntry.count({
          where: { ownerMemberId: memberId, completedAt: null, lastMarkedAt: null },
        }),
      ]);

      /* ── am I on pace? ───────────────────────────────────────────────── */
      const now = new Date();
      const msInMonth = monthEnd.getTime() - month.getTime();
      const elapsedMs = Math.min(Math.max(now.getTime() - month.getTime(), 0), msInMonth);
      const elapsedShare = msInMonth > 0 ? elapsedMs / msInMonth : 1;
      const daysLeft = Math.max(
        0,
        Math.ceil((monthEnd.getTime() - Math.max(now.getTime(), month.getTime())) / 86_400_000),
      );

      const volumeTarget = goal.progress.volume.targetMinor;
      const volumeActual = goal.progress.volume.actualMinor;
      const achievedShare = volumeTarget && volumeTarget > 0 ? volumeActual / volumeTarget : null;

      return {
        weekOf: weekOf.toISOString().slice(0, 10),
        month: month.toISOString().slice(0, 10),
        memberId,
        isSelf: memberId === actor.memberId,
        update,
        progression: {
          volume: {
            targetMinor: volumeTarget,
            actualMinor: volumeActual,
            remainingMinor: volumeTarget ? Math.max(0, volumeTarget - volumeActual) : null,
          },
          newPartners: {
            target: goal.progress.newPartners.target,
            actual: goal.progress.newPartners.actual,
          },
          daysLeftInMonth: daysLeft,
          // The share of the month gone, against the share of the target done.
          // "Behind" is only meaningful next to how much month is left, which
          // is the sentence the Progression box is asking the member to write.
          elapsedShare: Math.round(elapsedShare * 100) / 100,
          achievedShare: achievedShare === null ? null : Math.round(achievedShare * 100) / 100,
          onPace: achievedShare === null ? null : achievedShare >= elapsedShare,
        },
        thisWeek: {
          namesAdded,
          ticks,
          checklistDone,
          // Rows on a sheet that have never moved: the answer to "who is
          // interesting" that nobody remembers to look up.
          neverStarted: staleTracked,
        },
      };
    });
  }
}
