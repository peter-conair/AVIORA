'use client';

import { useLocale, useTranslations } from 'next-intl';
import type { AnalyticsCohort } from '@/lib/types';
import { formatCount, formatMonth, formatRatio } from '@/lib/format';

interface RetentionCohortsProps {
  cohorts: AnalyticsCohort[];
}

/**
 * Retention by joining month: of the members who joined in month M, the share
 * still active in the window (docs/28 §3). A month nobody joined has no rate —
 * shown as "not measured" rather than 0%, which would read as total churn.
 */
export function RetentionCohorts({ cohorts }: RetentionCohortsProps) {
  const t = useTranslations('analytics');
  const locale = useLocale();

  if (cohorts.length === 0) {
    return <p className="text-sm text-slate-500">{t('retention.empty')}</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[20rem] text-left text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-xs uppercase text-slate-500">
            <th className="py-2 pr-3">{t('retention.month')}</th>
            <th className="py-2 pr-3 text-right">{t('retention.joined')}</th>
            <th className="py-2 pr-3 text-right">{t('retention.stillActive')}</th>
            <th className="py-2 text-right">{t('retention.rate')}</th>
          </tr>
        </thead>
        <tbody>
          {cohorts.map((cohort) => (
            <tr key={cohort.month} className="border-b border-slate-100 last:border-0">
              <td className="py-2 pr-3 text-slate-700">{formatMonth(cohort.month, locale)}</td>
              <td className="py-2 pr-3 text-right text-slate-700">
                {formatCount(cohort.joined, locale)}
              </td>
              <td className="py-2 pr-3 text-right text-slate-700">
                {formatCount(cohort.stillActive, locale)}
              </td>
              <td className="py-2 text-right font-medium text-slate-900">
                {formatRatio(cohort.rate, locale, t('notMeasured'))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
