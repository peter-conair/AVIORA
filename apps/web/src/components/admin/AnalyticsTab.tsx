'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { api, ApiError, isForbidden } from '@/lib/api-client';
import {
  DEFAULT_ANALYTICS_WINDOW,
  type AnalyticsWindow,
  type TenantAnalyticsResponse,
} from '@/lib/types';
import { Card } from '@/components/ui/Card';
import { DefinitionsDetails } from '@/components/analytics/DefinitionsDetails';
import { HealthExclusionNote } from '@/components/analytics/HealthExclusionNote';
import { MeasuresGrid } from '@/components/analytics/MeasuresGrid';
import { RetentionCohorts } from '@/components/analytics/RetentionCohorts';
import { Stat } from '@/components/analytics/Stat';
import { WindowPicker } from '@/components/analytics/WindowPicker';
import { formatCount, formatRatio } from '@/lib/format';

/**
 * Tenant analytics (docs/28 §5, `GET /analytics/tenant`).
 *
 * The same measures as the leader scope, over the whole tenant, and with the
 * same absence: no habit, metric or health profile is counted, aggregated or
 * averaged anywhere in this tab.
 */
export function AnalyticsTab() {
  const t = useTranslations('analytics');
  const tt = useTranslations('analytics.tenant');
  const tc = useTranslations('common');
  const locale = useLocale();

  const [windowKey, setWindowKey] = useState<AnalyticsWindow>(DEFAULT_ANALYTICS_WINDOW);
  const [data, setData] = useState<TenantAnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get<TenantAnalyticsResponse>(`/analytics/tenant?window=${windowKey}`)
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
      <Card>
        <p className="text-sm text-slate-600">{tt('forbidden')}</p>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-slate-500">{tt('intro')}</p>

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
          <Card title={tt('measuresTitle')}>
            <MeasuresGrid measures={data.measures} />
          </Card>

          <Card title={tt('churnTitle')}>
            <div className="flex flex-col gap-2">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <Stat
                  label={t('measures.churn')}
                  value={formatRatio(data.measures.churnRate, locale, t('notMeasured'))}
                  hint={t('measures.churnHint', {
                    ended: formatCount(data.measures.churnedMembers, locale),
                    atStart: formatCount(data.measures.membersActiveAtWindowStart, locale),
                  })}
                />
                <Stat
                  label={tt('churnEnded')}
                  value={formatCount(data.measures.churnedMembers, locale)}
                />
                <Stat
                  label={tt('churnAtStart')}
                  value={formatCount(data.measures.membersActiveAtWindowStart, locale)}
                />
              </div>
              <p className="text-xs text-slate-500">{tt('churnHint')}</p>
            </div>
          </Card>

          <Card title={tt('retentionTitle')}>
            <div className="flex flex-col gap-2">
              <p className="text-sm text-slate-500">{tt('retentionHint')}</p>
              <RetentionCohorts cohorts={data.measures.retentionCohorts} />
            </div>
          </Card>

          <Card title={tt('coursesTitle')}>
            {data.measures.courses.length === 0 ? (
              <p className="text-sm text-slate-500">{tt('coursesEmpty')}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[24rem] text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-xs uppercase text-slate-500">
                      <th className="py-2 pr-3">{tt('course')}</th>
                      <th className="py-2 pr-3 text-right">{tt('courseInWindow')}</th>
                      <th className="py-2 pr-3 text-right">{tt('courseAllTime')}</th>
                      <th className="py-2 text-right">{tt('courseInProgress')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.measures.courses.map((course) => (
                      <tr key={course.courseId} className="border-b border-slate-100 last:border-0">
                        <td className="py-2 pr-3 text-slate-800">{course.title}</td>
                        <td className="py-2 pr-3 text-right text-slate-700">
                          {formatCount(course.completedInWindow, locale)}
                        </td>
                        <td className="py-2 pr-3 text-right text-slate-700">
                          {formatCount(course.completedAllTime, locale)}
                        </td>
                        <td className="py-2 text-right text-slate-700">
                          {formatCount(course.inProgress, locale)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <DefinitionsDetails definitions={data.definitions} />
        </>
      )}
    </div>
  );
}
