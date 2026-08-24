import { z } from 'zod';
import {
  METRIC_GRAPHS,
  RANK_COMPARATORS,
  RANK_METRICS,
  RANK_WINDOWS,
  type MetricRequirement,
} from '../growth/metrics';

/**
 * The rule vocabulary (docs/26 §1, §3). Every one of spec §43's eleven bonuses
 * is the same sentence — IF <conditions on metrics> THEN <fixed amount, or a
 * percentage of some basis> — so there are conditions and two payout kinds, and
 * nothing more. A tenant that invents a twelfth bonus writes rows, not code.
 *
 * Conditions reuse the Sprint 9 metric/comparator/threshold/window vocabulary
 * verbatim, plus `graph`. Reusing it is the point: a rank rule and a bonus rule
 * that both say "personal volume ≥ 50,000" must compute the same number, or the
 * plan is lying to somebody.
 *
 * There is now a THIRD payout kind, `differential`, and docs/70 §5 is the
 * argument for it. The short version: `fixed` and `percent` both resolve from
 * the payee alone, and a stairstep plan does not — what it owes depends on the
 * rate the LEG achieved in the same period. That could not be said in the
 * existing vocabulary at any threshold, so docs/26 §1's own instruction applied
 * — extend the vocabulary, never add a branch named after somebody's plan. The
 * rungs are still the tenant's numbers; nothing in this file knows one.
 */

/**
 * `params` a condition may carry, beyond the graph's own:
 *
 * - `legVolumeMinor` — what makes a leg count, for `qualified_legs`
 * - `excludeLegsAtOrAboveMinor` — breakaway: a leg at or above this stops
 *   counting toward `downline_volume`. Must be at least 1 if present, because
 *   zero would exclude every leg and quietly answer nought to every rule that
 *   asked (validated in `assertRuleIsComputable`).
 */
export const conditionSchema = z.object({
  metric: z.enum(RANK_METRICS),
  comparator: z.enum(RANK_COMPARATORS).default('gte'),
  threshold: z.number().int().min(0).max(1_000_000_000_000),
  window: z.enum(RANK_WINDOWS).default('lifetime'),
  params: z.record(z.unknown()).nullish(),
  graph: z.enum(METRIC_GRAPHS).default('compensation'),
});

/**
 * One rung. `atLeastMinor` is the volume that reaches it; `percent` is what it
 * pays. A member below every rung is on 0%, which is the honest reading of "has
 * not qualified" and the safe direction if a ladder is half configured.
 */
export const differentialTierSchema = z.object({
  atLeastMinor: z.number().int().min(0).max(1_000_000_000_000),
  percent: z.number().min(0).max(100),
});
export type DifferentialTier = z.infer<typeof differentialTierSchema>;

export const payoutSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('fixed'),
    amountMinor: z.number().int().positive().max(1_000_000_000),
  }),
  z.object({
    kind: z.literal('percent'),
    percent: z.number().positive().max(100),
    /** A metric name, computed by the same calculator as the conditions, so
     *  "5% of downline volume" cannot mean one thing in the condition and
     *  another in the payout. */
    basis: z.enum(RANK_METRICS),
    /**
     * Defaults to the run's own period. A percentage of LIFETIME volume would
     * pay for the same sales again in every period, for ever; if a plan really
     * means all-time, it has to say so.
     */
    basisWindow: z.enum(RANK_WINDOWS).default('period'),
    basisGraph: z.enum(METRIC_GRAPHS).default('compensation'),
    basisParams: z.record(z.unknown()).nullish(),
    capMinor: z.number().int().positive().max(1_000_000_000).nullish(),
  }),
  z.object({
    kind: z.literal('differential'),
    /**
     * The ladder, in the tenant's own numbers. It lives on the rule that uses
     * it rather than on the plan because one differential rule is the normal
     * case; a plan that grows a second one is the moment to hoist this to the
     * plan, and the shape is chosen so that hoist is a data move.
     *
     * It is deliberately NOT read from the rank ladder (docs/62), even though a
     * tenant will usually type the same numbers into both. A run must be
     * reproducible from source data as of its period, and `rank_progress` holds
     * whatever the last evaluation left there — replaying an old run against it
     * would pay a different number and neither figure could be defended.
     */
    tiers: z.array(differentialTierSchema).min(1).max(30),
    /**
     * The metric that puts somebody on a rung. Resolved for the payee AND for
     * the head of every leg, by the same calculator, over the same window — the
     * whole point of the kind is that those two numbers are comparable.
     */
    basis: z.enum(RANK_METRICS),
    basisWindow: z.enum(RANK_WINDOWS).default('period'),
    basisGraph: z.enum(METRIC_GRAPHS).default('compensation'),
    basisParams: z.record(z.unknown()).nullish(),
    capMinor: z.number().int().positive().max(1_000_000_000).nullish(),
  }),
]);

export type RuleCondition = z.infer<typeof conditionSchema>;
export type RulePayout = z.infer<typeof payoutSchema>;

export const ruleSchema = z.object({
  code: z.string().regex(/^[a-z0-9-]{2,40}$/),
  name: z.string().min(1).max(160),
  /**
   * A reporting label, carried through to entries untouched. Nothing branches
   * on it (docs/26 §1) — which is also why it is not an enum: constraining it
   * to the eleven bonuses spec §43 happens to list would make a twelfth one a
   * release rather than a row.
   */
  bonusType: z.string().regex(/^[a-z0-9_]{2,40}$/),
  priority: z.number().int().min(0).max(10_000).default(100),
  status: z.enum(['active', 'archived']).default('active'),
  conditions: z.array(conditionSchema).max(20).default([]),
  payout: payoutSchema,
});

