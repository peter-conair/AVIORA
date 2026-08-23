'use client';

import { useLocale, useTranslations } from 'next-intl';
import { TRACKED_METRICS, type HealthSummary } from '@/lib/types';
import { Card } from '@/components/ui/Card';
import { formatDate } from '@/lib/format';

interface HealthSummaryViewProps {
  summary: HealthSummary;
}

const KNOWN_METRICS: readonly string[] = TRACKED_METRICS;

/**
 * The 30-day record, shown the same way to the member and to anyone they
 * shared it with. It reports counts and latest readings only — there is
 * deliberately no score, grade, ring or rating anywhere in this view.
 */
export function HealthSummaryView({ summary }: HealthSummaryViewProps) {
  const t = useTranslations('health');
  const locale = useLocale();

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-slate-600">{t('progress.window', { days: summary.windowDays })}</p>

      <Card title={t('progress.habitsTitle')}>
        {summary.habits.length === 0 ? (
          <p className="text-sm text-slate-500">{t('progress.habitsEmpty')}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {summary.habits.map((habit) => {
              const ratio =
                summary.windowDays > 0
                  ? Math.min(100, Math.round((habit.daysLogged / summary.windowDays) * 100))
                  : 0;
              return (
                <li key={habit.id} className="flex flex-col gap-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <span className="text-sm font-medium text-slate-800">{habit.name}</span>
                    <span className="text-xs text-slate-500">
                      {t('progress.daysLogged', {
                        days: habit.daysLogged,
                        window: summary.windowDays,
                      })}
                    </span>
                  </div>
                  <div
                    className="h-2 w-full overflow-hidden rounded-full bg-slate-100"
                    aria-hidden="true"
                  >
                    <div
                      className="h-full rounded-full bg-brand-700"
                      style={{ width: `${ratio}%` }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card title={t('progress.metricsTitle')}>
        {summary.latestMetrics.length === 0 ? (
          <p className="text-sm text-slate-500">{t('progress.metricsEmpty')}</p>
        ) : (
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {summary.latestMetrics.map((reading) => (
              <li
                key={reading.metric}
                className="flex flex-col gap-0.5 rounded-lg border border-slate-200 p-3"
              >
                <span className="text-xs text-slate-500">
                  {KNOWN_METRICS.includes(reading.metric)
                    ? t(`metrics.names.${reading.metric}`)
                    : reading.metric}
                </span>
                <span className="text-lg font-semibold text-slate-900">
                  {reading.value}{' '}
                  <span className="text-sm font-normal text-slate-600">{reading.unit}</span>
                </span>
                <span className="text-xs text-slate-500">
                  {t('progress.measuredOn', { date: formatDate(reading.measuredOn, locale) })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* The API's own safety note, rendered verbatim — never paraphrased or hidden. */}
      <p className="rounded-xl border border-slate-200 bg-slate-100 p-3 text-xs text-slate-600">
        {summary.note}
      </p>
    </div>
  );
}
