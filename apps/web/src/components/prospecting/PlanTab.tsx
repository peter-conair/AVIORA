'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { api, ApiError } from '@/lib/api-client';
import { Card } from '@/components/ui/Card';
import type { PlanResponse } from '@/lib/types';

/**
 * The plan (docs/69).
 *
 * Two directions on one screen. Backwards: the month's target becomes a number
 * of names, which is almost always far more than the twenty-row sheet and which
 * nobody works out in their head. Forwards: those names become a short list of
 * people to deal with today.
 *
 * Every rate says whether it was measured or guessed, and where the chain
 * breaks the screen asks for the ONE number that would repair it instead of
 * rendering an empty funnel.
 */
export function PlanTab() {
  const t = useTranslations('plan');
  const tc = useTranslations('common');
  const locale = useLocale();

  const [data, setData] = useState<PlanResponse | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get<PlanResponse>('/plan'));
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const saveAssumptions = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.put('/plan/assumptions', {
        assumedOrderValueMinor: draft.order?.trim() ? Math.round(Number(draft.order) * 100) : null,
        assumedContactRate: draft.contact?.trim() ? Number(draft.contact) : null,
        assumedConversionRate: draft.convert?.trim() ? Number(draft.convert) : null,
      });
      await load();
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setBusy(false);
    }
  };

  if (!data) return <p className="text-sm text-slate-500">{tc('loading')}</p>;

  const rateRow = (label: string, r: PlanResponse['rates']['averageOrder'], asPercent: boolean) => (
    <div className="flex items-baseline justify-between gap-2 py-1.5">
      <span className="text-sm text-slate-600">{label}</span>
      <span className="flex items-baseline gap-2">
        <span className="text-sm font-medium text-slate-800">
          {r.value === null
            ? '—'
            : asPercent
              ? `${Math.round(r.value * 100)}%`
              : (r.value / 100).toLocaleString()}
        </span>
        <span
          className={`rounded-full px-1.5 py-0.5 text-[0.65rem] ${
            r.source === 'measured'
              ? 'bg-brand-50 text-brand-700'
              : r.source === 'assumed'
                ? 'bg-amber-50 text-amber-700'
                : 'bg-slate-100 text-slate-400'
          }`}
        >
          {t(`source.${r.source}`)}
          {r.source === 'measured' ? ` · ${r.sample}` : ''}
        </span>
      </span>
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      {/* ── the one missing number, asked for directly ───────────────────── */}
      {data.blockedBy === 'no_target' ? (
        <Card>
          <p className="text-sm text-slate-700">{t('needTarget')}</p>
          <Link
            href={`/${locale}/prospecting`}
            className="mt-2 inline-block rounded-lg bg-brand-700 px-4 py-2 text-sm font-medium text-white"
          >
            {t('goSetTarget')}
          </Link>
        </Card>
      ) : null}

      {/* ── backwards: what the target actually asks for ─────────────────── */}
      <Card title={t('backwards')}>
        <ul className="flex flex-col divide-y divide-slate-100">
          {data.funnel
            .slice()
            .reverse()
            .map((row) => (
              <li key={row.step} className="flex items-baseline justify-between gap-2 py-2">
                <span className="text-sm text-slate-700">{t(`step.${row.step}`)}</span>
                <span className="text-sm">
                  <span className="font-semibold text-slate-900">{row.have}</span>
                  <span className="text-slate-400"> / </span>
                  <span className="text-slate-600">{row.need ?? '—'}</span>
                  {row.short !== null && row.short > 0 ? (
                    <span className="ml-2 rounded-full bg-amber-50 px-1.5 py-0.5 text-[0.65rem] text-amber-700">
                      {t('short', { n: row.short })}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
        </ul>
        <p className="mt-2 text-xs text-slate-500">
          {t('sheetNote', { target: data.nameList.target })}
        </p>
      </Card>

      {/* ── the numbers in between ───────────────────────────────────────── */}
      <Card title={t('rates')}>
        {rateRow(t('avgOrder'), data.rates.averageOrder, false)}
        {rateRow(t('contactRate'), data.rates.contactRate, true)}
        {rateRow(t('conversionRate'), data.rates.conversionRate, true)}

        {data.blockedBy && data.blockedBy !== 'no_target' ? (
          <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3">
            {/* Said plainly: the system has not measured enough yet, and a
                guess is better than a blank plan as long as it says it is one. */}
            <p className="text-sm text-amber-900">{t('notEnoughHistory')}</p>
            <div className="mt-2 grid grid-cols-3 gap-2">
              {(
                [
                  ['order', t('avgOrder')],
                  ['contact', `${t('contactRate')} %`],
                  ['convert', `${t('conversionRate')} %`],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="flex flex-col gap-1">
                  <span className="text-[0.65rem] text-slate-600">{label}</span>
                  <input
                    aria-label={label}
                    inputMode="numeric"
                    value={draft[key] ?? ''}
                    onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                    className="w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
                  />
                </label>
              ))}
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => void saveAssumptions()}
              className="mt-2 rounded-lg bg-brand-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {t('useMyEstimate')}
            </button>
          </div>
        ) : null}
      </Card>

      {/* ── forwards: today ──────────────────────────────────────────────── */}
      <Card title={t('today')}>
        {data.today.unrated.length === 0 &&
        data.today.dueFollowUps.length === 0 &&
        data.today.neverStarted.length === 0 ? (
          <p className="text-sm text-slate-500">{t('nothingToday')}</p>
        ) : (
          <div className="flex flex-col gap-3">
            {data.today.unrated.length > 0 ? (
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  {t('unratedTitle')}
                </p>
                <p className="mb-1 text-xs text-slate-500">{t('unratedWhy')}</p>
                <ul className="flex flex-col divide-y divide-slate-100">
                  {data.today.unrated.map((lead) => (
                    <li key={lead.id} className="py-1.5 text-sm text-slate-700">
                      {lead.name}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {data.today.dueFollowUps.length > 0 ? (
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  {t('dueTitle', { n: data.today.dueFollowUps.length })}
                </p>
                <Link
                  href={`/${locale}/follow-ups`}
                  className="text-sm text-brand-700 underline-offset-2 hover:underline"
                >
                  {t('openFollowUps')}
                </Link>
              </div>
            ) : null}
            {data.today.neverStarted.length > 0 ? (
              <p className="text-sm text-amber-700">
                {t('neverStarted', { n: data.today.neverStarted.length })}
              </p>
            ) : null}
          </div>
        )}
      </Card>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}
    </div>
  );
}
