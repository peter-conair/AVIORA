import { Injectable, Logger } from '@nestjs/common';
import type { DomainEventEnvelope } from '@aviora/shared';
import { withTenant } from '@aviora/db';
import { PrismaService } from '../../common/db/prisma.service';
import { ActionAdapters } from './action-adapters';
import { evaluateConditions, type ConditionVerdict } from './conditions';
import { parseActions, parseConditions } from './rules';

interface RuleRow {
  id: string;
  code: string;
  conditions: unknown;
  actions: unknown;
}

interface ActionOutcome {
  index: number;
  type: string;
  status: 'success' | 'failed';
  detail?: Record<string, unknown>;
  error?: string;
}

/**
 * The automation engine (docs/27 §1): ONE more handler on the existing event
 * bus, not a new pipeline. For each active rule on the event's trigger it
 * records an execution and runs the rule's actions.
 *
 * Two guarantees hold this file together:
 *
 * 1. `UNIQUE (rule_id, event_id)` is the arbiter. The execution row is inserted
 *    BEFORE any action runs, so a replayed event collides on the key and does
 *    nothing — it cannot grant a second reward.
 * 2. Failure is isolated the way the bus already isolates handlers. An action
 *    that throws marks its own execution failed with the error; the rule's
 *    remaining actions still run, and so do the other rules.
 *
 * Nothing here appends an event. A rule that emitted an event would be a rule
 * that can trigger a rule (docs/27 §6).
 */
/** True when this event was produced by an automation action. */
function causedByAutomation(event: DomainEventEnvelope): boolean {
  const payload = event.payload as { sourceType?: unknown } | null;
  return !!payload && payload.sourceType === 'automation';
}

@Injectable()
export class AutomationEngine {
  private readonly logger = new Logger(AutomationEngine.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly actions: ActionAdapters,
  ) {}

  async run(event: DomainEventEnvelope): Promise<void> {
    // Platform-scope events (tenant_id NULL) belong to no tenant's rules.
    if (!event.tenantId) return;

    // Automation never reacts to its own output. Rewards emit events, and any
    // event is a legal trigger, so a rule granting a reward on RewardGranted
    // would chain for ever — the same loop docs/27 §1 refuses `trigger_workflow`
    // to avoid, arriving through the back door. Nothing is lost by cutting it:
    // a rule's actions are a LIST, so anything that should happen alongside an
    // automated grant belongs in the same rule, where it is visible.
    if (causedByAutomation(event)) return;

    const tenantId = event.tenantId;

    const rules = await withTenant(this.prisma.app, tenantId, (tx) =>
      tx.automationRule.findMany({
        where: { triggerEvent: event.eventName, status: 'active' },
        orderBy: [{ priority: 'asc' }, { code: 'asc' }],
        select: { id: true, code: true, conditions: true, actions: true },
      }),
    );

    for (const rule of rules) {
      try {
        await this.runRule(tenantId, rule, event);
      } catch (e) {
        // A rule that fails OUTSIDE its own recording — an unreadable rule row,
        // a lost connection — must not stop the rules after it. The handler
        // itself never throws: the executions are the audit trail, and a
        // retried event would collide on (rule_id, event_id) anyway.
        this.logger.error(
          `automation rule ${rule.code} failed for ${event.eventName} (${event.eventId}): ${message(e)}`,
        );
      }
    }
  }

  private async runRule(
    tenantId: string,
    rule: RuleRow,
    event: DomainEventEnvelope,
  ): Promise<void> {
    const conditions = parseConditions(rule.conditions);
    const actions = parseActions(rule.actions);
    const memberId = memberOf(event);

    const verdict = await withTenant(this.prisma.app, tenantId, (tx) =>
      evaluateConditions(tx, { tenantId, memberId, event }, conditions),
    );
    // Every adapter acts ON a member; without one there is nothing to act upon.
    const blocked =
      verdict.matched && !memberId ? 'the event names no member to act upon' : verdict.reason;

    const executionId = await this.open(tenantId, rule, event, memberId, {
      ...verdict,
      matched: verdict.matched && blocked === null,
      reason: blocked,
    });
    if (!executionId) return; // this event already fired this rule
    if (blocked !== null || !memberId) return; // recorded as skipped

    const outcomes: ActionOutcome[] = [];
    const errors: string[] = [];
    for (const [index, action] of actions.entries()) {
      try {
        const detail = await this.actions.run(action, {
          tenantId,
          memberId,
          ruleCode: rule.code,
          event,
        });
        outcomes.push({ index, type: action.type, status: 'success', detail });
      } catch (e) {
        const error = message(e);
        errors.push(`${action.type}: ${error}`);
        outcomes.push({ index, type: action.type, status: 'failed', error });
      }
    }

    await withTenant(this.prisma.app, tenantId, (tx) =>
      tx.automationExecution.update({
        where: { id: executionId },
        data: {
          status: errors.length === 0 ? 'success' : 'failed',
          result: { actions: outcomes, conditions: verdict.checks } as object,
          error: errors.length === 0 ? null : errors.join(' | ').slice(0, 2000),
        },
      }),
    );
  }

  /**
   * Claims the (rule, event) pair. Returns null when another run — a replay, or
   * a second relay instance — already claimed it; that collision is the whole
   * idempotency guarantee, so it is expected rather than an error.
   *
   * A matching rule is recorded as `running` and settled below. A rule whose
   * conditions did not match is settled here as `skipped`, which also makes the
   * decision permanent: a replayed event re-reads the same row rather than
   * re-deciding against data that has moved on.
   */
  private async open(
    tenantId: string,
    rule: RuleRow,
    event: DomainEventEnvelope,
    memberId: string | null,
    verdict: ConditionVerdict,
  ): Promise<string | null> {
    try {
      const execution = await withTenant(this.prisma.app, tenantId, (tx) =>
        tx.automationExecution.create({
          data: {
            tenantId,
            ruleId: rule.id,
            eventId: event.eventId,
            memberId,
            status: verdict.matched ? 'running' : 'skipped',
            result: {
              ruleCode: rule.code,
              eventName: event.eventName,
              conditions: verdict.checks,
              ...(verdict.matched ? {} : { skippedBecause: verdict.reason }),
            } as object,
          },
          select: { id: true },
        }),
      );
      return verdict.matched ? execution.id : null;
    } catch (e) {
      if ((e as { code?: string } | null)?.code === 'P2002') return null;
      throw e;
    }
  }
}

/**
 * The member an event is about. Payloads name them in one of two ways and
 * member-aggregate events carry the id itself; an event that names none simply
 * has no member, and rules with actions skip.
 */
function memberOf(event: DomainEventEnvelope): string | null {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  for (const key of ['memberId', 'ownerMemberId']) {
    const value = payload[key];
    if (typeof value === 'string' && value) return value;
  }
  return event.aggregateType === 'member' ? event.aggregateId : null;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
