import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ERROR_CODES, EVENTS } from '@aviora/shared';
import { appendEvent, type Tx } from '@aviora/db';
import { TenantDb } from '../../common/db/tenant-db.service';
import { AuditService } from '../../common/audit/audit.service';

export const REFERRAL_TYPES = [
  'referral',
  'sponsor',
  'introducer',
  'affiliate',
  'mentor_referral',
] as const;
export type ReferralType = (typeof REFERRAL_TYPES)[number];

export const DEFAULT_REFERRAL_TYPE: ReferralType = 'referral';

/**
 * Hard cap on every recursive walk. Unbounded recursion over a graph the tenant
 * controls is a denial-of-service surface, and the cap is also what keeps the
 * cycle guard from running forever on data written before it existed.
 */
export const MAX_REFERRAL_DEPTH = 20;

export interface ReferralNode {
  memberId: string;
  depth: number;
}

interface WalkRow {
  member_id: string;
  depth: number;
}

function clampDepth(maxDepth?: number): number {
  if (!maxDepth || maxDepth < 1) return MAX_REFERRAL_DEPTH;
  return Math.min(maxDepth, MAX_REFERRAL_DEPTH);
}

/**
 * Members BELOW `rootMemberId` on active edges of one type.
 *
 * The referral graph is traversed here and nowhere else. It shares no table,
 * no closure and no helper with the operational team graph — spec §17 requires
 * that moving a member in one graph leave the other untouched, and the only
 * durable way to guarantee that is for neither to be able to read the other.
 *
 * Raw SQL bypasses the Prisma tenant extension, so `tenant_id` is written into
 * the predicate explicitly. RLS still applies underneath; this is the belt to
 * its braces.
 *
 * `asOf` selects the edges that were live at that instant, not the ones live
 * now. Replaying an old evaluation has to see the graph as it was, or the
 * replay disagrees with the original and neither can be trusted.
 */
export async function referralDownline(
  tx: Tx,
  tenantId: string,
  rootMemberId: string,
  relationshipType: string,
  maxDepth?: number,
  asOf?: Date,
): Promise<ReferralNode[]> {
  const depth = clampDepth(maxDepth);
  const at = asOf ?? new Date();
  const rows = await tx.$queryRaw<WalkRow[]>`
    WITH RECURSIVE walk AS (
      SELECT r.referred_member_id AS member_id, 1 AS depth
        FROM referral_relationships r
       WHERE r.tenant_id = ${tenantId}::uuid
         AND r.referrer_member_id = ${rootMemberId}::uuid
         AND r.relationship_type = ${relationshipType}
         AND r.effective_from <= ${at}
         AND (r.effective_to IS NULL OR r.effective_to > ${at})
      UNION ALL
      SELECT r.referred_member_id, w.depth + 1
        FROM referral_relationships r
        JOIN walk w ON r.referrer_member_id = w.member_id
       WHERE r.tenant_id = ${tenantId}::uuid
         AND r.relationship_type = ${relationshipType}
         AND r.effective_from <= ${at}
         AND (r.effective_to IS NULL OR r.effective_to > ${at})
         AND w.depth < ${depth}::int
    )
    SELECT member_id, MIN(depth)::int AS depth
      FROM walk
     GROUP BY member_id
     ORDER BY 2, 1`;
  return rows.map((r) => ({ memberId: r.member_id, depth: r.depth }));
}

