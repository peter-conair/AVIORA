import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  ERROR_CODES,
  EVENTS,
  LADDER_METRIC,
  LADDER_UNSET_THRESHOLD,
  LADDER_WINDOW,
  RANK_LADDER,
} from '@aviora/shared';
import { appendEvent, type Tx } from '@aviora/db';
import { TenantDb } from '../../common/db/tenant-db.service';
import { tenantCurrency } from '../../common/money/currency';
import { AuditService } from '../../common/audit/audit.service';
import { MAX_REFERRAL_DEPTH } from './referral.service';
import {
  computeMetrics,
  passes,
  requirementKey,
  type MetricRequirement,
  type RankComparator,
  type RankMetric,
  type RankWindow,
} from './metrics';

export interface QualificationInput {
  metric: RankMetric;
  comparator: RankComparator;
  threshold: number;
  window: RankWindow;
  params?: Record<string, unknown>;
}

export interface CreateRankInput {
  code: string;
  name: string;
  level: number;
  status?: 'active' | 'archived' | 'draft';
  requalifyWindowDays?: number;
  /** Courses to suggest to a member working towards this rank (docs/27 §3).
   *  Recommendation only — a rank is earned by its qualifications. */
  recommendedCourseIds?: string[];
  qualifications: QualificationInput[];
}

export interface RankEvaluation {
  memberId: string;
  previousRankId: string | null;
  rankId: string | null;
  rankCode: string | null;
  changed: boolean;
  metrics: Record<string, number>;
}

interface RankRow {
  id: string;
  code: string;
  name: string;
  level: number;
  requalifyWindowDays: number | null;
  recommendedCourseIds: string[];
  qualifications: Array<{
    metric: string;
    comparator: string;
    threshold: number;
    window: string;
    params: unknown;
  }>;
}

/**
 * The rank engine (docs/25 §3, spec §44). Qualifications are DATA — metric,
 * comparator, threshold, window — so a new rank rule is a row, never a branch.
 */
