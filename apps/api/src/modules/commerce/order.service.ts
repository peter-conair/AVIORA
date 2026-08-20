import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ERROR_CODES, EVENTS, PERMISSIONS } from '@aviora/shared';
import { appendEvent, type Tx } from '@aviora/db';
import { TenantDb } from '../../common/db/tenant-db.service';
import { AuditService } from '../../common/audit/audit.service';
import type { TeamActor } from '../team/team-scope.service';
import { CommerceScopeService } from './commerce-scope.service';
import { taxOnOrder } from './tax';

export interface RecordPaymentInput {
  provider: string;
  amountMinor: number;
  providerRef?: string;
}

/**
 * Orders are the immutable record of a purchase (docs/24 §3). Payments are
 * recorded, never captured: `provider` is the seam a PSP adapter slots into
 * without any of this changing.
 */
@Injectable()
export class OrderService {
  constructor(
    private readonly db: TenantDb,
    private readonly scope: CommerceScopeService,
    private readonly audit: AuditService,
  ) {}

  list(actor: TeamActor) {
    return this.db.tx(async (tx) => {
      const members = await this.scope.memberIds(tx, actor, PERMISSIONS.COMMERCE_ORDER_VIEW);
      return tx.order.findMany({
        where: this.scope.whereMember(members),
        orderBy: { placedAt: 'desc' },
        take: 100,
        include: { items: { orderBy: { id: 'asc' } } },
      });
    });
  }

  get(id: string, actor: TeamActor) {
    return this.db.tx(async (tx) => {
      const order = await tx.order.findFirst({
        where: { id },
        include: {
          items: { orderBy: { id: 'asc' } },
          payments: { orderBy: { createdAt: 'asc' } },
        },
      });
      const members = await this.scope.memberIds(tx, actor, PERMISSIONS.COMMERCE_ORDER_VIEW);
      // Another member's order is not forbidden, it is invisible: 403 would
      // confirm the order exists.
      if (!order || !this.scope.canAccess(members, order.memberId)) {
        throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Order not found' });
      }
      // Read back from the order, never recomputed (docs/29 §4).
      return { ...order, tax: taxOnOrder(order) };
    });
  }

  /** A recorded payment that settles the balance completes the order. */
  async recordPayment(
    id: string,
    actor: TeamActor,
    input: RecordPaymentInput,
    actorUserId: string,
  ) {
    const result = await this.db.tx(async (tx) => {
      const order = await this.forUpdate(tx, id, actor);
      if (order.status !== 'pending') {
        throw new ConflictException({
          code: ERROR_CODES.CONFLICT,
          message: `An order that is ${order.status} cannot take a payment`,
        });
      }
      const payment = await tx.payment.create({
        data: {
          tenantId: this.db.tenantId,
          orderId: order.id,
          provider: input.provider,
          providerRef: input.providerRef,
          amountMinor: input.amountMinor,
          currency: order.currency,
          status: 'succeeded',
          settledAt: new Date(),
        },
      });
      const succeeded = await tx.payment.aggregate({
        where: { orderId: order.id, status: 'succeeded' },
        _sum: { amountMinor: true },
      });
      const paidMinor = succeeded._sum.amountMinor ?? 0;
      if (paidMinor < order.totalMinor) return { payment, order, paidMinor };

      const paid = await tx.order.update({
        where: { id: order.id },
        data: { status: 'paid', paidAt: new Date() },
      });
      await appendEvent(tx, {
        eventName: EVENTS.OrderCompleted,
        tenantId: this.db.tenantId,
        aggregateType: 'order',
        aggregateId: order.id,
        actorUserId,
        payload: {
          memberId: order.memberId,
          number: order.number,
          currency: order.currency,
          totalMinor: order.totalMinor,
        },
      });
      return { payment, order: paid, paidMinor };
    });

    await this.audit.record({
      action: 'commerce.order.payment',
      entityType: 'order',
      entityId: result.order.id,
      after: {
        provider: result.payment.provider,
        amountMinor: result.payment.amountMinor,
        status: result.order.status,
      },
    });
    return result;
  }

  async cancel(id: string, actor: TeamActor) {
    const order = await this.db.tx(async (tx) => {
      const existing = await this.forUpdate(tx, id, actor);
      if (existing.status !== 'pending') {
        throw new ConflictException({
          code: ERROR_CODES.CONFLICT,
          message: `An order that is ${existing.status} cannot be cancelled`,
        });
      }
      return tx.order.update({
        where: { id: existing.id },
        data: { status: 'cancelled', cancelledAt: new Date() },
      });
    });
    await this.audit.record({
      action: 'commerce.order.cancel',
      entityType: 'order',
      entityId: order.id,
      after: { status: order.status },
    });
    return order;
  }

  private async forUpdate(tx: Tx, id: string, actor: TeamActor) {
    const order = await tx.order.findFirst({ where: { id } });
    const members = await this.scope.memberIds(tx, actor, PERMISSIONS.COMMERCE_ORDER_MANAGE);
    if (!order || !this.scope.canAccess(members, order.memberId)) {
      throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Order not found' });
    }
    return order;
  }
}
