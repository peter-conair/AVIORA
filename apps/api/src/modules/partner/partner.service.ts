import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { withTenant, type Tx } from '@aviora/db';
import { ERROR_CODES } from '@aviora/shared';
import { PrismaService } from '../../common/db/prisma.service';
import { TenantDb } from '../../common/db/tenant-db.service';
import { InvitationsService } from '../membership/invitations.service';

/**
 * Partners (docs/46).
 *
 * Two audiences share this file, and the split matters: the TENANT manages
 * partners, and a PARTNER sees only its own numbers. Every method that a
 * partner can reach takes the partner id from CLS — resolved by the guard from
 * the token — and never from an argument the caller supplied.
 */

const PARTNER_NOTE =
  'Counts only. A partner never sees who their referrals are — no name, no ' +
  'email, no id — and nothing from health in any aggregate. They brought these ' +
  'people; they did not acquire them (docs/46 §3).';

@Injectable()
export class PartnerService {
  constructor(
    private readonly db: TenantDb,
    private readonly prisma: PrismaService,
    private readonly invitations: InvitationsService,
  ) {}

  /* ── tenant side ───────────────────────────────────────────────────────── */

  async create(input: { code: string; name: string; contactEmail?: string }) {
    return this.db.tx(async (tx) => {
      const dup = await tx.partner.findFirst({ where: { code: input.code } });
      if (dup) {
        throw new ConflictException({
          code: ERROR_CODES.CONFLICT,
          message: 'A partner with that code already exists',
        });
      }
      return tx.partner.create({
        data: {
          tenantId: this.db.tenantId,
          code: input.code,
          name: input.name,
          contactEmail: input.contactEmail ?? null,
        },
      });
    });
  }

  async list() {
    return this.db.tx(async (tx) => {
      const partners = await tx.partner.findMany({ orderBy: { createdAt: 'desc' } });
      return Promise.all(
        partners.map(async (p) => ({
          ...p,
          referrals: await tx.partnerReferral.count({ where: { partnerId: p.id } }),
          users: await tx.partnerUser.count({ where: { partnerId: p.id, status: 'active' } }),
        })),
      );
    });
  }

  /** Grants a person portal access. They get a User to sign in with, never a Member. */
  async addUser(partnerId: string, email: string) {
    const normalised = email.toLowerCase().trim();
    return this.db.tx(async (tx) => {
      const partner = await tx.partner.findFirst({ where: { id: partnerId } });
      if (!partner) {
        throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Partner not found' });
      }
      const user = await this.prisma.owner.user.findUnique({
        where: { email: normalised },
        select: { id: true },
      });
      if (!user) {
        // Deliberately not creating one: a partner login is an account with a
        // password, and this platform does not set passwords on somebody's
        // behalf. The person registers, then the tenant grants access.
        throw new BadRequestException({
          code: ERROR_CODES.VALIDATION_FAILED,
          message: `No account exists for ${normalised}. They register first, then you grant access.`,
        });
      }
      const member = await tx.member.findFirst({
        where: { userId: user.id },
        select: { id: true },
      });
      if (member) {
        // A person cannot be both. Partner staff must not appear in member
        // counts or receive member communications (docs/46 §1), and a principal
        // with two identities has none.
        throw new BadRequestException({
          code: ERROR_CODES.VALIDATION_FAILED,
          message:
            'That person is already a member of this tenant, so they cannot be partner staff',
        });
      }
      const existing = await tx.partnerUser.findFirst({ where: { userId: user.id } });
      if (existing) {
        throw new ConflictException({
          code: ERROR_CODES.CONFLICT,
          message: 'That person already has partner access in this tenant',
        });
      }
      return tx.partnerUser.create({
        data: { tenantId: this.db.tenantId, partnerId, userId: user.id },
      });
    });
  }

  async removeUser(partnerUserId: string) {
    return this.db.tx(async (tx) => {
      const link = await tx.partnerUser.findFirst({ where: { id: partnerUserId } });
      if (!link) {
        throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Not found' });
      }
      return tx.partnerUser.update({ where: { id: link.id }, data: { status: 'revoked' } });
    });
  }

  /* ── partner side — every method scoped by the CALLER'S partner id ─────── */

