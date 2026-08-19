import * as crypto from 'node:crypto';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { ERROR_CODES, EVENTS } from '@aviora/shared';
import { appendEvent } from '@aviora/db';
import { PrismaService } from '../../common/db/prisma.service';
import { TenantDb } from '../../common/db/tenant-db.service';
import { AuditService } from '../../common/audit/audit.service';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class InvitationsService {
  constructor(
    private readonly db: TenantDb,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async invite(input: { email: string; planId: string }, invitedByMemberId: string | null) {
    const email = input.email.toLowerCase().trim();
    const rawToken = crypto.randomBytes(32).toString('base64url');
    const invitation = await this.db.tx(async (tx) => {
      const plan = await tx.membershipPlan.findFirst({
        where: { id: input.planId, status: 'active' },
      });
      if (!plan) {
        throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Plan not found' });
      }
      const existingMember = await tx.member.findFirst({
        where: { user: { email }, status: 'active' },
        select: { id: true },
      });
      if (existingMember) {
        throw new BadRequestException({
          code: ERROR_CODES.CONFLICT,
          message: 'This email already belongs to an active member of this tenant',
        });
      }
      const inv = await tx.invitation.create({
        data: {
          tenantId: this.db.tenantId,
          email,
          planId: input.planId,
          invitedByMemberId,
          tokenHash: hash(rawToken),
          expiresAt: new Date(Date.now() + INVITE_TTL_MS),
        },
      });
      await appendEvent(tx, {
        eventName: EVENTS.MemberInvited,
        tenantId: this.db.tenantId,
        aggregateType: 'invitation',
        aggregateId: inv.id,
        actorUserId: null,
        payload: { email, invitationId: inv.id, token: rawToken },
      });
      return inv;
    });
    await this.audit.record({
      action: 'member.invite',
      entityType: 'invitation',
      entityId: invitation.id,
      after: { email, planId: input.planId },
    });
    return invitation;
  }

  list() {
    return this.db.tx((tx) =>
      tx.invitation.findMany({
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          email: true,
          planId: true,
          status: true,
          expiresAt: true,
          acceptedAt: true,
          createdAt: true,
        },
      }),
    );
  }

  /** Public: inspect an invitation by its raw token (the token IS the credential). */
  async inspect(rawToken: string) {
    const inv = await this.findPendingByToken(rawToken);
    const [tenant, plan] = await Promise.all([
      this.prisma.owner.tenant.findUniqueOrThrow({
        where: { id: inv.tenantId },
        select: { name: true, slug: true, defaultLanguage: true },
      }),
      inv.planId
        ? this.prisma.owner.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT set_config('app.tenant_id', ${inv.tenantId}, true)`;
            return tx.membershipPlan.findFirst({
              where: { id: inv.planId! },
              select: { name: true, trialDays: true },
            });
          })
        : Promise.resolve(null),
    ]);
    return {
      email: inv.email,
      tenantName: tenant.name,
      tenantSlug: tenant.slug,
      planName: plan?.name ?? null,
      trialDays: plan?.trialDays ?? 0,
      expiresAt: inv.expiresAt,
    };
  }

  /**
   * Public accept (spec §72 steps 9–11): find/verify user → member +
   * membership activation + MEMBER role — one transaction, events to outbox.
   */
  async accept(rawToken: string, input: { displayName: string; password: string }) {
    const inv = await this.findPendingByToken(rawToken);
    const email = inv.email;

    let user = await this.prisma.owner.user.findUnique({ where: { email } });
    if (user) {
      const ok = await argon2.verify(user.passwordHash, input.password).catch(() => false);
      if (!ok) {
        throw new UnauthorizedException({
          code: ERROR_CODES.UNAUTHENTICATED,
          message: 'An account with this email exists — the password does not match',
        });
      }
    }
    const passwordHash = user ? null : await argon2.hash(input.password, { type: argon2.argon2id });

    const result = await this.prisma.owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${inv.tenantId}, true)`;

      if (!user) {
        user = await tx.user.create({
          data: { email, passwordHash: passwordHash!, displayName: input.displayName },
        });
      }
      const existingTm = await tx.tenantMembership.findFirst({
        where: { tenantId: inv.tenantId, userId: user.id },
      });
      if (!existingTm) {
        await tx.tenantMembership.create({ data: { tenantId: inv.tenantId, userId: user.id } });
      }
      let member = await tx.member.findFirst({
        where: { tenantId: inv.tenantId, userId: user.id },
      });
      if (!member) {
        member = await tx.member.create({
          data: { tenantId: inv.tenantId, userId: user.id, displayName: input.displayName },
        });
      }
      const memberRole = await tx.role.findFirst({
        where: { tenantId: inv.tenantId, code: 'MEMBER' },
      });
      if (memberRole) {
        const hasRole = await tx.memberRole.findFirst({
          where: { memberId: member.id, roleId: memberRole.id },
        });
        if (!hasRole) {
          await tx.memberRole.create({
            data: { tenantId: inv.tenantId, memberId: member.id, roleId: memberRole.id },
          });
        }
      }

      let membership = null;
      if (inv.planId) {
        const plan = await tx.membershipPlan.findFirst({ where: { id: inv.planId } });
        if (plan) {
          const trialEndsAt =
            plan.trialDays > 0 ? new Date(Date.now() + plan.trialDays * 24 * 60 * 60 * 1000) : null;
          membership = await tx.membership.create({
            data: {
              tenantId: inv.tenantId,
              memberId: member.id,
              planId: plan.id,
              status: 'active',
              trialEndsAt,
            },
          });
        }
      }

      await tx.invitation.update({
        where: { id: inv.id },
        data: { status: 'accepted', acceptedAt: new Date() },
      });

      await appendEvent(tx, {
        eventName: EVENTS.MemberRegistered,
        tenantId: inv.tenantId,
        aggregateType: 'member',
        aggregateId: member.id,
        actorUserId: user.id,
        payload: { email, displayName: input.displayName, memberId: member.id },
      });
      if (membership) {
        await appendEvent(tx, {
          eventName: EVENTS.MembershipActivated,
          tenantId: inv.tenantId,
          aggregateType: 'membership',
          aggregateId: membership.id,
          actorUserId: user.id,
          payload: {
            memberId: member.id,
            planId: membership.planId,
            email,
            displayName: input.displayName,
            trialEndsAt: membership.trialEndsAt?.toISOString() ?? null,
          },
        });
      }
      return { userId: user.id, memberId: member.id, membershipId: membership?.id ?? null };
    });

    await this.audit.record({
      action: 'member.register',
      entityType: 'member',
      entityId: result.memberId,
      after: { email, via: 'invitation', invitationId: inv.id },
      tenantId: inv.tenantId,
    });
    return { ...result, tenantId: inv.tenantId };
  }

  private async findPendingByToken(rawToken: string) {
    const inv = await this.prisma.owner.invitation.findUnique({
      where: { tokenHash: hash(rawToken) },
    });
    if (!inv || inv.status !== 'pending' || inv.expiresAt < new Date()) {
      throw new NotFoundException({
        code: ERROR_CODES.NOT_FOUND,
        message: 'Invitation not found, already used, or expired',
      });
    }
    return inv;
  }
}

function hash(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}
