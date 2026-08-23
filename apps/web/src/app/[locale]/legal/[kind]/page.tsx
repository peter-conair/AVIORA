'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { api, ApiError } from '@/lib/api-client';
import {
  isLegalKind,
  type LegalAcceptancesResponse,
  type LegalAcceptanceRecord,
  type LegalAcceptResponse,
  type LegalCurrentResponse,
  type LegalDocument,
} from '@/lib/types';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { formatDateTime } from '@/lib/format';

/**
 * A tenant's current legal document, and the record of accepting it
 * (docs/29 §3).
 *
 * The page is PUBLIC — a terms page nobody can read without an account is not a
 * terms page — so it lives outside the member shell and asks for the acceptance
 * list in a way that treats 401 as "nobody is signed in" rather than as a
 * reason to eject the reader to a sign-in screen.
 *
 * The accept button names the VERSION it is accepting, and the page lists what
 * this member accepted before. "You agreed to the terms" is worthless evidence
 * if nobody can say which terms, and that is as true on the screen as it is in
 * the database.
 */
export default function LegalPage() {
  const t = useTranslations('legalPage');
  const tc = useTranslations('common');
  const locale = useLocale();
  const params = useParams<{ kind: string }>();
  const rawKind = typeof params.kind === 'string' ? params.kind : '';

  const [doc, setDoc] = useState<LegalDocument | null>(null);
  const [resolvedFor, setResolvedFor] = useState<{
    locale: string;
    country: string | null;
  } | null>(null);
  const [acceptances, setAcceptances] = useState<LegalAcceptanceRecord[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [accepting, setAccepting] = useState(false);
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<LegalAcceptResponse | null>(null);

  const known = isLegalKind(rawKind);

  const loadAcceptances = useCallback(async () => {
    try {
      // A 401 here is the answer "nobody is signed in", not a failure: the
      // reader still gets the document, just without an accept button.
      const res = await api.getAnonymousOk<LegalAcceptancesResponse>('/legal/acceptances');
      setAcceptances(res.acceptances);
    } catch {
      setAcceptances(null);
    }
  }, []);

  useEffect(() => {
    if (!known) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    api
      .get<LegalCurrentResponse>(`/legal/${rawKind}?locale=${encodeURIComponent(locale)}`)
      .then((res) => {
        if (cancelled) return;
        setDoc(res.document);
        setResolvedFor(res.resolvedFor);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    void loadAcceptances();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawKind, locale, known]);

  const signedIn = acceptances !== null;

  /** What this member accepted of THIS kind before — newest first, as returned. */
  const priorForKind = useMemo(
    () => (acceptances ?? []).filter((entry) => entry.document.kind === rawKind),
    [acceptances, rawKind],
  );

  const alreadyOnThisVersion = useMemo(
    () => priorForKind.some((entry) => entry.document.id === doc?.id),
    [priorForKind, doc],
  );

  const handleAccept = async () => {
    if (!doc) return;
    setAcceptError(null);
    setAccepting(true);
    try {
      // The id of what is ON SCREEN travels with the request. If a new version
      // was published while this page was open, the record must say which text
      // was read — not which text is current now.
      const res = await api.post<LegalAcceptResponse>(`/legal/${rawKind}/accept`, {
        documentId: doc.id,
        locale,
      });
      setAccepted(res);
      await loadAcceptances();
    } catch (err: unknown) {
      setAcceptError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setAccepting(false);
    }
  };

  const kindLabel = known ? t(`kinds.${rawKind}`) : rawKind;

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link href="/dashboard" className="text-lg font-bold tracking-tight text-brand-700">
          AVIORA
        </Link>
        <Link
          href={`/legal/${rawKind}`}
          locale={locale === 'th' ? 'en' : 'th'}
          className="rounded-lg border border-slate-300 px-2 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
        >
          {locale === 'th' ? 'EN' : 'ไทย'}
        </Link>
      </div>

      {!known ? (
        <Card title={t('unknownTitle')}>
          <p className="text-sm text-slate-600">{t('unknownBody', { kind: rawKind })}</p>
        </Card>
      ) : loading ? (
        <p className="text-sm text-slate-500">{tc('loading')}</p>
      ) : error || !doc ? (
        <Card title={kindLabel}>
          <p className="text-sm text-slate-600">{error ?? t('notPublished')}</p>
        </Card>
      ) : (
        <>
          <Card
            title={doc.title}
            actions={<Badge tone="teal">{t('versionBadge', { version: doc.version })}</Badge>}
          >
            <p className="mb-3 break-words text-xs text-slate-500">
              {t('metaLine', {
                kind: kindLabel,
                published: formatDateTime(doc.publishedAt, locale),
              })}
              {resolvedFor
                ? ` · ${t('resolvedFor', {
                    locale: resolvedFor.locale,
                    country: resolvedFor.country ?? t('countryAny'),
                  })}`
                : ''}
            </p>
            {/* Plain text by contract: rendered as text, never as markup. */}
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-800">
              {doc.body}
            </p>
          </Card>

          {signedIn ? (
            <Card title={t('acceptTitle')}>
              <p className="mb-3 break-words text-sm text-slate-700">
                {t('acceptingVersion', { version: doc.version, title: doc.title })}
              </p>

              {priorForKind.length === 0 ? (
                <p className="mb-3 text-xs text-slate-500">{t('noPriorAcceptance')}</p>
              ) : (
                <div className="mb-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                    {t('priorTitle')}
                  </p>
                  <ul className="mt-1 flex flex-col gap-1">
                    {priorForKind.map((entry) => (
                      <li key={entry.id} className="break-words text-xs text-slate-600">
                        {t('priorLine', {
                          version: entry.document.version,
                          title: entry.document.title,
                          accepted: formatDateTime(entry.acceptedAt, locale),
                        })}
                        {entry.document.id === doc.id ? ` · ${t('priorIsCurrent')}` : ''}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {acceptError ? <p className="mb-2 text-sm text-red-600">{acceptError}</p> : null}
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  onClick={handleAccept}
                  disabled={accepting || alreadyOnThisVersion}
                >
                  {accepting ? tc('saving') : t('acceptAction', { version: doc.version })}
                </Button>
                {alreadyOnThisVersion && !accepted ? (
                  <span className="text-sm text-slate-600">{t('alreadyOnThisVersion')}</span>
                ) : null}
                {accepted ? (
                  <span className="text-sm text-brand-700">
                    {accepted.alreadyAccepted
                      ? t('acceptedAlready', { version: accepted.acceptance.version })
                      : t('acceptedNow', {
                          version: accepted.acceptance.version,
                          at: formatDateTime(accepted.acceptance.acceptedAt, locale),
                        })}
                  </span>
                ) : null}
              </div>
            </Card>
          ) : (
            <Card title={t('acceptTitle')}>
              <p className="text-sm text-slate-600">{t('signInToAccept')}</p>
              <div className="mt-3">
                <Link
                  href="/sign-in"
                  className="inline-flex rounded-lg bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-800"
                >
                  {t('signInAction')}
                </Link>
              </div>
            </Card>
          )}
        </>
      )}
    </main>
  );
}
