import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ERROR_CODES, EVENTS, newId } from '@aviora/shared';
import { appendEvent, withTenant, type Tx } from '@aviora/db';
import { PrismaService } from '../../common/db/prisma.service';
import { TenantDb } from '../../common/db/tenant-db.service';
import { AuditService } from '../../common/audit/audit.service';
import { tenantCurrency } from '../../common/money/currency';
import { GamificationService } from '../gamification/gamification.service';
import { ensureCourseAccess } from '../learning/course-access';
import {
  configProblem,
  parseBadgeConfig,
  parseCouponConfig,
  parseCourseAccessConfig,
  parsePointsConfig,
  reversalNote,
  type RewardType,
} from './rewards';

export interface CreateDefinitionInput {
  code: string;
  name: string;
  type: RewardType;
  config?: Record<string, unknown>;
  status?: 'active' | 'archived';
}

export interface GrantInput {
  tenantId: string;
  rewardCode: string;
  memberId: string;
  /** automation | manual (docs/27 §2). */
  sourceType: string;
  /** The rule code or the actor that caused it. */
  sourceRef?: string | null;
  actorUserId?: string | null;
}

/**
 * Reward OS (docs/27 §2). Rewards are recognition and stay separate from money:
 * `points` and `badge` DELEGATE to gamification, `coupon` and `course_access`
 * hand off to the module that owns the thing, and everything else — `cash`
 * included — is a recorded grant that pays nobody.
 *
 * Grants are reachable from a request (a manual grant) and from the outbox (an
 * automation action), so every path takes an explicit tenantId and opens its
 * own tenant-scoped transaction rather than reading CLS.
 */
@Injectable()
export class RewardService {
  constructor(
    private readonly db: TenantDb,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly gamification: GamificationService,
  ) {}

  listDefinitions() {
    return this.db.tx((tx) => tx.rewardDefinition.findMany({ orderBy: { createdAt: 'desc' } }));
  }

  async createDefinition(input: CreateDefinitionInput) {
    const problem = configProblem(input.type, input.config);
    if (problem) {
      throw new ConflictException({
        code: ERROR_CODES.VALIDATION_FAILED,
        message: `A ${input.type} reward cannot be granted with this config — ${problem}`,
      });
    }

    const definition = await this.db
      .tx((tx) =>
        tx.rewardDefinition.create({
          data: {
            tenantId: this.db.tenantId,
            code: input.code,
            name: input.name,
            type: input.type,
            config: (input.config ?? {}) as object,
            status: input.status ?? 'active',
          },
        }),
      )
      .catch((e: unknown) => {
        if ((e as { code?: string } | null)?.code !== 'P2002') throw e;
        throw new ConflictException({
          code: ERROR_CODES.CONFLICT,
          message: 'A reward with this code already exists',
        });
      });

    await this.audit.record({
      action: 'reward.definition.create',
      entityType: 'reward_definition',
      entityId: definition.id,
      after: { code: definition.code, type: definition.type },
    });
    return definition;
  }

  /** The caller's own grants, newest first (docs/27 §5). */
  mine(memberId: string) {
    return this.db.tx((tx) =>
      tx.rewardGrant.findMany({
        where: { memberId },
        orderBy: { grantedAt: 'desc' },
        take: 200,
        include: { reward: { select: { code: true, name: true, type: true } } },
      }),
    );
  }

  async grant(input: GrantInput) {
    const grant = await withTenant(this.prisma.app, input.tenantId, async (tx) => {
      const definition = await tx.rewardDefinition.findFirst({
        where: { code: input.rewardCode, status: 'active' },
      });
      if (!definition) {
        throw new NotFoundException({
          code: ERROR_CODES.NOT_FOUND,
          message: `No active reward is defined with the code '${input.rewardCode}'`,
        });
      }
      const member = await tx.member.findFirst({
        where: { id: input.memberId },
        select: { id: true },
      });
      if (!member) {
        throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Member not found' });
      }

      const created = await tx.rewardGrant.create({
        data: {
          tenantId: input.tenantId,
          rewardId: definition.id,
          memberId: input.memberId,
          sourceType: input.sourceType,
          sourceRef: input.sourceRef ?? null,
          status: 'granted',
        },
      });

      const metadata = await this.fulfil(tx, {
        tenantId: input.tenantId,
        memberId: input.memberId,
        grantId: created.id,
        code: definition.code,
        type: definition.type,
        config: definition.config,
      });

      const stored = await tx.rewardGrant.update({
        where: { id: created.id },
        data: { metadata: metadata as object },
        include: { reward: { select: { code: true, name: true, type: true } } },
      });

      await appendEvent(tx, {
        eventName: EVENTS.RewardGranted,
        tenantId: input.tenantId,
        aggregateType: 'member',
        aggregateId: input.memberId,
        actorUserId: input.actorUserId ?? null,
        payload: {
          grantId: stored.id,
          memberId: input.memberId,
          rewardCode: definition.code,
          rewardType: definition.type,
          sourceType: input.sourceType,
          sourceRef: input.sourceRef ?? null,
        },
      });

      return stored;
    });

    await this.audit.record({
      action: 'reward.grant.create',
      entityType: 'reward_grant',
      entityId: grant.id,
      tenantId: input.tenantId,
      after: {
        rewardCode: input.rewardCode,
        memberId: input.memberId,
        sourceType: input.sourceType,
      },
    });
    return grant;
  }

