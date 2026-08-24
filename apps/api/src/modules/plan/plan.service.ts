import { ForbiddenException, Injectable } from '@nestjs/common';
import { ERROR_CODES, NAME_LIST_TARGET } from '@aviora/shared';
import type { Tx } from '@aviora/db';
import { TenantDb } from '../../common/db/tenant-db.service';
import type { TeamActor } from '../team/team-scope.service';
import { BusinessGoalService } from '../goals-business/business-goal.service';

/**
 * How much of somebody's own history it takes before a rate means anything.
 *
 * A conversion rate off two leads is noise wearing a percentage sign, and a
 * plan built on it sends somebody after the wrong number of people all month.
 * These thresholds are a judgement rather than a law — low enough to be
 * reachable in a first month or two, high enough that one lucky week does not
 * set the plan.
 */
export const MIN_RATE_SAMPLE = 10;
export const MIN_ORDER_SAMPLE = 5;

export interface Measured {
  value: number | null;
  source: 'measured' | 'assumed' | 'unknown';
  sample: number;
}

/**
 * The plan (docs/69).
 *
 * Works backwards from the month's target to the number of names it needs, and
 * forwards from the names to what to do today. Everything between the two is
 * the member's own history — **never an industry figure invented here**, which
 * would be a number that looks authoritative because it is in the code.
 */
@Injectable()
export class PlanService {
  constructor(private readonly db: TenantDb) {}

