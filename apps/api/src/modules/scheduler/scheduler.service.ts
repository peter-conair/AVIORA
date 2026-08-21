import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { CLS_ID, ClsService } from 'nestjs-cls';
import { newId } from '@aviora/shared';
import { PrismaService } from '../../common/db/prisma.service';
import { TenantDb } from '../../common/db/tenant-db.service';
import { TenantDatabaseResolver } from '../../common/db/tenant-database.resolver';
import { CLS_TENANT_ID } from '../../common/tenant/tenant-context.middleware';
import { DEFAULT_TIMEZONE, isValidTimeZone } from '../../common/time/zone';
import { SubscriptionService } from '../commerce/subscription.service';
import { RankService } from '../growth/rank.service';
import { RunService } from '../compensation/run.service';
import { AlertsService } from '../observability/alerts.service';
import {
  CATCHUP_DAYS,
  MAX_SKIP_ROWS,
  currentDailySlot,
  currentMonthlySlot,
  currentSweepSlot,
  dailyAsOf,
  monthJustEnded,
  planDaily,
  planMonthly,
  planSweep,
  type OccurrencePlan,
} from './occurrences';

const POLL_MS = 60_000;

/** A delivery still pending this long after it was due means nothing is draining it. */
const STUCK_AFTER_MS = 15 * 60_000;

/** Rows the sweep names individually before it stops naming and starts counting. */
const SWEEP_TENANT_LIMIT = 20;

export const SCHEDULER_JOBS = [
  'subscription.renew',
  'rank.evaluate',
  'commission.draft',
  'webhook.sweep',
  'alert.sweep',
] as const;
export type SchedulerJob = (typeof SCHEDULER_JOBS)[number];

/** Jobs that run once per tenant; the rest carry `tenant_id = NULL` (docs/35 §2). */
export const TENANT_JOBS: readonly SchedulerJob[] = [
  'subscription.renew',
  'rank.evaluate',
  'commission.draft',
];

/**
 * Who the scheduler is, in a column that only holds uuids.
 *
 * The services below all take an actor because a person normally presses the
 * button. Here nobody did, and `domain_events.actor_user_id` is a uuid with no
 * foreign key, so the nil uuid says "the timer" in the one alphabet the column
 * accepts. The audit trail is not told this at all — it reads the actor from
 * CLS, which the scheduler deliberately leaves empty, so an audit row written
 * under a job has no user rather than a fictional one.
 */
export const SCHEDULER_ACTOR_USER_ID = '00000000-0000-0000-0000-000000000000';

interface TenantRow {
  id: string;
  timeZone: string;
}

interface PlannedOccurrence {
  job: SchedulerJob;
  tenantId: string | null;
  timeZone: string;
  scheduledFor: Date;
  /** `due` runs; `skip` is only recorded, with the reason (docs/35 §4). */
  kind: 'due' | 'skip';
  /** Set on the oldest skip of a backlog that was too long to record in full. */
  elided?: { count: number; truncated: boolean };
}

