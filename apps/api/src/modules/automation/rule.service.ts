import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ERROR_CODES } from '@aviora/shared';
import { TenantDb } from '../../common/db/tenant-db.service';
import { AuditService } from '../../common/audit/audit.service';
import {
  actionProblem,
  normaliseCondition,
  TRIGGER_EVENTS,
  type RuleCondition,
  type RuleInput,
} from './rules';

export interface UpdateRuleInput {
  name?: string;
  priority?: number;
  status?: 'active' | 'disabled' | 'archived';
}

export interface ExecutionQuery {
  ruleId?: string;
  status?: string;
  limit?: number;
}

const EXECUTION_PAGE = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Rule configuration (docs/27 §1). Everything a rule can get wrong is refused
 * HERE, with the reason: a rule naming an event that does not exist can never
 * fire, and an action with no adapter would look configured and do nothing.
 * Both are typos, and both are cheaper to find now than in an execution log.
 */
@Injectable()
export class RuleService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
  ) {}

  list() {
    return this.db.tx((tx) =>
      tx.automationRule.findMany({ orderBy: [{ priority: 'asc' }, { code: 'asc' }] }),
    );
  }

  async create(input: RuleInput) {
    if (!TRIGGER_EVENTS.has(input.triggerEvent)) {
      throw new ConflictException({
        code: ERROR_CODES.VALIDATION_FAILED,
        message: `'${input.triggerEvent}' is not an event this platform emits, so the rule could never fire`,
      });
    }
    const conditions: RuleCondition[] = [];
    for (const [index, raw] of input.conditions.entries()) {
      const result = normaliseCondition(raw);
      if ('problem' in result) {
        throw new ConflictException({
          code: ERROR_CODES.VALIDATION_FAILED,
          message: `Condition ${index + 1}: ${result.problem}`,
        });
      }
      conditions.push(result.condition);
    }
    // Every action, not just the first: a half-valid rule is the dangerous one,
    // because the half that works hides the half that never runs.
    for (const [index, action] of input.actions.entries()) {
      const problem = actionProblem(action);
      if (problem) {
        throw new ConflictException({
          code: ERROR_CODES.VALIDATION_FAILED,
          message: `Action ${index + 1}: ${problem}`,
        });
      }
    }

    const rule = await this.db
      .tx((tx) =>
        tx.automationRule.create({
          data: {
            tenantId: this.db.tenantId,
            code: input.code,
            name: input.name,
            triggerEvent: input.triggerEvent,
            // stored normalised, so a rule reads back exactly as it will run
            conditions: conditions as object[],
            actions: input.actions as object[],
            priority: input.priority,
            status: input.status,
          },
        }),
      )
      .catch((e: unknown) => {
        if ((e as { code?: string } | null)?.code !== 'P2002') throw e;
        throw new ConflictException({
          code: ERROR_CODES.CONFLICT,
          message: 'A rule with this code already exists',
        });
      });

    await this.audit.record({
      action: 'automation.rule.create',
      entityType: 'automation_rule',
      entityId: rule.id,
      after: {
        code: rule.code,
        triggerEvent: rule.triggerEvent,
        actions: input.actions.map((a) => a.type),
      },
    });
    return rule;
  }

  /** Enable, disable, reprioritise (docs/27 §5). A rule's trigger, conditions
   *  and actions are not editable in place: changing what a rule DOES while its
   *  executions still point at it would rewrite the audit trail's meaning. */
  async update(id: string, input: UpdateRuleInput) {
    const before = await this.db.tx((tx) => tx.automationRule.findFirst({ where: { id } }));
    if (!before) {
      throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Rule not found' });
    }

    const rule = await this.db.tx((tx) =>
      tx.automationRule.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.priority !== undefined ? { priority: input.priority } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
        },
      }),
    );

    await this.audit.record({
      action: 'automation.rule.update',
      entityType: 'automation_rule',
      entityId: rule.id,
      before: { status: before.status, priority: before.priority },
      after: { status: rule.status, priority: rule.priority },
    });
    return rule;
  }

  /** What fired, on which event, and what it did — newest first (docs/27 §5). */
  executions(query: ExecutionQuery) {
    const limit = Number.isFinite(query.limit) ? Number(query.limit) : EXECUTION_PAGE;
    return this.db.tx((tx) =>
      tx.automationExecution.findMany({
        where: {
          // A filter that is not a uuid cannot match a row; passing it to the
          // column would be a database error rather than an empty page.
          ...(query.ruleId && UUID.test(query.ruleId) ? { ruleId: query.ruleId } : {}),
          ...(query.status ? { status: query.status } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: Math.min(Math.max(limit, 1), EXECUTION_PAGE),
        include: { rule: { select: { code: true, name: true, triggerEvent: true } } },
      }),
    );
  }
}
