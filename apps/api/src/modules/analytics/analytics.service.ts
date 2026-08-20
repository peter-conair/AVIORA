import { ForbiddenException, Injectable } from '@nestjs/common';
import { ERROR_CODES, PERMISSIONS } from '@aviora/shared';
import { TenantDb } from '../../common/db/tenant-db.service';
import { PrismaService } from '../../common/db/prisma.service';
import { tenantCurrency } from '../../common/money/currency';
import { tenantTimezone } from '../../common/time/tenant-zone';
import { HealthService } from '../health/health.service';
import { requirementKey } from '../growth/metrics';
import { TeamScopeService, type TeamActor } from '../team/team-scope.service';
import { withoutHealth, type HealthFreeReader } from './analytics-reader';
import {
  DEFINITIONS,
  SELF_ACTIVITY_SIGNALS,
  SHARED_ACTIVITY_SIGNALS,
  computeMeasures,
  type Measures,
  type ScopedMember,
} from './measures';
import { resolveWindow, windowEcho, type AnalyticsWindow } from './window';

export interface NamedMember {
  memberId: string;
  displayName: string;
}

export interface Milestone extends NamedMember {
  currentRank: RankView | null;
  nextRank: RankView | null;
  /**
   * The largest single shortfall as a share of its threshold (0–1). Ranks mix
   * money, counts and legs, so "smallest remaining requirement" only orders if
   * the remainders are made comparable first; the raw remainders are below.
   */
  largestGapShare: number | null;
  missing: Array<{
    metric: string;
    window: string;
    threshold: number;
    current: number;
    remaining: number;
  }>;
  /** Money thresholds are minor units; the code says which money. */
  currency: string;
  evaluatedAt: Date | null;
}

interface RankView {
  code: string;
  name: string;
  level: number;
}

export interface TeamAnalytics {
  team: { id: string; code: string; name: string };
  leaders: NamedMember[];
  memberCount: number;
  measures: Measures;
  inactiveMembers: NamedMember[];
  milestones: Milestone[];
}

export interface TeamScopeAnalytics {
  scope: 'team';
  window: ReturnType<typeof windowEcho>;
  definitions: ReturnType<typeof definitionsFor>;
  measures: Measures;
  teams: TeamAnalytics[];
}

/**
 * Analytics OS (docs/28). ONE set of measures at four scopes — the scope is
 * which members are handed to `computeMeasures`, never a second definition of
 * a number. Nothing is stored: a metric with its own table is a metric that
 * can disagree with the thing it measures (docs/28 §1).
 *
 * The team, tenant and platform paths compute over a `HealthFreeReader`, so
 * they cannot read habits, habit logs, metrics or health profiles at all
 * (docs/28 §2). Only `me()` touches health, and only through HealthService,
 * which asks the member's own consent grants first.
 */
@Injectable()
export class AnalyticsService {
  constructor(
    private readonly db: TenantDb,
    private readonly prisma: PrismaService,
    private readonly teamScope: TeamScopeService,
    private readonly health: HealthService,
  ) {}

  /** The member's own dashboard — health included, because it is theirs. */
  async me(actor: TeamActor, windowKey: AnalyticsWindow, locale = 'en') {
    const memberId = requireMember(actor);
    const window = resolveWindow(windowKey, await this.timezone());

    // Read before the measures transaction rather than inside it: a nested
    // tenant transaction would take a second connection while holding the first.
    const [health, habitDays, previousHabitDays] = await Promise.all([
      this.health.summary(memberId, memberId, locale),
      this.health.habitLogDays(memberId, memberId, window.from, window.to),
      this.health.habitLogDays(memberId, memberId, window.previousFrom, window.previousTo),
    ]);

    const result = await this.healthFree(async (reader) => {
      const measures = await computeMeasures({
        reader,
        tenantId: this.db.tenantId,
        memberIds: [memberId],
        window,
        externalActivity: {
          current: habitDays > 0 ? new Set([memberId]) : new Set(),
          previous: previousHabitDays > 0 ? new Set([memberId]) : new Set(),
        },
      });
      const milestones = await this.milestones(reader, measures.members);
      return { measures, milestones };
    });

    return {
      scope: 'member' as const,
      window: windowEcho(window),
      definitions: definitionsFor(SELF_ACTIVITY_SIGNALS),
      measures: result.measures.measures,
      milestone: result.milestones[0] ?? null,
      health,
    };
  }

