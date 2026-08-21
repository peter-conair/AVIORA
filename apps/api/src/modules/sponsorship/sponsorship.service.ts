import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ERROR_CODES, EVENTS } from '@aviora/shared';
import { withTenant, type Tx } from '@aviora/db';
import { PrismaService } from '../../common/db/prisma.service';
import { TenantDb } from '../../common/db/tenant-db.service';
import { AuditService } from '../../common/audit/audit.service';
import { InvitationsService } from '../membership/invitations.service';

/**
 * Corporate wellness sponsorship (docs/45).
 *
 * A sponsor pays for a number of memberships on a plan; employees consume them.
 * The interesting part of this file is not the accounting — it is §1 of the
 * contract: what a sponsor may see about the people they pay for, and what they
 * may never see. Health is SELF-scoped with no admin override, and paying for
 * somebody's membership is not consent to see their sleep.
 */

/** Repeated verbatim in every participation response. A sponsor should not have to ask. */
const EXCLUSION_NOTE =
  'Participation only. Nothing here reflects health data — habits, metrics or ' +
  'health profiles — for anyone, in any aggregate. Health is visible to the ' +
  'member alone unless they grant it to a named person, and paying for a ' +
  'membership is not that grant (docs/13, docs/45 §1).';

@Injectable()
export class SponsorshipService {
  constructor(
    private readonly db: TenantDb,
    private readonly prisma: PrismaService,
    private readonly invitations: InvitationsService,
    private readonly audit: AuditService,
  ) {}

  async create(input: {
    code: string;
    name: string;
    planId: string;
    seats: number;
    sponsorName?: string;
  }) {
    const pool = await this.db.tx(async (tx) => {
      const plan = await tx.membershipPlan.findFirst({
        where: { id: input.planId, status: 'active' },
        select: { id: true },
      });
      if (!plan) {
        throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Plan not found' });
      }
      const dup = await tx.sponsorshipPool.findFirst({ where: { code: input.code } });
      if (dup) {
        throw new ConflictException({
          code: ERROR_CODES.CONFLICT,
          message: 'A sponsorship with that code already exists',
        });
      }
      return tx.sponsorshipPool.create({
        data: {
          tenantId: this.db.tenantId,
          code: input.code,
          name: input.name,
          planId: input.planId,
          seats: input.seats,
          sponsorName: input.sponsorName ?? null,
        },
      });
    });
    // Seats are what somebody paid for; how many existed and when is the kind
    // of thing a billing conversation turns on.
    await this.audit.record({
      action: 'sponsorship.create',
      entityType: 'sponsorship_pool',
      entityId: pool.id,
      after: { code: pool.code, seats: pool.seats, planId: pool.planId },
    });
    return pool;
  }

  /** Pools with their seat accounting: used, reserved, free. */
  async list() {
    return this.db.tx(async (tx) => {
      const pools = await tx.sponsorshipPool.findMany({ orderBy: { createdAt: 'desc' } });
      return Promise.all(
        pools.map(async (pool) => ({ ...pool, ...(await this.seatsOf(tx, pool)) })),
      );
    });
  }

  private async seatsOf(tx: Tx, pool: { id: string; seats: number }) {
    const [assigned, reserved] = await Promise.all([
      tx.sponsoredSeat.count({
        where: { poolId: pool.id, releasedAt: null, memberId: { not: null } },
      }),
      tx.sponsoredSeat.count({
        where: { poolId: pool.id, releasedAt: null, memberId: null },
      }),
    ]);
    return {
      // Reserved seats are counted as taken, because they are: the invitation
      // has gone out and the person on the other end expects to get in.
      seatsAssigned: assigned,
      seatsReserved: reserved,
      seatsFree: pool.seats - assigned - reserved,
    };
  }