  private requireMember(actor: TeamActor): string {
    if (!actor.memberId) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'You are not a member of this tenant',
      });
    }
    return actor.memberId;
  }

  /** A rate from history when there is enough of it, the member's assumption when not. */
  private static rate(
    measuredNumerator: number,
    measuredDenominator: number,
    minSample: number,
    assumed: number | null | undefined,
  ): Measured {
    if (measuredDenominator >= minSample) {
      return {
        value: measuredNumerator / measuredDenominator,
        source: 'measured',
        sample: measuredDenominator,
      };
    }
    if (assumed != null && assumed > 0) {
      return { value: assumed / 100, source: 'assumed', sample: measuredDenominator };
    }
    // Neither measured nor assumed. Saying so beats returning a plausible
    // fraction nobody chose.
    return { value: null, source: 'unknown', sample: measuredDenominator };
  }

  async forMember(actor: TeamActor, monthInput?: string) {
    const memberId = this.requireMember(actor);
    const month = BusinessGoalService.monthOf(monthInput);

    return this.db.tx(async (tx) => {
      const goal = await tx.businessGoal.findFirst({ where: { memberId, month } });

      /* ── history, all of it this member's own ────────────────────────── */
      const onAList = { OR: [{ onSponsorList: true }, { onCustomerList: true }] };
      const [names, contacted, converted, customerMemberIds] = await Promise.all([
        tx.lead.count({ where: { ownerMemberId: memberId, ...onAList } }),
        tx.lead.count({
          where: { ownerMemberId: memberId, ...onAList, interactions: { some: {} } },
        }),
        tx.customer.count({ where: { ownerMemberId: memberId, convertedFromLeadId: { not: null } } }),
        tx.customer.findMany({
          where: { ownerMemberId: memberId, memberId: { not: null } },
          select: { memberId: true },
        }),
      ]);

      const buyerIds = customerMemberIds.map((c) => c.memberId!).filter(Boolean);
      const orders = buyerIds.length
        ? await tx.order.findMany({
            where: { memberId: { in: buyerIds }, status: 'paid' },
            select: { totalMinor: true },
          })
        : [];
      const orderTotal = orders.reduce((sum, o) => sum + o.totalMinor, 0);

      const averageOrder: Measured =
        orders.length >= MIN_ORDER_SAMPLE
          ? { value: orderTotal / orders.length, source: 'measured', sample: orders.length }
          : goal?.assumedOrderValueMinor
            ? { value: goal.assumedOrderValueMinor, source: 'assumed', sample: orders.length }
            : { value: null, source: 'unknown', sample: orders.length };

      const contactRate = PlanService.rate(
        contacted,
        names,
        MIN_RATE_SAMPLE,
        goal?.assumedContactRate,
      );
      const conversionRate = PlanService.rate(
        converted,
        contacted,
        MIN_RATE_SAMPLE,
        goal?.assumedConversionRate,
      );

      /* ── backwards from the target ───────────────────────────────────── */
      const volumeTarget = goal?.volumeTargetMinor ?? null;
      const customersNeeded =
        volumeTarget && averageOrder.value ? Math.ceil(volumeTarget / averageOrder.value) : null;
      const contactsNeeded =
        customersNeeded !== null && conversionRate.value
          ? Math.ceil(customersNeeded / conversionRate.value)
          : null;
      const namesNeeded =
        contactsNeeded !== null && contactRate.value
          ? Math.ceil(contactsNeeded / contactRate.value)
          : null;

      const step = (label: string, need: number | null, have: number) => ({
        step: label,
        need,
        have,
        // `null` short means the chain broke above this line, which is a
        // different thing from needing none.
        short: need === null ? null : Math.max(0, need - have),
      });

      /* ── forwards, to what to do today ───────────────────────────────── */
      const [unrated, dueFollowUps, stalled] = await Promise.all([
        tx.lead.findMany({
          where: {
            ownerMemberId: memberId,
            status: 'open',
            ...onAList,
            OR: [{ sponsorScore: 0 }, { customerScore: 0 }],
          },
          select: { id: true, name: true },
          orderBy: { createdAt: 'asc' },
          take: 10,
        }),
        tx.followUp.findMany({
          where: { ownerMemberId: memberId, status: 'open', dueAt: { lte: new Date() } },
          select: { id: true, dueAt: true, leadId: true, customerId: true, notes: true },
          orderBy: { dueAt: 'asc' },
          take: 10,
        }),
        tx.trackerEntry.findMany({
          where: { ownerMemberId: memberId, completedAt: null, lastMarkedAt: null },
          select: { id: true, subjectId: true, subjectType: true },
          take: 10,
        }),
      ]);

      return {
        month: month.toISOString().slice(0, 10),
        target: {
          volumeMinor: volumeTarget,
          newPartners: goal?.newPartnersTarget ?? null,
        },
        rates: { averageOrder, contactRate, conversionRate },
        // Where the chain breaks, and what would repair it — so the screen can
        // ask for the one missing number instead of showing an empty plan.
        blockedBy:
          volumeTarget === null
            ? 'no_target'
            : averageOrder.value === null
              ? 'order_value'
              : conversionRate.value === null
                ? 'conversion_rate'
                : contactRate.value === null
                  ? 'contact_rate'
                  : null,
        funnel: [
          step('names', namesNeeded, names),
          step('contacted', contactsNeeded, contacted),
          step('customers', customersNeeded, converted),
        ],
        nameList: { target: NAME_LIST_TARGET, have: names },
        today: {
          unrated: unrated.map((l) => ({ id: l.id, name: l.name })),
          dueFollowUps,
          neverStarted: stalled,
        },
      };
    });
  }

  /** The member's own assumptions, for the month they apply to. */
  async setAssumptions(
    actor: TeamActor,
    monthInput: string | undefined,
    input: {
      assumedOrderValueMinor?: number | null;
      assumedContactRate?: number | null;
      assumedConversionRate?: number | null;
    },
  ) {
    const memberId = this.requireMember(actor);
    const month = BusinessGoalService.monthOf(monthInput);
    return this.db.tx(async (tx: Tx) =>
      tx.businessGoal.upsert({
        where: { tenantId_memberId_month: { tenantId: this.db.tenantId, memberId, month } },
        create: { tenantId: this.db.tenantId, memberId, month, ...input },
        update: input,
      }),
    );
  }
}
