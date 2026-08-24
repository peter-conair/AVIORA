'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { api, ApiError, isForbidden } from '@/lib/api-client';
import { Card } from '@/components/ui/Card';
import type { BusinessGoalResponse } from '@/lib/types';

/**
 * The monthly goal sheet (docs/58).
 *
 * The sheet's two halves stay visually different on purpose. Narrative goals
 * are text and nothing pretends to measure them. The three numbers show a bar,
 * and each says whether the system measured it or somebody typed it — a typed
 * number and a measured one look identical otherwise, and that is how a
 * dashboard starts lying.
 */
export function GoalsTab() {
  const t = useTranslations('prospecting');
  const tc = useTranslations('common');

  const [data, setData] = useState<BusinessGoalResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  /** See WeeklyUpdateTab: a load landing mid-sentence must not erase it. */
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

  const load = useCallback(async () => {
    try {
      const res = await api.get<BusinessGoalResponse>('/goals/business');
      setData(res);
      if (dirtyRef.current) return;
      setDraft({
        shortTerm: res.goal?.shortTerm ?? '',
        midTerm: res.goal?.midTerm ?? '',
        longTerm: res.goal?.longTerm ?? '',
        lifeGoal: res.goal?.lifeGoal ?? '',
        volume: res.goal?.volumeTargetMinor ? String(res.goal.volumeTargetMinor / 100) : '',
        newPartners: res.goal?.newPartnersTarget != null ? String(res.goal.newPartnersTarget) : '',
        developCustomers:
          res.goal?.developCustomersTarget != null ? String(res.goal.developCustomersTarget) : '',
        developPartners:
          res.goal?.developPartnersTarget != null ? String(res.goal.developPartnersTarget) : '',
        developCustomersActual: String(res.progress.develop.customersActual ?? 0),
        developPartnersActual: String(res.progress.develop.partnersActual ?? 0),
      });
    } catch (err: unknown) {
      if (isForbidden(err)) setForbidden(true);
      else setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty]);

  useEffect(() => {
    void load();
  }, [load]);

  const num = (v: string): number | null => (v.trim() === '' ? null : Number(v));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.put('/goals/business', {
        shortTerm: draft.shortTerm || null,
        midTerm: draft.midTerm || null,
        longTerm: draft.longTerm || null,
        lifeGoal: draft.lifeGoal || null,
        // Money is entered in whole units and stored in minor, like everywhere
        // else in the system.
        volumeTargetMinor: draft.volume?.trim() ? Math.round(Number(draft.volume) * 100) : null,
        newPartnersTarget: num(draft.newPartners ?? ''),
        developCustomersTarget: num(draft.developCustomers ?? ''),
        developPartnersTarget: num(draft.developPartners ?? ''),
        developCustomersActual: Number(draft.developCustomersActual ?? 0),
        developPartnersActual: Number(draft.developPartnersActual ?? 0),
      });
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

  const p = data.progress;
  const bar = (actual: number, target: number | null) => {
    if (!target) return null;
    const pct = Math.min(100, Math.round((actual / target) * 100));
    return (
      <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100">
        <div
          className={`h-full rounded-full ${pct >= 100 ? 'bg-brand-600' : 'bg-amber-500'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    );
  };

  const field = (key: string, label: string) => (
    <label className="flex flex-col gap-1">
      <span className="text-sm text-slate-600">{label}</span>
      <textarea
        value={draft[key] ?? ''}
        onChange={(e) => {
          setDraft({ ...draft, [key]: e.target.value });
          markDirty();
        }}
        rows={2}
        className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
      />
    </label>
  );

  const numberField = (key: string, label: string) => (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-slate-500">{label}</span>
      <input
        aria-label={label}
        inputMode="numeric"
        value={draft[key] ?? ''}
        onChange={(e) => {
          setDraft({ ...draft, [key]: e.target.value });
          markDirty();
        }}
        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
      />
    </label>
  );

  return (
    <div className="flex flex-col gap-4">
      <Card title={t('goalsThisMonth', { month: data.month.slice(0, 7) })}>
        <div className="flex flex-col gap-4">
          {/* ── the numeric half: what the system can actually help with ── */}
          <div>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-sm font-medium text-slate-700">{t('targetVolume')}</span>
              <span className="text-sm text-slate-600">
                {(p.volume.actualMinor / 100).toLocaleString()}
                {p.volume.targetMinor ? ` / ${(p.volume.targetMinor / 100).toLocaleString()}` : ''}
              </span>
            </div>
            {bar(p.volume.actualMinor, p.volume.targetMinor)}
            <p className="mt-1 text-xs text-brand-700">{t('sourceComputed')}</p>
            {numberField('volume', t('targetVolumeInput'))}
          </div>

          <div>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-sm font-medium text-slate-700">{t('targetPartners')}</span>
              <span className="text-sm text-slate-600">
                {p.newPartners.actual}
                {p.newPartners.target != null ? ` / ${p.newPartners.target}` : ''}
              </span>
            </div>
            {bar(p.newPartners.actual, p.newPartners.target)}
            <p className="mt-1 text-xs text-brand-700">{t('sourceComputed')}</p>
            {numberField('newPartners', t('targetPartnersInput'))}
          </div>

          <div>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-sm font-medium text-slate-700">{t('targetDevelop')}</span>
              <span className="text-sm text-slate-600">
                {p.develop.customersActual}+{p.develop.partnersActual}
                {p.develop.customersTarget != null
                  ? ` / ${p.develop.customersTarget}+${p.develop.partnersTarget ?? 0}`
                  : ''}
              </span>
            </div>
            {/* Said plainly: this one is not measured, it is reported. */}
            <p className="mt-1 text-xs text-amber-700">{t('sourceManual')}</p>
            <div className="mt-1 grid grid-cols-2 gap-2">
              {numberField('developCustomers', t('developCustomersTarget'))}
              {numberField('developPartners', t('developPartnersTarget'))}
              {numberField('developCustomersActual', t('developCustomersActual'))}
              {numberField('developPartnersActual', t('developPartnersActual'))}
            </div>
          </div>
        </div>
      </Card>

      <Card title={t('goalsNarrative')}>
        <div className="flex flex-col gap-3">
          {field('shortTerm', t('shortTerm'))}
          {field('midTerm', t('midTerm'))}
          {field('longTerm', t('longTerm'))}
          {field('lifeGoal', t('lifeGoal'))}
        </div>
      </Card>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      <button
        type="button"
        onClick={() => void save()}
        disabled={saving}
        className="rounded-lg bg-brand-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {t('saveGoals')}
      </button>
    </div>
  );
}
