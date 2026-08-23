'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { api, ApiError, isForbidden } from '@/lib/api-client';
import { Card } from '@/components/ui/Card';
import type { WeeklyUpdateResponse } from '@/lib/types';

/**
 * WEEKLY UPDATE (docs/61).
 *
 * The four boxes of the paper sheet, with the numbers they discuss shown above
 * them — computed, never typed. The member writes why; the system says what.
 */
export function WeeklyUpdateTab() {
  const t = useTranslations('prospecting');
  const tc = useTranslations('common');

  const [data, setData] = useState<WeeklyUpdateResponse | null>(null);
  const [weekOf, setWeekOf] = useState<string | undefined>();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  /**
   * Whether the person has typed since the last load.
   *
   * Without this, a refresh that lands while somebody is mid-sentence reseeds
   * the boxes from the server and silently erases what they wrote — and the
   * save that follows posts the empty value over their words. Found by a
   * browser test; the API never saw it, because the API was told to store
   * nothing and did exactly that.
   */
  const [dirty, setDirty] = useState(false);
  /**
   * A ref as well as state, because `load()` closes over `dirty` at the moment
   * it is created. A request that resolves AFTER the person starts typing was
   * still reading `false` and reseeding the boxes over their words — which is
   * why the first fix passed alone and failed under a loaded test run, where
   * the response lands later.
   */
  const dirtyRef = useRef(false);
  const markDirty = () => {
    dirtyRef.current = true;
    setDirty(true);
  };
  const clearDirty = () => {
    dirtyRef.current = false;
    setDirty(false);
  };
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(async () => {
    try {
      const q = weekOf ? `?weekOf=${weekOf}` : '';
      const res = await api.get<WeeklyUpdateResponse>(`/weekly-update${q}`);
      setData(res);
      // Never overwrite words somebody is still typing.
      if (dirtyRef.current) return;
      setDraft({
        progressionNote: res.update?.progressionNote ?? '',
        prospectNote: res.update?.prospectNote ?? '',
        planNote: res.update?.planNote ?? '',
        questionNote: res.update?.questionNote ?? '',
      });
    } catch (err: unknown) {
      if (isForbidden(err)) setForbidden(true);
      else setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekOf, dirty]);

  useEffect(() => {
    void load();
  }, [load]);

  const shift = (weeks: number) => {
    const base = data ? new Date(`${data.weekOf}T00:00:00Z`) : new Date();
    base.setUTCDate(base.getUTCDate() + weeks * 7);
    setWeekOf(base.toISOString().slice(0, 10));
    setSaved(false);
    // A different week is a different sheet, so its boxes should load.
    clearDirty();
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const q = data ? `?weekOf=${data.weekOf}` : '';
      await api.put(`/weekly-update${q}`, {
        progressionNote: draft.progressionNote || null,
        prospectNote: draft.prospectNote || null,
        planNote: draft.planNote || null,
        questionNote: draft.questionNote || null,
      });
      setSaved(true);
      clearDirty();
      await load();
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setSaving(false);
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

  const p = data.progression;
  const box = (key: string, title: string, hint: string) => (
    <Card key={key} title={title}>
      <p className="mb-2 text-xs text-slate-500">{hint}</p>
      <textarea
        aria-label={title}
        rows={3}
        disabled={!data.isSelf}
        value={draft[key] ?? ''}
        onChange={(e) => {
          setDraft({ ...draft, [key]: e.target.value });
          markDirty();
          setSaved(false);
        }}
        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50"
      />
    </Card>
  );

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
      </Card>

      {/* The computed half. Everything here is read, never entered — which is
          the only reason this beats the paper sheet. */}
      <Card title={t('whereYouStand')}>
        <dl className="flex flex-col gap-2 text-sm">
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-slate-600">{t('targetVolume')}</dt>
            <dd className="text-slate-800">
              {(p.volume.actualMinor / 100).toLocaleString()}
              {p.volume.targetMinor
                ? ` / ${(p.volume.targetMinor / 100).toLocaleString()}`
                : ` — ${t('noTarget')}`}
            </dd>
          </div>
          {p.volume.remainingMinor !== null ? (
            <div className="flex items-baseline justify-between gap-2">
              <dt className="text-slate-600">{t('remainingVolume')}</dt>
              <dd className="font-medium text-slate-800">
                {(p.volume.remainingMinor / 100).toLocaleString()}
              </dd>
            </div>
          ) : null}
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-slate-600">{t('targetPartners')}</dt>
            <dd className="text-slate-800">
              {p.newPartners.actual}
              {p.newPartners.target != null ? ` / ${p.newPartners.target}` : ''}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-slate-600">{t('daysLeft')}</dt>
            <dd className="text-slate-800">{p.daysLeftInMonth}</dd>
          </div>
        </dl>
        {/* Null is not "behind": a member who set no target has not failed, and
            saying so would be the screen inventing a judgement. */}
        {p.onPace === null ? (
          <p className="mt-3 text-sm text-slate-500">{t('noTargetSet')}</p>
        ) : (
          <p className={`mt-3 text-sm ${p.onPace ? 'text-teal-700' : 'text-amber-700'}`}>
            {p.onPace
              ? t('onPace', { done: Math.round((p.achievedShare ?? 0) * 100) })
              : t('behindPace', {
                  done: Math.round((p.achievedShare ?? 0) * 100),
                  gone: Math.round(p.elapsedShare * 100),
                })}
          </p>
        )}
      </Card>

      <Card title={t('thisWeekDid')}>
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <dt className="text-xs text-slate-500">{t('namesAdded')}</dt>
            <dd className="text-lg font-semibold text-slate-800">{data.thisWeek.namesAdded}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">{t('ticksMade')}</dt>
            <dd className="text-lg font-semibold text-slate-800">{data.thisWeek.ticks}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">{t('checklistDone')}</dt>
            <dd className="text-lg font-semibold text-slate-800">{data.thisWeek.checklistDone}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">{t('neverStartedCount')}</dt>
            <dd
              className={`text-lg font-semibold ${
                data.thisWeek.neverStarted > 0 ? 'text-amber-700' : 'text-slate-800'
              }`}
            >
              {data.thisWeek.neverStarted}
            </dd>
          </div>
        </dl>
      </Card>

      {box('progressionNote', t('progressionTitle'), t('progressionHint'))}
      {box('prospectNote', t('prospectTitle'), t('prospectHint'))}
      {box('planNote', t('planTitle'), t('planHint'))}
      {box('questionNote', t('questionTitle'), t('questionHint'))}

      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      {data.isSelf ? (
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="rounded-lg bg-teal-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {saved ? t('savedWeekly') : t('saveWeekly')}
        </button>
      ) : null}
    </div>
  );
}
