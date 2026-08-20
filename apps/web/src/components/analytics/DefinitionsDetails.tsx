'use client';

import { useTranslations } from 'next-intl';
import { excludesHealthActivity, type AnalyticsDefinitions } from '@/lib/types';

interface DefinitionsDetailsProps {
  definitions: AnalyticsDefinitions;
}

const TERMS = ['activeMember', 'newMember', 'retention', 'churn', 'growth', 'engagement'] as const;

/** Signals this build has wording for; anything else is shown as the API named it. */
const KNOWN_SIGNALS: readonly string[] = ['goal', 'learning', 'order', 'post', 'habit_log'];

/**
 * The definitions the response echoed, in the reader's own language.
 *
 * Measures nobody can define the same way twice are worse than no measures
 * (docs/28 §3), so the wording is not optional decoration — it is why two
 * people reading the same figure mean the same thing. The activity signals
 * come from the response itself, so a scope that counts a different set says so.
 */
export function DefinitionsDetails({ definitions }: DefinitionsDetailsProps) {
  const t = useTranslations('analytics');

  return (
    <details className="rounded-xl border border-slate-200 bg-white p-3">
      <summary className="cursor-pointer text-sm font-medium text-slate-700">
        {t('definitions.title')}
      </summary>
      <dl className="mt-3 flex flex-col gap-2">
        {TERMS.map((term) => (
          <div key={term} className="flex min-w-0 flex-col">
            <dt className="text-xs font-semibold text-slate-700">
              {t(`definitions.terms.${term}.label`)}
            </dt>
            <dd className="break-words text-xs text-slate-600">
              {t(`definitions.terms.${term}.text`)}
            </dd>
          </div>
        ))}
        <div className="flex min-w-0 flex-col">
          <dt className="text-xs font-semibold text-slate-700">
            {t('definitions.activitySignals')}
          </dt>
          <dd className="break-words text-xs text-slate-600">
            {definitions.activitySignals
              .map((signal) =>
                KNOWN_SIGNALS.includes(signal) ? t(`definitions.signals.${signal}`) : signal,
              )
              .join(' · ')}
          </dd>
        </div>
        {excludesHealthActivity(definitions) ? (
          <div className="flex min-w-0 flex-col">
            <dt className="text-xs font-semibold text-slate-700">
              {t('definitions.healthExcludedLabel')}
            </dt>
            <dd className="break-words text-xs text-slate-600">{t('healthExcluded')}</dd>
          </div>
        ) : (
          <div className="flex min-w-0 flex-col">
            <dt className="text-xs font-semibold text-slate-700">
              {t('definitions.healthIncludedLabel')}
            </dt>
            <dd className="break-words text-xs text-slate-600">
              {t('definitions.healthIncluded')}
            </dd>
          </div>
        )}
      </dl>
    </details>
  );
}