interface JobResult {
  /**
   * `skipped` means the work this occurrence owed was NOT done — it fell
   * outside the catch-up window, or the tenant is read-only. A tenant that has
   * nothing configured for a job is owed nothing, so it `succeeded` and its
   * outcome says why it was a no-op. Keeping the two apart is what lets an
   * operator query for `skipped` and read a list of real gaps.
   */
  status: 'succeeded' | 'skipped';
  outcome: unknown;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * The scheduler (docs/35).
 *
 * Three properties decide every line here, and they are the three failure
 * modes docs/35 §1 names:
 *
 * 1. **It cannot run twice.** The `scheduled_job_runs` row for an occurrence is
 *    written BEFORE any work starts, and `UNIQUE (job, tenant_id,
 *    scheduled_for)` is the arbiter — the same defence subscription renewal,
 *    the commission run and webhook delivery already rest on.
 * 2. **It cannot run silently.** Every occurrence leaves a row saying what it
 *    did, including the ones it declined to run and why.
 * 3. **One tenant cannot stop the rest.** Each occurrence is claimed, run and
 *    settled on its own; a tenant whose data throws gets `failed` with the
 *    error, and the loop moves on.
 *
 * Nothing here computes a renewal date, a rank or a payout. Each job calls the
 * service an administrator's button already calls; a second implementation
 * would be a second answer (docs/35 §3).
 */
@Injectable()
export class SchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SchedulerService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly db: TenantDb,
    private readonly cls: ClsService,
    private readonly databases: TenantDatabaseResolver,
    private readonly subscriptions: SubscriptionService,
    private readonly ranks: RankService,
    private readonly runs: RunService,
    private readonly alerts: AlertsService,
  ) {}

  onModuleInit() {
    if (process.env.AVIORA_SCHEDULER_DISABLED === 'true') return;
    this.timer = setInterval(() => void this.tick(), POLL_MS);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * One pass over everything that should have happened by now.
   *
   * Catch-up is not a separate code path. Each job resumes from the newest
   * occurrence it has on record, and `occurrences.ts` decides which of the
   * slots since then still run and which are only marked — so a process that
   * has been down for an hour and one that has been down for a month take the
   * same path and produce different rows.
   */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = new Date();
      const [tenants, floors] = await Promise.all([this.activeTenants(), this.floors()]);

      for (const item of this.plan(now, tenants, floors)) {
        if (item.kind === 'skip') await this.mark(item);
        else await this.runOccurrence(item, now);
      }
    } catch (e) {
      this.logger.error('scheduler tick failed', e as Error);
    } finally {
      this.running = false;
    }
  }

  /**
   * Runs one occurrence on demand, past the catch-up window if the operator
   * says so (docs/35 §5). Force re-runs an occurrence that already has a row
   * rather than adding a second one — "one run per job, per tenant, per
   * occurrence" is the contract, and the services underneath are idempotent,
   * so a deliberate re-run costs an attempt and not a second payment.
   */
  async runNow(job: SchedulerJob, tenantId: string | null, scheduledFor?: Date) {
    const timeZone = tenantId ? await this.timeZoneOf(tenantId) : 'UTC';
    const now = new Date();
    const occurrence = scheduledFor ?? this.currentOccurrence(job, timeZone, now);
    const item: PlannedOccurrence = {
      job,
      tenantId,
      timeZone,
      scheduledFor: occurrence,
      kind: 'due',
    };
    const runId = await this.runOccurrence(item, now, { force: true });
    return runId ? this.prisma.owner.scheduledJobRun.findUnique({ where: { id: runId } }) : null;
  }

  // ── planning ──────────────────────────────────────────────────────────────

  private plan(now: Date, tenants: TenantRow[], floors: Map<string, Date>): PlannedOccurrence[] {
    const planned: PlannedOccurrence[] = [];
    const add = (
      job: SchedulerJob,
      tenantId: string | null,
      timeZone: string,
      cadence: (floor: Date | null) => OccurrencePlan,
    ) => {
      const plan = cadence(floors.get(`${job}|${tenantId ?? ''}`) ?? null);
      const first = planned.length;
      for (const scheduledFor of plan.skip) {
        planned.push({ job, tenantId, timeZone, scheduledFor, kind: 'skip' });
      }
      // The oldest recorded skip carries the count of the ones beyond the cap:
      // it is where a reader walking back in time reaches the edge of the record.
      if (plan.elided > 0 && planned[first]) {
        planned[first].elided = { count: plan.elided, truncated: plan.truncated };
      }
      for (const scheduledFor of plan.due) {
        planned.push({ job, tenantId, timeZone, scheduledFor, kind: 'due' });
      }
    };

    for (const tenant of tenants) {
      const daily = (floor: Date | null) => planDaily(tenant.timeZone, now, floor);
      add('subscription.renew', tenant.id, tenant.timeZone, daily);
      add('rank.evaluate', tenant.id, tenant.timeZone, daily);
      add('commission.draft', tenant.id, tenant.timeZone, (floor) =>
        planMonthly(tenant.timeZone, now, floor),
      );
    }
    add('webhook.sweep', null, 'UTC', (floor) => planSweep(now, floor));
    // Alerting rides the scheduler rather than a timer of its own (docs/42 §3),
    // so it inherits one run per occurrence and leaves a row saying it
    // happened — and if the sweep itself dies mid-run, the stale `claimed` row
    // is visible in exactly the place an operator already looks.
    add('alert.sweep', null, 'UTC', (floor) => planSweep(now, floor));
    return planned;
  }

  /**
   * The slot in force right now — what an operator means by "run it" when they
   * name no occurrence. The catch-up window does not apply: naming an
   * occurrence it declined is the whole point of the override (docs/35 §5).
   */
  private currentOccurrence(job: SchedulerJob, timeZone: string, now: Date): Date {
    if (job === 'webhook.sweep' || job === 'alert.sweep') return currentSweepSlot(now);
    if (job === 'commission.draft') return currentMonthlySlot(timeZone, now);
    return currentDailySlot(timeZone, now);
  }

  /**
   * The newest occurrence each job has on record, per tenant — where catch-up
   * starts (docs/35 §4). One grouped query for the whole tick, and the reason
   * no second query is needed to ask what already ran: every slot after this
   * one is by definition unrecorded.
   */
  private async floors(): Promise<Map<string, Date>> {
    const rows = await this.prisma.owner.scheduledJobRun.groupBy({
      by: ['job', 'tenantId'],
      _max: { scheduledFor: true },
    });
    return new Map(
      rows
        .filter((r) => r._max.scheduledFor !== null)
        .map((r) => [`${r.job}|${r.tenantId ?? ''}`, r._max.scheduledFor!]),
    );
  }

  private async activeTenants(): Promise<TenantRow[]> {
    const [tenants, localisations] = await Promise.all([
      this.prisma.owner.tenant.findMany({
        where: { status: 'active' },
        select: { id: true, timezone: true },
      }),
      this.prisma.owner.tenantLocalisation.findMany({ select: { tenantId: true, timezone: true } }),
    ]);
    // Localisation is the tenant's own answer and wins; the tenant row is the
    // fallback the localisation service already falls back to (docs/29 §2).
    const overrides = new Map(localisations.map((l) => [l.tenantId, l.timezone]));
    return tenants.map((t) => ({
      id: t.id,
      timeZone: this.safeZone(overrides.get(t.id) ?? t.timezone, t.id),
    }));
  }

  private async timeZoneOf(tenantId: string): Promise<string> {
    const [localisation, tenant] = await Promise.all([
      this.prisma.owner.tenantLocalisation.findUnique({
        where: { tenantId },
        select: { timezone: true },
      }),
      this.prisma.owner.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } }),
    ]);
    return this.safeZone(localisation?.timezone ?? tenant?.timezone ?? DEFAULT_TIMEZONE, tenantId);
  }

  /**
   * A zone ICU cannot build would throw for every occurrence of every job for
   * this tenant, for ever. The platform default is wrong by at most a few
   * hours; a crash is wrong by the whole schedule.
   */
  private safeZone(timeZone: string, tenantId: string): string {
    if (isValidTimeZone(timeZone)) return timeZone;
    this.logger.warn(
      `tenant ${tenantId} has timezone '${timeZone}', which is not an IANA zone — ` +
        `scheduling it in ${DEFAULT_TIMEZONE} instead`,
    );
    return DEFAULT_TIMEZONE;
  }

  // ── claiming ──────────────────────────────────────────────────────────────

  /**
   * Claims one occurrence: the row IS the claim, and it is written before any
   * work happens (docs/35 §2).
   *
   * `UNIQUE (job, tenant_id, scheduled_for)` is the arbiter for the per-tenant
   * jobs. It cannot be for a PLATFORM occurrence — `tenant_id` is NULL there,
   * and Postgres counts NULLs as distinct, so the same slot would insert twice.
   * The advisory lock closes that: it serialises the case where no row exists
   * yet, and a caller that does not get it gives way rather than waiting, the
   * same bargain `SKIP LOCKED` makes. Under it the row probe is exact, and it
   * still takes `FOR UPDATE SKIP LOCKED` so a row another writer is holding is
   * never overwritten by a force.
   */
  private async claim(
    item: PlannedOccurrence,
    options: { force?: boolean; start: boolean },
  ): Promise<string | null> {
    const iso = item.scheduledFor.toISOString();
    try {
      return await this.prisma.owner.$transaction(async (tx) => {
        const [lock] = await tx.$queryRaw<Array<{ locked: boolean }>>`
          SELECT pg_try_advisory_xact_lock(
            hashtext(${item.job}::text || '@' || ${item.tenantId ?? '-'}::text || '@' || ${iso}::text)
          ) AS locked`;
        if (!lock?.locked) return null;

        const existing = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM scheduled_job_runs
           WHERE job = ${item.job}
             AND tenant_id IS NOT DISTINCT FROM ${item.tenantId}::uuid
             AND scheduled_for = ${item.scheduledFor}
           FOR UPDATE SKIP LOCKED`;
        const claimed = existing[0];
        if (claimed) {
          if (!options.force) return null;
          await tx.scheduledJobRun.update({
            where: { id: claimed.id },
            data: {
              status: 'claimed',
              attempts: { increment: 1 },
              startedAt: new Date(),
              finishedAt: null,
              error: null,
            },
          });
          return claimed.id;
        }

        const row = await tx.scheduledJobRun.create({
          data: {
            job: item.job,
            tenantId: item.tenantId,
            scheduledFor: item.scheduledFor,
            status: 'claimed',
            attempts: options.start ? 1 : 0,
            startedAt: options.start ? new Date() : null,
          },
        });
        return row.id;
      });
    } catch (e) {
      // Another instance inserted this occurrence between the probe and the
      // insert. Expected, and the whole point of the unique key.
      if ((e as { code?: string } | null)?.code === 'P2002') return null;
      throw e;
    }
  }

  private async settle(
    runId: string,
    status: 'succeeded' | 'failed' | 'skipped',
    outcome: unknown,
    error: string | null,
  ): Promise<void> {
    await this.prisma.owner.scheduledJobRun.update({
      where: { id: runId },
      data: {
        status,
        finishedAt: new Date(),
        outcome: (outcome ?? undefined) as object | undefined,
        error,
      },
    });
  }

  /** Records an occurrence the catch-up window will not run, and why (docs/35 §4). */
  private async mark(item: PlannedOccurrence): Promise<void> {
    const runId = await this.claim(item, { start: false });
    if (!runId) return;
    const reason =
      `missed by more than ${CATCHUP_DAYS} days — running it now would fire a backlog ` +
      'at once rather than recover; an operator can still run it by hand';
    await this.settle(
      runId,
      'skipped',
      {
        reason,
        catchUpDays: CATCHUP_DAYS,
        ...(item.elided
          ? {
              elided: item.elided.count,
              elidedNote:
                `${item.elided.count}${item.elided.truncated ? ' or more' : ''} older ` +
                `occurrences were not recorded at all: one tick writes at most ` +
                `${MAX_SKIP_ROWS} of these per job per tenant`,
            }
          : {}),
      },
      null,
    );
  }

  private async runOccurrence(
    item: PlannedOccurrence,
    now: Date,
    options: { force?: boolean } = {},
  ): Promise<string | null> {
    const runId = await this.claim(item, { force: options.force, start: true });
    if (!runId) return null;
    try {
      const result = await this.execute(item, now);
      await this.settle(runId, result.status, result.outcome, null);
    } catch (e) {
      // One tenant's failure belongs to that tenant. The loop above carries on,
      // and the row carries the error so the failure is findable (docs/35 §1).
      const error = message(e);
      this.logger.error(
        `job ${item.job} for ${item.tenantId ?? 'platform'} at ` +
          `${item.scheduledFor.toISOString()} failed: ${error}`,
      );
      await this.settle(runId, 'failed', null, error.slice(0, 1000));
    }
    return runId;
  }

  // ── the jobs ──────────────────────────────────────────────────────────────

  private async execute(item: PlannedOccurrence, now: Date): Promise<JobResult> {
    if (item.job === 'webhook.sweep') return this.sweep(now);
    if (item.job === 'alert.sweep') {
      return { status: 'succeeded' as const, outcome: await this.alerts.sweep() };
    }

    const tenantId = item.tenantId!;
    // The same refusal the API edge makes for a tenant mid-move (docs/31 §2).
    // A migration that accepts writes it is about to discard loses data whether
    // a person or a timer sent them.
    if (await this.databases.isMigrating(tenantId)) {
      return {
        status: 'skipped',
        outcome: { reason: 'the tenant is read-only while its data is being moved' },
      };
    }

    return this.withTenant(tenantId, async () => {
      if (item.job === 'subscription.renew') {
        return {
          status: 'succeeded' as const,
          outcome: await this.subscriptions.runDue(
            dailyAsOf(item.timeZone, item.scheduledFor, now),
            SCHEDULER_ACTOR_USER_ID,
          ),
        };
      }
      if (item.job === 'rank.evaluate') return this.evaluateRanks(item, now);
      return this.draftCommissions(item);
    });
  }

  private async evaluateRanks(item: PlannedOccurrence, now: Date): Promise<JobResult> {
    // A tenant that runs no rank programme is not evaluated at all. Evaluating
    // it would write a rank_progress row for every one of its members recording
    // that they qualify for none of the zero ranks it has.
    const ladder = await this.db.tx((tx) =>
      tx.rankDefinition.count({ where: { status: 'active' } }),
    );
    if (ladder === 0) {
      return { status: 'succeeded', outcome: { evaluated: 0, reason: 'no active ranks' } };
    }
    const outcome = await this.ranks.evaluate(
      undefined,
      dailyAsOf(item.timeZone, item.scheduledFor, now),
      SCHEDULER_ACTOR_USER_ID,
    );
    // The per-member detail is the endpoint's answer, not a log line.
    return {
      status: 'succeeded',
      outcome: { asOf: outcome.asOf, evaluated: outcome.evaluated, changed: outcome.changed },
    };
  }

  /**
   * A DRAFT per active plan for the month that just ended, and nothing else.
   * Approval is not reachable from here and must not become reachable: money
   * leaves on a person's decision, not a timer's (docs/35 §3).
   */
  private async draftCommissions(item: PlannedOccurrence): Promise<JobResult> {
    const plans = await this.db.tx((tx) =>
      tx.compensationPlan.findMany({
        where: { status: 'active' },
        select: { id: true, code: true },
      }),
    );
    if (plans.length === 0) {
      return { status: 'succeeded', outcome: { runs: [], reason: 'no active compensation plan' } };
    }

    const period = monthJustEnded(item.timeZone, item.scheduledFor);
    const drafted: Array<Record<string, unknown>> = [];
    for (const plan of plans) {
      const { run, created } = await this.runs.create(
        { planId: plan.id, periodStart: period.periodStart, periodEnd: period.periodEnd },
        SCHEDULER_ACTOR_USER_ID,
      );
      drafted.push({
        planId: plan.id,
        planCode: plan.code,
        runId: run.id,
        status: run.status,
        entryCount: run.entryCount,
        totalMinor: run.totalMinor,
        created,
      });
    }
    return {
      status: 'succeeded',
      outcome: {
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        runs: drafted,
      },
    };
  }

  /**
   * What is stuck, across every tenant. Read-only by design (docs/35 §3): the
   * dispatcher owns retrying, and a sweep that also retried would be a second
   * opinion about when a customer's server is ready to be called again.
   */
  private async sweep(now: Date): Promise<JobResult> {
    const stuckSince = new Date(now.getTime() - STUCK_AFTER_MS);
    const [overdue, failed] = await Promise.all([
      this.prisma.owner.webhookDelivery.groupBy({
        by: ['tenantId'],
        where: { status: 'pending', nextAttemptAt: { lt: stuckSince } },
        _count: { _all: true },
        _min: { nextAttemptAt: true },
      }),
      this.prisma.owner.webhookDelivery.groupBy({
        by: ['tenantId'],
        where: { status: 'failed' },
        _count: { _all: true },
      }),
    ]);

    const overdueTotal = overdue.reduce((sum, row) => sum + row._count._all, 0);
    const failedTotal = failed.reduce((sum, row) => sum + row._count._all, 0);
    const oldest = overdue
      .map((row) => row._min.nextAttemptAt)
      .filter((d): d is Date => d !== null)
      .sort((a, b) => a.getTime() - b.getTime())[0];

    if (overdueTotal > 0) {
      this.logger.warn(
        `${overdueTotal} webhook deliveries have been due for more than ` +
          `${STUCK_AFTER_MS / 60_000} minutes across ${overdue.length} tenants`,
      );
    }

    return {
      status: 'succeeded',
      outcome: {
        overdue: overdueTotal,
        failed: failedTotal,
        oldestOverdueAt: oldest ?? null,
        stuckAfterMinutes: STUCK_AFTER_MS / 60_000,
        byTenant: overdue
          .sort((a, b) => b._count._all - a._count._all)
          .slice(0, SWEEP_TENANT_LIMIT)
          .map((row) => ({ tenantId: row.tenantId, overdue: row._count._all })),
      },
    };
  }

  /**
   * The tenant context the domain services read from. They resolve their tenant
   * through CLS exactly as they do behind a request, so a job reaches the same
   * RLS-scoped client with the same tenant set — no second data path, and no
   * chance of a job seeing across tenants. The actor is deliberately not set:
   * no person did this.
   */
  private withTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return this.cls.run(() => {
      this.cls.set(CLS_ID, newId());
      this.cls.set(CLS_TENANT_ID, tenantId);
      return fn();
    });
  }
}
