import type { DomainEventEnvelope } from '@aviora/shared';
import type { Tx } from '@aviora/db';
import { computeMetrics, passes, requirementKey } from '../growth/metrics';
import { MAX_REFERRAL_DEPTH } from '../growth/referral.service';
import { compensationGraph, MAX_COMPENSATION_DEPTH } from '../compensation/placement.service';
import {
  conditionRequirement,
  isMetricCondition,
  isPayloadCondition,
  type RuleCondition,
} from './rules';

export interface ConditionCheck {
  kind: 'metric' | 'payload';
  /** metric name or payload path */
  subject: string;
  expected: unknown;
  actual: unknown;
  met: boolean;
}

export interface ConditionVerdict {
  matched: boolean;
  /** Why the rule did not fire — recorded on the skipped execution. */
  reason: string | null;
  checks: ConditionCheck[];
}

/**
 * A rule with no conditions fires on every occurrence of its trigger
 * (docs/27 §1). Metric conditions are computed by the SHARED calculator over
 * the graph the condition names, so an automation rule and a rank rule that
 * say the same thing cannot disagree about a member.
 */
export async function evaluateConditions(
  tx: Tx,
  scope: { tenantId: string; memberId: string | null; event: DomainEventEnvelope },
  conditions: RuleCondition[],
): Promise<ConditionVerdict> {
  const checks: ConditionCheck[] = [];

  for (const condition of conditions.filter(isPayloadCondition)) {
    const actual = readPath(scope.event.payload, condition.payloadPath);
    checks.push({
      kind: 'payload',
      subject: condition.payloadPath,
      expected: condition.value,
      actual,
      met: actual === condition.value,
    });
  }

  const metricConditions = conditions.filter(isMetricCondition);
  if (metricConditions.length > 0) {
    if (!scope.memberId) {
      return {
        matched: false,
        reason: 'the event names no member, so a metric condition cannot be computed',
        checks,
      };
    }
    const requirements = metricConditions.map(conditionRequirement);
    const values = await computeMetrics(
      {
        tx,
        tenantId: scope.tenantId,
        memberId: scope.memberId,
        // The moment the event describes, not the moment it was relayed: a
        // retried event must evaluate to what was true when it happened.
        asOf: new Date(scope.event.occurredAt),
        maxDepth: requirements.some((r) => r.graph === 'compensation')
          ? MAX_COMPENSATION_DEPTH
          : MAX_REFERRAL_DEPTH,
        graphs: { compensation: compensationGraph },
      },
      requirements,
    );
    for (const condition of metricConditions) {
      const value = values[requirementKey(conditionRequirement(condition))] ?? 0;
      checks.push({
        kind: 'metric',
        subject: condition.metric,
        expected: `${condition.comparator} ${condition.threshold}`,
        actual: value,
        met: passes(condition.comparator, value, condition.threshold),
      });
    }
  }

  const unmet = checks.filter((c) => !c.met);
  return {
    matched: unmet.length === 0,
    reason: unmet.length === 0 ? null : `${unmet.length} of ${checks.length} conditions not met`,
    checks,
  };
}

/** `a.b`, or `payload.a.b`, into the event body; a missing path is undefined. */
function readPath(payload: unknown, path: string): unknown {
  const segments = path.split('.');
  if (segments[0] === 'payload') segments.shift();
  let cursor: unknown = payload;
  for (const segment of segments) {
    if (typeof cursor !== 'object' || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}