  /** The leader dashboard — the teams they actually lead, and no health. */
  async team(actor: TeamActor, windowKey: AnalyticsWindow): Promise<TeamScopeAnalytics> {
    const window = resolveWindow(windowKey, await this.timezone());
    return this.healthFree(async (reader) => {
      const allowed = await this.teamScope.accessibleTeamIds(
        reader,
        actor,
        PERMISSIONS.TEAM_ANALYTICS_VIEW,
      );
      const teams = await reader.team.findMany({
        where: {
          tenantId: this.db.tenantId,
          status: 'active',
          ...(allowed === 'ALL' ? {} : { id: { in: [...allowed] } }),
        },
        orderBy: { name: 'asc' },
        select: { id: true, code: true, name: true },
      });

      const perTeam: TeamAnalytics[] = [];
      const everyMemberId = new Set<string>();
      for (const team of teams) {
        const [memberships, leaderships] = await Promise.all([
          reader.teamMembership.findMany({
            where: { tenantId: this.db.tenantId, teamId: team.id, status: 'active' },
            select: { memberId: true },
          }),
          reader.teamLeadership.findMany({
            where: { tenantId: this.db.tenantId, teamId: team.id, status: 'active' },
            select: { memberId: true },
          }),
        ]);
        const memberIds = [...new Set(memberships.map((m) => m.memberId))];
        for (const id of memberIds) everyMemberId.add(id);

        const result = await computeMeasures({
          reader,
          tenantId: this.db.tenantId,
          memberIds,
          window,
        });
        const byId = new Map(result.members.map((m) => [m.id, m]));
        perTeam.push({
          team,
          leaders: await this.namedMembers(
            reader,
            leaderships.map((l) => l.memberId),
          ),
          memberCount: memberIds.length,
          measures: result.measures,
          inactiveMembers: result.members
            .filter((m) => !result.activeMemberIds.has(m.id))
            .map(named),
          milestones: await this.milestones(
            reader,
            [...memberIds].flatMap((id) => {
              const member = byId.get(id);
              return member ? [member] : [];
            }),
          ),
        });
      }

      // The overall figures are computed over the union, not summed from the
      // teams: a member in two teams in scope would otherwise be counted twice.
      const overall = await computeMeasures({
        reader,
        tenantId: this.db.tenantId,
        memberIds: [...everyMemberId],
        window,
      });

      return {
        scope: 'team' as const,
        window: windowEcho(window),
        definitions: definitionsFor(SHARED_ACTIVITY_SIGNALS),
        measures: overall.measures,
        teams: perTeam,
      };
    });
  }

  /** The whole tenant. No health, for the same reason as the leader scope. */
  async tenant(windowKey: AnalyticsWindow) {
    const window = resolveWindow(windowKey, await this.timezone());
    const result = await this.healthFree((reader) =>
      computeMeasures({ reader, tenantId: this.db.tenantId, memberIds: null, window }),
    );
    return {
      scope: 'tenant' as const,
      window: windowEcho(window),
      definitions: definitionsFor(SHARED_ACTIVITY_SIGNALS),
      measures: result.measures,
    };
  }

  /**
   * Across tenants, through the owner connection — the one reader RLS does not
   * bind, so every query here names its tenant explicitly. It is still typed
   * `HealthFreeReader`: crossing tenants is exactly where health data must not
   * be reachable.
   */
  async platform(windowKey: AnalyticsWindow) {
    // UTC, and the echo says so. Tenant zones differ, so there is no single
    // zone in which a cross-tenant "this month" is true; naming one tenant's
    // month as the platform's would be a quiet lie about the other rows
    // (docs/29 §2).
    const window = resolveWindow(windowKey, 'UTC');
    const reader: HealthFreeReader = this.prisma.owner;
    const tenants = await this.prisma.owner.tenant.findMany({
      where: { status: 'active' },
      orderBy: { createdAt: 'asc' },
      select: { id: true, code: true, name: true },
    });

    const rows = [];
    for (const tenant of tenants) {
      const [result, ai] = await Promise.all([
        computeMeasures({ reader, tenantId: tenant.id, memberIds: null, window }),
        reader.aiUsage.aggregate({
          where: { tenantId: tenant.id, usageDate: { gte: window.from, lte: window.to } },
          _sum: { requests: true, inputTokens: true, outputTokens: true },
        }),
      ]);
      rows.push({
        tenant,
        measures: result.measures,
        ai: {
          requests: ai._sum.requests ?? 0,
          inputTokens: ai._sum.inputTokens ?? 0,
          outputTokens: ai._sum.outputTokens ?? 0,
        },
      });
    }

    return {
      scope: 'platform' as const,
      window: windowEcho(window),
      definitions: definitionsFor(SHARED_ACTIVITY_SIGNALS),
      // `perTenant`, not `tenants`: the tenant COUNT lives in totals, and one
      // name cannot honestly be both a number and a breakdown.
      perTenant: rows,
      totals: {
        tenants: rows.length,
        totalMembers: sum(rows.map((r) => r.measures.totalMembers)),
        activeMembers: sum(rows.map((r) => r.measures.activeMembers)),
        newMembers: sum(rows.map((r) => r.measures.newMembers)),
        aiRequests: sum(rows.map((r) => r.ai.requests)),
        aiInputTokens: sum(rows.map((r) => r.ai.inputTokens)),
        aiOutputTokens: sum(rows.map((r) => r.ai.outputTokens)),
      },
      notMeasured: NOT_MEASURED,
    };
  }

  /**
   * A tenant transaction whose handle arrives already narrowed. The team,
   * tenant and platform paths use only this, so no full `Tx` — and therefore
   * no health delegate — is ever in scope on them (docs/28 §2).
   */
  private healthFree<T>(fn: (reader: HealthFreeReader) => Promise<T>): Promise<T> {
    return this.db.tx((tx) => fn(withoutHealth(tx)));
  }