  async profile(partnerId: string) {
    return this.db.tx(async (tx) => {
      const partner = await tx.partner.findFirst({
        where: { id: partnerId },
        select: { id: true, code: true, name: true, contactEmail: true, status: true },
      });
      if (!partner) {
        throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Partner not found' });
      }
      return partner;
    });
  }

  /**
   * How the partner is doing, in counts (docs/46 §3).
   *
   * No member identity leaves this method. The member ids are used to ask
   * "how many of these are active" and are never returned — and activity here
   * is the same non-health definition docs/28 §3 settled on, so a referral who
   * only logs habits is not reported as anything.
   */
  async performance(partnerId: string, windowDays = 30) {
    const from = new Date(Date.now() - windowDays * 86_400_000);
    return this.db.tx(async (tx) => {
      const rows = await tx.partnerReferral.findMany({
        where: { partnerId },
        select: { memberId: true, joinedAt: true },
      });
      // Invitations that nobody accepted are counted separately rather than
      // folded into "referred": a partner's headline number should be people
      // who arrived, not letters they sent.
      const referrals = rows.filter((r) => r.memberId !== null);
      const outstanding = rows.length - referrals.length;
      const memberIds = referrals.map((r) => r.memberId!);

      const active = memberIds.length > 0 ? await this.activeAmong(tx, memberIds, from) : 0;
      const byMonth = new Map<string, number>();
      for (const r of referrals) {
        if (!r.joinedAt) continue;
        const key = r.joinedAt.toISOString().slice(0, 7);
        byMonth.set(key, (byMonth.get(key) ?? 0) + 1);
      }

      return {
        referred: referrals.length,
        invitationsOutstanding: outstanding,
        activeInWindow: active,
        joinedByMonth: [...byMonth.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([month, count]) => ({ month, count })),
        window: { days: windowDays, from: from.toISOString() },
        note: PARTNER_NOTE,
      };
    });
  }

  /** Non-health activity only, the definition docs/28 §3 fixed for everybody. */
  private async activeAmong(tx: Tx, memberIds: string[], from: Date): Promise<number> {
    const [learners, goalSetters, posters, buyers] = await Promise.all([
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
      tx.order.findMany({
        where: { memberId: { in: memberIds }, placedAt: { gte: from } },
        select: { memberId: true },
        distinct: ['memberId'],
      }),
    ]);
    return new Set([
      ...learners.map((r) => r.memberId),
      ...goalSetters.map((r) => r.memberId),
      ...posters.map((r) => r.authorMemberId),
      ...buyers.map((r) => r.memberId),
    ]).size;
  }

  /** The partner invites a customer; attribution follows on acceptance. */
  async invite(partnerId: string, email: string, planId: string) {
    const partner = await this.profile(partnerId);
    if (partner.status !== 'active') {
      throw new BadRequestException({
        code: ERROR_CODES.VALIDATION_FAILED,
        message: 'This partner is not active',
      });
    }
    const invitation = await this.invitations.invite({ email, planId }, null);
    // Written now with no member: invited, not yet joined — the same
    // reserve-then-assign shape sponsored seats use. The member id arrives from
    // the outbox handler when the invitation is accepted, because an invitation
    // nobody took is not somebody a partner brought (docs/46 §2).
    await this.db.tx(async (tx) =>
      tx.partnerReferral.create({
        data: { tenantId: this.db.tenantId, partnerId, invitationId: invitation.id },
      }),
    );
    return { invitation, partnerId };
  }

  /**
   * Records the referral when a partner's invitation is accepted. Driven by the
   * outbox, so the tenant comes from the event: a handler runs on the relay's
   * clock, where there is no tenant in CLS to read (docs/45 §2 learned this).
   */
  async attribute(tenantId: string, invitationId: string, memberId: string): Promise<void> {
    await withTenant(this.prisma.app, tenantId, async (tx) => {
      const already = await tx.partnerReferral.findFirst({ where: { memberId } });
      if (already) return;
      // Fills in the row the invitation created. `updateMany` rather than
      // `update` so a second delivery of the same event changes nothing: the
      // row it would fill is no longer outstanding.
      await tx.partnerReferral.updateMany({
        where: { invitationId, memberId: null },
        data: { memberId, joinedAt: new Date() },
      });
    });
  }
}
