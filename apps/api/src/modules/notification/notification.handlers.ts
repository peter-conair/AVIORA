import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EVENTS } from '@aviora/shared';
import { EventBus } from '../../common/events/event-bus';
import { EmailService } from '../../common/email/email.service';
import { PrismaService } from '../../common/db/prisma.service';

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
  ) {}

  onModuleInit() {
    this.bus.on(EVENTS.MemberInvited, async (event) => {
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

    this.bus.on(EVENTS.MembershipActivated, async (event) => {
      const p = event.payload as ActivatedPayload;
      const tenantName = await this.tenantName(event.tenantId);
      const { subject, html } = this.email.welcomeEmail({
        tenantName,
        displayName: p.displayName,
      });
      await this.email.send(p.email, subject, html);
      this.logger.log(`welcome email sent to ${p.email}`);
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
