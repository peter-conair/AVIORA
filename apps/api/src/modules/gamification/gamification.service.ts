import { Injectable, Logger } from '@nestjs/common';
import { withTenant } from '@aviora/db';
import { PrismaService } from '../../common/db/prisma.service';
import { TenantDb } from '../../common/db/tenant-db.service';

/** Levels are a simple, explainable curve: every 100 points is a level. */
const POINTS_PER_LEVEL = 100;

/**
 * Gamification (spec §38) — rules are configuration, never code.
 *
 * A tenant decides what each domain event is worth and whether it earns a
 * badge; a tenant that configures nothing simply has no points. Awards are
 * driven from the outbox, so they follow the same events as every other
 * reaction in the platform.
 */
@Injectable()
export class GamificationService {
  private readonly logger = new Logger(GamificationService.name);

  constructor(
    private readonly db: TenantDb,
    private readonly prisma: PrismaService,
  ) {}

  rules() {
    return this.db.tx((tx) => tx.gamificationRule.findMany({ orderBy: { eventName: 'asc' } }));
  }

  setRule(input: { eventName: string; points: number; badgeCode?: string; badgeName?: string }) {
    return this.db.tx(async (tx) => {
      const existing = await tx.gamificationRule.findFirst({
        where: { eventName: input.eventName },
      });
      if (existing) {
        return tx.gamificationRule.update({ where: { id: existing.id }, data: input });
      }
      return tx.gamificationRule.create({ data: { ...input, tenantId: this.db.tenantId } });
    });
  }

  /** A member's own standing: points, level, badges and recent entries. */
  async standing(memberId: string) {
    return this.db.tx(async (tx) => {
      const [sum, entries, badges] = await Promise.all([
        tx.pointEntry.aggregate({ where: { memberId }, _sum: { points: true } }),
        tx.pointEntry.findMany({
          where: { memberId },
          orderBy: { createdAt: 'desc' },
          take: 20,
          select: { eventName: true, points: true, createdAt: true },
        }),
        tx.memberBadge.findMany({
          where: { memberId },
          orderBy: { awardedAt: 'desc' },
          select: { badgeCode: true, badgeName: true, awardedAt: true },
        }),
      ]);
      const points = sum._sum.points ?? 0;
      return {
        points,
        level: Math.floor(points / POINTS_PER_LEVEL) + 1,
        pointsToNextLevel: POINTS_PER_LEVEL - (points % POINTS_PER_LEVEL),
        badges,
        recent: entries,
      };
    });
  }

  /** Tenant leaderboard — points only, nothing about how they were earned. */
  leaderboard() {
    return this.db.tx(async (tx) => {
      const grouped = await tx.pointEntry.groupBy({
        by: ['memberId'],
        _sum: { points: true },
        orderBy: { _sum: { points: 'desc' } },
        take: 20,
      });
      const members = await tx.member.findMany({
        where: { id: { in: grouped.map((g) => g.memberId) } },
        select: { id: true, displayName: true },
      });
      const nameById = new Map(members.map((m) => [m.id, m.displayName]));
      return grouped.map((g, index) => ({
        rank: index + 1,
        memberId: g.memberId,
        displayName: nameById.get(g.memberId) ?? null,
        points: g._sum.points ?? 0,
      }));
    });
  }

  /**
   * Awards points for one event occurrence. Called from an outbox handler, so
   * it opens its own tenant-scoped transaction, and it is idempotent per
   * (member, event, reference) so a retried event never pays twice.
   */
  async award(input: {
    tenantId: string;
    memberId: string;
    eventName: string;
    referenceId?: string;
  }): Promise<void> {
    await withTenant(this.prisma.app, input.tenantId, async (tx) => {
      const rule = await tx.gamificationRule.findFirst({
        where: { eventName: input.eventName },
      });
      if (!rule || rule.points <= 0) return; // a tenant that configured nothing earns nothing

      if (input.referenceId) {
        const already = await tx.pointEntry.findFirst({
          where: {
            memberId: input.memberId,
            eventName: input.eventName,
            referenceId: input.referenceId,
          },
        });
        if (already) return;
      }

      await tx.pointEntry.create({
        data: {
          tenantId: input.tenantId,
          memberId: input.memberId,
          eventName: input.eventName,
          points: rule.points,
          referenceId: input.referenceId,
        },
      });

      if (rule.badgeCode) {
        const held = await tx.memberBadge.findFirst({
          where: { memberId: input.memberId, badgeCode: rule.badgeCode },
        });
        if (!held) {
          await tx.memberBadge.create({
            data: {
              tenantId: input.tenantId,
              memberId: input.memberId,
              badgeCode: rule.badgeCode,
              badgeName: rule.badgeName ?? rule.badgeCode,
            },
          });
        }
      }
    });
  }
}
