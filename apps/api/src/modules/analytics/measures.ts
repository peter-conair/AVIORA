import { tenantCurrency } from '../../common/money/currency';
import type { HealthFreeReader } from './analytics-reader';
import type { ResolvedWindow } from './window';

/**
 * The §3 definitions, stated once and echoed by every response. Measures
 * nobody can define the same way twice are worse than no measures, and a
 * number without its window is a number that will be misquoted (docs/28 §3).
 */
export const DEFINITIONS = {
  activeMember:
    'A member with at least one recorded action in the window — the existence of the row, never its content.',
  newMember: 'joinedAt inside the window.',
  retention: 'Of the members who joined in cohort month M, the share still active in the window.',
  churn:
    'Members whose membership ended or lapsed in the window, over the members holding an active membership at the window start.',
  growth: 'Change in active members between two equal, adjacent windows.',
  engagement: 'Posts, comments and reactions per active member.',
  assignedCourse:
    'Every published course in the tenant. There is no per-member assignment table, so "assigned" is the catalogue a member may take.',
} as const;

/**
 * The signals that count as a recorded action (docs/28 §3).
 *
 * `habit_log` is in the §3 list and is health data, so it is NOT here: the
 * leader, tenant and platform scopes never see it. The member's own dashboard
 * adds it through `MeasureScope.externalActivity`, having obtained it from the
 * health module's consent gate.
 */
export const SHARED_ACTIVITY_SIGNALS = ['goal', 'learning', 'order', 'post'] as const;
export const SELF_ACTIVITY_SIGNALS = [...SHARED_ACTIVITY_SIGNALS, 'habit_log'] as const;

/** How many cohort months the retention table reports. */
const COHORT_MONTHS = 6;

export interface MeasureScope {
  reader: HealthFreeReader;
  tenantId: string;
  /** null = every member of the tenant. */
  memberIds: string[] | null;
  window: ResolvedWindow;
  /**
   * Members the CALLER already established were active, from a signal this
   * reader cannot see. Only the member's own dashboard passes anything: their
   * own habit logs, read through the health module (docs/28 §2).
   */
  externalActivity?: { current: ReadonlySet<string>; previous: ReadonlySet<string> };
}

export interface ScopedMember {
  id: string;
  displayName: string;
  joinedAt: Date;
  status: string;
}

export interface CohortMeasure {
  month: string;
  joined: number;
  stillActive: number;
  rate: number | null;
}

export interface CourseMeasure {
  courseId: string;
  code: string;
  title: string;
  completedInWindow: number;
  completedAllTime: number;
  inProgress: number;
}

export interface Measures {
  members: {
    total: number;
    active: number;
    inactive: number;
    activeShare: number | null;
    new: number;
  };
  growth: {
    active: number;
    previousActive: number;
    change: number;
    /** null when the previous window had no active members — not 0, and not Infinity. */
    changeRate: number | null;
  };
  churn: { ended: number; activeAtStart: number; rate: number | null };
  retention: { cohorts: CohortMeasure[] };
  engagement: {
    posts: number;
    comments: number;
    reactions: number;
    total: number;
    perActiveMember: number | null;
    previousPerActiveMember: number | null;
    change: number | null;
  };
  learning: { completedInWindow: number; courses: CourseMeasure[] };
  /** Integer minor units, with the code they are quoted in. */
  commerce: { currency: string; paidOrders: number; volumeMinor: number };
}

export interface MeasureResult {
  measures: Measures;
  /** The members the measures ran over — a leader dashboard names people. */
  members: ScopedMember[];
  activeMemberIds: ReadonlySet<string>;
}

/**
 * The §3 measures, computed once. Every scope calls this; the scope is which
 * members it is handed, never a different set of definitions.
 */
