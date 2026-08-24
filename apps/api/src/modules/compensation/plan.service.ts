import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ERROR_CODES } from '@aviora/shared';
import type { Tx } from '@aviora/db';
import { TenantDb } from '../../common/db/tenant-db.service';
import { tenantCurrency } from '../../common/money/currency';
import { AuditService } from '../../common/audit/audit.service';
import { basisRequirement, type DifferentialTier, type RuleInput } from './rules';

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
 * The shapes Zod cannot express.
 *
 * Every check here guards the same failure: a rule that is syntactically fine,
 * computes silently, and pays the wrong number. A validation error is a message
 * an admin can act on; a plan that quietly resolves everything to zero — or to
 * everything — is discovered in a payout, by a member.
 */
function assertRuleIsComputable(rule: RuleInput): void {
  const basis = basisRequirement(rule.payout);
  const uses = [
    ...rule.conditions.map((c) => ({ metric: c.metric, params: c.params ?? null })),
    ...(basis ? [{ metric: basis.metric, params: basis.params }] : []),
  ];
  for (const use of uses) {
    // A `qualified_legs` metric is meaningless without the volume that makes a
    // leg qualify, and would otherwise compute against a threshold of zero —
    // every leg qualifying, every period.
    if (use.metric === 'qualified_legs' && !numeric(use.params?.legVolumeMinor)) {
      throw new ConflictException({
        code: ERROR_CODES.VALIDATION_FAILED,
        message: `Rule ${rule.code}: a qualified_legs metric needs params.legVolumeMinor`,
      });
    }
    // Breakaway at zero excludes EVERY leg, because every leg is at or above
    // nothing. The rule would then answer zero to every question and disqualify
    // the whole tenant, which reads as "nobody sold anything" rather than as a
    // misconfiguration. Zero has no legitimate meaning here, so it is refused
    // rather than reinterpreted as "off" — absent is how a plan says off.
    if ('excludeLegsAtOrAboveMinor' in (use.params ?? {})) {
      const threshold = use.params?.excludeLegsAtOrAboveMinor;
      if (!Number.isInteger(threshold) || (threshold as number) < 1) {
        throw new ConflictException({
          code: ERROR_CODES.VALIDATION_FAILED,
          message:
            `Rule ${rule.code}: params.excludeLegsAtOrAboveMinor must be a whole number of at ` +
            `least 1. A breakaway threshold of zero would exclude every leg. Remove the ` +
            `parameter to turn breakaway off.`,
        });
      }
    }
  }

  if (rule.payout.kind === 'differential') assertLadderIsReadable(rule.code, rule.payout.tiers);
}

/**
 * A ladder has to be readable by the person who typed it as well as by the
 * calculator. `tierPercent` scans rather than assuming order, so none of this
 * changes an answer — it stops a tenant from storing a ladder whose rungs are
 * out of order or repeated, which nobody could check against their own plan
 * document.
 *
 * A ladder whose rungs are all the same rate is refused for a different reason:
 * it computes, and it pays nothing, for ever. Every leg resolves to the payee's
 * own rate, every difference is zero, and the rule produces no entries at all.
 * That is docs/62 §3's zero-threshold rank in the other direction — silent
 * rather than universal, and just as much a trap.
 */
function assertLadderIsReadable(ruleCode: string, tiers: DifferentialTier[]): void {
  let previous: DifferentialTier | null = null;
  for (const tier of tiers) {
    if (
      previous &&
      (tier.atLeastMinor <= previous.atLeastMinor || tier.percent <= previous.percent)
    ) {
      throw new ConflictException({
        code: ERROR_CODES.VALIDATION_FAILED,
        message:
          `Rule ${ruleCode}: the ladder must be ordered, with each rung requiring more volume ` +
          `and paying a higher percentage than the one before it.`,
      });
    }
    previous = tier;
  }
  const only = tiers.length === 1 ? tiers[0] : null;
  if (only && only.percent <= 0) {
    throw new ConflictException({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: `Rule ${ruleCode}: a ladder with a single rung at 0% can never pay anything.`,
    });
  }
}

function numeric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