  /**
   * Invites an employee and takes a seat NOW (docs/45 §2).
   *
   * Assigning only on acceptance would let a sponsor with 100 seats invite 200
   * people; the hundred who arrive second are refused at the door by a platform
   * that told their employer everything was fine.
   */
  async invite(poolId: string, email: string, invitedByMemberId: string | null) {
    const pool = await this.db.tx(async (tx) => {
      const found = await tx.sponsorshipPool.findFirst({ where: { id: poolId } });
      if (!found) {
        throw new NotFoundException({
          code: ERROR_CODES.NOT_FOUND,
          message: 'Sponsorship not found',
        });
      }
      if (found.status !== 'active') {
        throw new BadRequestException({
          code: ERROR_CODES.VALIDATION_FAILED,
          message: 'This sponsorship is closed',
        });
      }
      const seats = await this.seatsOf(tx, found);
      if (seats.seatsFree <= 0) {
        throw new BadRequestException({
          code: ERROR_CODES.VALIDATION_FAILED,
          message:
            `No seats left: ${found.seats} paid for, ${seats.seatsAssigned} in use and ` +
            `${seats.seatsReserved} reserved by invitations that have not been accepted yet`,
        });
      }
      return found;
    });

    const invitation = await this.invitations.invite(
      { email, planId: pool.planId },
      invitedByMemberId,
    );

    await this.db.tx(async (tx) =>
      tx.sponsoredSeat.create({
        data: { tenantId: this.db.tenantId, poolId: pool.id, invitationId: invitation.id },
      }),
    );
    return invitation;
  }

  /**
   * Assigns the reserved seat to the member who accepted. Driven by the outbox.
   *
   * The tenant comes from the EVENT and the scope is opened explicitly, because
   * a handler runs on the relay's clock and not inside a request: there is no
   * tenant in CLS for `TenantDb` to read. Calling a request-scoped helper here
   * throws for every event, which the outbox reports as "did not drain" — the
   * same words it uses for a broken handler of any kind.
   */
  async assignFromInvitation(
    tenantId: string,
    invitationId: string,
    memberId: string,
  ): Promise<boolean> {
    return withTenant(this.prisma.app, tenantId, async (tx) => {
      const seat = await tx.sponsoredSeat.findFirst({
        where: { invitationId, releasedAt: null, memberId: null },
      });
      if (!seat) return false;
      await tx.sponsoredSeat.update({
        where: { id: seat.id },
        data: { memberId, assignedAt: new Date() },
      });
      return true;
    });
  }

  async release(seatId: string) {
    const released = await this.db.tx(async (tx) => {
      const seat = await tx.sponsoredSeat.findFirst({ where: { id: seatId, releasedAt: null } });
      if (!seat) {
        throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Seat not found' });
      }
      return tx.sponsoredSeat.update({
        where: { id: seat.id },
        data: { releasedAt: new Date() },
      });
    });
    await this.audit.record({
      action: 'sponsorship.seat.release',
      entityType: 'sponsored_seat',
      entityId: released.id,
      after: { poolId: released.poolId, memberId: released.memberId },
    });
    return released;
  }

  async resize(poolId: string, input: { seats?: number; status?: string }) {
    const result = await this.db.tx(async (tx) => {
      const pool = await tx.sponsorshipPool.findFirst({ where: { id: poolId } });
      if (!pool) {
        throw new NotFoundException({
          code: ERROR_CODES.NOT_FOUND,
          message: 'Sponsorship not found',
        });
      }
      if (input.seats !== undefined) {
        const seats = await this.seatsOf(tx, pool);
        const taken = seats.seatsAssigned + seats.seatsReserved;
        if (input.seats < taken) {
          // Shrinking below what is in use would silently invalidate somebody's
          // membership, which is a thing a person should decide one seat at a
          // time — release seats, then shrink.
          throw new BadRequestException({
            code: ERROR_CODES.VALIDATION_FAILED,
            message:
              `Cannot shrink to ${input.seats}: ${taken} seats are in use or reserved. ` +
              'Release seats first.',
          });
        }
      }
      const updated = await tx.sponsorshipPool.update({
        where: { id: pool.id },
        data: {
          ...(input.seats !== undefined ? { seats: input.seats } : {}),
          ...(input.status ? { status: input.status } : {}),
        },
      });
      return { updated, before: { seats: pool.seats, status: pool.status } };
    });
    await this.audit.record({
      action: 'sponsorship.update',
      entityType: 'sponsorship_pool',
      entityId: result.updated.id,
      before: result.before,
      after: { seats: result.updated.seats, status: result.updated.status },
    });
    return result.updated;
  }

