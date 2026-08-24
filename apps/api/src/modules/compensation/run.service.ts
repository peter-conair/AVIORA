import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ERROR_CODES, EVENTS } from '@aviora/shared';
import { appendEvent, type Tx } from '@aviora/db';
import { TenantDb } from '../../common/db/tenant-db.service';
import { AuditService } from '../../common/audit/audit.service';
import {
  computeMetrics,
  legVolumes,
  passes,
  requirementKey,
  type MetricRequirement,
  type MetricScope,
} from '../growth/metrics';
import { MAX_COMPENSATION_DEPTH, compensationGraph } from './placement.service';
import {
  basisRequirement,
  conditionRequirement,
  differentialAmount,
  parseConditions,
  parsePayout,
  payoutAmount,
  type DifferentialLeg,
  type RuleCondition,
  type RulePayout,
} from './rules';

export interface CreateRunInput {
  planId: string;
  periodStart: Date;
  periodEnd: Date;
}

/** What computing a run needs to know about it. */
interface RunTarget {
  id: string;
  planId: string;
  periodStart: Date;
  periodEnd: Date;
  currency: string;
}

interface LoadedRule {
  id: string;
  code: string;
  bonusType: string;
  conditions: RuleCondition[];
  payout: RulePayout;
}

/**
 * Commission runs (docs/26 §4). A run is a SNAPSHOT of a period: it computes as
 * of `periodEnd` over the as-of graph traversal, so recomputing a draft over
 * unchanged source data produces identical entries and an entry can be
 * explained a year later without re-running anything.
 *
 * Computation is TWO passes over the members, not one — see `computeInto`. That
 * is the whole structural cost of supporting stairstep plans, and it is paid
 * whether or not a plan uses them, because a run that changed shape depending
 * on its rules would be a second engine wearing the first one's name.
 */
