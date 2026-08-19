import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EVENTS } from '@aviora/shared';
import { EventBus } from '../../common/events/event-bus';
import { EmailService } from '../../common/email/email.service';
import { PrismaService } from '../../common/db/prisma.service';
import { NotificationsService } from './notifications.service';

interface InvitedPayload {
  email: string;
  invitationId: string;
  token: string;
}

interface ActivatedPayload {
  memberId: string;
  email: string;
  displayName: string;
}

/** Email consumers for outbox-relayed events (docs/11 §6, Slice-1 set). */
@Injectable()
export class NotificationHandlers implements OnModuleInit {
  private readonly logger = new Logger(NotificationHandlers.name);

  constructor(
    private readonly bus: EventBus,
    private readonly email: EmailService,
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit() {
    this.bus.on(EVENTS.MemberInvited, 'email.invite', async (event) => {
      const p = event.payload as InvitedPayload;
      const tenantName = await this.tenantName(event.tenantId);
      const base = process.env.AVIORA_WEB_URL ?? 'http://localhost:3020';
      const { subject, html } = this.email.inviteEmail({
        tenantName,
        inviteUrl: `${base}/invite/${p.token}`,
      });
      await this.email.send(p.email, subject, html);
      this.logger.log(`invite email sent to ${p.email}`);
    });

    this.bus.on(EVENTS.MembershipActivated, 'email.welcome', async (event) => {
      const p = event.payload as ActivatedPayload;
      const tenantName = await this.tenantName(event.tenantId);
      const { subject, html } = this.email.welcomeEmail({
        tenantName,
        displayName: p.displayName,
      });
      await this.email.send(p.email, subject, html);
      this.logger.log(`welcome email sent to ${p.email}`);
    });

    // ── in-app notifications (Sprint 3 notification center) ──
    this.bus.on(EVENTS.MembershipActivated, 'notify.welcome', async (event) => {
      const p = event.payload as ActivatedPayload;
      if (!event.tenantId) return;
      await this.notifications.deliver({
        tenantId: event.tenantId,
        memberId: p.memberId,
        type: 'membership.activated',
        title: `Welcome to ${await this.tenantName(event.tenantId)}`,
        body: 'Your membership is active. Start with your goals and first course.',
        link: '/dashboard',
      });
    });

    this.bus.on(EVENTS.MemberJoinedTeam, 'notify.team-joined', async (event) => {
      const p = event.payload as { memberId: string };
      if (!event.tenantId) return;
      await this.notifications.deliver({
        tenantId: event.tenantId,
        memberId: p.memberId,
        type: 'team.joined',
        title: 'You joined a team',
        link: '/teams',
      });
    });

    this.bus.on(EVENTS.LeaderAssigned, 'notify.leader-assigned', async (event) => {
      const p = event.payload as { memberId: string; leadershipRole: string };
      if (!event.tenantId) return;
      await this.notifications.deliver({
        tenantId: event.tenantId,
        memberId: p.memberId,
        type: 'team.leader.assigned',
        title: 'You were assigned as a team leader',
        body: p.leadershipRole,
        link: '/leader',
      });
    });

    this.bus.on(EVENTS.CustomerConverted, 'notify.customer-converted', async (event) => {
      const p = event.payload as { ownerMemberId: string; name: string };
      if (!event.tenantId) return;
      await this.notifications.deliver({
        tenantId: event.tenantId,
        memberId: p.ownerMemberId,
        type: 'crm.customer.converted',
        title: `${p.name} became a customer`,
        link: '/crm',
      });
    });
  }

  private async tenantName(tenantId: string | null): Promise<string> {
    if (!tenantId) return 'AVIORA';
    const t = await this.prisma.owner.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true },
    });
    return t?.name ?? 'AVIORA';
  }
}
