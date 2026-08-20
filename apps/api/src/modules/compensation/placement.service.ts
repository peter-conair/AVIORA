import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ERROR_CODES, EVENTS } from '@aviora/shared';
import { appendEvent, type Tx } from '@aviora/db';
import { TenantDb } from '../../common/db/tenant-db.service';
import { AuditService } from '../../common/audit/audit.service';
import { windowRange, type MetricGraphAdapter } from '../growth/metrics';

/**
 * Hard cap on every recursive walk. Unbounded recursion over a graph the tenant
 * controls is a denial-of-service surface, and the cap is also what keeps the
 * cycle guard from running forever on data written before it existed.
 */
export const MAX_COMPENSATION_DEPTH = 20;

export interface PlacementNode {
  memberId: string;
  depth: number;
}

interface WalkRow {
  member_id: string;
  depth: number;
}

function clampDepth(maxDepth?: number): number {
  if (!maxDepth || maxDepth < 1) return MAX_COMPENSATION_DEPTH;
  return Math.min(maxDepth, MAX_COMPENSATION_DEPTH);
}

/**
 * Members placed BELOW `rootMemberId`.
 *
 * The compensation graph is traversed here and nowhere else. It reads no
 * `team_closure` and no `referral_relationships`: spec §17 requires all three
 * graphs to be independent, and a member referred by one person and paid under
 * another is the normal case in a plan with placement, not an edge case. The
 * only durable guarantee is that none of the three can read the others.
 *
 * Raw SQL bypasses the Prisma tenant extension, so `tenant_id` is written into
 * the predicate explicitly. RLS still applies underneath; this is the belt to
 * its braces.
 *
 * `asOf` selects the edges that were live at that instant, not the ones live
 * now — a run replayed over unchanged data has to see the graph as it stood,
 * or the replay disagrees with the original and neither can be trusted.
 */
export async function compensationDownline(
  tx: Tx,
  tenantId: string,
  rootMemberId: string,
  maxDepth?: number,
  asOf?: Date,
): Promise<PlacementNode[]> {
  const depth = clampDepth(maxDepth);
  const at = asOf ?? new Date();
  const rows = await tx.$queryRaw<WalkRow[]>`
    WITH RECURSIVE walk AS (
      SELECT c.downline_member_id AS member_id, 1 AS depth
        FROM compensation_relationships c
       WHERE c.tenant_id = ${tenantId}::uuid
         AND c.upline_member_id = ${rootMemberId}::uuid
         AND c.effective_from <= ${at}
         AND (c.effective_to IS NULL OR c.effective_to > ${at})
      UNION ALL
      SELECT c.downline_member_id, w.depth + 1
        FROM compensation_relationships c
        JOIN walk w ON c.upline_member_id = w.member_id
       WHERE c.tenant_id = ${tenantId}::uuid
         AND c.effective_from <= ${at}
         AND (c.effective_to IS NULL OR c.effective_to > ${at})
         AND w.depth < ${depth}::int
    )
    SELECT member_id, MIN(depth)::int AS depth
      FROM walk
     GROUP BY member_id
     ORDER BY 2, 1`;
  return rows.map((r) => ({ memberId: r.member_id, depth: r.depth }));
}

/** Members placed ABOVE `rootMemberId`, nearest first. */
export async function compensationUpline(
  tx: Tx,
  tenantId: string,
  rootMemberId: string,
  maxDepth?: number,
  asOf?: Date,
): Promise<PlacementNode[]> {
  const depth = clampDepth(maxDepth);
  const at = asOf ?? new Date();
  const rows = await tx.$queryRaw<WalkRow[]>`
    WITH RECURSIVE walk AS (
      SELECT c.upline_member_id AS member_id, 1 AS depth
        FROM compensation_relationships c
       WHERE c.tenant_id = ${tenantId}::uuid
         AND c.downline_member_id = ${rootMemberId}::uuid
         AND c.effective_from <= ${at}
         AND (c.effective_to IS NULL OR c.effective_to > ${at})
      UNION ALL
      SELECT c.upline_member_id, w.depth + 1
        FROM compensation_relationships c
        JOIN walk w ON c.downline_member_id = w.member_id
       WHERE c.tenant_id = ${tenantId}::uuid
         AND c.effective_from <= ${at}
         AND (c.effective_to IS NULL OR c.effective_to > ${at})
         AND w.depth < ${depth}::int
    )
    SELECT member_id, MIN(depth)::int AS depth
      FROM walk
     GROUP BY member_id
     ORDER BY 2, 1`;
  return rows.map((r) => ({ memberId: r.member_id, depth: r.depth }));
}

