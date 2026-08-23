'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { api, ApiError } from '@/lib/api-client';
import { Card } from '@/components/ui/Card';
import type { StartStatus } from '@/lib/types';

/**
 * Starting the business (docs/63 §5).
 *
 * A brand-new member used to land on a dashboard whose every card said "empty".
 * This is the one card that says what to do — and it disappears once the path
 * is finished, because a permanent "getting started" panel on the screen of
 * somebody who started a year ago is clutter that teaches people to ignore it.
 */
export function StartHereCard() {
  const t = useTranslations('start');
  const tc = useTranslations('common');
  const locale = useLocale();

  const [data, setData] = useState<StartStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get<StartStatus>(`/start?locale=${locale}`));
    } catch {
      // A member outside a tenant has no path; that is not an error worth a
      // red box on the dashboard.
      setData(null);
    }
  }, [locale]);

  useEffect(() => {
    void load();
  }, [load]);

  const tick = async (key: string, done: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await api.put(`/start/${key}`, { done });
      await load();
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setBusy(false);
    }
  };

  if (!data || data.complete) return null;

  const pct = Math.round((data.doneCount / Math.max(data.total, 1)) * 100);

  return (
    <Card title={t('title')}>
      <p className="text-sm text-slate-600">{t('intro')}</p>

      <div className="mt-3 flex items-center gap-2">
        <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
          <div className="h-full rounded-full bg-teal-600" style={{ width: `${pct}%` }} />
        </div>
        <span className="shrink-0 text-sm text-slate-600">
          {data.doneCount} / {data.total}
        </span>
      </div>

      {data.next ? (
        <div className="mt-3 rounded-lg border border-teal-200 bg-teal-50 p-3">
          <p className="text-xs font-medium uppercase tracking-wide text-teal-800">{t('nextUp')}</p>
          <p className="mt-1 text-sm font-semibold text-slate-900">{data.next.label}</p>
          <p className="mt-0.5 text-xs text-slate-600">{data.next.hint}</p>
          {data.next.source === 'manual' ? (
            // Only the steps nothing can observe are tickable. Everything else
            // ticks itself when the member does the thing.
            <button
              type="button"
              disabled={busy}
              onClick={() => void tick(data.next!.key, true)}
              className="mt-2 rounded-lg bg-teal-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {t('markDone')}
            </button>
          ) : (
            <Link
              href={`/${locale}${data.next.href}`}
              className="mt-2 inline-block rounded-lg bg-teal-700 px-3 py-1.5 text-sm font-medium text-white"
            >
              {t('goDoIt')}
            </Link>
          )}
        </div>
      ) : null}

      <ul className="mt-3 flex flex-col divide-y divide-slate-100">
        {data.steps.map((step) => (
          <li key={step.key} className="flex items-center justify-between gap-2 py-2">
            <span
              className={`min-w-0 text-sm ${step.done ? 'text-slate-400 line-through' : 'text-slate-700'}`}
            >
              {step.label}
            </span>
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${
                step.done ? 'bg-teal-50 text-teal-700' : 'bg-slate-100 text-slate-400'
              }`}
            >
              {step.done ? '✓' : step.source === 'manual' ? t('askedShort') : t('readShort')}
            </span>
          </li>
        ))}
      </ul>
      {error ? <p className="mt-2 text-sm text-red-600">{error}</p> : null}
    </Card>
  );
}