export async function computeMeasures(scope: MeasureScope): Promise<MeasureResult> {
  const { window } = scope;
  const [members, activeNow, activePrev, engagement, prevEngagement, learning, commerce, churn] =
    await Promise.all([
      scopedMembers(scope),
      activeMemberIds(scope, window.from, window.to, scope.externalActivity?.current),
      activeMemberIds(
        scope,
        window.previousFrom,
        window.previousTo,
        scope.externalActivity?.previous,
      ),
      engagementCounts(scope, window.from, window.to),
      engagementCounts(scope, window.previousFrom, window.previousTo),
      learningByCourse(scope),
      commerceTotals(scope),
      churnCounts(scope),
    ]);

  const inScope = new Set(members.map((m) => m.id));
  // An action may outlive the membership row it came from; only members still
  // in scope are counted, so `active` can never exceed `total`.
  const active = new Set([...activeNow].filter((id) => inScope.has(id)));
  const previousActive = new Set([...activePrev].filter((id) => inScope.has(id)));

  const perActive = ratio(engagement.total, active.size);
  const prevPerActive = ratio(prevEngagement.total, previousActive.size);

  return {
    measures: {
      members: {
        total: members.length,
        active: active.size,
        inactive: members.length - active.size,
        activeShare: ratio(active.size, members.length),
        new: members.filter((m) => m.joinedAt >= window.from && m.joinedAt <= window.to).length,
      },
      growth: {
        active: active.size,
        previousActive: previousActive.size,
        change: active.size - previousActive.size,
        changeRate: ratio(active.size - previousActive.size, previousActive.size),
      },
      churn: {
        ended: churn.ended,
        activeAtStart: churn.activeAtStart,
        rate: ratio(churn.ended, churn.activeAtStart),
      },
      retention: { cohorts: cohorts(members, active, window) },
      engagement: {
        ...engagement,
        perActiveMember: perActive,
        previousPerActiveMember: prevPerActive,
        change: perActive === null || prevPerActive === null ? null : perActive - prevPerActive,
      },
      learning,
      commerce,
    },
    members,
    activeMemberIds: active,
  };
}

/** `undefined` is Prisma's "no filter", which is exactly tenant-wide scope. */
function memberFilter(scope: MeasureScope) {
  return scope.memberIds ? { in: scope.memberIds } : undefined;
}

async function scopedMembers(scope: MeasureScope): Promise<ScopedMember[]> {
  return scope.reader.member.findMany({
    where: {
      tenantId: scope.tenantId,
      ...(scope.memberIds ? { id: { in: scope.memberIds } } : {}),
    },
    select: { id: true, displayName: true, joinedAt: true, status: true },
  });
}

/**
 * Members with at least one recorded action between `from` and `to`. Each
 * query selects only the member id: the definition is the EXISTENCE of the
 * action, and reading its content would be reading more than the measure needs.
 */
async function activeMemberIds(
  scope: MeasureScope,
  from: Date,
  to: Date,
  external?: ReadonlySet<string>,
): Promise<ReadonlySet<string>> {
  const { reader, tenantId } = scope;
  const memberId = memberFilter(scope);
  const range = { gte: from, lte: to };

  const [goals, learning, orders, posts] = await Promise.all([
    reader.goal.findMany({
      where: {
        tenantId,
        memberId,
        OR: [{ createdAt: range }, { completedAt: range }],
      },
      select: { memberId: true },
      distinct: ['memberId'],
    }),
    reader.learningProgress.findMany({
      where: { tenantId, memberId, OR: [{ startedAt: range }, { completedAt: range }] },
      select: { memberId: true },
      distinct: ['memberId'],
    }),
    reader.order.findMany({
      where: { tenantId, memberId, placedAt: range },
      select: { memberId: true },
      distinct: ['memberId'],
    }),
    reader.post.findMany({
      where: {
        tenantId,
        ...(memberId ? { authorMemberId: memberId } : {}),
        createdAt: range,
      },
      select: { authorMemberId: true },
      distinct: ['authorMemberId'],
    }),
  ]);

  const ids = new Set<string>(external ?? []);
  for (const row of goals) ids.add(row.memberId);
  for (const row of learning) ids.add(row.memberId);
  for (const row of orders) ids.add(row.memberId);
  for (const row of posts) ids.add(row.authorMemberId);
  return ids;
}

async function engagementCounts(scope: MeasureScope, from: Date, to: Date) {
  const { reader, tenantId } = scope;
  const memberId = memberFilter(scope);
  const range = { gte: from, lte: to };

  const [posts, comments, reactions] = await Promise.all([
    reader.post.count({
      where: {
        tenantId,
        ...(memberId ? { authorMemberId: memberId } : {}),
        createdAt: range,
        deletedAt: null,
      },
    }),
    reader.comment.count({
      where: {
        tenantId,
        ...(memberId ? { authorMemberId: memberId } : {}),
        createdAt: range,
        deletedAt: null,
      },
    }),
    reader.reaction.count({ where: { tenantId, memberId, createdAt: range } }),
  ]);
  return { posts, comments, reactions, total: posts + comments + reactions };
}

