import { ConflictException } from '@nestjs/common';
import { ERROR_CODES } from '@aviora/shared';
import type { Tx } from '@aviora/db';

/** Only the seed tenant makes this the fallback — nothing in code depends on it. */
export const DEFAULT_CURRENCY = 'THB';

export const OFFERING_KINDS = ['one_time', 'subscription'] as const;
export const COUPON_KINDS = ['percent', 'fixed'] as const;

export interface PricedOffering {
  id: string;
  priceMinor: number;
}

/** Resolves a price for the caller. */
export type PriceResolver = (offering: PricedOffering) => Promise<number>;

/**
 * The single price rule (docs/24 §1):
 *
 *   price(offering, member) = OfferingPlanPrice for the member's ACTIVE plan,
 *                            otherwise offering.priceMinor
 *
 * The plan is resolved once and closed over, so the catalogue, the cart and
 * subscription creation all charge from one definition and can never drift.
 * Nothing here looks at a plan's name or code.
 */
export async function priceResolver(tx: Tx, memberId: string | null): Promise<PriceResolver> {
  const membership = memberId
    ? await tx.membership.findFirst({
        where: { memberId, status: 'active' },
        orderBy: { startedAt: 'desc' },
        select: { planId: true },
      })
    : null;
  const planId = membership?.planId ?? null;

  return async (offering: PricedOffering) => {
    if (!planId) return offering.priceMinor;
    const planPrice = await tx.offeringPlanPrice.findFirst({
      where: { offeringId: offering.id, planId },
      select: { priceMinor: true },
    });
    return planPrice?.priceMinor ?? offering.priceMinor;
  };
}

/** Tenant setting `commerce.currency`, ISO-4217. */
export async function tenantCurrency(tx: Tx): Promise<string> {
  const setting = await tx.tenantSetting.findFirst({ where: { key: 'commerce.currency' } });
  const value = setting?.value;
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value) ? value : DEFAULT_CURRENCY;
}

export interface CouponRules {
  kind: string;
  value: number;
  currency: string | null;
  minSubtotalMinor: number | null;
  startsAt: Date | null;
  endsAt: Date | null;
  maxRedemptions: number | null;
  redeemedCount: number;
  status: string;
}

/**
 * Discount in minor units. Percent rounds with Math.round — integer arithmetic
 * end to end, so a discount can never introduce a fractional minor unit.
 */
export function discountMinorFor(
  coupon: { kind: string; value: number },
  subtotalMinor: number,
): number {
  const raw =
    coupon.kind === 'percent' ? Math.round((subtotalMinor * coupon.value) / 100) : coupon.value;
  return Math.max(0, Math.min(raw, subtotalMinor));
}

/** Window, redemption cap, minimum subtotal and currency, in that order. */
export function assertCouponUsable(
  coupon: CouponRules,
  subtotalMinor: number,
  currency: string,
  now = new Date(),
): void {
  const reject = (message: string): never => {
    throw new ConflictException({ code: ERROR_CODES.CONFLICT, message });
  };

  if (coupon.status !== 'active') reject('Coupon is not active');
  if (coupon.startsAt && coupon.startsAt > now) reject('Coupon is not valid yet');
  if (coupon.endsAt && coupon.endsAt < now) reject('Coupon has expired');
  if (coupon.maxRedemptions !== null && coupon.redeemedCount >= coupon.maxRedemptions) {
    reject('Coupon has reached its redemption limit');
  }
  if (coupon.minSubtotalMinor !== null && subtotalMinor < coupon.minSubtotalMinor) {
    reject('Cart subtotal is below the coupon minimum');
  }
  if (coupon.kind === 'fixed' && coupon.currency && coupon.currency !== currency) {
    reject('Coupon is issued in a different currency');
  }
}
