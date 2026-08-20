import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ERROR_CODES, EVENTS } from '@aviora/shared';
import { appendEvent, type Tx } from '@aviora/db';
import { TenantDb } from '../../common/db/tenant-db.service';
import { AuditService } from '../../common/audit/audit.service';
import { addInterval, todayUtc, withOrderNumber } from './billing';
import { assertCouponUsable, discountMinorFor, priceResolver, tenantCurrency } from './pricing';

interface CartRow {
  id: string;
  status: string;
  couponId: string | null;
}

/**
 * One open cart per member (docs/24 §1). Item prices are snapshotted, so a
 * catalogue edit cannot silently change what the member was looking at, and
 * checkout is the moment the snapshot becomes an immutable order.
 */
@Injectable()
export class CartService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
  ) {}

  view(memberId: string | null) {
    const me = requireMember(memberId);
    return this.db.tx(async (tx) => this.snapshot(tx, await this.openCart(tx, me)));
  }

  addItem(memberId: string | null, input: { offeringId: string; quantity: number }) {
    const me = requireMember(memberId);
    return this.db.tx(async (tx) => {
      const offering = await tx.offering.findFirst({
        where: { id: input.offeringId, status: 'active' },
      });
      if (!offering) {
        throw new NotFoundException({
          code: ERROR_CODES.NOT_FOUND,
          message: 'Offering not found',
        });
      }
      const cart = await this.openCart(tx, me);
      await this.assertSameCurrency(tx, cart.id, offering.currency);

      const priceOf = await priceResolver(tx, me);
      const unitPriceMinor = await priceOf(offering);
      const existing = await tx.cartItem.findFirst({
        where: { cartId: cart.id, offeringId: offering.id },
      });
      if (existing) {
        await tx.cartItem.update({
          where: { id: existing.id },
          data: { quantity: input.quantity, unitPriceMinor },
        });
      } else {
        await tx.cartItem.create({
          data: {
            tenantId: this.db.tenantId,
            cartId: cart.id,
            offeringId: offering.id,
            quantity: input.quantity,
            unitPriceMinor,
          },
        });
      }
      return this.snapshot(tx, cart);
    });
  }

  removeItem(memberId: string | null, itemId: string) {
    const me = requireMember(memberId);
    return this.db.tx(async (tx) => {
      const cart = await this.openCart(tx, me);
      const item = await tx.cartItem.findFirst({ where: { id: itemId, cartId: cart.id } });
      if (!item) {
        throw new NotFoundException({
          code: ERROR_CODES.NOT_FOUND,
          message: 'Cart item not found',
        });
      }
      await tx.cartItem.delete({ where: { id: item.id } });
      return this.snapshot(tx, cart);
    });
  }

  applyCoupon(memberId: string | null, code: string) {
    const me = requireMember(memberId);
    return this.db.tx(async (tx) => {
      const cart = await this.openCart(tx, me);
      const coupon = await tx.coupon.findFirst({ where: { code: code.toUpperCase() } });
      if (!coupon) {
        throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Coupon not found' });
      }
      const { subtotalMinor, currency } = await this.totals(tx, cart.id);
      assertCouponUsable(coupon, subtotalMinor, currency);
      const updated = await tx.cart.update({
        where: { id: cart.id },
        data: { couponId: coupon.id },
      });
      return this.snapshot(tx, updated);
    });
  }

  removeCoupon(memberId: string | null) {
    const me = requireMember(memberId);
    return this.db.tx(async (tx) => {
      const cart = await this.openCart(tx, me);
      const updated = await tx.cart.update({ where: { id: cart.id }, data: { couponId: null } });
      return this.snapshot(tx, updated);
    });
  }

  /**
   * Turns the cart into an order. Subscription offerings additionally create
   * the Subscription that will produce every later order, priced by the same
   * resolver that priced the cart line.
   */
  async checkout(memberId: string | null, actorUserId: string) {
    const me = requireMember(memberId);
    const result = await withOrderNumber((orderNumber) =>
      this.db.tx(async (tx) => {
        const cart = await this.openCart(tx, me);
        const items = await tx.cartItem.findMany({
          where: { cartId: cart.id },
          include: { offering: true },
          orderBy: { id: 'asc' },
        });
        if (items.length === 0) {
          throw new ConflictException({
            code: ERROR_CODES.CONFLICT,
            message: 'Cart is empty',
          });
        }

        const currency = items[0]!.offering.currency;
        const subtotalMinor = items.reduce((sum, i) => sum + i.unitPriceMinor * i.quantity, 0);
        const coupon = cart.couponId
          ? await tx.coupon.findFirst({ where: { id: cart.couponId } })
          : null;
        if (coupon) assertCouponUsable(coupon, subtotalMinor, currency);
        const discountMinor = coupon ? discountMinorFor(coupon, subtotalMinor) : 0;

        const order = await tx.order.create({
          data: {
            tenantId: this.db.tenantId,
            memberId: me,
            number: orderNumber,
            currency,
            subtotalMinor,
            discountMinor,
            totalMinor: subtotalMinor - discountMinor,
            couponId: coupon?.id,
          },
        });
        for (const item of items) {
          await tx.orderItem.create({
            data: {
              tenantId: this.db.tenantId,
              orderId: order.id,
              offeringId: item.offeringId,
              name: item.offering.name,
              quantity: item.quantity,
              unitPriceMinor: item.unitPriceMinor,
              lineTotalMinor: item.unitPriceMinor * item.quantity,
            },
          });
        }
        if (coupon) {
          await tx.coupon.update({
            where: { id: coupon.id },
            data: { redeemedCount: { increment: 1 } },
          });
        }
        await tx.cart.update({ where: { id: cart.id }, data: { status: 'ordered' } });

        const subscriptions = [];
        for (const item of items) {
          const { kind, intervalUnit, intervalCount } = item.offering;
          if (kind !== 'subscription' || !intervalUnit || !intervalCount) continue;
          const subscription = await tx.subscription.create({
            data: {
              tenantId: this.db.tenantId,
              memberId: me,
              offeringId: item.offeringId,
              intervalUnit,
              intervalCount,
              quantity: item.quantity,
              currency: item.offering.currency,
              priceMinor: item.unitPriceMinor,
              // this checkout is the first cycle, so the schedule starts one
              // interval out rather than billing again today
              nextRunOn: addInterval(todayUtc(), intervalUnit, intervalCount),
            },
          });
          await appendEvent(tx, {
            eventName: EVENTS.SubscriptionCreated,
            tenantId: this.db.tenantId,
            aggregateType: 'subscription',
            aggregateId: subscription.id,
            actorUserId,
            payload: {
              memberId: me,
              offeringId: item.offeringId,
              priceMinor: subscription.priceMinor,
              currency: subscription.currency,
              nextRunOn: subscription.nextRunOn.toISOString().slice(0, 10),
            },
          });
          subscriptions.push(subscription);
        }

        await appendEvent(tx, {
          eventName: EVENTS.OrderPlaced,
          tenantId: this.db.tenantId,
          aggregateType: 'order',
          aggregateId: order.id,
          actorUserId,
          payload: {
            memberId: me,
            number: order.number,
            currency: order.currency,
            totalMinor: order.totalMinor,
            itemCount: items.length,
          },
        });
        return { order, subscriptions };
      }),
    );

    await this.audit.record({
      action: 'commerce.order.place',
      entityType: 'order',
      entityId: result.order.id,
      after: {
        number: result.order.number,
        totalMinor: result.order.totalMinor,
        currency: result.order.currency,
      },
    });
    return result;
  }

  private async openCart(tx: Tx, memberId: string): Promise<CartRow> {
    const existing = await tx.cart.findFirst({ where: { memberId, status: 'open' } });
    return existing ?? (await tx.cart.create({ data: { tenantId: this.db.tenantId, memberId } }));
  }

  /** A cart bills in one currency — a tenant may sell in several, an order may not. */
  private async assertSameCurrency(tx: Tx, cartId: string, currency: string): Promise<void> {
    const other = await tx.cartItem.findFirst({
      where: { cartId, offering: { currency: { not: currency } } },
    });
    if (other) {
      throw new ConflictException({
        code: ERROR_CODES.CONFLICT,
        message: 'Cart already holds items priced in another currency',
      });
    }
  }

  private async totals(tx: Tx, cartId: string) {
    const items = await tx.cartItem.findMany({
      where: { cartId },
      include: { offering: { select: { currency: true } } },
      orderBy: { id: 'asc' },
    });
    const subtotalMinor = items.reduce((sum, i) => sum + i.unitPriceMinor * i.quantity, 0);
    const currency = items[0]?.offering.currency ?? (await tenantCurrency(tx));
    return { subtotalMinor, currency };
  }

  private async snapshot(tx: Tx, cart: CartRow) {
    const items = await tx.cartItem.findMany({
      where: { cartId: cart.id },
      include: { offering: { select: { name: true, kind: true, currency: true } } },
      orderBy: { id: 'asc' },
    });
    const subtotalMinor = items.reduce((sum, i) => sum + i.unitPriceMinor * i.quantity, 0);
    const currency = items[0]?.offering.currency ?? (await tenantCurrency(tx));
    const coupon = cart.couponId
      ? await tx.coupon.findFirst({ where: { id: cart.couponId } })
      : null;
    const discountMinor = coupon ? discountMinorFor(coupon, subtotalMinor) : 0;

    return {
      id: cart.id,
      status: cart.status,
      currency,
      items: items.map((i) => ({
        id: i.id,
        offeringId: i.offeringId,
        name: i.offering.name,
        kind: i.offering.kind,
        quantity: i.quantity,
        unitPriceMinor: i.unitPriceMinor,
        lineTotalMinor: i.unitPriceMinor * i.quantity,
      })),
      coupon: coupon ? { code: coupon.code, kind: coupon.kind, value: coupon.value } : null,
      subtotalMinor,
      discountMinor,
      totalMinor: subtotalMinor - discountMinor,
    };
  }
}

function requireMember(memberId: string | null): string {
  if (!memberId) {
    throw new ForbiddenException({
      code: ERROR_CODES.FORBIDDEN,
      message: 'You are not a member of this tenant',
    });
  }
  return memberId;
}
