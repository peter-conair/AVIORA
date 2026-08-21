import { Injectable } from '@nestjs/common';
import { estimateAiCost, AI_RATE_CURRENCY } from '@aviora/shared';
import { PrismaService } from '../../common/db/prisma.service';

/**
 * A run claimed for longer than this is a job nobody finished (docs/35 §5).
 * Generous on purpose: a slow monthly commission draft is not an incident, and
 * an alarm that cries wolf is an alarm people turn off.
 */
const STALE_CLAIM_MINUTES = 30;

/** How far back the usage answers look unless asked otherwise. */
const DEFAULT_WINDOW_DAYS = 30;

export interface QueueHealth {
  pending: number;
  failing: number;
  processedInWindow: number;
  oldestPendingAgeSeconds: number | null;
  worstAttempts: number;
  window: { days: number; from: string; to: string };
  note: string;
}

@Injectable()
export class ObservabilityService {
  constructor(private readonly prisma: PrismaService) {}

  private windowFrom(days?: number): { days: number; from: Date; to: Date } {
    const d = Math.min(Math.max(Math.trunc(days ?? DEFAULT_WINDOW_DAYS), 1), 365);
    const to = new Date();
    const from = new Date(to.getTime() - d * 24 * 60 * 60 * 1000);
    return { days: d, from, to };
  }

  /**
   * The outbox, as it stands right now (docs/36 §1 — nothing here is stored).
   *
   * "Failing" is not a status the table carries: an event with attempts and a
   * last error is one the relay keeps retrying, and the honest reading of it is
   * "not delivered yet, and it has already gone wrong at least once".
   */
  async queue(days?: number): Promise<QueueHealth> {
    const w = this.windowFrom(days);
    const [pending, failing, processed, oldest, worst] = await Promise.all([
      this.prisma.owner.domainEvent.count({ where: { processedAt: null } }),
      this.prisma.owner.domainEvent.count({ where: { processedAt: null, attempts: { gt: 0 } } }),
      this.prisma.owner.domainEvent.count({ where: { processedAt: { gte: w.from } } }),
      this.prisma.owner.domainEvent.findFirst({
        where: { processedAt: null },
        orderBy: { occurredAt: 'asc' },
        select: { occurredAt: true },
      }),
      this.prisma.owner.domainEvent.findFirst({
        where: { processedAt: null },
        orderBy: { attempts: 'desc' },
        select: { attempts: true, lastError: true },
      }),
    ]);
    return {
      pending,
      failing,
      processedInWindow: processed,
      oldestPendingAgeSeconds: oldest
        ? Math.round((Date.now() - oldest.occurredAt.getTime()) / 1000)
        : null,
      worstAttempts: worst?.attempts ?? 0,
      window: { days: w.days, from: w.from.toISOString(), to: w.to.toISOString() },
      note:
        'pending is the backlog now; failing is the part of that backlog that has ' +
        'already errored at least once. Both are counted from domain_events, which ' +
        'is the queue — there is no separate metric to disagree with it.',
    };
  }

  /**
   * Scheduler health, and the thing docs/35 §5 asks an operator to look for.
   *
   * A `claimed` row older than the threshold is reported as stale because the
   * scheduler will never pick it up again: it refuses to re-run an occurrence
   * that already has a row, which is how it avoids paying twice. Someone has to
   * force it, and they cannot force what nobody tells them about.
   */
  async jobs(days?: number) {
    const w = this.windowFrom(days);
    const staleBefore = new Date(Date.now() - STALE_CLAIM_MINUTES * 60 * 1000);
    const [byStatus, stale, recentFailures] = await Promise.all([
      this.prisma.owner.scheduledJobRun.groupBy({
        by: ['job', 'status'],
        where: { scheduledFor: { gte: w.from } },
        _count: { _all: true },
      }),
      this.prisma.owner.scheduledJobRun.findMany({
        where: { status: 'claimed', startedAt: { lt: staleBefore } },
        orderBy: { startedAt: 'asc' },
        take: 50,
        select: { id: true, job: true, tenantId: true, scheduledFor: true, startedAt: true },
      }),
      this.prisma.owner.scheduledJobRun.findMany({
        where: { status: 'failed', scheduledFor: { gte: w.from } },
        orderBy: { finishedAt: 'desc' },
        take: 20,
        select: {
          id: true,
          job: true,
          tenantId: true,
          scheduledFor: true,
          attempts: true,
          error: true,
        },
      }),
    ]);

    const jobs: Record<string, Record<string, number>> = {};
    for (const row of byStatus) {
      (jobs[row.job] ??= {})[row.status] = row._count._all;
    }

    return {
      window: { days: w.days, from: w.from.toISOString(), to: w.to.toISOString() },
      jobs,
      stale: {
        thresholdMinutes: STALE_CLAIM_MINUTES,
        count: stale.length,
        runs: stale.map((r) => ({
          ...r,
          claimedForSeconds: r.startedAt
            ? Math.round((Date.now() - r.startedAt.getTime()) / 1000)
            : null,
        })),
        note:
          `a run claimed for more than ${STALE_CLAIM_MINUTES} minutes is a job nobody ` +
          'finished. The scheduler will not retry it — that is how it avoids billing ' +
          'twice — so it runs only if an operator forces it (POST /platform/scheduler/run).',
      },
      recentFailures,
    };
  }

