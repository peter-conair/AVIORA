import { z } from 'zod';
import { EVENTS } from '@aviora/shared';
import {
  METRIC_GRAPHS,
  RANK_COMPARATORS,
  RANK_METRICS,
  RANK_WINDOWS,
  type MetricRequirement,
} from '../growth/metrics';

/**
 * The rule vocabulary (docs/27 §1). A rule is one sentence — WHEN <event> IF
 * <conditions> THEN <actions> — and everything it can get wrong is refused at
 * creation WITH THE REASON: a rule naming an event that does not exist can
 * never fire, and an action with no adapter would look configured and do
 * nothing. Both are typos, and both are cheaper to find now than in a log.
 *
 * Conditions and actions are therefore checked field by field here rather than
 * by a Zod union at the edge. A union failure reports "invalid input" and keeps
 * the offending word to itself, which is the one thing this validation exists
 * to say out loud.
 */

/** Actions with a real adapter. */
export const ACTION_TYPES = [
  'send_notification',
  'grant_reward',
  'create_followup',
  'assign_course',
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

/**
 * The rest of spec §51's list. Each is refused by NAME rather than ignored: a
 * rule whose `send_email` action silently does nothing is worse than no rule,
 * because the tenant believes the email went out.
 *
 * `trigger_workflow` is not merely unimplemented — rules that fire rules are
 * how an automation engine becomes a loop nobody can trace, so it waits for a
 * depth guard to arrive with it (docs/27 §1).
 */
export const ACTIONS_WITHOUT_ADAPTER = [
  'send_email',
  'send_line',
  'run_ai',
  'assign_coach',
  'update_segment',
  'create_task',
  'trigger_workflow',
] as const;

/** Every event name the outbox can carry; a trigger must be one of them. */
export const TRIGGER_EVENTS = new Set<string>(Object.values(EVENTS));

/**
 * A metric condition reuses the rank and compensation vocabulary verbatim —
 * metric, comparator, threshold, window, graph — so a rule that says "personal
 * volume ≥ 50,000" computes the same number the rank ladder and the commission
 * run do.
 */
const metricConditionSchema = z.object({
  metric: z.enum(RANK_METRICS),
  comparator: z.enum(RANK_COMPARATORS).default('gte'),
  threshold: z.number().int().min(0).max(1_000_000_000_000),
  window: z.enum(RANK_WINDOWS).default('lifetime'),
  params: z.record(z.unknown()).nullish(),
  graph: z.enum(METRIC_GRAPHS).default('referral'),
});

/**
 * A payload matcher asks about the OCCURRENCE rather than the member: the value
 * at `payloadPath` in the event body equals `value`. Only equality — docs/27 §1
 * says "equals a value", and a comparator that ordered arbitrary JSON would be
 * inventing semantics the contract does not have.
 */
const payloadConditionSchema = z.object({
  /** Dotted path into the payload; a leading `payload.` is accepted and dropped. */
  payloadPath: z.string().regex(/^(payload\.)?[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/),
  comparator: z.literal('eq').default('eq'),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
});

export type MetricCondition = z.infer<typeof metricConditionSchema>;
export type PayloadCondition = z.infer<typeof payloadConditionSchema>;
export type RuleCondition = MetricCondition | PayloadCondition;

/** An action is `{ type, ...config }` — the shape the shared schema documents. */
export const actionSchema = z.object({ type: z.string().min(1).max(40) }).catchall(z.unknown());

export type RuleAction = z.infer<typeof actionSchema>;

export const ruleInputSchema = z.object({
  code: z.string().regex(/^[a-z0-9-]{2,40}$/),
  name: z.string().min(1).max(160),
  triggerEvent: z.string().min(1).max(80),
  conditions: z.array(z.record(z.unknown())).max(20).default([]),
  /** A rule with no actions does nothing, which is not a rule. */
  actions: z.array(actionSchema).min(1).max(10),
  priority: z.number().int().min(0).max(10_000).default(100),
  status: z.enum(['active', 'disabled', 'archived']).default('active'),
});

export type RuleInput = z.infer<typeof ruleInputSchema>;

/** Per-action config, checked at creation for the same reason (docs/27 §1). */
const ACTION_CONFIG_SCHEMAS: Record<ActionType, z.ZodTypeAny> = {
  send_notification: z
    .object({
      title: z.string().min(1).max(160),
      body: z.string().max(2000).optional(),
      link: z.string().max(500).optional(),
      /** The notification type a member's preferences switch off. */
      notificationType: z.string().min(1).max(60).optional(),
    })
    .passthrough(),
  grant_reward: z.object({ rewardCode: z.string().regex(/^[a-z0-9-]{2,40}$/) }).passthrough(),
  create_followup: z
    .object({
      title: z.string().min(1).max(160),
      notes: z.string().max(2000).optional(),
      dueInDays: z.number().int().min(0).max(3650).optional(),
    })
    .passthrough(),
  /**
   * Shape only. Whether the course still EXISTS is not asked here: a course can
   * be retired the day after a rule is written, so a missing referent surfaces
   * as a failed execution, which is where docs/27 §1 puts it.
   */
  assign_course: z.object({ courseId: z.string().uuid() }).passthrough(),
};

export function isSupportedAction(type: string): type is ActionType {
  return (ACTION_TYPES as readonly string[]).includes(type);
}

/** The reason an action cannot be accepted, or null when it can. */
export function actionProblem(action: RuleAction): string | null {
  if (!isSupportedAction(action.type)) {
    return (ACTIONS_WITHOUT_ADAPTER as readonly string[]).includes(action.type)
      ? `'${action.type}' has no adapter yet, so a rule using it would silently do nothing (docs/27 §1)`
      : `'${action.type}' is not an action this engine knows`;
  }
  const result = ACTION_CONFIG_SCHEMAS[action.type].safeParse(action);
  if (result.success) return null;
  return `'${action.type}' cannot run as configured — ${issues(result.error)}`;
}

/**
 * The reason a condition cannot be accepted, or the normalised condition. The
 * refusal quotes the value that was wrong — an unknown metric, comparator,
 * window or graph is a condition that can never be true, and the tenant needs
 * to know WHICH word to fix.
 */
export function normaliseCondition(
  raw: Record<string, unknown>,
): { condition: RuleCondition } | { problem: string } {
  if ('metric' in raw) {
    const named = (name: string, value: unknown, allowed: readonly string[]) =>
      value === undefined || allowed.includes(String(value))
        ? null
        : `'${String(value)}' is not a ${name} this platform knows`;
    const problem =
      named('metric', raw['metric'], RANK_METRICS) ??
      named('comparator', raw['comparator'], RANK_COMPARATORS) ??
      named('window', raw['window'], RANK_WINDOWS) ??
      named('graph', raw['graph'], METRIC_GRAPHS);
    if (problem) return { problem };
    const parsed = metricConditionSchema.safeParse(raw);
    return parsed.success ? { condition: parsed.data } : { problem: issues(parsed.error) };
  }

  if ('payloadPath' in raw) {
    if (raw['comparator'] !== undefined && raw['comparator'] !== 'eq') {
      return {
        problem: `a payload matcher compares with 'eq' only; '${String(raw['comparator'])}' would order values the platform cannot order`,
      };
    }
    const parsed = payloadConditionSchema.safeParse(raw);
    return parsed.success ? { condition: parsed.data } : { problem: issues(parsed.error) };
  }

  return { problem: 'a condition must name either a metric or a payloadPath' };
}

/** Re-reads stored rules, whose JSON columns are `unknown` to the client. */
export function parseConditions(value: unknown): RuleCondition[] {
  const rows = Array.isArray(value) ? value : [];
  const conditions: RuleCondition[] = [];
  for (const row of rows) {
    // Stored rows were normalised at creation, so anything unreadable here was
    // written around the API — refuse the rule rather than fire it half-gated.
    const result = normaliseCondition((row ?? {}) as Record<string, unknown>);
    if ('problem' in result) throw new Error(`stored condition is unreadable: ${result.problem}`);
    conditions.push(result.condition);
  }
  return conditions;
}

export function parseActions(value: unknown): RuleAction[] {
  return z.array(actionSchema).parse(value ?? []);
}

export function isMetricCondition(condition: RuleCondition): condition is MetricCondition {
  return 'metric' in condition;
}

export function isPayloadCondition(condition: RuleCondition): condition is PayloadCondition {
  return 'payloadPath' in condition;
}

export function conditionRequirement(condition: MetricCondition): MetricRequirement {
  return {
    metric: condition.metric,
    window: condition.window,
    params: condition.params ?? null,
    graph: condition.graph,
  };
}

function issues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || 'config'}: ${i.message}`).join('; ');
}
