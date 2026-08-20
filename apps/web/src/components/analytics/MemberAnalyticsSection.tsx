'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { api, ApiError, isForbidden } from '@/lib/api-client';
import {
  DEFAULT_ANALYTICS_WINDOW,
  isMoneyMetric,
  rankMetricKey,
  rankWindowKey,
  type AnalyticsMilestoneGap,
  type AnalyticsWindow,
  type MemberAnalyticsResponse,
} from '@/lib/types';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { HealthSummaryView } from '@/components/health/HealthSummaryView';
import { Stat } from '@/components/analytics/Stat';
import { WindowPicker } from '@/components/analytics/WindowPicker';
import { formatCount, formatDate, formatDecimal, formatMoney, formatSigned } from '@/lib/format';

/**
 * The member's own numbers (docs/28 §5, `GET /analytics/me`).
 *
 * This is the one scope that counts health activity, because the health record
 * is the member's own — so their habit logs make them active here even though
 * the same logs are invisible to every leader, tenant and platform figure.
 *
 * The whole-tenant measures (total members, churn, cohorts) are not shown: at
 * a single member's scope they describe a population of one and would read as
 * facts about the workspace.
 */
export function MemberAnalyticsSection() {
  const t = useTranslations('analytics');
  const tm = useTranslations('analytics.member');
  const tg = useTranslations('growth');
  const tc = useTranslations('common');
  const locale = useLocale();

  const [windowKey, setWindowKey] = useState<AnalyticsWindow>(DEFAULT_ANALYTICS_WINDOW);
  const [data, setData] = useState<MemberAnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get<MemberAnalyticsResponse>(`/analytics/me?window=${windowKey}`)
      .then((res) => {
        if (!cancelled) {
          setData(res);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // A leader-only account holds no `analytics.self.view`; that is a
        // narrower scope, not a failure, so the section simply stays away.
        if (isForbidden(err)) setUnavailable(true);
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

  if (unavailable) return null;

  const metricLabel = (metric: string): string => {
    const key = rankMetricKey(metric);
    return key ? tg(key) : metric;
  };

  const windowLabel = (value: string): string => {
    const key = rankWindowKey(value);
    return key ? tg(key) : value;
  };

  const gapValue = (gap: AnalyticsMilestoneGap, currency: string): string =>
    isMoneyMetric(gap.metric)
      ? formatMoney(gap.remaining, currency, locale)
      : formatCount(gap.remaining, locale);

  const measures = data?.measures ?? null;
  const milestone = data?.milestone ?? null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-bold text-slate-900">{tm('title')}</h2>
        <p className="text-sm text-slate-500">{tm('intro')}</p>
      </div>

      <WindowPicker
        value={windowKey}
        onChange={setWindowKey}
        echo={data?.window ?? null}
        disabled={loading}
      />

      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      {loading && !data ? (
        <p className="py-6 text-center text-sm text-slate-500">{tc('loading')}</p>
      ) : !data || !measures ? null : (
        <>
          <Card title={tm('activityTitle')}>
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <Stat
                  label={tm('active')}
                  value={measures.activeMembers > 0 ? tm('activeYes') : tm('activeNo')}
                  hint={tm('activeHint')}
                />
                <Stat
                  label={t('measures.engagementEvents')}
                  value={formatCount(measures.engagementEvents, locale)}
                  hint={t('measures.engagementEventsHint', {
                    posts: formatCount(measures.posts, locale),
                    comments: formatCount(measures.comments, locale),
                    reactions: formatCount(measures.reactions, locale),
                  })}
                />
                <Stat
                  label={t('measures.courseCompletions')}
                  value={formatCount(measures.courseCompletions, locale)}
                  hint={t('measures.courseCompletionsHint')}
                />
                <Stat
                  label={t('measures.paidOrders')}
                  value={formatCount(measures.paidOrders, locale)}
                  hint={t('measures.paidOrdersHint')}
                />
                {/* Minor units, divided by 100 exactly once — here, at render. */}
                <Stat
                  label={tm('spend')}
                  value={formatMoney(measures.volumeMinor, measures.currency, locale)}
                  hint={t('measures.volumeHint', { currency: measures.currency })}
                />
                <Stat
                  label={tm('engagementPerActive')}
                  value={formatDecimal(
                    measures.engagementPerActiveMember,
                    locale,
                    t('notMeasured'),
                  )}
                  hint={tm('engagementPerActiveHint', {
                    change: formatSigned(
                      measures.engagementChange === null
                        ? null
                        : Math.round(measures.engagementChange * 100) / 100,
                      locale,
                    ),
                  })}
                />
              </div>
              <p className="text-xs text-slate-500">{tm('healthCounted')}</p>
            </div>
          </Card>

          <Card title={tm('milestoneTitle')}>
            {!milestone || !milestone.nextRank ? (
              <p className="text-sm text-slate-500">{tm('milestoneNone')}</p>
            ) : (
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="break-words text-base font-semibold text-slate-900">
                    {milestone.nextRank.name}
                  </span>
                  {milestone.currentRank ? (
                    <Badge tone="teal">
                      {tm('currentRank', { name: milestone.currentRank.name })}
                    </Badge>
                  ) : null}
                </div>
                {milestone.missing.length === 0 ? (
                  <p className="text-sm text-slate-600">{tm('milestoneMet')}</p>
                ) : (
                  <ul className="flex flex-col divide-y divide-slate-100">
                    {milestone.missing.map((gap) => (
                      <li
                        key={`${gap.metric}-${gap.window}-${gap.threshold}`}
                        className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-2"
                      >
                        <span className="min-w-0 break-words text-sm text-slate-800">
                          {metricLabel(gap.metric)}
                          <span className="ml-2 text-xs text-slate-500">
                            {windowLabel(gap.window)}
                          </span>
                        </span>
                        <Badge tone="amber">
                          {tm('milestoneRemaining', {
                            amount: gapValue(gap, milestone.currency),
                          })}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                )}
                {milestone.evaluatedAt ? (
                  <p className="text-xs text-slate-500">
                    {tm('milestoneEvaluatedAt', {
                      date: formatDate(milestone.evaluatedAt, locale),
                    })}
                  </p>
                ) : null}
              </div>
            )}
          </Card>

          <div className="flex flex-col gap-2">
            <h3 className="text-base font-semibold text-slate-900">{tm('healthTitle')}</h3>
            <p className="text-sm text-slate-500">{tm('healthIntro')}</p>
            {/* Their own record, shown to them and to nobody else by this screen. */}
            <HealthSummaryView summary={data.health} />
          </div>
        </>
      )}
    </div>
  );
}
