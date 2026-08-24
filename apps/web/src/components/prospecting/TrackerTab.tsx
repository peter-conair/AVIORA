'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { api, ApiError, isForbidden } from '@/lib/api-client';
import { Card } from '@/components/ui/Card';
import type { TrackerSheet, TrackerSheetList, TrackerStalled } from '@/lib/types';

/**
 * Any tracking sheet, on a phone (docs/59 §6).
 *
 * One component for all three, because they are one primitive — it never names
 * a column. The paper is a wide grid of ticks; forty columns cannot honestly be
 * shown at 360 px, so each person becomes a card with their steps as chips,
 * grouped by the stage bands the paper draws.
 *
 * What is deliberately kept from the paper: you can see one person's whole row
 * at once. What is deliberately added: the date a tick happened, and therefore
 * who has stopped.
 */
export function TrackerTab() {
  const t = useTranslations('prospecting');
  const tc = useTranslations('common');
  const locale = useLocale();

  const [sheets, setSheets] = useState<TrackerSheetList['templates']>([]);
  const [code, setCode] = useState<string | null>(null);
  const [sheet, setSheet] = useState<TrackerSheet | null>(null);
  const [stalled, setStalled] = useState<TrackerStalled | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<{ id: string; name: string }[]>([]);
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    api
      .get<TrackerSheetList>(`/tracker/sheets?locale=${locale}`)
      .then((res) => {
        setSheets(res.templates);
        setCode((c) => c ?? res.templates[0]?.code ?? null);
      })
      .catch((err: unknown) => {
        if (isForbidden(err)) setForbidden(true);
        else setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locale]);

  const load = useCallback(async () => {
    if (!code) return;
    try {
      const [s, st] = await Promise.all([
        api.get<TrackerSheet>(`/tracker/sheets/${code}?locale=${locale}`),
        api.get<TrackerStalled>(`/tracker/stalled?locale=${locale}`),
      ]);
      setSheet(s);
      setStalled(st);
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, locale]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Who could be put on this sheet.
   *
   * Which list to read is the sheet's own `subjectType` — the component still
   * never names a sheet, so a tenant's own template works the same way.
   */
  const loadCandidates = async () => {
    if (!sheet) return;
    setPicking(true);
    try {
      const already = new Set(sheet.entries.map((e) => e.subjectId));
      const path =
        sheet.template.subjectType === 'member'
          ? '/members'
          : sheet.template.subjectType === 'customer'
            ? '/crm/customers'
            : '/crm/leads';
      const res =
        await api.get<Record<string, { id: string; name?: string; displayName?: string }[]>>(path);
      const rows = res.members ?? res.customers ?? res.leads ?? [];
      setCandidates(
        rows
          .filter((r) => !already.has(r.id))
          .map((r) => ({ id: r.id, name: r.displayName ?? r.name ?? '—' })),
      );
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    }
  };

  const addToSheet = async (subjectId: string) => {
    if (!code) return;
    setBusy(subjectId);
    try {
      await api.post(`/tracker/sheets/${code}/entries`, { subjectId });
      setPicking(false);
      setCandidates([]);
      await load();
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (entryId: string, stepId: string, done: boolean, value?: number) => {
    setBusy(entryId + stepId);
    try {
      await api.put(`/tracker/entries/${entryId}/marks`, {
        stepId,
        done,
        ...(value === undefined ? {} : { value }),
      });
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

  // Stage order comes from the server in COLUMN order; sorting here would put
  // "day 14" before "day 4".
  const stageOf = (stageLabel: string | null) => stageLabel ?? '';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-1 overflow-x-auto rounded-xl border border-slate-200 bg-white p-1">
        {sheets.map((s) => (
          <button
            key={s.code}
            type="button"
            onClick={() => setCode(s.code)}
            className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium ${
              code === s.code ? 'bg-brand-700 text-white' : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            {s.name}
          </button>
        ))}
      </div>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      <Card>
        {picking ? (
          candidates.length === 0 ? (
            <p className="text-sm text-slate-500">{t('nobodyToAdd')}</p>
          ) : (
            <ul className="flex max-h-64 flex-col divide-y divide-slate-100 overflow-y-auto">
              {candidates.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    disabled={busy === c.id}
                    onClick={() => void addToSheet(c.id)}
                    className="w-full rounded-lg px-2 py-2 text-left text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  >
                    {c.name}
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : (
          <button
            type="button"
            onClick={() => void loadCandidates()}
            className="rounded-lg bg-brand-700 px-4 py-2 text-sm font-medium text-white"
          >
            {t('addToSheet')}
          </button>
        )}
      </Card>

      {stalled && stalled.stalled.length > 0 ? (
        <Card title={t('stalledTitle', { days: stalled.days })}>
          {/* The thing the paper cannot do: not "who has done the most", but
              "who was moving and stopped". */}
          <ul className="flex flex-col divide-y divide-slate-100">
            {stalled.stalled.slice(0, 8).map((row) => (
              <li key={row.entryId} className="flex items-center justify-between gap-2 py-2">
                <span className="min-w-0 truncate text-sm text-slate-700">
                  {row.subjectName ?? '—'}
                  <span className="ml-2 text-xs text-slate-400">{row.sheet}</span>
                </span>
                <span className="shrink-0 text-xs text-amber-700">
                  {row.neverStarted ? t('neverStarted') : t('lastMoved')}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {!sheet || sheet.entries.length === 0 ? (
        <Card>
          <p className="text-sm text-slate-500">{t('trackerEmpty')}</p>
        </Card>
      ) : (
        <ul className="flex flex-col gap-2">
          {sheet.entries.map((entry) => {
            const done = new Set(entry.done);
            const isOpen = open === entry.id;
            return (
              <li key={entry.id}>
                <Card>
                  <button
                    type="button"
                    onClick={() => setOpen(isOpen ? null : entry.id)}
                    aria-expanded={isOpen}
                    className="flex w-full items-baseline justify-between gap-2 text-left"
                  >
                    <span className="min-w-0 truncate font-medium text-slate-800">
                      {entry.groupLabel ? (
                        <span className="mr-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">
                          {entry.groupLabel}
                        </span>
                      ) : null}
                      {entry.subjectName ?? '—'}
                    </span>
                    <span className="shrink-0 text-sm font-semibold text-brand-700">
                      {entry.doneCount} / {entry.stepCount}
                    </span>
                  </button>
                  {/* The result, not the activity. A customer on a six-week
                      programme came for this number (docs/64 §3). */}
                  {Object.entries(entry.change ?? {}).length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {Object.entries(entry.change).map(([unit, c]) => (
                        <span
                          key={unit}
                          className={`rounded-full px-2 py-0.5 text-xs ${
                            c.delta < 0
                              ? 'bg-brand-50 text-brand-800'
                              : c.delta > 0
                                ? 'bg-amber-50 text-amber-800'
                                : 'bg-slate-100 text-slate-600'
                          }`}
                        >
                          {c.first} → {c.latest} {unit}
                          {c.delta !== 0 ? ` (${c.delta > 0 ? '+' : ''}${c.delta})` : ''}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className="h-full rounded-full bg-brand-600"
                      style={{
                        width: `${Math.round((entry.doneCount / Math.max(entry.stepCount, 1)) * 100)}%`,
                      }}
                    />
                  </div>

                  {isOpen ? (
                    <div className="mt-3 flex flex-col gap-3">
                      {[...new Set(sheet.steps.map((s) => stageOf(s.stageLabel)))].map((stage) => (
                        <div key={stage || 'none'}>
                          {stage ? (
                            <p className="mb-1 text-xs font-medium text-slate-500">{stage}</p>
                          ) : null}
                          <div className="flex flex-wrap gap-1.5">
                            {sheet.steps
                              .filter((s) => stageOf(s.stageLabel) === stage)
                              .map((step) => {
                                const ticked = done.has(step.id);
                                if (step.captureUnit) {
                                  // A number, because a tick here would record
                                  // that the scales were used and throw away
                                  // what they said.
                                  return (
                                    <MeasureField
                                      key={step.id}
                                      step={step}
                                      value={entry.values?.[step.id]}
                                      disabled={busy === entry.id + step.id}
                                      onSave={(n) => void toggle(entry.id, step.id, true, n)}
                                    />
                                  );
                                }
                                return (
                                  <button
                                    key={step.id}
                                    type="button"
                                    disabled={busy === entry.id + step.id}
                                    aria-pressed={ticked}
                                    aria-label={`${entry.subjectName} — ${step.label}`}
                                    onClick={() => void toggle(entry.id, step.id, !ticked)}
                                    className={`rounded-full px-2.5 py-1 text-xs disabled:opacity-50 ${
                                      ticked
                                        ? 'bg-brand-600 text-white'
                                        : 'border border-slate-300 text-slate-600'
                                    }`}
                                  >
                                    {step.label}
                                  </button>
                                );
                              })}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * One measurement column (docs/64 §2).
 *
 * Committed on blur rather than on every keystroke: a weigh-in typed as "7",
 * "76", "76.", "76.5" would otherwise write four readings, and the first three
 * are wrong.
 */
function MeasureField({
  step,
  value,
  disabled,
  onSave,
}: {
  step: { id: string; label: string; captureUnit: string | null };
  value: number | undefined;
  disabled: boolean;
  onSave: (value: number) => void;
}) {
  const [draft, setDraft] = useState(value === undefined ? '' : String(value));

  useEffect(() => {
    setDraft(value === undefined ? '' : String(value));
  }, [value]);

  const commit = () => {
    const n = Number(draft);
    if (draft.trim() === '' || Number.isNaN(n) || n === value) return;
    onSave(n);
  };

  return (
    <label className="flex items-center gap-1 rounded-full border border-slate-300 px-2 py-1 text-xs">
      <span className="text-slate-600">{step.label}</span>
      <input
        aria-label={`${step.label} (${step.captureUnit})`}
        inputMode="decimal"
        disabled={disabled}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        className="w-14 rounded border border-slate-200 px-1 py-0.5 text-right disabled:opacity-50"
      />
      <span className="text-slate-400">{step.captureUnit}</span>
    </label>
  );
}