/** Members one placement below `rootMemberId`, live at `asOf`. */
export async function compensationDirects(
  tx: Tx,
  rootMemberId: string,
  asOf: Date,
  window?: string,
): Promise<string[]> {
  const rows = await tx.compensationRelationship.findMany({
    where: {
      uplineMemberId: rootMemberId,
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: asOf } }],
      ...(window ? { effectiveFrom: windowRange(window, asOf) } : {}),
    },
    select: { downlineMemberId: true },
  });
  return rows.map((r) => r.downlineMemberId);
}

/**
 * How the shared metric calculator walks this graph. Handed to `computeMetrics`
 * through `MetricScope.graphs`, so the growth module never imports this one.
 *
 * `direct_referrals` over this adapter counts direct PLACEMENTS. The metric
 * vocabulary is deliberately shared with ranks (docs/26 §3) — a rule that says
 * "personal volume ≥ 50,000" must mean the same thing in both places — so the
 * graph, not the metric name, is what changes the line being counted.
 */
export const compensationGraph: MetricGraphAdapter = {
  async downline(scope, memberId) {
    const nodes = await compensationDownline(
      scope.tx,
      scope.tenantId,
      memberId,
      scope.maxDepth,
      scope.asOf,
    );
    return nodes.map((n) => n.memberId);
  },
  directs(scope, memberId, _params, window) {
    return compensationDirects(scope.tx, memberId, scope.asOf, window);
  },
};

export interface CreatePlacementInput {
  uplineMemberId: string;
  downlineMemberId: string;
  metadata?: Record<string, unknown>;
}

/**
 * The compensation graph (docs/26 §2). Placements are closed, never deleted:
 * ending one stamps `effective_to`, so a run replayed over an old period still
 * pays the line that existed then.
 */
