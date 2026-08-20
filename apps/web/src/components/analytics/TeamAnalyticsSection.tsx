'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { api, ApiError, isForbidden } from '@/lib/api-client';
import {
  DEFAULT_ANALYTICS_WINDOW,
  isMoneyMetric,
  rankMetricKey,
  rankWindowKey,
  type AnalyticsMilestone,
  type AnalyticsMilestoneGap,
  type AnalyticsWindow,
  type TeamAnalyticsResponse,
} from '@/lib/types';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { DefinitionsDetails } from '@/components/analytics/DefinitionsDetails';
import { HealthExclusionNote } from '@/components/analytics/HealthExclusionNote';
import { MeasuresGrid } from '@/components/analytics/MeasuresGrid';
import { TeamCoach } from '@/components/analytics/TeamCoach';
import { WindowPicker } from '@/components/analytics/WindowPicker';
import { formatCount, formatMoney } from '@/lib/format';

/** How many members one team card names before it stops listing. */
const NAME_LIMIT = 5;

/**
 * Leader analytics (docs/28 §5, `GET /analytics/team`).
 *
 * It lives on the leader's own page rather than at a new route: this is the
 * same scope the page already shows — the teams they actually lead — and a
 * second route would be a second place to ask who those teams are.
 *
 * No health data reaches this scope at all, which is why the exclusion note
 * sits above the numbers and beside every inactive-member list.
 */
export function TeamAnalyticsSection() {
  const t = useTranslations('analytics');
  const tt = useTranslations('analytics.team');
  const tg = useTranslations('growth');
  const tc = useTranslations('common');
  const locale = useLocale();

  const [windowKey, setWindow] = useState<AnalyticsWindow>(DEFAULT_ANALYTICS_WINDOW);
  const [data, setData] = useState<TeamAnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get<TeamAnalyticsResponse>(`/analytics/team?window=${windowKey}`)
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

  const metricLabel = (metric: string): string => {
    const key = rankMetricKey(metric);
    return key ? tg(key) : metric;
  };

  const windowLabel = (value: string): string => {
    const key = rankWindowKey(value);
    return key ? tg(key) : value;
  };

  /** Money metrics are minor units of the milestone's own currency; counts are counts. */
  const gapValue = (gap: AnalyticsMilestoneGap, currency: string): string =>
    isMoneyMetric(gap.metric)
      ? formatMoney(gap.remaining, currency, locale)
      : formatCount(gap.remaining, locale);

  const closest = (milestones: AnalyticsMilestone[]): AnalyticsMilestone[] =>
    milestones
      .filter((m) => m.nextRank && m.largestGapShare !== null)
      .sort((a, b) => (a.largestGapShare ?? 1) - (b.largestGapShare ?? 1))
      .slice(0, 3);

  if (forbidden) {
    return (
      <Card title={tt('title')}>
        <p className="text-sm text-slate-600">{tt('forbidden')}</p>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-bold text-slate-900">{tt('title')}</h2>
        <p className="text-sm text-slate-500">{tt('intro')}</p>
      </div>

      <WindowPicker
        value={windowKey}
        onChange={setWindow}
        echo={data?.window ?? null}
        disabled={loading}
      />

      {/* Above the numbers, not below them: a leader reads the figures first. */}
      <HealthExclusionNote definitions={data?.definitions ?? null} />

      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      {loading && !data ? (
        <p className="py-10 text-center text-sm text-slate-500">{tc('loading')}</p>
      ) : !data ? null : (
        <>
          <Card title={tt('overallTitle')}>
            <div className="flex flex-col gap-3">
              <p className="text-sm text-slate-500">
                {tt('overallHint', { count: data.teams.length })}
              </p>
              <MeasuresGrid measures={data.measures} />
            </div>
          </Card>

          <DefinitionsDetails definitions={data.definitions} />

          {data.teams.length === 0 ? (
            <Card>
              <p className="text-sm text-slate-600">{tt('empty')}</p>
            </Card>
          ) : (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {data.teams.map((entry) => {
                const milestones = closest(entry.milestones);
                return (
                  <Card
                    key={entry.team.id}
                    title={entry.team.name}
                    actions={<Badge tone="gray">{entry.team.code}</Badge>}
                  >
                    <div className="flex flex-col gap-3">
                      <p className="text-xs text-slate-500">
                        {tt('leaders', {
                          names: entry.leaders.length
                            ? entry.leaders.map((l) => l.displayName).join(', ')
                            : tt('noLeader'),
                        })}
                        <span className="mx-1">·</span>
                        {tt('memberCount', { count: entry.memberCount })}
                      </p>

                      <MeasuresGrid measures={entry.measures} variant="compact" />

                      <div className="flex flex-col gap-1">
                        <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                          {tt('inactiveTitle', { count: entry.inactiveMembers.length })}
                        </span>
                        {entry.inactiveMembers.length === 0 ? (
                          <p className="text-sm text-slate-500">{tt('inactiveNone')}</p>
                        ) : (
                          <>
                            <ul className="flex flex-wrap gap-1">
                              {entry.inactiveMembers.slice(0, NAME_LIMIT).map((member) => (
                                <li key={member.memberId}>
                                  <Badge tone="amber">{member.displayName}</Badge>
                                </li>
                              ))}
                            </ul>
                            {entry.inactiveMembers.length > NAME_LIMIT ? (
                              <p className="text-xs text-slate-500">
                                {tt('inactiveMore', {
                                  count: entry.inactiveMembers.length - NAME_LIMIT,
                                })}
                              </p>
                            ) : null}
                            {/* Right next to the names, because this is the list
                                a leader is most likely to act on. */}
                            <p className="text-xs text-slate-500">{t('inactiveMeaning')}</p>
                          </>
                        )}
                      </div>

                      <div className="flex flex-col gap-1">
                        <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                          {tt('milestonesTitle')}
                        </span>
                        {milestones.length === 0 ? (
                          <p className="text-sm text-slate-500">{tt('milestonesNone')}</p>
                        ) : (
                          <ul className="flex flex-col divide-y divide-slate-100">
                            {milestones.map((milestone) => (
                              <li key={milestone.memberId} className="flex flex-col gap-0.5 py-2">
                                <span className="min-w-0 break-words text-sm text-slate-800">
                                  {tt('milestoneMember', {
                                    name: milestone.displayName,
                                    rank: milestone.nextRank?.name ?? '—',
                                  })}
                                </span>
                                {milestone.missing.length === 0 ? (
                                  <span className="text-xs text-slate-500">
                                    {tt('milestoneMet')}
                                  </span>
                                ) : (
                                  <span className="min-w-0 break-words text-xs text-slate-500">
                                    {milestone.missing
                                      .map((gap) =>
                                        tt('milestoneGap', {
                                          metric: metricLabel(gap.metric),
                                          remaining: gapValue(gap, milestone.currency),
                                          window: windowLabel(gap.window),
                                        }),
                                      )
                                      .join(' · ')}
                                  </span>
                                )}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </div>
                  </Card>
                );
              })}
            </div>
          )}

          <TeamCoach windowKey={windowKey} />
        </>
      )}
    </div>
  );
}