  /**
   * Revokes, never deletes (docs/27 §2). What was already fulfilled is not
   * undone — the grant says so in its metadata rather than leaving the reward
   * ledger and gamification quietly disagreeing.
   */
  async revoke(id: string) {
    const grant = await this.db.tx(async (tx) => {
      const existing = await tx.rewardGrant.findFirst({
        where: { id },
        include: { reward: { select: { code: true, name: true, type: true } } },
      });
      if (!existing) {
        throw new NotFoundException({
          code: ERROR_CODES.NOT_FOUND,
          message: 'Reward grant not found',
        });
      }
      if (existing.status === 'revoked') return existing;

      const updated = await tx.rewardGrant.update({
        where: { id },
        data: {
          status: 'revoked',
          revokedAt: new Date(),
          metadata: {
            ...(isRecord(existing.metadata) ? existing.metadata : {}),
            revocation: reversalNote(existing.reward.type),
          } as object,
        },
        include: { reward: { select: { code: true, name: true, type: true } } },
      });

      await appendEvent(tx, {
        eventName: EVENTS.RewardRevoked,
        tenantId: this.db.tenantId,
        aggregateType: 'member',
        aggregateId: existing.memberId,
        actorUserId: null,
        payload: {
          grantId: existing.id,
          memberId: existing.memberId,
          rewardCode: existing.reward.code,
          rewardType: existing.reward.type,
        },
      });

      return updated;
    });

    await this.audit.record({
      action: 'reward.grant.revoke',
      entityType: 'reward_grant',
      entityId: grant.id,
      before: { status: 'granted' },
      after: { status: grant.status, revokedAt: grant.revokedAt },
    });
    return grant;
  }

  /**
   * Hands the reward to the module that owns it. Returns what happened, which
   * is stored on the grant — for the recorded types that record IS the whole
   * fulfilment, and saying so is what stops anyone reading a `cash` grant as a
   * payment.
   */
  private async fulfil(
    tx: Tx,
    reward: {
      tenantId: string;
      memberId: string;
      grantId: string;
      code: string;
      type: string;
      config: unknown;
    },
  ): Promise<Record<string, unknown>> {
    switch (reward.type) {
      case 'points': {
        const { points } = parsePointsConfig(reward.config);
        const awarded = await this.gamification.grant(tx, {
          tenantId: reward.tenantId,
          memberId: reward.memberId,
          eventName: EVENTS.RewardGranted,
          referenceId: reward.grantId,
          points,
        });
        return { fulfilment: 'points', pointsAwarded: awarded.pointsAwarded };
      }

      case 'badge': {
        const badge = parseBadgeConfig(reward.config);
        const awarded = await this.gamification.grant(tx, {
          tenantId: reward.tenantId,
          memberId: reward.memberId,
          eventName: EVENTS.RewardGranted,
          referenceId: reward.grantId,
          badgeCode: badge.badgeCode,
          badgeName: badge.badgeName,
        });
        return {
          fulfilment: 'badge',
          badgeCode: badge.badgeCode,
          // false when the member already held it — a second grant of the same
          // badge is a record, not a second badge
          badgeAwarded: awarded.badgeAwarded !== null,
        };
      }

      case 'course_access': {
        const { courseId } = parseCourseAccessConfig(reward.config);
        const access = await ensureCourseAccess(tx, reward.tenantId, reward.memberId, courseId);
        return { fulfilment: 'course_access', courseId, started: access.started };
      }

      case 'coupon': {
        const config = parseCouponConfig(reward.config);
        // One code per grant, single-use: a coupon reward is for the member who
        // earned it, and the coupon table has no member of its own.
        const code = `${reward.code.toUpperCase()}-${newId().replace(/-/g, '').slice(-8).toUpperCase()}`;
        const coupon = await tx.coupon.create({
          data: {
            tenantId: reward.tenantId,
            code,
            kind: config.kind,
            value: config.value,
            currency:
              config.kind === 'fixed' ? (config.currency ?? (await tenantCurrency(tx))) : null,
            minSubtotalMinor: config.minSubtotalMinor,
            endsAt: config.expiresInDays
              ? new Date(Date.now() + config.expiresInDays * 86_400_000)
              : null,
            maxRedemptions: 1,
          },
        });
        return { fulfilment: 'coupon', couponId: coupon.id, couponCode: coupon.code };
      }

      default:
        return {
          fulfilment: 'recorded',
          note:
            reward.type === 'cash'
              ? 'Cash rewards are recorded, never paid: paying is compensation’s job (docs/27 §2).'
              : 'Recorded grant — the fulfilment happens off-platform.',
        };
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