@Injectable()
export class PlacementService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
  ) {}

  async create(input: CreatePlacementInput, actorUserId: string) {
    // The DB has a CHECK for this, but a raw constraint violation reaches the
    // caller as an opaque 500 — the guard exists to answer in the API's own
    // vocabulary, not to add safety the database already provides.
    if (input.uplineMemberId === input.downlineMemberId) {
      throw new ConflictException({
        code: ERROR_CODES.VALIDATION_FAILED,
        message: 'A member cannot be placed under themselves',
      });
    }

    const placement = await this.db
      .tx(async (tx) => {
        const [upline, downline] = await Promise.all([
          tx.member.findFirst({ where: { id: input.uplineMemberId }, select: { id: true } }),
          tx.member.findFirst({ where: { id: input.downlineMemberId }, select: { id: true } }),
        ]);
        if (!upline || !downline) {
          throw new NotFoundException({
            code: ERROR_CODES.NOT_FOUND,
            message: !upline ? 'Upline member not found' : 'Downline member not found',
          });
        }

        // Walk up from the PROPOSED upline: if the downline member is already
        // an ancestor, this placement would close a loop, and a loop makes
        // every downline metric — and so every commission — non-terminating.
        const ancestors = await compensationUpline(
          tx,
          this.db.tenantId,
          input.uplineMemberId,
          MAX_COMPENSATION_DEPTH,
        );
        if (ancestors.some((a) => a.memberId === input.downlineMemberId)) {
          throw new ConflictException({
            code: ERROR_CODES.VALIDATION_FAILED,
            message: 'This placement would create a cycle in the compensation graph',
          });
        }

        const created = await tx.compensationRelationship.create({
          data: {
            tenantId: this.db.tenantId,
            uplineMemberId: input.uplineMemberId,
            downlineMemberId: input.downlineMemberId,
            metadata: input.metadata as object | undefined,
          },
        });
        await appendEvent(tx, {
          eventName: EVENTS.CompensationPlacementCreated,
          tenantId: this.db.tenantId,
          aggregateType: 'compensation_relationship',
          aggregateId: created.id,
          actorUserId,
          payload: {
            uplineMemberId: created.uplineMemberId,
            downlineMemberId: created.downlineMemberId,
          },
        });
        return created;
      })
      .catch((e: unknown) => {
        // The partial unique index on (tenant, downline member) WHERE
        // effective_to IS NULL is the arbiter, not a prior read: two concurrent
        // writes cannot both pass a check-then-insert.
        if ((e as { code?: string } | null)?.code !== 'P2002') throw e;
        throw new ConflictException({
          code: ERROR_CODES.CONFLICT,
          message: 'This member is already placed under an active upline',
        });
      });

    await this.audit.record({
      action: 'compensation.placement.create',
      entityType: 'compensation_relationship',
      entityId: placement.id,
      after: {
        uplineMemberId: placement.uplineMemberId,
        downlineMemberId: placement.downlineMemberId,
      },
    });
    return placement;
  }

  async end(id: string, actorUserId: string) {
    const placement = await this.db.tx(async (tx) => {
      const existing = await tx.compensationRelationship.findFirst({ where: { id } });
      if (!existing) {
        throw new NotFoundException({
          code: ERROR_CODES.NOT_FOUND,
          message: 'Placement not found',
        });
      }
      if (existing.effectiveTo) {
        throw new ConflictException({
          code: ERROR_CODES.CONFLICT,
          message: 'This placement has already ended',
        });
      }
      const ended = await tx.compensationRelationship.update({
        where: { id: existing.id },
        data: { effectiveTo: new Date() },
      });
      await appendEvent(tx, {
        eventName: EVENTS.CompensationPlacementEnded,
        tenantId: this.db.tenantId,
        aggregateType: 'compensation_relationship',
        aggregateId: existing.id,
        actorUserId,
        payload: {
          uplineMemberId: existing.uplineMemberId,
          downlineMemberId: existing.downlineMemberId,
          effectiveTo: ended.effectiveTo?.toISOString() ?? null,
        },
      });
      return ended;
    });
    await this.audit.record({
      action: 'compensation.placement.end',
      entityType: 'compensation_relationship',
      entityId: placement.id,
      after: { effectiveTo: placement.effectiveTo },
    });
    return placement;
  }

  /** Every placement in the tenant, for the people who administer the graph. */
  list(input: { includeEnded?: boolean; limit?: number }) {
    return this.db.tx(async (tx) => {
      const rows = await tx.compensationRelationship.findMany({
        where: input.includeEnded ? {} : { effectiveTo: null },
        orderBy: { effectiveFrom: 'desc' },
        take: Math.min(Math.max(input.limit ?? 200, 1), 500),
      });
      const names = await this.displayNames(tx, [
        ...rows.map((r) => r.uplineMemberId),
        ...rows.map((r) => r.downlineMemberId),
      ]);
      return rows.map((r) => ({
        ...r,
        uplineDisplayName: names.get(r.uplineMemberId) ?? null,
        downlineDisplayName: names.get(r.downlineMemberId) ?? null,
      }));
    });
  }

  private async displayNames(tx: Tx, ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map();
    const members = await tx.member.findMany({
      where: { id: { in: unique } },
      select: { id: true, displayName: true },
    });
    return new Map(members.map((m) => [m.id, m.displayName]));
  }
}