export type RuleInput = z.infer<typeof ruleSchema>;

/** Re-reads a stored rule, whose JSON columns are `unknown` to the client. */
export function parseConditions(value: unknown): RuleCondition[] {
  return z.array(conditionSchema).parse(value ?? []);
}

export function parsePayout(value: unknown): RulePayout {
  return payoutSchema.parse(value);
}

export function conditionRequirement(condition: RuleCondition): MetricRequirement {
  return {
    metric: condition.metric,
    window: condition.window,
    params: condition.params ?? null,
    graph: condition.graph,
  };
}

/**
 * The metric a payout is measured against — the percentage's basis, or the
 * ladder's rung-decider. A fixed payout needs none.
 */
export function basisRequirement(payout: RulePayout): MetricRequirement | null {
  if (payout.kind === 'fixed') return null;
  return {
    metric: payout.basis,
    window: payout.basisWindow,
    params: payout.basisParams ?? null,
    graph: payout.basisGraph,
  };
}

export interface PayoutAmount {
  amountMinor: number;
  /** What the percentage came to before the cap — kept so a capped entry can
   *  be explained without recomputing it. */
  uncappedMinor: number;
  capApplied: boolean;
}

/**
 * All money is integer minor units. The percentage rounds ONCE, on the raw
 * product, and the cap is applied to that result — capping first, or rounding a
 * value that has already been rounded, makes the same rule pay differently
 * depending on which step happened to run first (docs/26 §3).
 */
export function payoutAmount(payout: RulePayout, basisMinor: number): PayoutAmount {
  if (payout.kind === 'fixed') {
    return {
      amountMinor: payout.amountMinor,
      uncappedMinor: payout.amountMinor,
      capApplied: false,
    };
  }
  if (payout.kind === 'differential') {
    // A differential is not a function of one member's basis, so there is no
    // number this call could return. Reaching it means a caller took the
    // one-pass path with a two-pass rule, which would silently pay the wrong
    // amount — louder is better.
    throw new Error('A differential payout is computed by differentialAmount, not payoutAmount');
  }
  const uncappedMinor = Math.round((basisMinor * payout.percent) / 100);
  const cap = payout.capMinor ?? null;
  const capApplied = cap !== null && uncappedMinor > cap;
  return {
    amountMinor: capApplied ? (cap as number) : uncappedMinor,
    uncappedMinor,
    capApplied,
  };
}

export type DifferentialPayout = Extract<RulePayout, { kind: 'differential' }>;

/**
 * The rung a basis value reaches, in percent. Below every rung is 0%.
 *
 * Written as a scan of all tiers rather than a sorted lookup so that a ladder
 * stored in any order still resolves to the same rate; `assertRuleIsComputable`
 * insists on ascending order at write time, and this does not depend on it.
 */
export function tierPercent(tiers: DifferentialTier[], basisMinor: number): number {
  let percent = 0;
  for (const tier of tiers) {
    if (basisMinor >= tier.atLeastMinor && tier.percent > percent) percent = tier.percent;
  }
  return percent;
}

/** One leg, as the calculator was handed it. */
export interface DifferentialLegInput {
  memberId: string;
  /** The whole line's volume — what the differential is a percentage of. */
  volumeMinor: number;
  /** The leg head's own rung-deciding metric, over the same window. */
  basisMinor: number;
}

export interface DifferentialLeg extends DifferentialLegInput {
  ratePercent: number;
  /** The payee's rate minus this leg's. Never negative; see below. */
  differentialPercent: number;
  amountMinor: number;
}

export interface DifferentialAmount extends PayoutAmount {
  ratePercent: number;
  /** Every leg, including the ones that paid nothing — an entry has to be able
   *  to answer "why did I get nothing for that line?" as well as "why this
   *  much?". */
  legs: DifferentialLeg[];
}

/**
 * The stairstep payout: for each leg, the payee's rate minus the rate that leg
 * already earned, applied to that leg's volume (docs/70 §3).
 *
 * Two decisions worth naming.
 *
 * **A leg at or above the payee's own rate pays zero, never a negative.** That
 * is breakaway falling out of the arithmetic rather than being special-cased:
 * once a line reaches the top rung its differential is nil, which is exactly
 * what the plan means by the line having left. A negative would be the engine
 * clawing money back from somebody for having built a strong leader.
 *
 * **Rounding happens per leg, not on the total.** docs/26 §3 says a percentage
 * rounds once, and it still does — once per leg, because each leg is its own
 * line on the statement. Rounding the sum instead would print an itemisation
 * that does not add up to its own total, and a member who cannot add up their
 * own payslip has no way to check it. The cap, when set, applies to the total.
 */
export function differentialAmount(
  payout: DifferentialPayout,
  memberBasisMinor: number,
  legs: DifferentialLegInput[],
): DifferentialAmount {
  const ratePercent = tierPercent(payout.tiers, memberBasisMinor);
  const resolved: DifferentialLeg[] = legs.map((leg) => {
    const legRate = tierPercent(payout.tiers, leg.basisMinor);
    const differentialPercent = Math.max(0, ratePercent - legRate);
    return {
      ...leg,
      ratePercent: legRate,
      differentialPercent,
      amountMinor: Math.round((leg.volumeMinor * differentialPercent) / 100),
    };
  });
  const uncappedMinor = resolved.reduce((sum, leg) => sum + leg.amountMinor, 0);
  const cap = payout.capMinor ?? null;
  const capApplied = cap !== null && uncappedMinor > cap;
  return {
    amountMinor: capApplied ? (cap as number) : uncappedMinor,
    uncappedMinor,
    capApplied,
    ratePercent,
    legs: resolved,
  };
}