@Injectable()
export class RunService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
  ) {}

  list() {
    return this.db.tx((tx) =>
      tx.commissionRun.findMany({
        orderBy: { periodEnd: 'desc' },
        include: { plan: { select: { code: true, name: true } } },
      }),
    );
  }

  /**
   * Idempotent per period. Asking twice for the same (plan, start, end) returns
   * the run that already exists — the second row would be a second payout, the
   * same defence and the same reason as subscription renewal.
   */
  async create(input: CreateRunInput, actorUserId: string) {
    const existing = await this.findByPeriod(input);
    if (existing) return { run: existing, created: false };

    try {
      const run = await this.db.tx(async (tx) => {
        const plan = await tx.compensationPlan.findFirst({
          where: { id: input.planId, status: 'active' },
          select: { id: true, currency: true },
        });
        if (!plan) {
          throw new NotFoundException({
            code: ERROR_CODES.NOT_FOUND,
            message: 'Active compensation plan not found',
          });
        }
        const created = await tx.commissionRun.create({
          data: {
            tenantId: this.db.tenantId,
            planId: plan.id,
            periodStart: input.periodStart,
            periodEnd: input.periodEnd,
            currency: plan.currency,
          },
        });
        await appendEvent(tx, {
          eventName: EVENTS.CommissionRunCreated,
          tenantId: this.db.tenantId,
          aggregateType: 'commission_run',
          aggregateId: created.id,
          actorUserId,
          payload: {
            planId: plan.id,
            periodStart: input.periodStart.toISOString(),
            periodEnd: input.periodEnd.toISOString(),
            currency: plan.currency,
          },
        });
        // Computed inside the same transaction: a run that exists but was never
        // costed is a period the unique key now says has already been run.
        return this.computeInto(tx, created);
      });
      await this.audit.record({
        action: 'compensation.run.create',
        entityType: 'commission_run',
        entityId: run.id,
        after: { planId: run.planId, entryCount: run.entryCount, totalMinor: run.totalMinor },
      });
      return { run, created: true };
    } catch (e: unknown) {
      if ((e as { code?: string } | null)?.code !== 'P2002') throw e;
      // The unique key on the period, not the read above, is the arbiter: two
      // callers racing cannot both create a run, and the loser returns the
      // winner's rather than reporting a failure the caller cannot act on.
      const raced = await this.findByPeriod(input);
      if (!raced) throw e;
      return { run: raced, created: false };
    }
  }

  /** Draft only. An approved run is frozen, and saying so beats a silent no-op. */
  async recompute(id: string) {
    const run = await this.db.tx(async (tx) => {
      const existing = await this.forUpdate(tx, id);
      if (existing.status !== 'draft') {
        throw new ConflictException({
          code: ERROR_CODES.CONFLICT,
          message: `A run that is ${existing.status} is frozen and cannot be recomputed`,
        });
      }
      return this.computeInto(tx, existing);
    });
    await this.audit.record({
      action: 'compensation.run.recompute',
      entityType: 'commission_run',
      entityId: run.id,
      after: { entryCount: run.entryCount, totalMinor: run.totalMinor },
    });
    return run;
  }

  /**
   * Freezes the run and emits `CommissionEarned` per entry. Draft computation
   * emits nothing: a draft is a proposal, and nothing downstream — gamification
   * included — should react to a proposal (docs/26 §4).
   */
  async approve(id: string, actorUserId: string) {
    const run = await this.db.tx(async (tx) => {
      const existing = await this.forUpdate(tx, id);
      if (existing.status !== 'draft') {
        throw new ConflictException({
          code: ERROR_CODES.CONFLICT,
          message: `A run that is ${existing.status} cannot be approved again`,
        });
      }
      const entries = await tx.commissionEntry.findMany({
        where: { runId: existing.id },
        orderBy: { memberId: 'asc' },
      });
      const approved = await tx.commissionRun.update({
        where: { id: existing.id },
        data: { status: 'approved', approvedAt: new Date() },
      });
      await appendEvent(tx, {
        eventName: EVENTS.CommissionRunApproved,
        tenantId: this.db.tenantId,
        aggregateType: 'commission_run',
        aggregateId: approved.id,
        actorUserId,
        payload: {
          planId: approved.planId,
          periodStart: approved.periodStart.toISOString(),
          periodEnd: approved.periodEnd.toISOString(),
          currency: approved.currency,
          totalMinor: approved.totalMinor,
          entryCount: approved.entryCount,
        },
      });
      for (const entry of entries) {
        await appendEvent(tx, {
          eventName: EVENTS.CommissionEarned,
          tenantId: this.db.tenantId,
          aggregateType: 'commission_entry',
          aggregateId: entry.id,
          actorUserId,
          payload: {
            runId: approved.id,
            memberId: entry.memberId,
            ruleId: entry.ruleId,
            bonusType: entry.bonusType,
            amountMinor: entry.amountMinor,
            currency: entry.currency,
          },
        });
      }
      return approved;
    });
    await this.audit.record({
      action: 'compensation.run.approve',
      entityType: 'commission_run',
      entityId: run.id,
      after: { status: run.status, totalMinor: run.totalMinor, entryCount: run.entryCount },
    });
    return run;
  }

  entries(runId: string) {
    return this.db.tx(async (tx) => {
      const run = await this.forUpdate(tx, runId);
      const entries = await tx.commissionEntry.findMany({
        where: { runId: run.id },
        orderBy: [{ memberId: 'asc' }, { amountMinor: 'desc' }],
        include: {
          member: { select: { displayName: true } },
          rule: { select: { code: true, name: true } },
        },
      });
      return { run, entries };
    });
  }

  /**
   * The caller's own APPROVED entries. A member should never see a number that
   * has not been signed off, so a draft run is invisible here (docs/26 §7).
   */
  me(memberId: string) {
    return this.db.tx(async (tx) => {
      const entries = await tx.commissionEntry.findMany({
        where: { memberId, run: { status: 'approved' } },
        orderBy: { id: 'desc' },
        include: {
          run: { select: { id: true, periodStart: true, periodEnd: true, approvedAt: true } },
          rule: { select: { code: true, name: true } },
        },
      });
      return {
        memberId,
        currency: entries[0]?.currency ?? null,
        totalMinor: entries.reduce((sum, e) => sum + e.amountMinor, 0),
        entries,
      };
    });
  }

  /**
   * Replaces the run's entries with what the plan's rules produce as of
   * `periodEnd`. Draft entries are deleted first rather than merged, so a
   * recompute after a rule is archived does not leave its payout behind.
   */
  private async computeInto(tx: Tx, run: RunTarget) {
    const rules = await this.activeRules(tx, run.planId);
    const requirements = rules.flatMap((rule) => [
      ...rule.conditions.map(conditionRequirement),
      ...basisOf(rule.payout),
    ]);

    await tx.commissionEntry.deleteMany({ where: { runId: run.id } });

    let totalMinor = 0;
    let entryCount = 0;
    if (rules.length) {
      const members = await tx.member.findMany({
        where: { status: 'active' },
        orderBy: { id: 'asc' },
        select: { id: true },
      });

      const scopeFor = (memberId: string): MetricScope => ({
        tx,
        tenantId: this.db.tenantId,
        memberId,
        asOf: run.periodEnd,
        // a run is a snapshot of a period, so a `period` window means this
        // run's window and nothing else
        periodStart: run.periodStart,
        maxDepth: MAX_COMPENSATION_DEPTH,
        // The compensation graph is walked through its own adapter; the
        // shared calculator never learns its table exists.
        graphs: { compensation: compensationGraph },
      });

      // PASS ONE — resolve every member before paying anybody.
      //
      // A differential owes what the payee's rate exceeds the LEG's rate by, so
      // the payout for one member is not a function of that member alone
      // (docs/70 §3). Computing and paying in a single loop would read a leg's
      // metrics before or after its own turn depending on id order, which is a
      // plan that pays differently on Tuesday. Two passes is the smallest
      // structure in which that cannot happen.
      const metricsByMember = new Map<string, Record<string, number>>();
      for (const member of members) {
        metricsByMember.set(member.id, await computeMetrics(scopeFor(member.id), requirements));
      }
      // A leg may be headed by somebody who is no longer active, and their rate
      // still decides what their upline is owed. Resolved on demand rather than
      // by widening pass one, so an archived member costs a query only where
      // they are actually part of somebody's line.
      const valuesFor = async (memberId: string): Promise<Record<string, number>> => {
        const cached = metricsByMember.get(memberId);
        if (cached) return cached;
        const computed = await computeMetrics(scopeFor(memberId), requirements);
        metricsByMember.set(memberId, computed);
        return computed;
      };

      // PASS TWO — pay.
      for (const member of members) {
        const values = metricsByMember.get(member.id) ?? {};
        for (const rule of rules) {
          const checks = rule.conditions.map((condition) => ({
            metric: condition.metric,
            comparator: condition.comparator,
            window: condition.window,
            graph: condition.graph,
            threshold: condition.threshold,
            value: values[requirementKey(conditionRequirement(condition))] ?? 0,
          }));
          if (!checks.every((c) => passes(c.comparator, c.value, c.threshold))) continue;

          const basis = basisRequirement(rule.payout);
          const basisValue = basis ? (values[requirementKey(basis)] ?? 0) : 0;

          let amountMinor: number;
          let uncappedMinor: number;
          let capApplied: boolean;
          let differential: { ratePercent: number; legs: DifferentialLeg[] } | null = null;

          if (rule.payout.kind === 'differential' && basis) {
            const legs = await legVolumes(scopeFor(member.id), basis);
            const rated = [];
            for (const leg of legs) {
              const legValues = await valuesFor(leg.memberId);
              rated.push({ ...leg, basisMinor: legValues[requirementKey(basis)] ?? 0 });
            }
            const computed = differentialAmount(rule.payout, basisValue, rated);
            ({ amountMinor, uncappedMinor, capApplied } = computed);
            differential = { ratePercent: computed.ratePercent, legs: computed.legs };
          } else {
            ({ amountMinor, uncappedMinor, capApplied } = payoutAmount(rule.payout, basisValue));
          }

          // A qualifying rule that comes to nothing is not a payment; a zero
          // row would still land in the run's totals and in the member's
          // earnings view.
          if (amountMinor <= 0) continue;

          await tx.commissionEntry.create({
            data: {
              tenantId: this.db.tenantId,
              runId: run.id,
              memberId: member.id,
              ruleId: rule.id,
              // Carried through as the label it is. Nothing above branched on
              // it and nothing below will (docs/26 §1).
              bonusType: rule.bonusType,
              amountMinor,
              currency: run.currency,
              basis: {
                ruleCode: rule.code,
                asOf: run.periodEnd.toISOString(),
                conditions: checks,
                payout: {
                  ...rule.payout,
                  ...(basis ? { basisValue } : {}),
                  ...(differential ?? {}),
                  uncappedMinor,
                  capApplied,
                },
              } as object,
            },
          });
          totalMinor += amountMinor;
          entryCount += 1;
        }
      }
    }

    return tx.commissionRun.update({
      where: { id: run.id },
      data: { totalMinor, entryCount, computedAt: new Date() },
    });
  }

  private async activeRules(tx: Tx, planId: string): Promise<LoadedRule[]> {
    const rows = await tx.compensationRule.findMany({
      where: { planId, status: 'active' },
      orderBy: [{ priority: 'asc' }, { code: 'asc' }],
    });
    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      bonusType: row.bonusType,
      conditions: parseConditions(row.conditions),
      payout: parsePayout(row.payout),
    }));
  }

  private findByPeriod(input: CreateRunInput) {
    return this.db.tx((tx) =>
      tx.commissionRun.findFirst({
        where: {
          planId: input.planId,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
        },
      }),
    );
  }

  private async forUpdate(tx: Tx, id: string) {
    const run = await tx.commissionRun.findFirst({ where: { id } });
    if (!run) {
      throw new NotFoundException({
        code: ERROR_CODES.NOT_FOUND,
        message: 'Commission run not found',
      });
    }
    return run;
  }
}

function basisOf(payout: RulePayout): MetricRequirement[] {
  const basis = basisRequirement(payout);
  return basis ? [basis] : [];
}
