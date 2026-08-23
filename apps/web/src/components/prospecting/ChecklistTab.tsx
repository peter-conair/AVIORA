'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { api, ApiError, isForbidden } from '@/lib/api-client';
import { Card } from '@/components/ui/Card';
import type { ChecklistWeek } from '@/lib/types';

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

/**
 * DAILY CHECK LIST, one week at a time (docs/60 §5).
 *
 * The paper is seven columns by eight rows and it fits on a phone, so unlike
 * the follow-up sheets this one stays a grid — the point of the sheet is seeing
 * the whole week at once, and a stack of cards would destroy exactly that.
 * Column headings are one letter to make it fit without shrinking the tap
 * targets, which have to stay thumb-sized.
 */
export function ChecklistTab() {
  const t = useTranslations('prospecting');
  const tc = useTranslations('common');
  const locale = useLocale();

  const [data, setData] = useState<ChecklistWeek | null>(null);
  const [weekOf, setWeekOf] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const q = new URLSearchParams({ locale });
      if (weekOf) q.set('weekOf', weekOf);
      setData(await api.get<ChecklistWeek>(`/checklist?${q.toString()}`));
    } catch (err: unknown) {
      if (isForbidden(err)) setForbidden(true);
      else setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekOf, locale]);

  useEffect(() => {
    void load();
  }, [load]);

  const shift = (weeks: number) => {
    const base = data ? new Date(`${data.weekOf}T00:00:00Z`) : new Date();
    base.setUTCDate(base.getUTCDate() + weeks * 7);
    setWeekOf(base.toISOString().slice(0, 10));
  };

  const toggleDaily = async (habitId: string, date: string, done: boolean) => {
    setBusy(habitId + date);
    try {
      await api.put(`/checklist/items/${habitId}`, { date, done });
      await load();
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setBusy(null);
    }
  };

  const toggleWeekly = async (habitId: string, done: boolean) => {
    setBusy(habitId);
    try {
      // No date sent: the server puts a weekly item on the week's own start
      // whatever day it is ticked (docs/60 §2).
      await api.put(`/checklist/items/${habitId}`, { date: data?.weekOf, done });
      await load();
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setBusy(null);
    }
  };

  if (forbidden) {
    return (
      <Card>
        <p className="text-sm text-slate-600">{t('forbidden')}</p>
      </Card>
    );
  }
  if (loading) return <p className="text-sm text-slate-500">{tc('loading')}</p>;
  if (!data) return null;

  const doneToday = data.daily.filter((h) =>
    h.done.includes(new Date().toISOString().slice(0, 10)),
  ).length;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => shift(-1)}
            aria-label={t('prevWeek')}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
          >
            ‹
          </button>
          <p className="text-sm font-medium text-slate-700">{t('weekOf', { date: data.weekOf })}</p>
          <button
            type="button"
            onClick={() => shift(1)}
            aria-label={t('nextWeek')}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
          >
            ›
          </button>
        </div>
        <p className="mt-2 text-sm text-slate-500">
          {t('doneToday', { done: doneToday, total: data.expectedDaily })}
        </p>
      </Card>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      <Card title={t('everyDay')}>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th className="w-auto py-1 text-left text-xs font-medium text-slate-500" />
                {DAY_KEYS.map((d) => (
                  <th key={d} className="w-8 py-1 text-center text-xs font-medium text-slate-500">
                    {t(`days.${d}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.daily.map((habit) => (
                <tr key={habit.id} className="border-t border-slate-100">
                  <td className="py-1 pr-2 text-xs text-slate-700">{habit.name}</td>
                  {data.days.map((day) => {
                    const done = habit.done.includes(day);
                    return (
                      <td key={day} className="py-1 text-center">
                        <button
                          type="button"
                          aria-pressed={done}
                          aria-label={`${habit.name} — ${day}`}
                          disabled={busy === habit.id + day || !data.isSelf}
                          onClick={() => void toggleDaily(habit.id, day, !done)}
                          className={`h-7 w-7 rounded-md border text-xs disabled:opacity-40 ${
                            done
                              ? 'border-brand-600 bg-brand-600 text-white'
                              : 'border-slate-300 text-transparent'
                          }`}
                        >
                          ✓
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title={t('everyWeek')}>
        <ul className="flex flex-col divide-y divide-slate-100">
          {data.weekly.map((habit) => (
            <li key={habit.id} className="flex items-center justify-between gap-2 py-1">
              <span className="min-w-0 text-sm text-slate-700">{habit.name}</span>
              <button
                type="button"
                aria-pressed={habit.done}
                aria-label={habit.name}
                disabled={busy === habit.id || !data.isSelf}
                onClick={() => void toggleWeekly(habit.id, !habit.done)}
                className={`h-7 w-7 shrink-0 rounded-md border text-xs disabled:opacity-40 ${
                  habit.done
                    ? 'border-brand-600 bg-brand-600 text-white'
                    : 'border-slate-300 text-transparent'
                }`}
              >
                ✓
              </button>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