/**
 * Completions per course. "Assigned" is the published catalogue (DEFINITIONS
 * .assignedCourse): there is no assignment table, and inventing one here would
 * be a metric that can disagree with the thing it measures.
 */
async function learningByCourse(scope: MeasureScope): Promise<Measures['learning']> {
  const { reader, tenantId, window } = scope;
  const memberId = memberFilter(scope);

  const [courses, inWindow, lifetime] = await Promise.all([
    reader.course.findMany({
      where: { tenantId, status: 'published' },
      select: { id: true, code: true, title: true },
    }),
    reader.learningProgress.groupBy({
      by: ['courseId'],
      where: {
        tenantId,
        memberId,
        status: 'completed',
        completedAt: { gte: window.from, lte: window.to },
      },
      _count: true,
    }),
    reader.learningProgress.groupBy({
      by: ['courseId', 'status'],
      where: { tenantId, memberId },
      _count: true,
    }),
  ]);

  const inWindowByCourse = new Map(inWindow.map((r) => [r.courseId, r._count]));
  const completedByCourse = new Map<string, number>();
  const inProgressByCourse = new Map<string, number>();
  for (const row of lifetime) {
    const target = row.status === 'completed' ? completedByCourse : inProgressByCourse;
    target.set(row.courseId, (target.get(row.courseId) ?? 0) + row._count);
  }

  return {
    completedInWindow: inWindow.reduce((sum, r) => sum + r._count, 0),
    courses: courses.map((c) => ({
      courseId: c.id,
      code: c.code,
      title: c.title,
      completedInWindow: inWindowByCourse.get(c.id) ?? 0,
      completedAllTime: completedByCourse.get(c.id) ?? 0,
      inProgress: inProgressByCourse.get(c.id) ?? 0,
    })),
  };
}

async function commerceTotals(scope: MeasureScope): Promise<Measures['commerce']> {
  const { reader, tenantId, window } = scope;
  const [currency, totals] = await Promise.all([
    tenantCurrency(reader, tenantId),
    reader.order.aggregate({
      where: {
        tenantId,
        memberId: memberFilter(scope),
        status: 'paid',
        paidAt: { gte: window.from, lte: window.to },
      },
      _sum: { totalMinor: true },
      _count: true,
    }),
  ]);
  return { currency, paidOrders: totals._count, volumeMinor: totals._sum.totalMinor ?? 0 };
}

async function churnCounts(scope: MeasureScope) {
  const { reader, tenantId, window } = scope;
  const memberId = memberFilter(scope);

  const [ended, atStart] = await Promise.all([
    reader.membership.findMany({
      where: {
        tenantId,
        memberId,
        OR: [
          { cancelledAt: { gte: window.from, lte: window.to } },
          // lapsed: the paid period ran out inside the window and was not renewed
          {
            status: { not: 'active' },
            currentPeriodEnd: { gte: window.from, lte: window.to },
          },
        ],
      },
      select: { memberId: true },
      distinct: ['memberId'],
    }),
    reader.membership.findMany({
      where: {
        tenantId,
        memberId,
        startedAt: { lte: window.from },
        OR: [{ cancelledAt: null }, { cancelledAt: { gt: window.from } }],
      },
      select: { memberId: true },
      distinct: ['memberId'],
    }),
  ]);
  return { ended: ended.length, activeAtStart: atStart.length };
}

/** Cohorts come from members already fetched — no cohort costs a query. */
function cohorts(
  members: ScopedMember[],
  active: ReadonlySet<string>,
  window: ResolvedWindow,
): CohortMeasure[] {
  const rows: CohortMeasure[] = [];
  for (let back = COHORT_MONTHS - 1; back >= 0; back--) {
    const start = new Date(Date.UTC(window.to.getUTCFullYear(), window.to.getUTCMonth() - back, 1));
    const end = new Date(
      Date.UTC(window.to.getUTCFullYear(), window.to.getUTCMonth() - back + 1, 1),
    );
    const joined = members.filter((m) => m.joinedAt >= start && m.joinedAt < end);
    const stillActive = joined.filter((m) => active.has(m.id)).length;
    rows.push({
      month: start.toISOString().slice(0, 7),
      joined: joined.length,
      stillActive,
      rate: ratio(stillActive, joined.length),
    });
  }
  return rows;
}

/** null rather than 0 when there is no denominator: no data is not zero. */
function ratio(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}