  /**
   * What the sponsor may see (docs/45 §1).
   *
   * Every measure here is an ACTION a member took that is not health: courses
   * completed, goals met, posts written, orders placed. Health activity is
   * absent, and — as docs/28 §3 established — does not count as activity
   * either, because a member who only logs health would otherwise be
   * identifiable as somebody who tracks their health.
   *
   * There is deliberately no per-member breakdown, at any size. A named list of
   * people who did not use the benefit is a performance-management tool wearing
   * a wellness badge (docs/45 §4).
   */
  async participation(poolId: string, windowDays = 30) {
    const from = new Date(Date.now() - windowDays * 86_400_000);
    return this.db.tx(async (tx) => {
      const pool = await tx.sponsorshipPool.findFirst({ where: { id: poolId } });
      if (!pool) {
        throw new NotFoundException({
          code: ERROR_CODES.NOT_FOUND,
          message: 'Sponsorship not found',
        });
      }
      const seats = await tx.sponsoredSeat.findMany({
        where: { poolId, releasedAt: null, memberId: { not: null } },
        select: { memberId: true },
      });
      const memberIds = seats.map((s) => s.memberId!).filter(Boolean);

      if (memberIds.length === 0) {
        return {
          pool: { id: pool.id, name: pool.name, seats: pool.seats },
          window: { days: windowDays, from: from.toISOString() },
          sponsoredMembers: 0,
          active: 0,
          learning: { completions: 0 },
          goals: { completed: 0 },
          community: { posts: 0 },
          note: EXCLUSION_NOTE,
        };
      }

      const [completions, goalsDone, posts, activeLearners, activeGoalSetters, activePosters] =
        await Promise.all([
          tx.learningProgress.count({
            where: { memberId: { in: memberIds }, completedAt: { gte: from } },
          }),
          tx.goal.count({
            where: { memberId: { in: memberIds }, status: 'completed', updatedAt: { gte: from } },
          }),
          tx.post.count({ where: { authorMemberId: { in: memberIds }, createdAt: { gte: from } } }),
          tx.learningProgress.findMany({
            where: { memberId: { in: memberIds }, updatedAt: { gte: from } },
            select: { memberId: true },
            distinct: ['memberId'],
          }),
          tx.goal.findMany({
            where: { memberId: { in: memberIds }, updatedAt: { gte: from } },
            select: { memberId: true },
            distinct: ['memberId'],
          }),
          tx.post.findMany({
            where: { authorMemberId: { in: memberIds }, createdAt: { gte: from } },
            select: { authorMemberId: true },
            distinct: ['authorMemberId'],
          }),
        ]);

      const active = new Set([
        ...activeLearners.map((r) => r.memberId),
        ...activeGoalSetters.map((r) => r.memberId),
        ...activePosters.map((r) => r.authorMemberId),
      ]);

      return {
        pool: { id: pool.id, name: pool.name, seats: pool.seats },
        window: { days: windowDays, from: from.toISOString() },
        sponsoredMembers: memberIds.length,
        active: active.size,
        learning: { completions },
        goals: { completed: goalsDone },
        community: { posts },
        note: EXCLUSION_NOTE,
      };
    });
  }
}

export const SPONSORSHIP_EVENTS = [EVENTS.MemberRegistered] as const;
