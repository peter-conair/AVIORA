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
 */
export const conditionSchema = z.object({
  metric: z.enum(RANK_METRICS),
  comparator: z.enum(RANK_COMPARATORS).default('gte'),
  threshold: z.number().int().min(0).max(1_000_000_000_000),
  window: z.enum(RANK_WINDOWS).default('lifetime'),
  params: z.record(z.unknown()).nullish(),
  graph: z.enum(METRIC_GRAPHS).default('compensation'),
});

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

/** The metric a percent payout is a percentage OF; a fixed payout needs none. */
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
  const uncappedMinor = Math.round((basisMinor * payout.percent) / 100);
  const cap = payout.capMinor ?? null;
  const capApplied = cap !== null && uncappedMinor > cap;
  return {
    amountMinor: capApplied ? (cap as number) : uncappedMinor,
    uncappedMinor,
    capApplied,
  };
}
