import type { Tx } from '@aviora/db';
import { DEFAULT_REFERRAL_TYPE, referralDownline } from './referral.service';

/**
 * Derived metrics (docs/25 §3). Every value here is computed from tables the
 * platform already owns — paid orders, referral edges, learning progress — so
 * no metric is ever stored twice and none can drift from its source.
 *
 * `referral_downline_volume` deliberately says REFERRAL downline. Calling it
 * team volume would re-couple the two graphs spec §17 keeps apart, and the
 * name is the only thing stopping that. Which line it actually walks is the
 * requirement's `graph` (docs/26 §2) — the shell is shared, the graph is not.
 */
export const RANK_METRICS = [
  'personal_volume',
  /**
   * The line below the member on whichever graph the requirement names.
   * `referral_downline_volume` is the Sprint 9 spelling and survives as an
   * alias pinned to the referral graph: a metric whose NAME fixes a graph
   * leaves the graph parameter nothing to do, so new rules should say
   * `downline_volume` and name their graph.
   */
  'downline_volume',
  'referral_downline_volume',
  'direct_referrals',
  'qualified_legs',
  'courses_completed',
] as const;
export type RankMetric = (typeof RANK_METRICS)[number];

export const RANK_WINDOWS = [
  'lifetime',
  'rolling_30',
  'rolling_90',
  'calendar_month',
  /** Resolved from the caller's period; see windowRange. */
  'period',
] as const;
export type RankWindow = (typeof RANK_WINDOWS)[number];

export const RANK_COMPARATORS = ['gte', 'gt', 'lte', 'lt', 'eq'] as const;
export type RankComparator = (typeof RANK_COMPARATORS)[number];

/**
 * Which graph a metric walks. Sprint 9 had one; the compensation engine
 * (docs/26 §2) reuses this calculator over its own placement graph. So the
 * graph is a property of the REQUIREMENT, not of the metric — a rank rule and
 * a bonus rule that both say "personal volume ≥ 50,000" must compute the same
 * number, and one that says "downline volume" must be able to mean a different
 * line without a second calculator existing to disagree with this one.
 */
export const METRIC_GRAPHS = ['referral', 'compensation'] as const;
export type MetricGraph = (typeof METRIC_GRAPHS)[number];

/** Rank qualifications carry no graph of their own and keep walking this one. */
export const DEFAULT_METRIC_GRAPH: MetricGraph = 'referral';

export interface MetricRequirement {
  metric: string;
  window: string;
  params: Record<string, unknown> | null;
  graph?: string;
}

export type GraphParams = Record<string, unknown> | null;

/**
 * The two questions a metric asks of a graph. The shell knows nothing about
 * either graph's table: the compensation module hands its own adapter in
 * through `MetricScope.graphs` rather than this file importing it, so neither
 * graph can reach the other's rows even by accident (spec §17).
 */
export interface MetricGraphAdapter {
  /** Everyone below `memberId`, depth-capped, as the graph stood at `asOf`. */
  downline(scope: MetricScope, memberId: string, params: GraphParams): Promise<string[]>;
  /** One edge below `memberId`; `window`, when given, bounds when it STARTED. */
  directs(
    scope: MetricScope,
    memberId: string,
    params: GraphParams,
    window?: string,
  ): Promise<string[]>;
}

