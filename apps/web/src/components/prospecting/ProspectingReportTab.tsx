'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { api, ApiError, isForbidden } from '@/lib/api-client';
import { Card } from '@/components/ui/Card';
import type { ProspectingReport } from '@/lib/types';

/**
 * The report the coach asks for at the weekly meeting (docs/56 §6).
 *
 * Not a dashboard of everything — three questions: are the sheets full, who do
 * I call next, and where are my names actually coming from. The last one is
 * the only thing here the paper cannot do.
 */
export function ProspectingReportTab() {
  const t = useTranslations('prospecting');
  const tc = useTranslations('common');
  const [data, setData] = useState<ProspectingReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .get<ProspectingReport>('/crm/prospecting/report')
      .then((res) => !cancelled && setData(res))
      .catch((err: unknown) => {
        if (cancelled) return;
        if (isForbidden(err)) setForbidden(true);
        else setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (forbidden) {
    return (
      <Card>
        <p className="text-sm text-slate-600">{t('forbidden')}</p>
      </Card>
    );
  }
  if (loading) return <p className="text-sm text-slate-500">{tc('loading')}</p>;
  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!data) return null;

  return (
    <div className="flex flex-col gap-4">
      {data.lists.map((list) => (
        <Card key={list.list} title={t(`lists.${list.list}`)}>
          <p className="text-sm text-slate-600">
            {t('progress', { filled: list.filled, target: list.target })}
            {list.remaining > 0 ? ` · ${t('remaining', { count: list.remaining })}` : ''}
          </p>
          {list.top.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500">{t('emptyList')}</p>
          ) : (
            <ol className="mt-3 flex flex-col divide-y divide-slate-100">
              {list.top.map((entry) => (
                <li key={entry.id} className="flex items-center justify-between gap-2 py-2">
                  <span className="min-w-0 truncate text-sm text-slate-700">{entry.name}</span>
                  <span className="shrink-0 text-sm font-semibold text-brand-700">
                    {entry.score} / {list.scoreMax}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </Card>
      ))}

      {data.unrated > 0 ? (
        <Card>
          {/* Names written down but never rated look like progress and are not,
              which is exactly what a coach needs pointing at. */}
          <p className="text-sm text-amber-700">{t('unrated', { count: data.unrated })}</p>
        </Card>
      ) : null}

      <Card title={t('whereNamesComeFrom')}>
        <ul className="flex flex-col divide-y divide-slate-100">
          {data.joggerCategories.map((category) => (
            <li key={category.key} className="flex items-center justify-between gap-2 py-2">
              <span className="text-sm text-slate-700">
                {t(`joggerCategories.${category.key}`)}
              </span>
              <span
                className={`shrink-0 text-sm ${
                  category.named > 0 ? 'font-semibold text-slate-800' : 'text-slate-400'
                }`}
              >
                {category.named}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-slate-500">{t('zeroesAreThePoint')}</p>
      </Card>
    </div>
  );
}
