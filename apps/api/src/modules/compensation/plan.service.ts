import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ERROR_CODES } from '@aviora/shared';
import type { Tx } from '@aviora/db';
import { TenantDb } from '../../common/db/tenant-db.service';
import { tenantCurrency } from '../../common/money/currency';
import { AuditService } from '../../common/audit/audit.service';
import { basisRequirement, type RuleInput } from './rules';

export interface CreatePlanInput {
  code: string;
  name: string;
  description?: string;
  currency?: string;
  status?: 'active' | 'archived';
  effectiveFrom?: Date;
  effectiveTo?: Date;
  rules: RuleInput[];
}

/**
 * Plans and their rules (docs/26 §3). A plan is configuration: the tenant's
 * eleven — or twelve — bonuses are rows in `compensation_rules`, and this
 * service never learns any of their names.
 */
@Injectable()
export class PlanService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
  ) {}

  list() {
    return this.db.tx((tx) =>
      tx.compensationPlan.findMany({
        orderBy: { createdAt: 'desc' },
        include: { rules: { orderBy: [{ priority: 'asc' }, { code: 'asc' }] } },
      }),
    );
  }

  async create(input: CreatePlanInput) {
    for (const rule of input.rules) assertRuleIsComputable(rule);

    const plan = await this.db
      .tx(async (tx) => {
        const created = await tx.compensationPlan.create({
          data: {
            tenantId: this.db.tenantId,
            code: input.code,
            name: input.name,
            description: input.description,
            currency: input.currency ?? (await tenantCurrency(tx)),
            status: input.status ?? 'active',
            ...(input.effectiveFrom ? { effectiveFrom: input.effectiveFrom } : {}),
            effectiveTo: input.effectiveTo ?? null,
          },
        });
        for (const rule of input.rules) await this.insertRule(tx, created.id, rule);
        return tx.compensationPlan.findFirstOrThrow({
          where: { id: created.id },
          include: { rules: { orderBy: [{ priority: 'asc' }, { code: 'asc' }] } },
        });
      })
      .catch((e: unknown) => {
        if ((e as { code?: string } | null)?.code !== 'P2002') throw e;
        throw new ConflictException({
          code: ERROR_CODES.CONFLICT,
          message: 'A plan with this code already exists, or a rule code is repeated',
        });
      });

    await this.audit.record({
      action: 'compensation.plan.create',
      entityType: 'compensation_plan',
      entityId: plan.id,
      after: { code: plan.code, currency: plan.currency, rules: plan.rules.length },
    });
    return plan;
  }

  async addRule(planId: string, input: RuleInput) {
    assertRuleIsComputable(input);

    const rule = await this.db
      .tx(async (tx) => {
        const plan = await tx.compensationPlan.findFirst({
          where: { id: planId },
          select: { id: true },
        });
        if (!plan) {
          throw new NotFoundException({
            code: ERROR_CODES.NOT_FOUND,
            message: 'Compensation plan not found',
          });
        }
        return this.insertRule(tx, plan.id, input);
      })
      .catch((e: unknown) => {
        if ((e as { code?: string } | null)?.code !== 'P2002') throw e;
        throw new ConflictException({
          code: ERROR_CODES.CONFLICT,
          message: 'A rule with this code already exists in this plan',
        });
      });

    await this.audit.record({
      action: 'compensation.rule.create',
      entityType: 'compensation_rule',
      entityId: rule.id,
      after: { planId, code: rule.code, bonusType: rule.bonusType },
    });
    return rule;
  }

  private insertRule(tx: Tx, planId: string, input: RuleInput) {
    return tx.compensationRule.create({
      data: {
        tenantId: this.db.tenantId,
        planId,
        code: input.code,
        name: input.name,
        bonusType: input.bonusType,
        priority: input.priority,
        status: input.status,
        conditions: input.conditions as object[],
        payout: input.payout as object,
      },
    });
  }
}

/**
 * The shapes Zod cannot express: a `qualified_legs` metric is meaningless
 * without the volume that makes a leg qualify, and it would otherwise compute
 * silently against a threshold of zero — every leg qualifying, every period.
 */
function assertRuleIsComputable(rule: RuleInput): void {
  const basis = basisRequirement(rule.payout);
  const uses = [
    ...rule.conditions.map((c) => ({ metric: c.metric, params: c.params ?? null })),
    ...(basis ? [{ metric: basis.metric, params: basis.params }] : []),
  ];
  for (const use of uses) {
    if (use.metric === 'qualified_legs' && !numeric(use.params?.legVolumeMinor)) {
      throw new ConflictException({
        code: ERROR_CODES.VALIDATION_FAILED,
        message: `Rule ${rule.code}: a qualified_legs metric needs params.legVolumeMinor`,
      });
    }
  }
}

function numeric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
