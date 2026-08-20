'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { api, ApiError, isForbidden, issueFor, validationIssues } from '@/lib/api-client';
import {
  LEGAL_KINDS,
  isLegalKind,
  type LegalDocument,
  type LegalDocumentsResponse,
  type LegalKind,
  type LegalPublishResponse,
} from '@/lib/types';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { formatDateTime } from '@/lib/format';

const LOCALE_PATTERN = '[a-z]{2}(-[A-Z]{2})?';
const COUNTRY_PATTERN = '[A-Za-z]{2}';

/** One (kind, locale, country) line, newest version first. */
interface DocumentSeries {
  key: string;
  kind: string;
  locale: string;
  country: string | null;
  versions: LegalDocument[];
}

function toSeries(documents: readonly LegalDocument[]): DocumentSeries[] {
  const byKey = new Map<string, DocumentSeries>();
  for (const doc of documents) {
    const key = `${doc.kind}|${doc.locale}|${doc.country ?? ''}`;
    const series = byKey.get(key);
    if (series) series.versions.push(doc);
    else
      byKey.set(key, {
        key,
        kind: doc.kind,
        locale: doc.locale,
        country: doc.country,
        versions: [doc],
      });
  }
  for (const series of byKey.values()) series.versions.sort((a, b) => b.version - a.version);
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Versioned legal documents (docs/29 §3).
 *
 * Two things this screen refuses to soften:
 *
 * - EVERY version is listed, including superseded ones, with the body readable.
 *   Keeping an old version and then hiding it would defeat the point of keeping
 *   it: somebody accepted that text and has to be able to read what they agreed
 *   to.
 * - There is no edit. Publishing again is version N+1, and the form says so,
 *   because an administrator who expects "save" and gets a new version will
 *   otherwise think something went wrong.
 */
export function LegalTab() {
  const t = useTranslations('admin.legal');
  const tc = useTranslations('common');
  const locale = useLocale();

  const [documents, setDocuments] = useState<LegalDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const [kind, setKind] = useState<LegalKind>('terms');
  const [docLocale, setDocLocale] = useState(locale);
  const [country, setCountry] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [published, setPublished] = useState<LegalDocument | null>(null);
  const [issues, setIssues] = useState<ReturnType<typeof validationIssues>>([]);

  const load = useCallback(async () => {
    const res = await api.get<LegalDocumentsResponse>('/legal/documents');
    setDocuments(res.documents);
  }, []);

  useEffect(() => {
    let cancelled = false;
    load()
      .catch((err: unknown) => {
        if (cancelled) return;
        if (isForbidden(err)) setForbidden(true);
        else setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const series = useMemo(() => toSeries(documents), [documents]);

  const kindLabel = (value: string): string => (isLegalKind(value) ? t(`kinds.${value}`) : value);

  const handlePublish = async (e: FormEvent) => {
    e.preventDefault();
    setPublishError(null);
    setIssues([]);
    setPublished(null);
    setPublishing(true);
    try {
      const payload: Record<string, unknown> = { kind, locale: docLocale, title, body };
      // Omitted means "every country"; a value means this version is that
      // country's. An empty string is neither.
      if (country) payload.country = country.toUpperCase();
      const res = await api.post<LegalPublishResponse>('/legal/documents', payload);
      setPublished(res.document);
      setBody('');
      await load();
    } catch (err: unknown) {
      if (isForbidden(err)) setPublishError(t('forbidden'));
      else {
        setIssues(validationIssues(err));
        setPublishError(err instanceof ApiError ? err.message : tc('errorGeneric'));
      }
    } finally {
      setPublishing(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      <Card title={t('listTitle')}>
        <p className="mb-3 text-xs text-slate-500">{t('listHint')}</p>
        {forbidden ? (
          <p className="text-sm text-slate-600">{t('forbidden')}</p>
        ) : loading ? (
          <p className="text-sm text-slate-500">{tc('loading')}</p>
        ) : series.length === 0 ? (
          <p className="text-sm text-slate-500">{t('listEmpty')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-slate-100">
            {series.map((entry) => (
              <li key={entry.key} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span className="text-sm font-semibold text-slate-800">
                    {kindLabel(entry.kind)}
                  </span>
                  <span className="font-mono text-xs text-slate-500">{entry.locale}</span>
                  <span className="text-xs text-slate-500">{entry.country ?? t('countryAny')}</span>
                </div>
                <ul className="flex flex-col gap-2">
                  {entry.versions.map((doc, index) => {
                    const open = openId === doc.id;
                    return (
                      <li
                        key={doc.id}
                        className="flex flex-col gap-1 rounded-lg border border-slate-200 p-3"
                      >
                        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                          <span className="min-w-0 break-words text-sm text-slate-800">
                            {doc.title}
                          </span>
                          <Badge tone={index === 0 ? 'teal' : 'gray'}>
                            {index === 0 ? t('currentVersion') : t('supersededVersion')}
                          </Badge>
                        </div>
                        <span className="block break-words text-xs text-slate-500">
                          {t('versionLine', {
                            version: doc.version,
                            published: formatDateTime(doc.publishedAt, locale),
                          })}
                          {' · '}
                          {t('acceptedBy', { count: doc._count?.acceptances ?? 0 })}
                        </span>
                        <div>
                          <button
                            type="button"
                            aria-expanded={open}
                            onClick={() => setOpenId(open ? null : doc.id)}
                            className="rounded-lg px-2 py-1 text-xs font-medium text-teal-800 hover:bg-teal-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700"
                          >
                            {open ? t('hideBody') : t('readBody')}
                          </button>
                        </div>
                        {open ? (
                          // Plain text by contract — rendered as text, never as
                          // markup, whatever a tenant typed into it.
                          <p className="whitespace-pre-wrap break-words rounded-lg bg-slate-50 p-3 text-sm text-slate-700">
                            {doc.body}
                          </p>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {forbidden ? null : (
        <Card title={t('publishTitle')}>
          <p className="mb-3 text-xs text-slate-500">{t('publishHint')}</p>
          <form onSubmit={handlePublish} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Select
              label={t('kind')}
              required
              value={kind}
              onChange={(e) => setKind(e.target.value as LegalKind)}
            >
              {LEGAL_KINDS.map((option) => (
                <option key={option} value={option}>
                  {t(`kinds.${option}`)}
                </option>
              ))}
            </Select>
            <Input
              label={t('locale')}
              required
              pattern={LOCALE_PATTERN}
              maxLength={5}
              hint={t('localeHint')}
              value={docLocale}
              error={issueFor(issues, 'locale')}
              onChange={(e) => setDocLocale(e.target.value)}
            />
            <Input
              label={t('country')}
              pattern={COUNTRY_PATTERN}
              maxLength={2}
              hint={t('countryHint')}
              className="sm:col-span-2"
              value={country}
              error={issueFor(issues, 'country')}
              onChange={(e) => setCountry(e.target.value.toUpperCase())}
            />
            <Input
              label={t('title')}
              required
              maxLength={200}
              className="sm:col-span-2"
              value={title}
              error={issueFor(issues, 'title')}
              onChange={(e) => setTitle(e.target.value)}
            />
            <Textarea
              label={t('body')}
              required
              rows={12}
              maxLength={200_000}
              hint={t('bodyHint')}
              className="sm:col-span-2 font-mono"
              value={body}
              error={issueFor(issues, 'body')}
              onChange={(e) => setBody(e.target.value)}
            />
            {publishError ? (
              <p className="text-sm text-red-600 sm:col-span-2">{publishError}</p>
            ) : null}
            {issues.length > 0 ? (
              <ul className="flex flex-col gap-1 sm:col-span-2">
                {issues.map((issue, index) => (
                  <li key={`${issue.path}-${index}`} className="break-words text-xs text-red-600">
                    {issue.path ? `${issue.path}: ` : ''}
                    {issue.message}
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
              <Button type="submit" disabled={publishing}>
                {publishing ? tc('saving') : t('submit')}
              </Button>
              {published ? (
                <span className="text-sm text-teal-700">
                  {t('publishedNote', {
                    kind: kindLabel(published.kind),
                    version: published.version,
                  })}
                </span>
              ) : null}
            </div>
          </form>
        </Card>
      )}
    </div>
  );
}