  /**
   * The tenant's zone, resolved before the measures transaction opens — window
   * boundaries are an input to the query, not something computed inside it.
   */
  private timezone(): Promise<string> {
    return this.db.tx((tx) => tenantTimezone(tx, this.db.tenantId));
  }

  /**
   * Distance to the next rank, read from the snapshot the rank engine already
   * stored (docs/25 §3). Recomputing the metrics here would be a second
   * calculator free to disagree with the one a commission run pays on.
   */
  private async milestones(
    reader: HealthFreeReader,
    members: ScopedMember[],
  ): Promise<Milestone[]> {
    if (!members.length) return [];
    const memberIds = members.map((m) => m.id);
    const [progress, definitions, currency] = await Promise.all([
      reader.rankProgress.findMany({
        where: { memberId: { in: memberIds } },
        select: { memberId: true, rankId: true, metrics: true, evaluatedAt: true },
      }),
      reader.rankDefinition.findMany({
        where: { status: 'active' },
        orderBy: { level: 'asc' },
        select: {
          id: true,
          code: true,
          name: true,
          level: true,
          qualifications: {
            select: { metric: true, comparator: true, threshold: true, window: true, params: true },
          },
        },
      }),
      tenantCurrency(reader),
    ]);
    if (!definitions.length) return [];

    const byId = new Map(definitions.map((d) => [d.id, d]));
    const progressByMember = new Map(progress.map((p) => [p.memberId, p]));

    return members.map((member) => {
      const own = progressByMember.get(member.id);
      const current = own?.rankId ? (byId.get(own.rankId) ?? null) : null;
      const next =
        definitions.find((d) => d.level > (current?.level ?? Number.NEGATIVE_INFINITY)) ?? null;
      const values = isRecord(own?.metrics) ? own.metrics : {};

      const missing = (next?.qualifications ?? [])
        .map((q) => {
          const raw =
            values[
              requirementKey({
                metric: q.metric,
                window: q.window,
                params: isRecord(q.params) ? q.params : null,
              })
            ];
          const value = typeof raw === 'number' ? raw : 0;
          return {
            metric: q.metric,
            window: q.window,
            threshold: q.threshold,
            current: value,
            remaining: Math.max(0, q.threshold - value),
          };
        })
        .filter((q) => q.remaining > 0);

      const gaps = missing.map((q) => (q.threshold > 0 ? q.remaining / q.threshold : 1));
      return {
        memberId: member.id,
        displayName: member.displayName,
        currentRank: current ? view(current) : null,
        nextRank: next ? view(next) : null,
        largestGapShare: gaps.length ? Math.max(...gaps) : next ? 0 : null,
        missing,
        currency,
        evaluatedAt: own?.evaluatedAt ?? null,
      };
    });
  }

  private async namedMembers(
    reader: HealthFreeReader,
    memberIds: string[],
  ): Promise<NamedMember[]> {
    if (!memberIds.length) return [];
    const rows = await reader.member.findMany({
      where: { id: { in: memberIds } },
      select: { id: true, displayName: true },
    });
    return rows.map((r) => ({ memberId: r.id, displayName: r.displayName }));
  }
}

/**
 * docs/28 §6: nothing meters these yet, and a fabricated cost is worse than a
 * missing one. They are named as unmeasured — never reported as 0, which reads
 * as "we spent nothing".
 */
const NOT_MEASURED = {
  aiCost: {
    status: 'not_measured' as const,
    reason: 'Token counts are recorded per tenant, but no price table converts them to money yet.',
  },
  storage: {
    status: 'not_measured' as const,
    reason: 'No storage meter exists; the platform stores no files it accounts for.',
  },
  infrastructureCost: {
    status: 'not_measured' as const,
    reason: 'Infrastructure spend is not attributed per tenant and is not read from any bill.',
  },
} as const;

function definitionsFor(signals: readonly string[]) {
  const countsHealth = signals.includes('habit_log');
  return {
    ...DEFINITIONS,
    activitySignals: [...signals],
    // A member who uses only the health features every day is reported here as
    // INACTIVE. Being chased for inactivity while diligently using the product
    // is a real harm, so a reader is told plainly what "inactive" means rather
    // than being left to assume it means "doing nothing" (docs/28 §3).
    ...(countsHealth
      ? {}
      : {
          healthActivityExcluded:
            'Health activity is deliberately not counted. A member who only logs habits appears inactive here — "inactive" means no non-health activity, not an idle member.',
        }),
  };
}

function requireMember(actor: TeamActor): string {
  if (!actor.memberId) {
    throw new ForbiddenException({
      code: ERROR_CODES.FORBIDDEN,
      message: 'You are not a member of this tenant',
    });
  }
  return actor.memberId;
}

function named(member: ScopedMember): NamedMember {
  return { memberId: member.id, displayName: member.displayName };
}

function view(rank: { code: string; name: string; level: number }): RankView {
  return { code: rank.code, name: rank.name, level: rank.level };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