/** Members ABOVE `rootMemberId` on active edges of one type, nearest first. */
export async function referralUpline(
  tx: Tx,
  tenantId: string,
  rootMemberId: string,
  relationshipType: string,
  maxDepth?: number,
  asOf?: Date,
): Promise<ReferralNode[]> {
  const depth = clampDepth(maxDepth);
  const at = asOf ?? new Date();
  const rows = await tx.$queryRaw<WalkRow[]>`
    WITH RECURSIVE walk AS (
      SELECT r.referrer_member_id AS member_id, 1 AS depth
        FROM referral_relationships r
       WHERE r.tenant_id = ${tenantId}::uuid
         AND r.referred_member_id = ${rootMemberId}::uuid
         AND r.relationship_type = ${relationshipType}
         AND r.effective_from <= ${at}
         AND (r.effective_to IS NULL OR r.effective_to > ${at})
      UNION ALL
      SELECT r.referrer_member_id, w.depth + 1
        FROM referral_relationships r
        JOIN walk w ON r.referred_member_id = w.member_id
       WHERE r.tenant_id = ${tenantId}::uuid
         AND r.relationship_type = ${relationshipType}
         AND r.effective_from <= ${at}
         AND (r.effective_to IS NULL OR r.effective_to > ${at})
         AND w.depth < ${depth}::int
    )
    SELECT member_id, MIN(depth)::int AS depth
      FROM walk
     GROUP BY member_id
     ORDER BY 2, 1`;
  return rows.map((r) => ({ memberId: r.member_id, depth: r.depth }));
}

export interface CreateReferralInput {
  referrerMemberId: string;
  referredMemberId: string;
  relationshipType: ReferralType;
  metadata?: Record<string, unknown>;
}

/**
 * The referral graph (docs/25 §2). Edges are closed, never deleted: ending one
 * stamps `effective_to` so who introduced whom, and when, survives.
 */
