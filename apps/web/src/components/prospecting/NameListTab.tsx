'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { NAME_LIST_TARGET, PROSPECT_SCORE_MAX, PROSPECT_SCORE_MIN } from '@aviora/shared';
import { api, ApiError, isForbidden } from '@/lib/api-client';
import { Card } from '@/components/ui/Card';
import type { NameListResponse, NameListEntry } from '@/lib/types';

/**
 * One of the two paper name lists, on a phone (docs/56 §5).
 *
 * The sheet is a wide grid, which a 360 px screen cannot honestly show. So the
 * grid becomes one card per person with the criteria as a row of small
 * selects — the same columns, stacked. Nothing is dropped: on paper the
 * salesperson can see every rating for one name at once, and that is what this
 * preserves.
 */
export function NameListTab({ list }: { list: 'sponsor' | 'customer' }) {
  const t = useTranslations('prospecting');
  const tc = useTranslations('common');
  const locale = useLocale();

  const [data, setData] = useState<NameListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [name, setName] = useState('');
  const [adding, setAdding] = useState(false);
  const [duplicateOwner, setDuplicateOwner] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get<NameListResponse>(`/crm/name-list/${list}?locale=${locale}`));
    } catch (err: unknown) {
      if (isForbidden(err)) setForbidden(true);
      else setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, locale]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  const add = async (allowDuplicate: boolean) => {
    if (!name.trim()) return;
    setAdding(true);
    setError(null);
    try {
      await api.post('/crm/leads', {
        name: name.trim(),
        [list === 'sponsor' ? 'onSponsorList' : 'onCustomerList']: true,
        ...(allowDuplicate ? { allowDuplicate: true } : {}),
      });
      setName('');
      setDuplicateOwner(null);
      await load();
    } catch (err: unknown) {
      if (err instanceof ApiError && err.code === 'CONFLICT') {
        setDuplicateOwner(
          (err.details as { ownerName?: string } | undefined)?.ownerName ?? t('someoneElse'),
        );
        return;
      }
      setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setAdding(false);
    }
  };

  const rate = async (entry: NameListEntry, key: string, value: number) => {
    setPending(entry.id);
    try {
      await api.patch(`/crm/leads/${entry.id}/scores`, { scores: { [key]: value } });
      await load();
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setPending(null);
    }
  };

  const handleAdd = (e: FormEvent) => {
    e.preventDefault();
    setDuplicateOwner(null);
    void add(false);
  };

  if (forbidden) {
    return (
      <Card>
        <p className="text-sm text-slate-600">{t('forbidden')}</p>
      </Card>
    );
  }

  const filled = data?.filled ?? 0;
  const pct = Math.min(100, Math.round((filled / NAME_LIST_TARGET) * 100));

  return (
    <div className="flex flex-col gap-4">
      <Card>
        {/* The sheet's twenty rows are the exercise, so the gap is the headline
            rather than a number to work out from a list length. */}
        <div className="flex items-baseline justify-between">
          <p className="text-sm font-medium text-slate-700">{t(`lists.${list}`)}</p>
          <p className="text-sm text-slate-500">
            {t('progress', { filled, target: NAME_LIST_TARGET })}
          </p>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100">
          <div
            className={`h-full rounded-full ${pct >= 100 ? 'bg-brand-600' : 'bg-amber-500'}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        {data && data.remaining > 0 ? (
          <p className="mt-2 text-sm text-amber-700">{t('remaining', { count: data.remaining })}</p>
        ) : null}

        <form onSubmit={handleAdd} className="mt-4 flex flex-wrap gap-2">
          <input
            aria-label={t('addName')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('addPlaceholder')}
            className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
          <button
            type="submit"
            disabled={adding || !name.trim()}
            className="rounded-lg bg-brand-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {t('add')}
          </button>
        </form>
        {duplicateOwner ? (
          <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-3">
            <p className="text-sm text-amber-900">
              {t('duplicateWarning', { owner: duplicateOwner })}
            </p>
            <button
              type="button"
              onClick={() => void add(true)}
              disabled={adding}
              className="mt-2 rounded-md border border-amber-400 px-3 py-1.5 text-sm font-medium text-amber-900 disabled:opacity-50"
            >
              {t('addAnyway')}
            </button>
          </div>
        ) : null}
        {error ? <p className="mt-2 text-sm text-red-600">{error}</p> : null}
      </Card>

      {loading ? (
        <p className="text-sm text-slate-500">{tc('loading')}</p>
      ) : !data || data.entries.length === 0 ? (
        <Card>
          <p className="text-sm text-slate-500">{t('emptyList')}</p>
        </Card>
      ) : (
        <ul className="flex flex-col gap-2">
          {data.entries.map((entry, index) => (
            <li key={entry.id}>
              <Card>
                <div className="flex items-baseline justify-between gap-2">
                  <p className="min-w-0 truncate font-medium text-slate-800">
                    <span className="mr-2 text-slate-400">{index + 1}.</span>
                    {entry.name}
                  </p>
                  <p
                    className={`shrink-0 text-sm font-semibold ${
                      entry.rated ? 'text-brand-700' : 'text-slate-400'
                    }`}
                  >
                    {/* Unrated shows a dash, not a zero — a sheet of names all
                        tied at nought is indistinguishable from a sheet of
                        people you rated badly. */}
                    {entry.rated ? `${entry.score} / ${data.scoreMax}` : t('notRated')}
                  </p>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {data.criteria.map((criterion) => (
                    <label key={criterion.key} className="flex flex-col gap-1">
                      <span className="text-xs text-slate-500">{criterion.label}</span>
                      <select
                        aria-label={`${entry.name} — ${criterion.label}`}
                        disabled={pending === entry.id}
                        value={entry.scores?.[criterion.key] ?? ''}
                        onChange={(e) => void rate(entry, criterion.key, Number(e.target.value))}
                        className="rounded-md border border-slate-300 px-2 py-1 text-sm disabled:opacity-50"
                      >
                        <option value="">–</option>
                        {Array.from(
                          { length: PROSPECT_SCORE_MAX - PROSPECT_SCORE_MIN + 1 },
                          (_, i) => PROSPECT_SCORE_MIN + i,
                        ).map((n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
