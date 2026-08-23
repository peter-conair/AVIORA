'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { API_URL, api, ApiError } from '@/lib/api-client';
import { Card } from '@/components/ui/Card';
import type { CustomerCard as CustomerCardData, PhotoConsent, ProgressPhoto } from '@/lib/types';

const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

/**
 * The customer index card (docs/66), and the photographs it may hold (docs/65).
 *
 * Three things on this screen are deliberately awkward, and all three are the
 * point:
 *
 *  - The identity number is never shown. A button reveals it, once, and that
 *    reveal is recorded.
 *  - A month the system saw for itself cannot be clicked.
 *  - The photo section does not exist until consent does.
 */
export function CustomerCard({ customerId }: { customerId: string }) {
  const t = useTranslations('crm.card');
  const tc = useTranslations('common');
  const locale = useLocale();

  const [data, setData] = useState<CustomerCardData | null>(null);
  const [consent, setConsent] = useState<PhotoConsent | null>(null);
  const [photos, setPhotos] = useState<ProgressPhoto[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [revealed, setRevealed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirtyRef = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const [card, cons, list] = await Promise.all([
        api.get<CustomerCardData>(`/crm/customers/${customerId}/card`),
        api.get<PhotoConsent>(`/crm/customers/${customerId}/photo-consent`),
        api
          .get<{ photos: ProgressPhoto[] }>(`/crm/customers/${customerId}/photos`)
          .catch(() => ({ photos: [] })),
      ]);
      setData(card);
      setConsent(cons);
      setPhotos(list.photos);
      // Same guard as the goal and weekly sheets: a load landing mid-sentence
      // must not erase what somebody is typing.
      if (dirtyRef.current) return;
      setDraft({
        externalCode: card.customer.externalCode ?? '',
        membershipExpiresAt: card.customer.membershipExpiresAt?.slice(0, 10) ?? '',
        birthDate: card.customer.birthDate?.slice(0, 10) ?? '',
        note: card.customer.note ?? '',
        idNumber: '',
      });
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);

  useEffect(() => {
    setRevealed(null);
    void load();
  }, [load]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.put(`/crm/customers/${customerId}/card`, {
        externalCode: draft.externalCode || null,
        membershipExpiresAt: draft.membershipExpiresAt || null,
        birthDate: draft.birthDate || null,
        note: draft.note || null,
        // Only sent when something was typed: an empty box must not wipe a
        // number that is on file.
        ...(draft.idNumber?.trim() ? { idNumber: draft.idNumber.trim() } : {}),
      });
      dirtyRef.current = false;
      setDraft({ ...draft, idNumber: '' });
      await load();
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setBusy(false);
    }
  };

  const reveal = async () => {
    setBusy(true);
    try {
      const res = await api.post<{ idNumber: string }>(
        `/crm/customers/${customerId}/id-number`,
        {},
      );
      setRevealed(res.idNumber);
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setBusy(false);
    }
  };

  const toggleMonth = async (month: number, ordered: boolean) => {
    if (!data) return;
    setBusy(true);
    setError(null);
    try {
      await api.put(`/crm/customers/${customerId}/months`, { year: data.year, month, ordered });
      await load();
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setBusy(false);
    }
  };

  const setConsentTo = async (granted: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (granted) {
        await api.post(`/crm/customers/${customerId}/photo-consent`, { note: t('consentNote') });
      } else {
        await api.delete(`/crm/customers/${customerId}/photo-consent`);
      }
      await load();
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setBusy(false);
    }
  };

  const upload = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const dataBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('read failed'));
        reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
        reader.readAsDataURL(file);
      });
      await api.post(`/crm/customers/${customerId}/photos`, {
        stepKey: 'before_photo',
        contentType: file.type,
        dataBase64,
      });
      await load();
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  if (!data) return <p className="text-sm text-slate-500">{tc('loading')}</p>;

  const field = (key: string, label: string, type = 'text') => (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-slate-500">{label}</span>
      <input
        aria-label={label}
        type={type}
        value={draft[key] ?? ''}
        onChange={(e) => {
          dirtyRef.current = true;
          setDraft({ ...draft, [key]: e.target.value });
        }}
        className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
      />
    </label>
  );

  return (
    <div className="flex flex-col gap-4">
      <Card title={t('title', { name: data.customer.name })}>
        <div className="grid grid-cols-2 gap-3">
          {field('externalCode', t('externalCode'))}
          {field('membershipExpiresAt', t('expires'), 'date')}
          {field('birthDate', t('birthDate'), 'date')}
        </div>

        <div className="mt-3 rounded-lg border border-slate-200 p-3">
          <p className="text-xs text-slate-500">{t('idNumber')}</p>
          {data.customer.hasIdNumber ? (
            revealed ? (
              <p className="mt-1 font-mono text-sm text-slate-900">{revealed}</p>
            ) : (
              <div className="mt-1 flex items-center gap-2">
                <span className="font-mono text-sm text-slate-400">••••••••••</span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void reveal()}
                  className="rounded-md border border-slate-300 px-2 py-1 text-xs disabled:opacity-50"
                >
                  {t('reveal')}
                </button>
              </div>
            )
          ) : (
            <p className="mt-1 text-sm text-slate-400">{t('noIdNumber')}</p>
          )}
          {/* Said plainly, because it is true and people should know before
              they press it. */}
          <p className="mt-2 text-xs text-amber-700">{t('revealIsRecorded')}</p>
          <div className="mt-2">{field('idNumber', t('setIdNumber'))}</div>
        </div>

        <label className="mt-3 flex flex-col gap-1">
          <span className="text-xs text-slate-500">{t('note')}</span>
          <textarea
            aria-label={t('note')}
            rows={2}
            value={draft.note ?? ''}
            onChange={(e) => {
              dirtyRef.current = true;
              setDraft({ ...draft, note: e.target.value });
            }}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
        </label>

        {error ? <p className="mt-2 text-sm text-red-600">{error}</p> : null}
        <button
          type="button"
          disabled={busy}
          onClick={() => void save()}
          className="mt-3 rounded-lg bg-brand-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {t('save')}
        </button>
      </Card>

      <Card title={t('months', { year: data.year })}>
        <p className="text-sm text-slate-600">{t('orderedCount', { count: data.orderedCount })}</p>
        <div className="mt-2 grid grid-cols-6 gap-2">
          {MONTHS.map((month) => {
            const box = data.months.find((m) => m.month === month)!;
            const fromSystem = box.source === 'computed';
            return (
              <button
                key={month}
                type="button"
                // A month the system saw for itself is not somebody's to tick.
                disabled={busy || fromSystem}
                aria-pressed={box.ordered}
                aria-label={t('monthLabel', { month })}
                onClick={() => void toggleMonth(month, !box.ordered)}
                className={`rounded-md border py-2 text-xs ${
                  box.ordered
                    ? fromSystem
                      ? 'border-brand-700 bg-brand-700 text-white'
                      : 'border-brand-600 bg-brand-50 text-brand-800'
                    : 'border-slate-300 text-slate-500'
                } disabled:opacity-100`}
              >
                {month}
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-xs text-slate-500">{t('monthsLegend')}</p>
      </Card>

      <Card title={t('photos')}>
        {!consent?.granted ? (
          <>
            {/* No consent, no photo section. Not a disabled uploader — nothing
                to press at all (docs/65 §2). */}
            <p className="text-sm text-slate-600">{t('needConsent')}</p>
            <button
              type="button"
              disabled={busy}
              onClick={() => void setConsentTo(true)}
              className="mt-2 rounded-lg bg-brand-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {t('recordConsent')}
            </button>
          </>
        ) : (
          <>
            <p className="text-sm text-brand-800">{t('consentOn')}</p>
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              aria-label={t('addPhoto')}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void upload(file);
              }}
              className="mt-2 block w-full text-sm"
            />
            {photos.length > 0 ? (
              <ul className="mt-3 grid grid-cols-3 gap-2">
                {photos.map((photo) => (
                  <li key={photo.id}>
                    {/* The API's own origin, not this app's — a relative path
                        here would ask the web server for a photograph it has
                        never heard of. The route is authenticated and the
                        cookie travels because the two hosts are same-site. */}
                    <img
                      src={`${API_URL}/photos/${photo.id}/content`}
                      alt={new Date(photo.takenAt).toLocaleDateString(locale)}
                      className="aspect-square w-full rounded-lg object-cover"
                    />
                  </li>
                ))}
              </ul>
            ) : null}
            <button
              type="button"
              disabled={busy}
              onClick={() => void setConsentTo(false)}
              className="mt-3 rounded-lg border border-red-300 px-3 py-1.5 text-sm text-red-700 disabled:opacity-50"
            >
              {t('withdrawConsent', { count: photos.length })}
            </button>
            {/* The consequence, before they press it — not after. */}
            <p className="mt-1 text-xs text-red-700">{t('withdrawDeletes')}</p>
          </>
        )}
      </Card>
    </div>
  );
}
