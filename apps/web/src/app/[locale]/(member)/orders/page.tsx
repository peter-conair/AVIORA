'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { api, ApiError, isForbidden } from '@/lib/api-client';
import {
  intervalUnitKey,
  orderStatusKey,
  type Order,
  type OrdersResponse,
  type Subscription,
  type SubscriptionResponse,
  type SubscriptionsResponse,
} from '@/lib/types';
import { Badge, statusTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { formatDate, formatMoney } from '@/lib/format';

type SubscriptionAction = 'pause' | 'resume' | 'skip' | 'cancel';

export default function OrdersPage() {
  const t = useTranslations('orders');
  const ts = useTranslations('shop');
  const tc = useTranslations('common');
  const locale = useLocale();

  const [orders, setOrders] = useState<Order[] | null>(null);
  const [subscriptions, setSubscriptions] = useState<Subscription[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [subsForbidden, setSubsForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const loadSubscriptions = useCallback(async () => {
    const res = await api.get<SubscriptionsResponse>('/subscriptions');
    setSubscriptions(res.subscriptions);
  }, []);

  useEffect(() => {
    let cancelled = false;

    // Orders and subscriptions are separate permissions, so one being out of
    // reach must not blank the other.
    loadSubscriptions().catch((err: unknown) => {
      if (cancelled) return;
      if (isForbidden(err)) setSubsForbidden(true);
      else setSubscriptions([]);
    });

    api
      .get<OrdersResponse>('/orders')
      .then((res) => {
        if (!cancelled) setOrders(res.orders);
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

  const handleAction = async (subscription: Subscription, action: SubscriptionAction) => {
    // Cancelling is terminal (docs/24 §3) — it gets an explicit confirmation.
    if (action === 'cancel' && !window.confirm(t('cancelConfirm'))) return;
    setError(null);
    setBusyId(subscription.id);
    try {
      const res = await api.post<SubscriptionResponse>(
        `/subscriptions/${subscription.id}/${action}`,
      );
      setSubscriptions((current) =>
        (current ?? []).map((s) =>
          s.id === res.subscription.id ? { ...s, ...res.subscription } : s,
        ),
      );
      // A skip records a run and can produce an order; a cancel changes nothing
      // about history. Re-reading orders keeps the two panels consistent.
      if (action === 'skip') {
        const fresh = await api.get<OrdersResponse>('/orders');
        setOrders(fresh.orders);
      }
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setBusyId(null);
    }
  };

  const orderStatusLabel = (status: string): string => {
    const key = orderStatusKey(status);
    return key ? t(key) : status;
  };

  const intervalLabel = (unit: string, count: number): string => {
    const key = intervalUnitKey(unit);
    return ts('recurring', { count, unit: key ? ts(key) : unit });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-bold text-slate-900">{t('title')}</h1>
        <p className="text-sm text-slate-500">{t('intro')}</p>
      </div>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      <Card title={t('ordersTitle')}>
        {forbidden ? (
          <p className="text-sm text-slate-600">{ts('forbidden')}</p>
        ) : loading || orders === null ? (
          <p className="text-sm text-slate-500">{tc('loading')}</p>
        ) : orders.length === 0 ? (
          <p className="text-sm text-slate-500">{t('ordersEmpty')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-slate-100">
            {orders.map((order) => (
              <li key={order.id} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <span className="min-w-0 break-all text-sm font-semibold text-slate-900">
                    {order.number}
                  </span>
                  <Badge tone={statusTone(order.status)}>{orderStatusLabel(order.status)}</Badge>
                </div>

                <p className="text-xs text-slate-500">
                  {t('placedOn', { date: formatDate(order.placedAt, locale) })}
                </p>

                {order.items && order.items.length > 0 ? (
                  <ul className="flex flex-col gap-0.5">
                    {order.items.map((item) => (
                      <li
                        key={item.id}
                        className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs text-slate-600"
                      >
                        <span className="min-w-0 break-words">
                          {item.name} × {item.quantity}
                        </span>
                        <span>{formatMoney(item.lineTotalMinor, order.currency, locale)}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}

                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  {order.discountMinor > 0 ? (
                    <span className="text-xs text-teal-700">
                      {ts('discount')} −{formatMoney(order.discountMinor, order.currency, locale)}
                    </span>
                  ) : (
                    <span />
                  )}
                  <span className="text-sm font-bold text-slate-900">
                    {formatMoney(order.totalMinor, order.currency, locale)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={t('subscriptionsTitle')}>
        <p className="mb-3 text-xs text-slate-500">{t('pauseNote')}</p>
        {subsForbidden ? (
          <p className="text-sm text-slate-600">{ts('forbidden')}</p>
        ) : subscriptions === null ? (
          <p className="text-sm text-slate-500">{tc('loading')}</p>
        ) : subscriptions.length === 0 ? (
          <p className="text-sm text-slate-500">{t('subscriptionsEmpty')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-slate-100">
            {subscriptions.map((subscription) => {
              const busy = busyId === subscription.id;
              const active = subscription.status === 'active';
              const paused = subscription.status === 'paused';
              const cancelled = subscription.status === 'cancelled';
              return (
                <li key={subscription.id} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                    <span className="min-w-0 break-words text-sm font-medium text-slate-800">
                      {subscription.offering?.name ?? subscription.offeringId}
                    </span>
                    <Badge tone={statusTone(subscription.status)}>
                      {paused ? t('paused') : cancelled ? t('cancelled') : t('active')}
                    </Badge>
                  </div>

                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-slate-500">
                    <span className="text-sm font-semibold text-slate-900">
                      {formatMoney(subscription.priceMinor, subscription.currency, locale)}
                    </span>
                    <span>
                      {intervalLabel(subscription.intervalUnit, subscription.intervalCount)}
                    </span>
                    <span>
                      {ts('quantity')} {subscription.quantity}
                    </span>
                  </div>

                  {cancelled ? null : (
                    <p className="text-xs text-slate-500">
                      {t('nextRun', { date: formatDate(subscription.nextRunOn, locale) })}
                    </p>
                  )}

                  {cancelled ? null : (
                    <div className="flex flex-wrap items-center gap-2">
                      {active ? (
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={busy}
                          onClick={() => void handleAction(subscription, 'pause')}
                        >
                          {t('pause')}
                        </Button>
                      ) : null}
                      {paused ? (
                        <Button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleAction(subscription, 'resume')}
                        >
                          {t('resume')}
                        </Button>
                      ) : null}
                      {active ? (
                        <Button
                          type="button"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => void handleAction(subscription, 'skip')}
                        >
                          {t('skip')}
                        </Button>
                      ) : null}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleAction(subscription, 'cancel')}
                        className="text-sm font-medium text-red-700 hover:underline disabled:opacity-50"
                      >
                        {busy ? tc('saving') : t('cancel')}
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