  /**
   * AI spend, estimated from tokens and the written-down rate card (docs/36 §5).
   *
   * Every row says which rate produced it, and a model with no rate reports a
   * null cost with the reason instead of a zero somebody would budget against.
   */
  async ai(days?: number, tenantId?: string) {
    const w = this.windowFrom(days);
    const rows = await this.prisma.owner.aiUsage.groupBy({
      by: ['tenantId', 'provider', 'model'],
      where: {
        usageDate: { gte: new Date(w.from.toISOString().slice(0, 10)) },
        ...(tenantId ? { tenantId } : {}),
      },
      _sum: { requests: true, inputTokens: true, outputTokens: true },
    });

    const usage = rows.map((r) => {
      const inputTokens = r._sum.inputTokens ?? 0;
      const outputTokens = r._sum.outputTokens ?? 0;
      const cost = estimateAiCost(r.provider, r.model, inputTokens, outputTokens);
      return {
        tenantId: r.tenantId,
        provider: r.provider,
        model: r.model,
        requests: r._sum.requests ?? 0,
        inputTokens,
        outputTokens,
        ...cost,
      };
    });

    const priced = usage.filter((u) => u.costMinor !== null);
    const unpriced = usage.filter((u) => u.costMinor === null);

    return {
      window: { days: w.days, from: w.from.toISOString(), to: w.to.toISOString() },
      currency: AI_RATE_CURRENCY,
      totalCostMinor: priced.reduce((sum, u) => sum + (u.costMinor ?? 0), 0),
      // Distinct: an unpriced model appears once per tenant that used it, and a
      // list repeating the same name forty times reads as forty problems.
      unpricedModels: [...new Set(unpriced.map((u) => `${u.provider}/${u.model}`))],
      usage,
      note:
        'an estimate of what the platform pays a provider, from tokens times a rate ' +
        'card that is a reviewed constant (docs/36 §5). It is not billing, nothing ' +
        'charges a tenant from it, and a model with no rate costs null rather than 0.',
    };
  }

  /**
   * What each tenant is using. The same computation serves one tenant asking
   * about itself, so the platform view and the tenant view cannot drift.
   */
  async tenants(days?: number, tenantId?: string) {
    const w = this.windowFrom(days);
    const where = tenantId ? { id: tenantId } : {};
    const tenants = await this.prisma.owner.tenant.findMany({
      where,
      select: { id: true, name: true, slug: true, status: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: tenantId ? 1 : 200,
    });
    const ids = tenants.map((t) => t.id);
    if (ids.length === 0) {
      return {
        window: { days: w.days, from: w.from.toISOString(), to: w.to.toISOString() },
        tenants: [],
      };
    }

    const [members, orders, events, ai] = await Promise.all([
      this.prisma.owner.member.groupBy({
        by: ['tenantId'],
        where: { tenantId: { in: ids } },
        _count: { _all: true },
      }),
      // Grouped by CURRENCY as well, because one number summing baht and
      // dollars is not a number. A tenant has one currency today, but the
      // shape must not be the thing that breaks when a second one appears.
      this.prisma.owner.order.groupBy({
        by: ['tenantId', 'currency'],
        where: { tenantId: { in: ids }, placedAt: { gte: w.from } },
        _count: { _all: true },
        _sum: { totalMinor: true },
      }),
      this.prisma.owner.domainEvent.groupBy({
        by: ['tenantId'],
        where: { tenantId: { in: ids }, occurredAt: { gte: w.from } },
        _count: { _all: true },
      }),
      this.prisma.owner.aiUsage.groupBy({
        by: ['tenantId'],
        where: {
          tenantId: { in: ids },
          usageDate: { gte: new Date(w.from.toISOString().slice(0, 10)) },
        },
        _sum: { requests: true, inputTokens: true, outputTokens: true },
      }),
    ]);

    const at = <T extends { tenantId: string | null }>(rows: T[], id: string) =>
      rows.find((r) => r.tenantId === id);

    return {
      window: { days: w.days, from: w.from.toISOString(), to: w.to.toISOString() },
      tenants: tenants.map((t) => {
        const mine = orders.filter((o) => o.tenantId === t.id);
        const a = at(ai, t.id);
        return {
          ...t,
          members: at(members, t.id)?._count._all ?? 0,
          ordersInWindow: mine.reduce((n, o) => n + (o._count?._all ?? 0), 0),
          orderValueInWindow: mine.map((o) => ({
            currency: o.currency,
            totalMinor: o._sum?.totalMinor ?? 0,
          })),
          eventsInWindow: at(events, t.id)?._count._all ?? 0,
          aiRequestsInWindow: a?._sum.requests ?? 0,
          aiTokensInWindow: (a?._sum.inputTokens ?? 0) + (a?._sum.outputTokens ?? 0),
        };
      }),
      note:
        'counts come from the tables that own the data — members, orders, ' +
        'domain_events, ai_usage — so a number here cannot disagree with the thing ' +
        'it measures. Order value is reported per currency and never summed across ' +
        'them: there is no exchange rate here, and inventing one would be a guess ' +
        'presented as a total.',
    };
  }
}