export interface MetricScope {
  tx: Tx;
  tenantId: string;
  memberId: string;
  asOf: Date;
  /** Start of the period being computed, when the caller has one (a run). */
  periodStart?: Date;
  maxDepth: number;
  /** Adapters beyond the built-in referral graph, keyed by graph name. */
  graphs?: Record<string, MetricGraphAdapter>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Stable identity for a (metric, window, graph, params) tuple, so each is queried once. */
export function requirementKey(requirement: MetricRequirement): string {
  const params = requirement.params ?? {};
  const stable = Object.keys(params)
    .sort()
    .map((k) => `${k}=${JSON.stringify(params[k])}`)
    .join(',');
  const graph = requirement.graph ?? DEFAULT_METRIC_GRAPH;
  return `${requirement.metric}|${requirement.window}|${graph}|${stable}`;
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
export function windowRange(
  window: string,
  asOf: Date,
  periodStart?: Date,
): { gte?: Date; lte: Date } {
  switch (window) {
    // The window a commission run is FOR. Without it, "5% of downline volume"
    // pays 5% of all-time volume in every period — the same money, again, for
    // ever. Only a caller that has a period (a run) can resolve it; anywhere
    // else it degrades to lifetime, which is the harmless direction.
    case 'period':
      return periodStart ? { gte: periodStart, lte: asOf } : { lte: asOf };
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
  const params = requirement.params ?? null;
  switch (requirement.metric) {
    case 'personal_volume':
      return paidVolume(scope, [scope.memberId], requirement.window);

    case 'downline_volume':
    case 'referral_downline_volume': {
      // Breakaway (docs/70 §4): a leg that reached the threshold stops counting
      // toward the volume that qualifies its upline. Absent the param this is
      // the plain subtree sum it has always been — a plan without breakaway
      // never sets it and never pays for the extra walk.
      const breakawayAt = numeric(params?.excludeLegsAtOrAboveMinor);
      if (breakawayAt > 0) {
        const legs = await legVolumes(scope, requirement);
        return legs.reduce(
          (sum, leg) => (leg.volumeMinor >= breakawayAt ? sum : sum + leg.volumeMinor),
          0,
        );
      }
      const ids = await resolveGraph(scope, requirement).downline(scope, scope.memberId, params);
      return paidVolume(scope, ids, requirement.window);
    }

    case 'direct_referrals': {
      const directs = await resolveGraph(scope, requirement).directs(
        scope,
        scope.memberId,
        params,
        requirement.window,
      );
      return directs.length;
    }

    case 'qualified_legs': {
      const legVolumeMinor = numeric(params?.legVolumeMinor);
      const legs = await legVolumes(scope, requirement);
      return legs.filter((leg) => leg.volumeMinor >= legVolumeMinor).length;
    }

    case 'courses_completed':
      return scope.tx.learningProgress.count({
        where: {
          memberId: scope.memberId,
          status: 'completed',
          completedAt: windowRange(requirement.window, scope.asOf, scope.periodStart),
        },
      });

    default:
      return 0;
  }
}

export interface LegVolume {
  /** The member at the head of the leg — a direct, on the requirement's graph. */
  memberId: string;
  /** The whole line's volume, over the requirement's window. */
  volumeMinor: number;
}

/**
 * Each direct leg below `scope.memberId`, with the volume of the entire line.
 *
 * A leg is the line INCLUDING the person at its head: the member who was
 * sponsored is part of the line they lead, and excluding them would score an
 * active direct with no downline of their own as a dead leg. Three callers now
 * depend on that sentence being true — `qualified_legs`, breakaway exclusion,
 * and the differential payout — so it is written once here rather than three
 * times slightly differently.
 *
 * Note the depth cap counts from the leg's head, not from `scope.memberId`, so
 * a very deep line is measured one level further down here than a plain
 * `downline_volume` over the same member would reach. That has been true of
 * `qualified_legs` since Sprint 9; it is called out because breakaway now makes
 * the two numbers appear side by side in the same rule.
 */
export async function legVolumes(
  scope: MetricScope,
  requirement: MetricRequirement,
): Promise<LegVolume[]> {
  const graph = resolveGraph(scope, requirement);
  const params = requirement.params ?? null;
  const directs = await graph.directs(scope, scope.memberId, params);
  const legs: LegVolume[] = [];
  for (const direct of directs) {
    const ids = await graph.downline(scope, direct, params);
    legs.push({
      memberId: direct,
      volumeMinor: await paidVolume(scope, [direct, ...ids], requirement.window),
    });
  }
  return legs;
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
      paidAt: windowRange(window, scope.asOf, scope.periodStart),
    },
    _sum: { totalMinor: true },
  });
  return totals._sum.totalMinor ?? 0;
}

/** The referral graph, the one this calculator was born walking. */
const referralGraph: MetricGraphAdapter = {
  async downline(scope, memberId, params) {
    const nodes = await referralDownline(
      scope.tx,
      scope.tenantId,
      memberId,
      referralType(params),
      scope.maxDepth,
      scope.asOf,
    );
    return nodes.map((n) => n.memberId);
  },
  async directs(scope, memberId, params, window) {
    const rows = await scope.tx.referralRelationship.findMany({
      where: {
        referrerMemberId: memberId,
        relationshipType: referralType(params),
        // live AT asOf, so a replay counts the edges that existed then
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: scope.asOf } }],
        ...(window ? { effectiveFrom: windowRange(window, scope.asOf, scope.periodStart) } : {}),
      },
      select: { referredMemberId: true },
    });
    return rows.map((r) => r.referredMemberId);
  },
};

function resolveGraph(scope: MetricScope, requirement: MetricRequirement): MetricGraphAdapter {
  // The legacy spelling names its graph in the metric itself, so it cannot be
  // pointed at another one — that is the whole reason the neutral name exists.
  const name =
    requirement.metric === 'referral_downline_volume'
      ? DEFAULT_METRIC_GRAPH
      : (requirement.graph ?? DEFAULT_METRIC_GRAPH);
  const adapter = name === DEFAULT_METRIC_GRAPH ? referralGraph : scope.graphs?.[name];
  // Quietly falling back to the referral graph would pay a compensation rule
  // off referral edges — the precise coupling spec §17 forbids. Rules are
  // validated at creation, so reaching this is a wiring bug, not tenant data.
  if (!adapter) throw new Error(`No adapter is registered for the '${name}' graph`);
  return adapter;
}

function referralType(params: Record<string, unknown> | null | undefined): string {
  const configured = params?.relationshipType;
  return typeof configured === 'string' && configured ? configured : DEFAULT_REFERRAL_TYPE;
}

function numeric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
