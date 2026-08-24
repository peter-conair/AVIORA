'use client';

import { useLocale, useTranslations } from 'next-intl';
import { ANALYTICS_WINDOWS, type AnalyticsWindow, type AnalyticsWindowEcho } from '@/lib/types';
import { formatDate } from '@/lib/format';

interface WindowPickerProps {
  value: AnalyticsWindow;
  onChange: (window: AnalyticsWindow) => void;
  /** The window the API resolved. Null until the first response arrives. */
  echo: AnalyticsWindowEcho | null;
  disabled?: boolean;
}

/**
 * The 30d / 90d / month selector, and the window the API actually resolved.
 *
 * The resolved window is shown rather than the key alone because a number
 * without its window is a number that will be misquoted (docs/28 §3) — "30d"
 * is a request, and the dates beneath it are what the figures above mean.
 */
export function WindowPicker({ value, onChange, echo, disabled = false }: WindowPickerProps) {
  const t = useTranslations('analytics');
  const locale = useLocale();

  return (
    <div className="flex flex-col gap-2">
      <div
        role="group"
        aria-label={t('window.label')}
        className="flex gap-1 overflow-x-auto rounded-xl border border-slate-200 bg-white p-1"
      >
        {ANALYTICS_WINDOWS.map((key) => (
          <button
            key={key}
            type="button"
            disabled={disabled}
            aria-pressed={value === key}
            onClick={() => onChange(key)}
            className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-60 ${
              value === key ? 'bg-brand-700 text-white' : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            {t(`window.${key}`)}
          </button>
        ))}
      </div>

      {echo ? (
        <p className="text-xs text-slate-500">
          {t('window.resolved', {
            from: formatDate(echo.from, locale),
            to: formatDate(echo.to, locale),
            days: echo.days,
          })}
          <span className="mx-1">·</span>
          {t('window.comparedWith', {
            from: formatDate(echo.comparedWith.from, locale),
            to: formatDate(echo.comparedWith.to, locale),
          })}
        </p>
      ) : null}
    </div>
  );
}
