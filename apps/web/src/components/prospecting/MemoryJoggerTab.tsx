'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { api, ApiError, isForbidden } from '@/lib/api-client';
import { Card } from '@/components/ui/Card';
import type { MemoryJoggerResponse } from '@/lib/types';

/**
 * The Memory Jogger (docs/56 §4).
 *
 * "Write twenty names" produces four. This asks who cuts your hair and who
 * sold you your car instead, and the names arrive as a side effect — so the
 * prompt is the thing on screen, and adding a name happens inline underneath
 * it rather than on a separate form the salesperson has to navigate to and
 * lose their place.
 */
export function MemoryJoggerTab({ onAdded }: { onAdded?: () => void }) {
  const t = useTranslations('prospecting');
  const tc = useTranslations('common');
  const locale = useLocale();

  const [data, setData] = useState<MemoryJoggerResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.get<MemoryJoggerResponse>(`/crm/memory-jogger?locale=${locale}`));
    } catch (err: unknown) {
      if (isForbidden(err)) setForbidden(true);
      else setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locale]);

  useEffect(() => {
    void load();
  }, [load]);

  const addName = async (promptKey: string) => {
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await api.post('/crm/leads', {
        name: name.trim(),
        joggerPrompt: promptKey,
        // A name from the jogger goes onto both sheets by default. Deciding
        // which list somebody belongs on is the NEXT exercise; forcing the
        // choice here is what stops people writing the name down at all.
        onSponsorList: true,
        onCustomerList: true,
      });
      setName('');
      await load();
      onAdded?.();
    } catch (err: unknown) {
      setError(
        err instanceof ApiError && err.code === 'CONFLICT'
          ? t('alreadyOnList')
          : err instanceof ApiError
            ? err.message
            : tc('errorGeneric'),
      );
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

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <p className="text-sm text-slate-600">{t('joggerIntro')}</p>
        <p className="mt-1 text-sm font-medium text-slate-800">
          {t('joggerTotal', { count: data?.total ?? 0 })}
        </p>
      </Card>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      {data?.categories.map((category) => (
        <Card key={category.key} title={category.label}>
          <ul className="flex flex-col divide-y divide-slate-100">
            {category.prompts.map((prompt) => {
              const isOpen = open === prompt.key;
              return (
                <li key={prompt.key} className="py-1">
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(isOpen ? null : prompt.key);
                      setName('');
                    }}
                    aria-expanded={isOpen}
                    className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-2 text-left text-sm hover:bg-slate-50"
                  >
                    <span className="min-w-0 text-slate-700">{prompt.label}</span>
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${
                        prompt.named > 0
                          ? 'bg-teal-50 text-teal-700'
                          : 'bg-slate-100 text-slate-400'
                      }`}
                    >
                      {prompt.named}
                    </span>
                  </button>
                  {isOpen ? (
                    <div className="flex flex-wrap gap-2 px-2 pb-2">
                      <input
                        aria-label={t('addName')}
                        autoFocus
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder={t('addPlaceholder')}
                        className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
                      />
                      <button
                        type="button"
                        disabled={saving || !name.trim()}
                        onClick={() => void addName(prompt.key)}
                        className="rounded-lg bg-teal-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                      >
                        {t('add')}
                      </button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </Card>
      ))}
    </div>
  );
}
