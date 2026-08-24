'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { api, ApiError, isEntitlementRequired, isForbidden } from '@/lib/api-client';
import {
  metricWalksAGraph,
  bonusTypeKey,
  isMoneyMetric,
  metricGraphKey,
  rankMetricKey,
  rankWindowKey,
  toEntryBasis,
  type CommissionEntry,
  type EarningsResponse,
} from '@/lib/types';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { formatDate, formatMoney } from '@/lib/format';

/**
 * The member's own approved commission entries (docs/26 §7).
 *
 * Only approved entries exist here — the API refuses to show a draft, and the
 * screen says so rather than leaving a member to wonder why a number they were
 * promised is missing.
 */
export default function EarningsPage() {
  const t = useTranslations('earnings');
  const tg = useTranslations('growth');
  const tc = useTranslations('common');
  const locale = useLocale();

  const [earnings, setEarnings] = useState<EarningsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  /** The plan does not include `growth.compensation` — a refusal, not a failure. */
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    api
      .get<EarningsResponse>('/compensation/me')
      .then((res) => {
        if (!cancelled) setEarnings(res);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Both arrive as 403. "Your plan does not include this" is checked
        // first, because it is the more specific of the two and the only one
        // the member can act on.
        if (isEntitlementRequired(err)) setUnavailable(true);
        else if (isForbidden(err)) setForbidden(true);
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

  const metricLabel = (metric: string): string => {
    const key = rankMetricKey(metric);
    return key ? tg(key) : metric;
  };

  const windowLabel = (window: string): string => {
    const key = rankWindowKey(window);
    return key ? tg(key) : window;
  };

  const graphLabel = (graph: string | undefined): string | null => {
    if (!graph) return null;
    const key = metricGraphKey(graph);
    return key ? tg(key) : graph;
  };

  const countFormat = (value: number): string =>
    new Intl.NumberFormat(locale === 'th' ? 'th-TH' : 'en-GB').format(value);

  /**
   * Money metrics are minor units in the entry's own currency and go through
   * the formatter, which divides by 100 exactly once. Counts are counts —
   * dividing one would turn 3 qualified legs into 0.03.
   */
  const metricValue = (metric: string, value: number, currency: string): string =>
    isMoneyMetric(metric) ? formatMoney(value, currency, locale) : countFormat(value);

  const bonusLabel = (bonusType: string): string => {
    const key = bonusTypeKey(bonusType);
    return key ? t(key) : t('bonusOther');
  };

  /** Shown beside the label only when this build has no wording for the type. */
  const bonusCode = (bonusType: string): string | null =>
    bonusTypeKey(bonusType) ? null : bonusType;

  const basisLines = (entry: CommissionEntry): string[] => {
    const basis = toEntryBasis(entry.basis);
    const lines: string[] = [];
    if (basis.payout?.kind === 'fixed') {
      lines.push(
        t('payoutFixed', { amount: formatMoney(basis.payout.amountMinor, entry.currency, locale) }),
      );
    } else if (basis.payout?.kind === 'percent') {
      lines.push(
        t('payoutPercent', {
          percent: countFormat(basis.payout.percent),
          metric: metricLabel(basis.payout.basis),
          basis: metricValue(basis.payout.basis, basis.basisValue ?? 0, entry.currency),
        }),
      );
      if (basis.capApplied && basis.payout.capMinor) {
        lines.push(
          t('payoutCapped', {
            cap: formatMoney(basis.payout.capMinor, entry.currency, locale),
            uncapped: formatMoney(basis.uncappedMinor ?? 0, entry.currency, locale),
          }),
        );
      }
    }
    return lines;
  };

  /** The response names the currency its total is in; without one there is nothing to show. */
  const totalCurrency = earnings?.currency ?? null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-bold text-slate-900">{t('title')}</h1>
        <p className="text-sm text-slate-500">{t('intro')}</p>
      </div>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      {loading ? (
        <p className="py-10 text-center text-sm text-slate-500">{tc('loading')}</p>
      ) : unavailable ? (
        <Card>
          <p className="text-sm text-slate-600">{t('unavailable')}</p>
        </Card>
      ) : forbidden ? (
        <Card>
          <p className="text-sm text-slate-600">{t('forbidden')}</p>
        </Card>
      ) : (
        <>
          {totalCurrency ? (
            <Card title={t('total')}>
              <span className="break-words text-2xl font-bold text-brand-700">
                {formatMoney(earnings?.totalMinor ?? 0, totalCurrency, locale)}
              </span>
            </Card>
          ) : null}

          <Card>
            {!earnings || earnings.entries.length === 0 ? (
              <p className="text-sm text-slate-500">{t('empty')}</p>
            ) : (
              <ul className="flex flex-col divide-y divide-slate-100">
                {earnings.entries.map((entry) => {
                  const basis = toEntryBasis(entry.basis);
                  const code = bonusCode(entry.bonusType);
                  const payoutLines = basisLines(entry);
                  return (
                    <li key={entry.id} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                        <span className="flex min-w-0 flex-col">
                          <span className="min-w-0 break-words text-sm font-medium text-slate-800">
                            {entry.rule?.name ?? bonusLabel(entry.bonusType)}
                          </span>
                          {entry.run ? (
                            <span className="text-xs text-slate-500">
                              {t('period', {
                                start: formatDate(entry.run.periodStart, locale),
                                end: formatDate(entry.run.periodEnd, locale),
                              })}
                            </span>
                          ) : null}
                        </span>
                        <span className="text-sm font-bold text-slate-900">
                          {formatMoney(entry.amountMinor, entry.currency, locale)}
                        </span>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone="teal">{bonusLabel(entry.bonusType)}</Badge>
                        {code ? (
                          <span className="min-w-0 break-all text-xs text-slate-500">{code}</span>
                        ) : null}
                      </div>

                      {/* The entry stores the numbers it was computed from, so
                          it can be explained without re-running anything —
                          folded away, never hidden. */}
                      {basis.conditions.length > 0 || payoutLines.length > 0 ? (
                        <details className="rounded-lg bg-slate-50 px-3 py-2">
                          <summary className="cursor-pointer text-xs font-medium text-slate-700">
                            {t('basisTitle')}
                          </summary>
                          <div className="mt-2 flex flex-col gap-2">
                            {basis.conditions.map((condition, index) => {
                              const graph = metricWalksAGraph(condition.metric)
                                ? graphLabel(condition.graph)
                                : null;
                              return (
                                <div
                                  key={`${condition.metric}-${condition.window}-${index}`}
                                  className="flex min-w-0 flex-col"
                                >
                                  <span className="min-w-0 break-words text-xs text-slate-800">
                                    {t('basisRow', {
                                      metric: metricLabel(condition.metric),
                                      value: metricValue(
                                        condition.metric,
                                        condition.value,
                                        entry.currency,
                                      ),
                                    })}
                                  </span>
                                  <span className="min-w-0 break-words text-xs text-slate-500">
                                    {t('basisThreshold', {
                                      threshold: metricValue(
                                        condition.metric,
                                        condition.threshold,
                                        entry.currency,
                                      ),
                                    })}{' '}
                                    · {windowLabel(condition.window)}
                                    {graph ? ` · ${graph}` : ''}
                                  </span>
                                </div>
                              );
                            })}
                            {payoutLines.map((line) => (
                              <span
                                key={line}
                                className="min-w-0 break-words text-xs text-slate-800"
                              >
                                {line}
                              </span>
                            ))}
                            {basis.asOf ? (
                              <span className="text-xs text-slate-500">
                                {t('computedAt', { date: formatDate(basis.asOf, locale) })}
                              </span>
                            ) : null}
                          </div>
                        </details>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </>
      )}

      {/* Said outright, and outside every gate: what is not here is not missing,
          it is not approved yet. A member who is not told this will assume the
          worse of the two explanations. */}
      <p className="text-xs text-slate-500">{t('draftNote')}</p>
    </div>
  );
}
