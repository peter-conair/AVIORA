import type { Tx } from '@aviora/db';
import { DEFAULT_REFERRAL_TYPE, referralDownline } from './referral.service';

/**
 * Derived metrics (docs/25 §3). Every value here is computed from tables the
 * platform already owns — paid orders, referral edges, learning progress — so
 * no metric is ever stored twice and none can drift from its source.
 *
 * `referral_downline_volume` deliberately says REFERRAL downline. Calling it
 * team volume would re-couple the two graphs spec §17 keeps apart, and the
 * name is the only thing stopping that.
 */
export const RANK_METRICS = [
  'personal_volume',
  'referral_downline_volume',
  'direct_referrals',
  'qualified_legs',
  'courses_completed',
] as const;
export type RankMetric = (typeof RANK_METRICS)[number];

export const RANK_WINDOWS = ['lifetime', 'rolling_30', 'rolling_90', 'calendar_month'] as const;
export type RankWindow = (typeof RANK_WINDOWS)[number];

export const RANK_COMPARATORS = ['gte', 'gt', 'lte', 'lt', 'eq'] as const;
export type RankComparator = (typeof RANK_COMPARATORS)[number];

export interface MetricRequirement {
  metric: string;
  window: string;
  params: Record<string, unknown> | null;
}

export interface MetricScope {
  tx: Tx;
  tenantId: string;
  memberId: string;
  asOf: Date;
  maxDepth: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Stable identity for a (metric, window, params) triple, so each is queried once. */
export function requirementKey(requirement: MetricRequirement): string {
  const params = requirement.params ?? {};
  const stable = Object.keys(params)
    .sort()
    .map((k) => `${k}=${JSON.stringify(params[k])}`)
    .join(',');
  return `${requirement.metric}|${requirement.window}|${stable}`;
}

export function passes(comparator: string, value: number, threshold: number): boolean {
  switch (comparator) {
    case 'gt':
      return value > threshold;
    case 'lt':
      return value < threshold;
    case 'lte':
      return value <= threshold;
    case 'eq':
      return value === threshold;
    default:
      return value >= threshold;
  }
}

/**
 * A window is always bounded ABOVE by `asOf`, `lifetime` included. Without the
 * upper bound, replaying an old evaluation would pick up everything that has
 * happened since and quietly produce a different rank — the opposite of the
 * reproducibility a later commission run depends on.
 */
export function windowRange(window: string, asOf: Date): { gte?: Date; lte: Date } {
  switch (window) {
    case 'rolling_30':
      return { gte: new Date(asOf.getTime() - 30 * DAY_MS), lte: asOf };
    case 'rolling_90':
      return { gte: new Date(asOf.getTime() - 90 * DAY_MS), lte: asOf };
    case 'calendar_month':
      return { gte: new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), 1)), lte: asOf };
    default:
      return { lte: asOf };
  }
}

/** Computes each distinct requirement exactly once; nothing else is queried. */
export async function computeMetrics(
  scope: MetricScope,
  requirements: MetricRequirement[],
): Promise<Record<string, number>> {
  const distinct = new Map<string, MetricRequirement>();
  for (const requirement of requirements) {
    distinct.set(requirementKey(requirement), requirement);
  }
  const values: Record<string, number> = {};
  for (const [key, requirement] of distinct) {
    values[key] = await computeMetric(scope, requirement);
  }
  return values;
}

async function computeMetric(scope: MetricScope, requirement: MetricRequirement): Promise<number> {
  const type = referralType(requirement.params);
  switch (requirement.metric) {
    case 'personal_volume':
      return paidVolume(scope, [scope.memberId], requirement.window);

    case 'referral_downline_volume': {
      const nodes = await referralDownline(
        scope.tx,
        scope.tenantId,
        scope.memberId,
        type,
        scope.maxDepth,
        scope.asOf,
      );
      return paidVolume(
        scope,
        nodes.map((n) => n.memberId),
        requirement.window,
      );
    }

    case 'direct_referrals':
      return scope.tx.referralRelationship.count({
        where: {
          referrerMemberId: scope.memberId,
          relationshipType: type,
          // live AT asOf, so a replay counts the edges that existed then
          OR: [{ effectiveTo: null }, { effectiveTo: { gt: scope.asOf } }],
          effectiveFrom: windowRange(requirement.window, scope.asOf),
        },
      });

    case 'qualified_legs': {
      const legVolumeMinor = numeric(requirement.params?.legVolumeMinor);
      const directs = await scope.tx.referralRelationship.findMany({
        where: {
          referrerMemberId: scope.memberId,
          relationshipType: type,
          OR: [{ effectiveTo: null }, { effectiveTo: { gt: scope.asOf } }],
        },
        select: { referredMemberId: true },
      });
      let qualified = 0;
      for (const direct of directs) {
        const nodes = await referralDownline(
          scope.tx,
          scope.tenantId,
          direct.referredMemberId,
          type,
          scope.maxDepth,
          scope.asOf,
        );
        // A leg is the line INCLUDING the person at its head: the member who
        // was referred is part of the line they lead. Excluding them would score
        // an active direct referral with no downline as a dead leg.
        const volume = await paidVolume(
          scope,
          [direct.referredMemberId, ...nodes.map((n) => n.memberId)],
          requirement.window,
        );
        if (volume >= legVolumeMinor) qualified += 1;
      }
      return qualified;
    }

    case 'courses_completed':
      return scope.tx.learningProgress.count({
        where: {
          memberId: scope.memberId,
          status: 'completed',
          completedAt: windowRange(requirement.window, scope.asOf),
        },
      });

    default:
      return 0;
  }
}

/** Volume is integer minor units, summed from PAID orders only. */
async function paidVolume(
  scope: MetricScope,
  memberIds: string[],
  window: string,
): Promise<number> {
  if (!memberIds.length) return 0;
  const totals = await scope.tx.order.aggregate({
    where: {
      memberId: { in: memberIds },
      status: 'paid',
      paidAt: windowRange(window, scope.asOf),
    },
    _sum: { totalMinor: true },
  });
  return totals._sum.totalMinor ?? 0;
}

function referralType(params: Record<string, unknown> | null | undefined): string {
  const configured = params?.relationshipType;
  return typeof configured === 'string' && configured ? configured : DEFAULT_REFERRAL_TYPE;
}

function numeric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