@Injectable()
export class ReferralService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
  ) {}

  async create(input: CreateReferralInput, actorUserId: string) {
    // The DB has a CHECK for this, but a raw constraint violation reaches the
    // caller as an opaque 500 — the guard exists to answer in the API's own
    // vocabulary, not to add safety the database already provides.
    if (input.referrerMemberId === input.referredMemberId) {
      throw new ConflictException({
        code: ERROR_CODES.VALIDATION_FAILED,
        message: 'A member cannot refer themselves',
      });
    }

    const edge = await this.db
      .tx(async (tx) => {
        const [referrer, referred] = await Promise.all([
          tx.member.findFirst({ where: { id: input.referrerMemberId }, select: { id: true } }),
          tx.member.findFirst({ where: { id: input.referredMemberId }, select: { id: true } }),
        ]);
        if (!referrer || !referred) {
          throw new NotFoundException({
            code: ERROR_CODES.NOT_FOUND,
            message: !referrer ? 'Referrer member not found' : 'Referred member not found',
          });
        }

        // Walk up from the PROPOSED referrer: if the referred member is already
        // an ancestor, this edge would close a loop, and a loop makes every
        // downline metric — and later, every commission — non-terminating.
        const ancestors = await referralUpline(
          tx,
          this.db.tenantId,
          input.referrerMemberId,
          input.relationshipType,
          MAX_REFERRAL_DEPTH,
        );
        if (ancestors.some((a) => a.memberId === input.referredMemberId)) {
          throw new ConflictException({
            code: ERROR_CODES.VALIDATION_FAILED,
            message: 'This relationship would create a cycle in the referral graph',
          });
        }

        const created = await tx.referralRelationship.create({
          data: {
            tenantId: this.db.tenantId,
            referrerMemberId: input.referrerMemberId,
            referredMemberId: input.referredMemberId,
            relationshipType: input.relationshipType,
            metadata: input.metadata as object | undefined,
          },
        });
        await appendEvent(tx, {
          eventName: EVENTS.ReferralCreated,
          tenantId: this.db.tenantId,
          aggregateType: 'referral_relationship',
          aggregateId: created.id,
          actorUserId,
          payload: {
            referrerMemberId: created.referrerMemberId,
            referredMemberId: created.referredMemberId,
            relationshipType: created.relationshipType,
          },
        });
        return created;
      })
      .catch((e: unknown) => {
        // The partial unique index on (tenant, referred member, type) WHERE
        // effective_to IS NULL is the arbiter, not a prior read: two concurrent
        // writes cannot both pass a check-then-insert.
        if ((e as { code?: string } | null)?.code !== 'P2002') throw e;
        throw new ConflictException({
          code: ERROR_CODES.CONFLICT,
          message: `This member already has an active ${input.relationshipType} relationship`,
        });
      });

    await this.audit.record({
      action: 'growth.referral.create',
      entityType: 'referral_relationship',
      entityId: edge.id,
      after: {
        referrerMemberId: edge.referrerMemberId,
        referredMemberId: edge.referredMemberId,
        relationshipType: edge.relationshipType,
      },
    });
    return edge;
  }

  async end(id: string, actorUserId: string) {
    const edge = await this.db.tx(async (tx) => {
      const existing = await tx.referralRelationship.findFirst({ where: { id } });
      if (!existing) {
        throw new NotFoundException({
          code: ERROR_CODES.NOT_FOUND,
          message: 'Referral relationship not found',
        });
      }
      if (existing.effectiveTo) {
        throw new ConflictException({
          code: ERROR_CODES.CONFLICT,
          message: 'This referral relationship has already ended',
        });
      }
      const ended = await tx.referralRelationship.update({
        where: { id: existing.id },
        data: { effectiveTo: new Date() },
      });
      await appendEvent(tx, {
        eventName: EVENTS.ReferralEnded,
        tenantId: this.db.tenantId,
        aggregateType: 'referral_relationship',
        aggregateId: existing.id,
        actorUserId,
        payload: {
          referrerMemberId: existing.referrerMemberId,
          referredMemberId: existing.referredMemberId,
          relationshipType: existing.relationshipType,
          effectiveTo: ended.effectiveTo?.toISOString() ?? null,
        },
      });
      return ended;
    });
    await this.audit.record({
      action: 'growth.referral.end',
      entityType: 'referral_relationship',
      entityId: edge.id,
      after: { effectiveTo: edge.effectiveTo },
    });
    return edge;
  }

  /** Who referred the caller, and whom the caller referred directly. */
  me(memberId: string) {
    return this.db.tx(async (tx) => {
      const [referrers, directReferrals] = await Promise.all([
        tx.referralRelationship.findMany({
          where: { referredMemberId: memberId, effectiveTo: null },
          orderBy: { effectiveFrom: 'asc' },
          select: {
            id: true,
            referrerMemberId: true,
            relationshipType: true,
            effectiveFrom: true,
          },
        }),
        tx.referralRelationship.findMany({
          where: { referrerMemberId: memberId, effectiveTo: null },
          orderBy: { effectiveFrom: 'desc' },
          take: 500,
          select: {
            id: true,
            referredMemberId: true,
            relationshipType: true,
            effectiveFrom: true,
          },
        }),
      ]);
      const names = await this.displayNames(tx, [
        ...referrers.map((r) => r.referrerMemberId),
        ...directReferrals.map((r) => r.referredMemberId),
      ]);
      const withNames = referrers.map((r) => ({
        ...r,
        displayName: names.get(r.referrerMemberId) ?? null,
      }));
      return {
        memberId,
        // "Who referred me" has one answer in a member's head, so it gets one
        // field. `referrers` still carries every type, since a member can have
        // a sponsor and a mentor at once.
        referrer: withNames.find((r) => r.relationshipType === DEFAULT_REFERRAL_TYPE) ?? null,
        referrers: withNames,
        directReferrals: directReferrals.map((r) => ({
          ...r,
          displayName: names.get(r.referredMemberId) ?? null,
        })),
      };
    });
  }

  /** Depth-capped subtree below the caller, active edges of one type only. */
  downline(memberId: string, relationshipType: string, maxDepth?: number) {
    return this.db.tx(async (tx) => {
      const nodes = await referralDownline(
        tx,
        this.db.tenantId,
        memberId,
        relationshipType,
        maxDepth,
      );
      const names = await this.displayNames(
        tx,
        nodes.map((n) => n.memberId),
      );
      return {
        memberId,
        relationshipType,
        maxDepth: clampDepth(maxDepth),
        total: nodes.length,
        downline: nodes.map((n) => ({ ...n, displayName: names.get(n.memberId) ?? null })),
      };
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
