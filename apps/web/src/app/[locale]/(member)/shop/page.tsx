'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { api, ApiError, isEntitlementRequired, isForbidden } from '@/lib/api-client';
import {
  intervalUnitKey,
  type Cart,
  type CartResponse,
  type CheckoutResponse,
  type Offering,
  type OfferingsResponse,
} from '@/lib/types';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { formatMoney } from '@/lib/format';

export default function ShopPage() {
  const t = useTranslations('shop');
  const tc = useTranslations('common');
  const locale = useLocale();

  const [offerings, setOfferings] = useState<Offering[]>([]);
  const [cart, setCart] = useState<Cart | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  /** The plan does not include `commerce.enabled`: browsing is fine, buying is not. */
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [couponCode, setCouponCode] = useState('');
  const [couponError, setCouponError] = useState<string | null>(null);
  const [couponBusy, setCouponBusy] = useState(false);
  const [checkingOut, setCheckingOut] = useState(false);
  const [placedNumber, setPlacedNumber] = useState<string | null>(null);

  const loadCart = useCallback(async () => {
    const res = await api.get<CartResponse>('/cart');
    setCart(res.cart);
  }, []);

  useEffect(() => {
    let cancelled = false;

    // The cart is entitlement-gated while the catalogue is not, so the two reads
    // fail independently and are handled independently (docs/24 §2).
    api
      .get<CartResponse>('/cart')
      .then((res) => {
        if (!cancelled) setCart(res.cart);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (isEntitlementRequired(err) || isForbidden(err)) setUnavailable(true);
      });

    api
      .get<OfferingsResponse>('/offerings')
      .then((res) => {
        if (!cancelled) setOfferings(res.offerings);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (isForbidden(err)) setForbidden(true);
        else setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Every cart write shares one failure shape, including losing the entitlement mid-session. */
  const runCartAction = async (id: string, action: () => Promise<void>) => {
    setError(null);
    setPlacedNumber(null);
    setBusyId(id);
    try {
      await action();
    } catch (err: unknown) {
      if (isEntitlementRequired(err) || isForbidden(err)) setUnavailable(true);
      else setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setBusyId(null);
    }
  };

  const setQuantity = (offeringId: string, quantity: number) =>
    runCartAction(offeringId, async () => {
      // The API treats a re-add as "set the quantity to this", so one route
      // covers adding and adjusting.
      const res = await api.post<CartResponse>('/cart/items', { offeringId, quantity });
      setCart(res.cart);
    });

  const removeItem = (itemId: string) =>
    runCartAction(itemId, async () => {
      const res = await api.delete<CartResponse>(`/cart/items/${itemId}`);
      setCart(res.cart);
    });

  const applyCoupon = async () => {
    const code = couponCode.trim();
    if (!code) return;
    setCouponError(null);
    setCouponBusy(true);
    try {
      const res = await api.post<CartResponse>('/cart/coupon', { code });
      setCart(res.cart);
      setCouponCode('');
    } catch (err: unknown) {
      if (isEntitlementRequired(err) || isForbidden(err)) setUnavailable(true);
      else setCouponError(err instanceof ApiError ? err.message : t('couponInvalid'));
    } finally {
      setCouponBusy(false);
    }
  };

  const removeCoupon = async () => {
    setCouponError(null);
    setCouponBusy(true);
    try {
      const res = await api.delete<CartResponse>('/cart/coupon');
      setCart(res.cart);
    } catch (err: unknown) {
      if (isEntitlementRequired(err) || isForbidden(err)) setUnavailable(true);
      else setCouponError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setCouponBusy(false);
    }
  };

  const checkout = async () => {
    setError(null);
    setCouponError(null);
    setCheckingOut(true);
    try {
      const res = await api.post<CheckoutResponse>('/cart/checkout');
      setPlacedNumber(res.order.number);
      // Checkout closes the cart; the next GET opens a fresh empty one.
      await loadCart();
    } catch (err: unknown) {
      if (isEntitlementRequired(err) || isForbidden(err)) setUnavailable(true);
      else setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setCheckingOut(false);
    }
  };

  const intervalLabel = (unit: string | null, count: number | null): string | null => {
    if (!unit || !count) return null;
    const key = intervalUnitKey(unit);
    return t('recurring', { count, unit: key ? t(key) : unit });
  };

  const quantityInCart = (offeringId: string): number =>
    cart?.items.find((item) => item.offeringId === offeringId)?.quantity ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-bold text-slate-900">{t('title')}</h1>
        <p className="text-sm text-slate-500">{t('intro')}</p>
      </div>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      {forbidden ? (
        <Card>
          <p className="text-sm text-slate-600">{t('forbidden')}</p>
        </Card>
      ) : loading ? (
        <p className="py-10 text-center text-sm text-slate-500">{tc('loading')}</p>
      ) : offerings.length === 0 ? (
        <Card>
          <p className="text-sm text-slate-500">{t('empty')}</p>
        </Card>
      ) : (
        <ul className="flex flex-col gap-4">
          {offerings.map((offering) => {
            const inCart = quantityInCart(offering.id);
            const recurring = intervalLabel(offering.intervalUnit, offering.intervalCount);
            return (
              <li key={offering.id}>
                <Card
                  title={offering.name}
                  actions={inCart > 0 ? <Badge tone="teal">{t('added')}</Badge> : null}
                >
                  <div className="flex flex-col gap-3">
                    {offering.description ? (
                      <p className="text-sm text-slate-600">{offering.description}</p>
                    ) : null}

                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <span className="text-lg font-bold text-teal-700">
                        {formatMoney(offering.priceMinor, offering.currency, locale)}
                      </span>
                      {offering.priceMinor !== offering.listPriceMinor ? (
                        <>
                          <span className="text-sm text-slate-400 line-through">
                            {formatMoney(offering.listPriceMinor, offering.currency, locale)}
                          </span>
                          <span className="text-xs text-slate-500">{t('memberPrice')}</span>
                        </>
                      ) : null}
                      {recurring ? (
                        <span className="text-xs text-slate-500">{recurring}</span>
                      ) : null}
                    </div>

                    {unavailable ? (
                      <p className="text-sm text-slate-600">{t('unavailable')}</p>
                    ) : (
                      <div>
                        <Button
                          type="button"
                          variant={inCart > 0 ? 'secondary' : 'primary'}
                          disabled={busyId === offering.id}
                          onClick={() => void setQuantity(offering.id, inCart + 1)}
                        >
                          {busyId === offering.id ? tc('saving') : t('addToCart')}
                        </Button>
                      </div>
                    )}
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      {forbidden ? null : (
        <Card title={t('cartTitle')}>
          {unavailable ? (
            <p className="text-sm text-slate-600">{t('unavailable')}</p>
          ) : !cart ? (
            <p className="text-sm text-slate-500">{tc('loading')}</p>
          ) : (
            <div className="flex flex-col gap-4">
              {placedNumber ? (
                <p className="rounded-lg bg-teal-50 p-2 text-sm text-teal-800">
                  {t('checkoutDone', { number: placedNumber })}
                </p>
              ) : null}

              {cart.items.length === 0 ? (
                <p className="text-sm text-slate-500">{t('cartEmpty')}</p>
              ) : (
                <>
                  <ul className="flex flex-col divide-y divide-slate-100">
                    {cart.items.map((item) => (
                      <li key={item.id} className="flex flex-col gap-2 py-3">
                        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                          <span className="min-w-0 break-words text-sm font-medium text-slate-800">
                            {item.name}
                          </span>
                          <span className="text-sm font-semibold text-slate-900">
                            {formatMoney(item.lineTotalMinor, cart.currency, locale)}
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                          <span className="inline-flex items-center gap-2">
                            <span className="text-xs text-slate-500">{t('quantity')}</span>
                            <button
                              type="button"
                              aria-label={t('decrease')}
                              disabled={busyId === item.offeringId || item.quantity <= 1}
                              onClick={() =>
                                void setQuantity(item.offeringId, Math.max(1, item.quantity - 1))
                              }
                              className="h-8 w-8 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-100 disabled:opacity-40"
                            >
                              −
                            </button>
                            <span className="min-w-[1.5rem] text-center text-sm text-slate-800">
                              {item.quantity}
                            </span>
                            <button
                              type="button"
                              aria-label={t('increase')}
                              disabled={busyId === item.offeringId}
                              onClick={() => void setQuantity(item.offeringId, item.quantity + 1)}
                              className="h-8 w-8 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-100 disabled:opacity-40"
                            >
                              +
                            </button>
                          </span>
                          <button
                            type="button"
                            disabled={busyId === item.id}
                            onClick={() => void removeItem(item.id)}
                            className="text-sm font-medium text-slate-500 hover:underline disabled:opacity-50"
                          >
                            {t('remove')}
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>

                  <div className="flex flex-col gap-2">
                    {cart.coupon ? (
                      <div className="flex flex-wrap items-center gap-3">
                        <Badge tone="teal">{cart.coupon.code}</Badge>
                        <button
                          type="button"
                          disabled={couponBusy}
                          onClick={() => void removeCoupon()}
                          className="text-sm font-medium text-slate-500 hover:underline disabled:opacity-50"
                        >
                          {t('removeCoupon')}
                        </button>
                      </div>
                    ) : (
                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          type="text"
                          value={couponCode}
                          maxLength={40}
                          placeholder={t('couponPlaceholder')}
                          aria-label={t('couponPlaceholder')}
                          onChange={(e) => setCouponCode(e.target.value)}
                          className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-teal-600"
                        />
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={couponBusy || couponCode.trim().length === 0}
                          onClick={() => void applyCoupon()}
                        >
                          {couponBusy ? tc('saving') : t('applyCoupon')}
                        </Button>
                      </div>
                    )}
                    {couponError ? <p className="text-sm text-red-600">{couponError}</p> : null}
                  </div>

                  <dl className="flex flex-col gap-1 border-t border-slate-100 pt-3 text-sm">
                    <div className="flex flex-wrap justify-between gap-x-3">
                      <dt className="text-slate-500">{t('subtotal')}</dt>
                      <dd className="text-slate-800">
                        {formatMoney(cart.subtotalMinor, cart.currency, locale)}
                      </dd>
                    </div>
                    {cart.discountMinor > 0 ? (
                      <div className="flex flex-wrap justify-between gap-x-3">
                        <dt className="text-slate-500">{t('discount')}</dt>
                        <dd className="text-teal-700">
                          −{formatMoney(cart.discountMinor, cart.currency, locale)}
                        </dd>
                      </div>
                    ) : null}
                    <div className="flex flex-wrap justify-between gap-x-3">
                      <dt className="font-semibold text-slate-700">{t('total')}</dt>
                      <dd className="font-bold text-slate-900">
                        {formatMoney(cart.totalMinor, cart.currency, locale)}
                      </dd>
                    </div>
                  </dl>

                  <div className="flex flex-col gap-2">
                    <Button type="button" disabled={checkingOut} onClick={() => void checkout()}>
                      {checkingOut ? tc('saving') : t('checkout')}
                    </Button>
                    <p className="text-xs text-slate-500">{t('priceNote')}</p>
                  </div>
                </>
              )}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
