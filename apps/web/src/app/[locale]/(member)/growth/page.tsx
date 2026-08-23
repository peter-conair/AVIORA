'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { api, ApiError, isEntitlementRequired, isForbidden } from '@/lib/api-client';
import {
  isMoneyMetric,
  rankMetricKey,
  rankWindowKey,
  referralTypeKey,
  type RankDefinition,
  type RankMeResponse,
  type RankRequirementGap,
  type RanksResponse,
  type ReferralEdge,
  type ReferralMeResponse,
  type Course,
  type CoursesResponse,
} from '@/lib/types';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { formatDate, formatMoney } from '@/lib/format';
import Link from 'next/link';

export default function GrowthPage() {
  const t = useTranslations('growth');
  const tc = useTranslations('common');
  const locale = useLocale();

  const [rank, setRank] = useState<RankMeResponse | null>(null);
  const [referrals, setReferrals] = useState<ReferralMeResponse | null>(null);
  const [ladder, setLadder] = useState<RankDefinition[] | null>(null);
  const [courses, setCourses] = useState<Course[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  /** The plan does not include `growth.ranks` — a refusal, not a failure. */
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    // The ladder is permission-scoped only, so a member whose plan excludes the
    // growth layer can still see what the workspace offers (docs/25 §4).
    api
      .get<RanksResponse>('/ranks')
      .then((res) => {
        if (!cancelled) setLadder(res.ranks);
      })
      .catch(() => {
        if (!cancelled) setLadder(null);
      });

    api
      .get<ReferralMeResponse>('/referrals/me')
      .then((res) => {
        if (!cancelled) setReferrals(res);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (isEntitlementRequired(err)) setUnavailable(true);
      });

    // Titles for the recommended course ids. A failure here loses the reading
    // list and nothing else, so it never surfaces an error.
    api
      .get<CoursesResponse>('/courses')
      .then((res) => {
        if (!cancelled) setCourses(res.courses);
      })
      .catch(() => {
        if (!cancelled) setCourses([]);
      });

    api
      .get<RankMeResponse>('/ranks/me')
      .then((res) => {
        if (!cancelled) setRank(res);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
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
    return key ? t(key) : metric;
  };

  const windowLabel = (window: string): string => {
    const key = rankWindowKey(window);
    return key ? t(key) : window;
  };

  const typeLabel = (type: string): string => {
    const key = referralTypeKey(type);
    return key ? t(key) : type;
  };

  /**
   * Money metrics are minor units in the currency the response names, and go
   * through the currency formatter, which divides by 100 exactly once. Counts
   * are counts — dividing one would turn 3 referrals into 0.03.
   */
  const metricValue = (metric: string, value: number, currency: string): string =>
    isMoneyMetric(metric)
      ? formatMoney(value, currency, locale)
      : new Intl.NumberFormat(locale === 'th' ? 'th-TH' : 'en-GB').format(value);

  const requirementLine = (gap: RankRequirementGap, currency: string): string =>
    t('requirement', {
      metric: metricLabel(gap.metric),
      current: metricValue(gap.metric, gap.current, currency),
      threshold: metricValue(gap.metric, gap.threshold, currency),
    });

  const edgeName = (edge: ReferralEdge): string => edge.displayName ?? '—';

  if (forbidden) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-xl font-bold text-slate-900">{t('title')}</h1>
        <Card>
          <p className="text-sm text-slate-600">{t('forbidden')}</p>
        </Card>
      </div>
    );
  }

  const current = rank?.current ?? null;
  const highest = rank?.highest ?? null;
  // Recognition and qualification are different facts. The best rank ever held
  // is shown only when it is not the rank held now, and never in its place.
  const showHighest = !!highest && highest.id !== current?.id;

  // Only courses the member can actually open. An id pointing at a course
  // they have no access to would render as a dead link.
  const recommended = (rank?.next?.recommendedCourseIds ?? [])
    .map((id) => courses.find((c) => c.id === id))
    .filter((c): c is Course => !!c);

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
      ) : (
        <>
          <Card title={t('currentRank')}>
            <div className="flex flex-col gap-2">
              {current ? (
                <>
                  <span className="break-words text-2xl font-bold text-brand-700">
                    {current.name}
                  </span>
                  {current.evaluatedAt ? (
                    <span className="text-xs text-slate-500">
                      {t('evaluatedAt', { date: formatDate(current.evaluatedAt, locale) })}
                    </span>
                  ) : null}
                </>
              ) : (
                <span className="text-sm text-slate-500">{t('noRank')}</span>
              )}

              {showHighest && highest ? (
                <div className="mt-1 flex flex-col gap-1 border-t border-slate-100 pt-3">
                  <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                    {t('highestEver')}
                  </span>
                  <span className="break-words text-sm font-semibold text-slate-800">
                    {highest.name}
                  </span>
                  <p className="text-xs text-slate-500">{t('highestEverNote')}</p>
                </div>
              ) : null}
            </div>
          </Card>

          <Card title={t('nextRank')}>
            {!rank?.next ? (
              <p className="text-sm text-slate-600">{t('highestRank')}</p>
            ) : (
              <div className="flex flex-col gap-3">
                <span className="break-words text-lg font-semibold text-slate-900">
                  {rank.next.name}
                </span>
                <div className="flex flex-col gap-2">
                  <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                    {t('missingTitle')}
                  </span>
                  {rank.missing.length === 0 ? (
                    <p className="text-sm text-slate-500">{t('missingNone')}</p>
                  ) : (
                    <ul className="flex flex-col divide-y divide-slate-100">
                      {rank.missing.map((gap) => (
                        <li
                          key={`${gap.metric}-${gap.window}-${gap.threshold}`}
                          className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-2"
                        >
                          <span className="flex min-w-0 flex-col">
                            <span className="min-w-0 break-words text-sm text-slate-800">
                              {requirementLine(gap, rank.currency)}
                            </span>
                            <span className="text-xs text-slate-500">
                              {windowLabel(gap.window)}
                            </span>
                          </span>
                          <Badge tone="amber">
                            {t('remaining', {
                              amount: metricValue(gap.metric, gap.remaining, rank.currency),
                            })}
                          </Badge>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {/* What to LEARN to get there. The ids have been on this
                    response since Sprint 27 and no screen ever showed them, so
                    the ladder told a member what they were short of and never
                    what to do about it (docs/62 §4). */}
                {recommended.length > 0 ? (
                  <div className="flex flex-col gap-2">
                    <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                      {t('learnToGetThere')}
                    </span>
                    <ul className="flex flex-col divide-y divide-slate-100">
                      {recommended.map((course) => (
                        <li key={course.id} className="py-2">
                          <Link
                            href={`/${locale}/learning`}
                            className="text-sm font-medium text-brand-700 underline-offset-2 hover:underline"
                          >
                            {course.title}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            )}
          </Card>

          <Card title={t('referrerTitle')}>
            <div className="flex flex-col gap-3">
              {!referrals || referrals.referrers.length === 0 ? (
                <p className="text-sm text-slate-500">{t('referrerNone')}</p>
              ) : (
                <ul className="flex flex-col divide-y divide-slate-100">
                  {referrals.referrers.map((edge) => (
                    <li
                      key={edge.id}
                      className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2"
                    >
                      <span className="flex min-w-0 flex-col">
                        <span className="min-w-0 break-words text-sm text-slate-800">
                          {edgeName(edge)}
                        </span>
                        <span className="text-xs text-slate-500">
                          {t('since', { date: formatDate(edge.effectiveFrom, locale) })}
                        </span>
                      </span>
                      <Badge tone="teal">{typeLabel(edge.relationshipType)}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Card>

          <Card title={t('referralsTitle')}>
            {!referrals || referrals.directReferrals.length === 0 ? (
              <p className="text-sm text-slate-500">{t('referralsEmpty')}</p>
            ) : (
              <ul className="flex flex-col divide-y divide-slate-100">
                {referrals.directReferrals.map((edge) => (
                  <li
                    key={edge.id}
                    className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2"
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="min-w-0 break-words text-sm text-slate-800">
                        {edgeName(edge)}
                      </span>
                      <span className="text-xs text-slate-500">
                        {t('since', { date: formatDate(edge.effectiveFrom, locale) })}
                      </span>
                    </span>
                    <Badge tone="gray">{typeLabel(edge.relationshipType)}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}

      {ladder === null ? null : (
        <Card title={t('ladderTitle')}>
          {ladder.length === 0 ? (
            <p className="text-sm text-slate-500">{t('ladderEmpty')}</p>
          ) : (
            <ol className="flex flex-col gap-1">
              {[...ladder]
                .sort((a, b) => a.level - b.level)
                .map((step) => {
                  const here = !!current && step.id === current.id;
                  return (
                    <li
                      key={step.id}
                      className={`flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg px-2 py-1.5 ${
                        here ? 'bg-brand-50 ring-1 ring-inset ring-brand-600/20' : ''
                      }`}
                    >
                      <span className="min-w-0 break-words text-sm text-slate-800">
                        {step.name}
                      </span>
                      {here ? <Badge tone="teal">{t('youAreHere')}</Badge> : null}
                    </li>
                  );
                })}
            </ol>
          )}
        </Card>
      )}

      {/* Said outright on the screen, and outside every gate: the person who
          referred a member is not that member's team, and neither graph follows
          the other (spec §17). A member who is not told this will assume it. */}
      <p className="text-xs text-slate-500">{t('graphNote')}</p>
    </div>
  );
}
