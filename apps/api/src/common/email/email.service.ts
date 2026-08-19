import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';

/**
 * Transactional email over SMTP (local dev: mailpit at :1025 → UI :8025).
 * Templates are deliberately minimal for Slice 1; th/en catalogs come with
 * the notification center story.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly transport = nodemailer.createTransport(
    process.env.AVIORA_SMTP_URL ?? 'smtp://localhost:1025',
  );
  private readonly from = process.env.AVIORA_EMAIL_FROM ?? 'AVIORA <no-reply@aviora.local>';

  async send(to: string, subject: string, html: string): Promise<void> {
    try {
      await this.transport.sendMail({ from: this.from, to, subject, html });
    } catch (e) {
      this.logger.error(`email to ${to} failed`, e as Error);
      throw e; // let the outbox retry
    }
  }

  inviteEmail(params: { tenantName: string; inviteUrl: string }): {
    subject: string;
    html: string;
  } {
    return {
      subject: `You're invited to join ${params.tenantName} on AVIORA`,
      html: `<p>You have been invited to join <b>${escapeHtml(params.tenantName)}</b>.</p>
<p><a href="${params.inviteUrl}">Accept your invitation</a> (link expires in 7 days).</p>
<p>— AVIORA</p>`,
    };
  }

  welcomeEmail(params: { tenantName: string; displayName: string }): {
    subject: string;
    html: string;
  } {
    return {
      subject: `Welcome to ${params.tenantName}`,
      html: `<p>Hi ${escapeHtml(params.displayName)},</p>
<p>Your membership at <b>${escapeHtml(params.tenantName)}</b> is now active. Welcome aboard!</p>
<p>— AVIORA</p>`,
    };
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
