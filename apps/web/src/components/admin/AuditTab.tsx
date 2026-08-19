'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { api, ApiError, isForbidden } from '@/lib/api-client';
import type { AuditActionsResponse, AuditLogEntry, AuditLogsResponse } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Select } from '@/components/ui/Select';
import { formatDateTime, shortId } from '@/lib/format';

const PAGE_SIZE = 25;

function toJson(value: unknown): string {
  if (value === null || value === undefined) return '—';
  return JSON.stringify(value, null, 2);
}

export function AuditTab() {
  const t = useTranslations('admin.audit');
  const tc = useTranslations('common');
  const locale = useLocale();

  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [actions, setActions] = useState<{ action: string; count: number }[]>([]);
  const [actionFilter, setActionFilter] = useState('');
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const buildPath = useCallback(
    (cursor: string | null): string => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (actionFilter) params.set('action', actionFilter);
      if (cursor) params.set('cursor', cursor);
      return `/audit-logs?${params.toString()}`;
    },
    [actionFilter],
  );

  useEffect(() => {
    let cancelled = false;
    api
      .get<AuditActionsResponse>('/audit-logs/actions')
      .then((res) => {
        if (!cancelled) setActions(res.actions);
      })
      .catch(() => {
        // The filter simply stays empty when the catalog is unavailable.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setExpandedId(null);
    api
      .get<AuditLogsResponse>(buildPath(null))
      .then((res) => {
        if (cancelled) return;
        setEntries(res.auditLogs);
        setNextCursor(res.nextCursor);
        setError(null);
      })
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
  }, [buildPath]);

  const handleLoadMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const res = await api.get<AuditLogsResponse>(buildPath(nextCursor));
      setEntries((current) => [...current, ...res.auditLogs]);
      setNextCursor(res.nextCursor);
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setLoadingMore(false);
    }
  };

  if (forbidden) {
    return (
      <Card>
        <p className="text-sm text-slate-600">{t('forbidden')}</p>
      </Card>
    );
  }

  return (
    <Card
      title={t('title')}
      actions={
        <div className="w-48">
          <Select
            aria-label={t('action')}
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
          >
            <option value="">{t('allActions')}</option>
            {actions.map(({ action, count }) => (
              <option key={action} value={action}>
                {t('actionWithCount', { action, count })}
              </option>
            ))}
          </Select>
        </div>
      }
    >
      {error ? <p className="mb-2 text-sm text-red-600">{error}</p> : null}
      {loading ? (
        <p className="text-sm text-slate-500">{tc('loading')}</p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-slate-500">{t('empty')}</p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[38rem] text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs uppercase text-slate-500">
                  <th className="py-2 pr-3">{t('time')}</th>
                  <th className="py-2 pr-3">{t('action')}</th>
                  <th className="py-2 pr-3">{t('entityType')}</th>
                  <th className="py-2 pr-3">{t('entityId')}</th>
                  <th className="py-2 pr-3">{t('requestId')}</th>
                  <th className="py-2">{t('details')}</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => {
                  const expanded = entry.id === expandedId;
                  return (
                    <tr key={entry.id} className="border-b border-slate-100 last:border-0">
                      <td className="py-2 pr-3 align-top text-slate-500">
                        {formatDateTime(entry.createdAt, locale)}
                      </td>
                      <td className="py-2 pr-3 align-top font-medium text-slate-800">
                        {entry.action}
                      </td>
                      <td className="py-2 pr-3 align-top text-slate-600">{entry.entityType}</td>
                      <td className="py-2 pr-3 align-top font-mono text-xs text-slate-500">
                        {shortId(entry.entityId)}
                      </td>
                      <td className="py-2 pr-3 align-top font-mono text-xs text-slate-500">
                        {shortId(entry.requestId)}
                      </td>
                      <td className="py-2 align-top">
                        <button
                          type="button"
                          onClick={() => setExpandedId(expanded ? null : entry.id)}
                          aria-expanded={expanded}
                          className="text-xs font-medium text-teal-700 hover:underline"
                        >
                          {expanded ? t('hide') : t('show')}
                        </button>
                        {expanded ? (
                          <div className="mt-2 flex flex-col gap-2">
                            {(
                              [
                                ['before', entry.before],
                                ['after', entry.after],
                              ] as const
                            ).map(([key, value]) => (
                              <div key={key}>
                                <h3 className="text-xs font-semibold uppercase text-slate-500">
                                  {t(key)}
                                </h3>
                                <pre className="mt-1 max-w-[min(40rem,80vw)] overflow-x-auto rounded-lg bg-slate-50 p-2 font-mono text-xs text-slate-700">
                                  {toJson(value)}
                                </pre>
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {nextCursor ? (
            <div className="mt-3">
              <Button
                variant="secondary"
                onClick={() => void handleLoadMore()}
                disabled={loadingMore}
              >
                {loadingMore ? tc('loading') : t('loadMore')}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </Card>
  );
}