@Injectable()
export class RankService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
  ) {}

  /** The tenant's ladder, lowest rank first. */
  /** The ladder, with the currency its money thresholds are quoted in. */
  list() {
    return this.db.tx(async (tx) => {
      // A tenant that has never opened the rank editor still sees the ladder
      // it talks in — as drafts it must put its own numbers into (docs/62).
      await this.ensureLadder(tx);
      const [ranks, currency] = await Promise.all([
        tx.rankDefinition.findMany({
          orderBy: { level: 'asc' },
          include: { qualifications: { orderBy: { metric: 'asc' } } },
        }),
        tenantCurrency(tx),
      ]);
      return { ranks, currency };
    });
  }

  /**
   * The performance ladder, seeded on first read (docs/62).
   *
   * Only into a tenant with NO ranks at all — a tenant that built its own
   * ladder, or deleted ours, must not find six draft rows appear underneath it.
   * Seeded as `draft` with a zero threshold, because what group volume earns
   * 12% is the business's number and not mine.
   */
  private async ensureLadder(tx: Tx) {
    const existing = await tx.rankDefinition.count();
    if (existing > 0) return;
    for (const rung of RANK_LADDER) {
      const rank = await tx.rankDefinition.create({
        data: {
          tenantId: this.db.tenantId,
          code: rung.code,
          name: rung.name.th,
          level: rung.level,
          // Never 'active': a ladder rank with a zero threshold would qualify
          // every member for 21% the moment it was evaluated.
          status: 'draft',
          // A performance level is re-earned every month, not kept.
          requalifyWindowDays: 31,
          recommendedCourseIds: [],
        },
      });
      await tx.rankQualification.create({
        data: {
          tenantId: this.db.tenantId,
          rankId: rank.id,
          metric: LADDER_METRIC,
          comparator: 'gte',
          threshold: LADDER_UNSET_THRESHOLD,
          window: LADDER_WINDOW,
        },
      });
    }
  }

  /**
   * Set a rank's numbers, and turn it on.
   *
   * The guard is the point: activating a rank whose thresholds are all zero
   * would qualify every member for it instantly, and the seeded ladder ships
   * in exactly that state on purpose. Refusing here is what makes seeding a
   * blank ladder safe rather than a loaded gun (docs/62 §3).
   */
  async update(
    id: string,
    input: {
      name?: string;
      level?: number;
      status?: 'active' | 'archived' | 'draft';
      requalifyWindowDays?: number | null;
      recommendedCourseIds?: string[];
      qualifications?: QualificationInput[];
    },
  ) {
    return this.db.tx(async (tx) => {
      const rank = await tx.rankDefinition.findFirst({
        where: { id },
        include: { qualifications: true },
      });
      if (!rank) {
        throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Rank not found' });
      }

      const nextQualifications = input.qualifications ?? rank.qualifications;
      if (
        input.status === 'active' &&
        (nextQualifications.length === 0 ||
          nextQualifications.every((q) => (q.threshold ?? 0) <= LADDER_UNSET_THRESHOLD))
      ) {
        throw new ConflictException({
          code: ERROR_CODES.CONFLICT,
          message:
            'This rank has no threshold set, so every member would qualify for it. ' +
            'Set the volume it requires before turning it on.',
        });
      }

      if (input.qualifications) {
        await tx.rankQualification.deleteMany({ where: { rankId: id } });
        for (const qualification of input.qualifications) {
          await tx.rankQualification.create({
            data: {
              tenantId: this.db.tenantId,
              rankId: id,
              metric: qualification.metric,
              comparator: qualification.comparator ?? 'gte',
              threshold: qualification.threshold,
              window: qualification.window ?? 'lifetime',
              params: qualification.params as object | undefined,
            },
          });
        }
      }

      const updated = await tx.rankDefinition.update({
        where: { id },
        data: {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.level === undefined ? {} : { level: input.level }),
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.requalifyWindowDays === undefined
            ? {}
            : { requalifyWindowDays: input.requalifyWindowDays }),
          ...(input.recommendedCourseIds === undefined
            ? {}
            : { recommendedCourseIds: input.recommendedCourseIds }),
        },
        include: { qualifications: true },
      });
      await this.audit.record({
        action: 'growth.rank.update',
        entityType: 'rank_definition',
        entityId: id,
        before: { status: rank.status, qualifications: rank.qualifications.length },
        after: { status: updated.status, qualifications: updated.qualifications.length },
      });
      return updated;
    });
  }

  async create(input: CreateRankInput) {
    for (const qualification of input.qualifications) {
      if (
        qualification.metric === 'qualified_legs' &&
        !numeric(qualification.params?.legVolumeMinor)
      ) {
        throw new ConflictException({
          code: ERROR_CODES.VALIDATION_FAILED,
          message: 'A qualified_legs rule needs params.legVolumeMinor',
        });
      }
    }

    const rank = await this.db
      .tx(async (tx) => {
        const created = await tx.rankDefinition.create({
          data: {
            tenantId: this.db.tenantId,
            code: input.code,
            name: input.name,
            level: input.level,
            status: input.status ?? 'active',
            requalifyWindowDays: input.requalifyWindowDays ?? null,
            recommendedCourseIds: input.recommendedCourseIds ?? [],
          },
        });
        for (const qualification of input.qualifications) {
          await tx.rankQualification.create({
            data: {
              tenantId: this.db.tenantId,
              rankId: created.id,
              metric: qualification.metric,
              comparator: qualification.comparator,
              threshold: qualification.threshold,
              window: qualification.window,
              params: qualification.params as object | undefined,
            },
          });
        }
        return tx.rankDefinition.findFirstOrThrow({
          where: { id: created.id },
          include: { qualifications: true },
        });
      })
      .catch((e: unknown) => {
        if ((e as { code?: string } | null)?.code !== 'P2002') throw e;
        throw new ConflictException({
          code: ERROR_CODES.CONFLICT,
          message: 'A rank with this code or level already exists',
        });
      });

    await this.audit.record({
      action: 'growth.rank.create',
      entityType: 'rank_definition',
      entityId: rank.id,
      after: { code: rank.code, level: rank.level, qualifications: rank.qualifications.length },
    });
    return rank;
  }

  /**
   * The member dashboard (docs/25 §5): the rank they hold, the rank above it,
   * and — for every rule they do not yet pass — the threshold beside their own
   * current value. "You need 2 more qualified legs" is the only form of this
   * that is any use to a member.
   */
  me(memberId: string, asOf = new Date()) {
    return this.db.tx(async (tx) => {
      const [progress, definitions, everHeld, currency] = await Promise.all([
        tx.rankProgress.findFirst({ where: { memberId } }),
        this.activeDefinitions(tx),
        // Recognition: the best rank ever held, which survives a demotion.
        // Kept apart from `current` so the number a commission would pay on
        // is never the number a certificate on the wall says.
        tx.rankHistory.findMany({ where: { memberId }, select: { rankId: true } }),
        // money thresholds are minor units; without the code the reader has to
        // guess which currency they are in
        tenantCurrency(tx),
      ]);
      const heldIds = new Set(everHeld.map((h) => h.rankId));
      const highest =
        [...definitions].filter((d) => heldIds.has(d.id)).sort((a, b) => b.level - a.level)[0] ??
        null;
      const current = progress?.rankId
        ? ((await tx.rankDefinition.findFirst({ where: { id: progress.rankId } })) ?? null)
        : null;
      const next =
        [...definitions]
          .sort((a, b) => a.level - b.level)
          .find((d) => d.level > (current?.level ?? Number.NEGATIVE_INFINITY)) ?? null;

      if (!next) {
        return {
          memberId,
          currency,
          current: currentView(current, progress?.evaluatedAt ?? null),
          highest: highest
            ? { id: highest.id, code: highest.code, name: highest.name, level: highest.level }
            : null,
          next: null,
          missing: [],
        };
      }

      const values = await computeMetrics(
        { tx, tenantId: this.db.tenantId, memberId, asOf, maxDepth: MAX_REFERRAL_DEPTH },
        next.qualifications.map(toRequirement),
      );
      const missing = next.qualifications
        .map((q) => {
          const value = values[requirementKey(toRequirement(q))] ?? 0;
          return {
            metric: q.metric,
            comparator: q.comparator,
            window: q.window,
            threshold: q.threshold,
            current: value,
            remaining: Math.max(0, q.threshold - value),
            met: passes(q.comparator, value, q.threshold),
          };
        })
        .filter((q) => !q.met);

      return {
        memberId,
        currency,
        current: currentView(current, progress?.evaluatedAt ?? null),
        highest: highest
          ? { id: highest.id, code: highest.code, name: highest.name, level: highest.level }
          : null,
        next: {
          id: next.id,
          code: next.code,
          name: next.name,
          level: next.level,
          // What §44's dashboard asks and ranks lacked: the learning a member
          // can do next (docs/27 §3).
          recommendedCourseIds: next.recommendedCourseIds,
        },
        missing,
      };
    });
  }

  /** One member, or every active member when `memberId` is omitted. */
  async evaluate(memberId: string | undefined, asOf: Date, actorUserId: string) {
    const targets = memberId
      ? [memberId]
      : (
          await this.db.tx((tx) =>
            tx.member.findMany({ where: { status: 'active' }, select: { id: true } }),
          )
        ).map((m) => m.id);

    const results: RankEvaluation[] = [];
    for (const target of targets) {
      results.push(await this.db.tx((tx) => this.evaluateMember(tx, target, asOf, actorUserId)));
    }
    for (const changed of results.filter((r) => r.changed)) {
      await this.audit.record({
        action: 'growth.rank.evaluate',
        entityType: 'rank_progress',
        entityId: changed.memberId,
        before: { rankId: changed.previousRankId },
        after: { rankId: changed.rankId, asOf },
      });
    }
    return {
      asOf,
      evaluated: results.length,
      changed: results.filter((r) => r.changed).length,
      results,
    };
  }

  private async evaluateMember(
    tx: Tx,
    memberId: string,
    asOf: Date,
    actorUserId: string,
  ): Promise<RankEvaluation> {
    const member = await tx.member.findFirst({ where: { id: memberId }, select: { id: true } });
    if (!member) {
      throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Member not found' });
    }

    const definitions = await this.activeDefinitions(tx);
    const values = await computeMetrics(
      { tx, tenantId: this.db.tenantId, memberId, asOf, maxDepth: MAX_REFERRAL_DEPTH },
      definitions.flatMap((d) => d.qualifications.map(toRequirement)),
    );

    // Highest level whose rules ALL pass. A rank with no rules passes trivially,
    // which is how a tenant models an entry rank.
    const earned =
      [...definitions]
        .sort((a, b) => b.level - a.level)
        .find((d) =>
          d.qualifications.every((q) =>
            passes(q.comparator, values[requirementKey(toRequirement(q))] ?? 0, q.threshold),
          ),
        ) ?? null;

    const progress = await tx.rankProgress.findFirst({ where: { memberId } });
    const previousRankId = progress?.rankId ?? null;
    // The stored rank is always the CURRENTLY QUALIFIED one, even when that is
    // lower than before. Recognition — the best rank ever held — is derivable
    // from rank_history and is reported separately. Keeping a rank in this
    // field after its rules stopped passing would mean a later commission run
    // pays on a qualification that is no longer true, which is precisely the
    // number nobody may fudge (docs/25 §3).
    const rankId = earned?.id ?? null;
    const changed = previousRankId !== rankId;

    // Re-running the same asOf over the same data resolves to the same rank, so
    // this branch does not fire and no duplicate history is written. That is
    // what lets a later commission run be replayed rather than trusted.
    if (progress) {
      await tx.rankProgress.update({
        where: { id: progress.id },
        data: { rankId, evaluatedAt: asOf, metrics: values },
      });
    } else {
      await tx.rankProgress.create({
        data: { tenantId: this.db.tenantId, memberId, rankId, evaluatedAt: asOf, metrics: values },
      });
    }

    if (changed) {
      if (previousRankId) {
        // Closed, never deleted. `reason` says how the period BEGAN and keeps
        // saying it; `lostAt` says it ended. Overwriting the reason with 'lost'
        // would erase the fact that the rank was ever earned, which is exactly
        // the fact history exists to keep.
        await tx.rankHistory.updateMany({
          where: { memberId, rankId: previousRankId, lostAt: null },
          data: { lostAt: asOf },
        });
        await appendEvent(tx, {
          eventName: EVENTS.RankLost,
          tenantId: this.db.tenantId,
          aggregateType: 'member',
          aggregateId: memberId,
          actorUserId,
          payload: { memberId, rankId: previousRankId, asOf: asOf.toISOString() },
        });
      }
      if (rankId) {
        const seen = await tx.rankHistory.findFirst({ where: { memberId, rankId } });
        await tx.rankHistory.create({
          data: {
            tenantId: this.db.tenantId,
            memberId,
            rankId,
            achievedAt: asOf,
            reason: seen ? 'requalified' : 'achieved',
          },
        });
        await appendEvent(tx, {
          eventName: EVENTS.RankAchieved,
          tenantId: this.db.tenantId,
          aggregateType: 'member',
          aggregateId: memberId,
          actorUserId,
          payload: {
            memberId,
            rankId,
            rankCode: earned?.code ?? null,
            level: earned?.level ?? null,
            asOf: asOf.toISOString(),
          },
        });
      }
    }

    return {
      memberId,
      previousRankId,
      rankId,
      rankCode: earned?.code ?? null,
      changed,
      metrics: values,
    };
  }

  private async activeDefinitions(tx: Tx): Promise<RankRow[]> {
    return tx.rankDefinition.findMany({
      where: { status: 'active' },
      orderBy: { level: 'asc' },
      select: {
        id: true,
        code: true,
        name: true,
        level: true,
        requalifyWindowDays: true,
        recommendedCourseIds: true,
        qualifications: {
          select: {
            metric: true,
            comparator: true,
            threshold: true,
            window: true,
            params: true,
          },
        },
      },
    });
  }
}

function toRequirement(qualification: {
  metric: string;
  window: string;
  params: unknown;
}): MetricRequirement {
  return {
    metric: qualification.metric,
    window: qualification.window,
    params: isRecord(qualification.params) ? qualification.params : null,
  };
}

function currentView(
  rank: {
    id: string;
    code: string;
    name: string;
    level: number;
    recommendedCourseIds: string[];
  } | null,
  evaluatedAt: Date | null,
) {
  return rank
    ? {
        id: rank.id,
        code: rank.code,
        name: rank.name,
        level: rank.level,
        // "What should I do next?" is asked of the rank a member HOLDS as often
        // as of the one above it (docs/27 §3).
        recommendedCourseIds: rank.recommendedCourseIds,
        evaluatedAt,
      }
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numeric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
