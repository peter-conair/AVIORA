import { Injectable } from '@nestjs/common';
import { ERROR_CODES, PERMISSIONS } from '@aviora/shared';
import { ForbiddenException } from '@nestjs/common';
import { TenantDb } from '../../common/db/tenant-db.service';
import { AuditService } from '../../common/audit/audit.service';
import { computeMetrics, requirementKey, type MetricRequirement } from '../growth/metrics';

/** The month's own volume and the partners signed in it — same definitions the rank engine uses. */
const VOLUME_REQUIREMENT: MetricRequirement = {
  metric: 'personal_volume',
  window: 'calendar_month',
  params: null,
};
const PARTNERS_REQUIREMENT: MetricRequirement = {
  metric: 'direct_referrals',
  window: 'calendar_month',
  params: null,
};
import { MAX_REFERRAL_DEPTH } from '../growth/referral.service';
import type { TeamActor } from '../team/team-scope.service';
import { CrmScopeService } from '../crm/crm-scope.service';

export interface BusinessGoalInput {
  shortTerm?: string | null;
  midTerm?: string | null;
  longTerm?: string | null;
  lifeGoal?: string | null;
  volumeTargetMinor?: number | null;
  newPartnersTarget?: number | null;
  developCustomersTarget?: number | null;
  developPartnersTarget?: number | null;
  developCustomersActual?: number;
  developPartnersActual?: number;
}

/**
 * The monthly goal sheet (docs/58).
 *
 * The point of building this rather than leaving it on paper is §3.1 of the
 * contract: progress comes from `computeMetrics` — the same definitions that
 * drive rank qualification and compensation — and not from a second count
 * written for this screen. A goal that said 28,000 while the rank engine said
 * 31,000 for the same month would leave two defensible numbers and no way to
 * say which was wrong.
 */
@Injectable()
export class BusinessGoalService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly scope: CrmScopeService,
  ) {}

  /**
   * The first of a month, as a plain date.
   *
   * A `date` column and not a timestamp on purpose: "which month is this sheet
   * for" is a calendar fact, and storing it as an instant makes it depend on
   * the reader's zone — the sheet for August would become July for anybody east
   * of the server (the standing rule in timezone-standard.md).
   */
  static monthOf(input?: string | Date): Date {
    const d = input ? new Date(input) : new Date();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  }

  private requireMember(actor: TeamActor): string {
    if (!actor.memberId) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'You are not a member of this tenant',
      });
    }
    return actor.memberId;
  }

  async upsert(actor: TeamActor, monthInput: string | undefined, input: BusinessGoalInput) {
    const memberId = this.requireMember(actor);
    const month = BusinessGoalService.monthOf(monthInput);
    const goal = await this.db.tx(async (tx) =>
      tx.businessGoal.upsert({
        where: { tenantId_memberId_month: { tenantId: this.db.tenantId, memberId, month } },
        create: { tenantId: this.db.tenantId, memberId, month, ...input },
        update: input,
      }),
    );
    await this.audit.record({
      action: 'goal.business.set',
      entityType: 'business_goal',
      entityId: goal.id,
      after: {
        month: goal.month,
        volumeTargetMinor: goal.volumeTargetMinor,
        newPartnersTarget: goal.newPartnersTarget,
      },
    });
    return goal;
  }

  /**
   * The sheet plus where it actually stands.
   *
   * `memberId` lets a leader read somebody in their scope — the weekly meeting
   * is the whole point of the sheet, and a coach who cannot see the goal cannot
   * hold it.
   */
  async get(actor: TeamActor, monthInput?: string, memberIdInput?: string) {
    const month = BusinessGoalService.monthOf(monthInput);
    const memberId = memberIdInput ?? this.requireMember(actor);

    return this.db.tx(async (tx) => {
      if (memberId !== actor.memberId) {
        const owners = await this.scope.ownerMemberIds(tx, actor, PERMISSIONS.CRM_LEAD_VIEW);
        if (!this.scope.canAccess(owners, memberId)) {
          throw new ForbiddenException({
            code: ERROR_CODES.FORBIDDEN,
            message: 'That member is outside your scope',
          });
        }
      }

      const goal = await tx.businessGoal.findFirst({ where: { memberId, month } });

      // The month being asked about, not today: a coach reviewing March in
      // April must see March's numbers, so the metric window is anchored to the
      // end of the month rather than to now.
      const asOf = monthEnd(month);
      const values = await computeMetrics(
        {
          tx,
          tenantId: this.db.tenantId,
          memberId,
          asOf,
          periodStart: month,
          maxDepth: MAX_REFERRAL_DEPTH,
        },
        [VOLUME_REQUIREMENT, PARTNERS_REQUIREMENT],
      );
      // Keyed with the same function that produced the keys. Hardcoding the
      // string shape here would break silently the day the default graph is
      // renamed, and read as "you did nothing this month".
      const volumeActualMinor = values[requirementKey(VOLUME_REQUIREMENT)] ?? 0;
      const newPartnersActual = values[requirementKey(PARTNERS_REQUIREMENT)] ?? 0;

      return {
        month: month.toISOString().slice(0, 10),
        memberId,
        goal,
        progress: {
          // `source` is not decoration: a number the system measured and a
          // number somebody typed look identical on screen unless the screen is
          // told which is which (docs/58 §3).
          volume: {
            targetMinor: goal?.volumeTargetMinor ?? null,
            actualMinor: volumeActualMinor,
            source: 'computed' as const,
            metric: 'personal_volume',
          },
          newPartners: {
            target: goal?.newPartnersTarget ?? null,
            actual: newPartnersActual,
            source: 'computed' as const,
            metric: 'direct_referrals',
          },
          develop: {
            customersTarget: goal?.developCustomersTarget ?? null,
            customersActual: goal?.developCustomersActual ?? 0,
            partnersTarget: goal?.developPartnersTarget ?? null,
            partnersActual: goal?.developPartnersActual ?? 0,
            // "5+3" is a coaching convention whose definition belongs to the
            // business. A number invented here would look measured.
            source: 'manual' as const,
          },
        },
      };
    });
  }
}

/** Last instant of the month, so a metric window bounded by `asOf` includes it. */
function monthEnd(month: Date): Date {
  return new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1) - 1);
}
