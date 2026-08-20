'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { api, ApiError, isForbidden } from '@/lib/api-client';
import {
  DEFAULT_ANALYTICS_WINDOW,
  type AnalyticsWindow,
  type PlatformAnalyticsResponse,
} from '@/lib/types';
import { Card } from '@/components/ui/Card';
import { DefinitionsDetails } from '@/components/analytics/DefinitionsDetails';
import { HealthExclusionNote } from '@/components/analytics/HealthExclusionNote';
import { Stat } from '@/components/analytics/Stat';
import { WindowPicker } from '@/components/analytics/WindowPicker';
import { formatCount, formatMoney, formatRatio, formatSigned } from '@/lib/format';

/**
 * Platform analytics (docs/28 §5, `GET /analytics/platform`).
 *
 * Cross-tenant, so the platform ROLE is the gate — the console this sits on
 * already checks it, and the API checks it again.
 *
 * AI, storage and infrastructure COST are named as not measured rather than
 * shown as 0 (docs/28 §6): nothing meters them yet, and a fabricated cost is
 * worse than a missing one. Token counts are real and are shown as counts.
 */
export function PlatformAnalyticsSection() {
  const t = useTranslations('analytics');
  const tp = useTranslations('analytics.platform');
  const tc = useTranslations('common');
  const locale = useLocale();

  const [windowKey, setWindowKey] = useState<AnalyticsWindow>(DEFAULT_ANALYTICS_WINDOW);
  const [data, setData] = useState<PlatformAnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get<PlatformAnalyticsResponse>(`/analytics/platform?window=${windowKey}`)
      .then((res) => {
        if (!cancelled) {
          setData(res);
          setError(null);
        }
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
  }, [windowKey]);

  if (forbidden) {
    return (
      <Card title={tp('title')}>
        <p className="text-sm text-slate-600">{tp('forbidden')}</p>
      </Card>
    );
  }

  const notMeasuredRows = data
    ? ([
        ['aiCost', data.notMeasured.aiCost],
        ['storage', data.notMeasured.storage],
        ['infrastructureCost', data.notMeasured.infrastructureCost],
      ] as const)
    : [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-bold text-slate-900">{tp('title')}</h2>
        <p className="text-sm text-slate-500">{tp('intro')}</p>
      </div>

      <WindowPicker
        value={windowKey}
        onChange={setWindowKey}
        echo={data?.window ?? null}
        disabled={loading}
      />

      <HealthExclusionNote definitions={data?.definitions ?? null} />

      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      {loading && !data ? (
        <p className="py-10 text-center text-sm text-slate-500">{tc('loading')}</p>
      ) : !data ? null : (
        <>
          <Card title={tp('totalsTitle')}>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Stat label={tp('tenants')} value={formatCount(data.totals.tenants, locale)} />
              <Stat
                label={t('measures.totalMembers')}
                value={formatCount(data.totals.totalMembers, locale)}
              />
              <Stat
                label={t('measures.activeMembers')}
                value={formatCount(data.totals.activeMembers, locale)}
                hint={t('measures.activeShareHint', {
                  share: formatRatio(
                    data.totals.totalMembers > 0
                      ? data.totals.activeMembers / data.totals.totalMembers
                      : null,
                    locale,
                    t('notMeasured'),
                  ),
                  total: formatCount(data.totals.totalMembers, locale),
                })}
              />
              <Stat
                label={t('measures.newMembers')}
                value={formatCount(data.totals.newMembers, locale)}
              />
              <Stat label={tp('aiRequests')} value={formatCount(data.totals.aiRequests, locale)} />
              <Stat
                label={tp('aiTokens')}
                value={formatCount(data.totals.aiInputTokens + data.totals.aiOutputTokens, locale)}
                hint={tp('aiTokensHint', {
                  input: formatCount(data.totals.aiInputTokens, locale),
                  output: formatCount(data.totals.aiOutputTokens, locale),
                })}
              />
            </div>
          </Card>

          <Card title={tp('perTenantTitle')}>
            {data.perTenant.length === 0 ? (
              <p className="text-sm text-slate-500">{tp('perTenantEmpty')}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[34rem] text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-xs uppercase text-slate-500">
                      <th className="py-2 pr-3">{tp('tenant')}</th>
                      <th className="py-2 pr-3 text-right">{t('measures.activeMembers')}</th>
                      <th className="py-2 pr-3 text-right">{t('measures.newMembers')}</th>
                      <th className="py-2 pr-3 text-right">{t('measures.growth')}</th>
                      <th className="py-2 pr-3 text-right">{t('measures.volume')}</th>
                      <th className="py-2 text-right">{tp('aiRequests')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.perTenant.map((row) => (
                      <tr key={row.tenant.id} className="border-b border-slate-100 last:border-0">
                        <td className="py-2 pr-3">
                          <span className="block font-medium text-slate-800">
                            {row.tenant.name}
                          </span>
                          <span className="block font-mono text-xs text-slate-500">
                            {row.tenant.code}
                          </span>
                        </td>
                        <td className="py-2 pr-3 text-right text-slate-700">
                          {formatCount(row.measures.activeMembers, locale)}
                          <span className="block text-xs text-slate-500">
                            {t('measures.ofTotal', {
                              total: formatCount(row.measures.totalMembers, locale),
                            })}
                          </span>
                        </td>
                        <td className="py-2 pr-3 text-right text-slate-700">
                          {formatCount(row.measures.newMembers, locale)}
                        </td>
                        <td className="py-2 pr-3 text-right text-slate-700">
                          {formatSigned(row.measures.growth, locale)}
                        </td>
                        {/* Minor units, divided by 100 exactly once — here, at render. */}
                        <td className="py-2 pr-3 text-right text-slate-700">
                          {formatMoney(row.measures.volumeMinor, row.measures.currency, locale)}
                        </td>
                        <td className="py-2 text-right text-slate-700">
                          {formatCount(row.ai.requests, locale)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title={tp('notMeasuredTitle')}>
            <div className="flex flex-col gap-3">
              <p className="text-sm text-slate-600">{tp('notMeasuredIntro')}</p>
              <dl className="flex flex-col gap-2">
                {notMeasuredRows.map(([key, entry]) => (
                  <div key={key} className="flex min-w-0 flex-col">
                    <dt className="text-sm font-medium text-slate-800">
                      {tp(`notMeasuredItems.${key}`)}
                      <span className="ml-2 text-xs font-normal text-slate-500">
                        {t('notMeasured')}
                      </span>
                    </dt>
                    {/* The API's own reason, verbatim — it says what is missing. */}
                    <dd className="break-words text-xs text-slate-600">{entry.reason}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </Card>

          <DefinitionsDetails definitions={data.definitions} />
        </>
      )}
    </div>
  );
}
