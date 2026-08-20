'use client';

import { useLocale, useTranslations } from 'next-intl';
import type { AnalyticsMeasures } from '@/lib/types';
import { Stat } from '@/components/analytics/Stat';
import { formatCount, formatDecimal, formatMoney, formatRatio, formatSigned } from '@/lib/format';

interface MeasuresGridProps {
  measures: AnalyticsMeasures;
  /** `compact` is the per-team card; `full` is a whole-scope dashboard. */
  variant?: 'full' | 'compact';
}

/**
 * The §3 measures, one number each and each with the figures behind it.
 *
 * A ratio the API returned as `null` had no denominator, so it is shown as
 * "not measured" — never as 0%, which would read as a measured nothing.
 */
export function MeasuresGrid({ measures: m, variant = 'full' }: MeasuresGridProps) {
  const t = useTranslations('analytics');
  const locale = useLocale();
  const notMeasured = t('notMeasured');

  const active = (
    <Stat
      key="active"
      label={t('measures.activeMembers')}
      value={formatCount(m.activeMembers, locale)}
      hint={t('measures.activeShareHint', {
        share: formatRatio(m.activeShare, locale, notMeasured),
        total: formatCount(m.totalMembers, locale),
      })}
    />
  );

  const growth = (
    <Stat
      key="growth"
      label={t('measures.growth')}
      value={formatSigned(m.growth, locale)}
      hint={t('measures.growthHint', {
        previous: formatCount(m.previousActiveMembers, locale),
        rate: formatRatio(m.growthRate, locale, notMeasured),
      })}
    />
  );

  const engagement = (
    <Stat
      key="engagement"
      label={t('measures.engagementPerActive')}
      value={formatDecimal(m.engagementPerActiveMember, locale, notMeasured)}
      hint={t('measures.engagementHint', {
        previous: formatDecimal(m.previousEngagementPerActiveMember, locale, notMeasured),
        change: formatSigned(
          m.engagementChange === null ? null : Math.round(m.engagementChange * 100) / 100,
          locale,
        ),
      })}
    />
  );

  const courses = (
    <Stat
      key="courses"
      label={t('measures.courseCompletions')}
      value={formatCount(m.courseCompletions, locale)}
      hint={t('measures.courseCompletionsHint')}
    />
  );

  if (variant === 'compact') {
    return (
      <div className="grid grid-cols-2 gap-2">
        {active}
        {growth}
        {engagement}
        {courses}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
      <Stat label={t('measures.totalMembers')} value={formatCount(m.totalMembers, locale)} />
      {active}
      <Stat
        label={t('measures.inactiveMembers')}
        value={formatCount(m.inactiveMembers, locale)}
        hint={t('measures.inactiveHint')}
      />
      <Stat
        label={t('measures.newMembers')}
        value={formatCount(m.newMembers, locale)}
        hint={t('measures.newMembersHint')}
      />
      {growth}
      {engagement}
      <Stat
        label={t('measures.engagementEvents')}
        value={formatCount(m.engagementEvents, locale)}
        hint={t('measures.engagementEventsHint', {
          posts: formatCount(m.posts, locale),
          comments: formatCount(m.comments, locale),
          reactions: formatCount(m.reactions, locale),
        })}
      />
      <Stat
        label={t('measures.churn')}
        value={formatRatio(m.churnRate, locale, notMeasured)}
        hint={t('measures.churnHint', {
          ended: formatCount(m.churnedMembers, locale),
          atStart: formatCount(m.membersActiveAtWindowStart, locale),
        })}
      />
      {courses}
      <Stat
        label={t('measures.paidOrders')}
        value={formatCount(m.paidOrders, locale)}
        hint={t('measures.paidOrdersHint')}
      />
      {/* Minor units, divided by 100 exactly once — here, at render. */}
      <Stat
        label={t('measures.volume')}
        value={formatMoney(m.volumeMinor, m.currency, locale)}
        hint={t('measures.volumeHint', { currency: m.currency })}
      />
    </div>
  );
}
