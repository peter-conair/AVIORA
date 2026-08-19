import { Injectable, NotFoundException } from '@nestjs/common';
import { ERROR_CODES } from '@aviora/shared';
import { withTenant, type Tx } from '@aviora/db';
import { PrismaService } from '../../common/db/prisma.service';
import { TenantDb } from '../../common/db/tenant-db.service';

export interface CreateNotificationInput {
  tenantId: string;
  memberId: string;
  type: string;
  title: string;
  body?: string;
  link?: string;
}

@Injectable()
export class NotificationsService {
  constructor(
    private readonly db: TenantDb,
    private readonly prisma: PrismaService,
  ) {}

  /** In-app inbox for the current member. */
  list(memberId: string, onlyUnread = false) {
    return this.db.tx((tx) =>
      tx.notification.findMany({
        where: { memberId, ...(onlyUnread ? { readAt: null } : {}) },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    );
  }

  unreadCount(memberId: string) {
    return this.db.tx((tx) => tx.notification.count({ where: { memberId, readAt: null } }));
  }

  async markRead(id: string, memberId: string) {
    return this.db.tx(async (tx) => {
      const existing = await tx.notification.findFirst({ where: { id, memberId } });
      if (!existing) {
        throw new NotFoundException({
          code: ERROR_CODES.NOT_FOUND,
          message: 'Notification not found',
        });
      }
      return tx.notification.update({
        where: { id },
        data: { readAt: existing.readAt ?? new Date() },
      });
    });
  }

  markAllRead(memberId: string) {
    return this.db.tx((tx) =>
      tx.notification.updateMany({
        where: { memberId, readAt: null },
        data: { readAt: new Date() },
      }),
    );
  }

  preferences(memberId: string) {
    return this.db.tx((tx) => tx.notificationPreference.findMany({ where: { memberId } }));
  }

  async setPreference(memberId: string, type: string, inApp: boolean, email: boolean) {
    return this.db.tx((tx) =>
      tx.notificationPreference.upsert({
        where: { memberId_type: { memberId, type } },
        create: { tenantId: this.db.tenantId, memberId, type, inApp, email },
        update: { inApp, email },
      }),
    );
  }

  /** Whether a channel is enabled for this member+type (default: on). */
  async isEnabled(tx: Tx, memberId: string, type: string, channel: 'inApp' | 'email') {
    const pref = await tx.notificationPreference.findFirst({ where: { memberId, type } });
    if (!pref) return true;
    return channel === 'inApp' ? pref.inApp : pref.email;
  }

  /**
   * Delivery from event handlers (outside a request): the relay has no
   * TenantContext, so this opens its own tenant-scoped transaction.
   */
  async deliver(input: CreateNotificationInput): Promise<void> {
    await withTenant(this.prisma.app, input.tenantId, async (tx) => {
      if (!(await this.isEnabled(tx, input.memberId, input.type, 'inApp'))) return;
      await tx.notification.create({
        data: {
          tenantId: input.tenantId,
          memberId: input.memberId,
          type: input.type,
          title: input.title,
          body: input.body,
          link: input.link,
        },
      });
    });
  }
}
