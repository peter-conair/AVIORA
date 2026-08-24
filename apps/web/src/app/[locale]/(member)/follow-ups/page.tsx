'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { api, ApiError, isForbidden } from '@/lib/api-client';
import { isOverdue, type CrmFollowUpEntry, type CrmFollowUpsResponse } from '@/lib/types';
import { Badge, statusTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { formatDateTime } from '@/lib/format';

function isCompleted(followUp: CrmFollowUpEntry): boolean {
  return followUp.status.toLowerCase() === 'completed';
}

export default function FollowUpsPage() {
  const t = useTranslations('followUpsPage');
  const tc = useTranslations('common');
  const locale = useLocale();

  const [followUps, setFollowUps] = useState<CrmFollowUpEntry[]>([]);
  const [showCompleted, setShowCompleted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [completingId, setCompletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const path = showCompleted ? '/crm/follow-ups?all=true' : '/crm/follow-ups';
    try {
      const res = await api.get<CrmFollowUpsResponse>(path);
      setFollowUps(res.followUps);
      setError(null);
    } catch (err: unknown) {
      if (isForbidden(err)) setForbidden(true);
      else setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showCompleted]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void load().finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const visible = useMemo(() => {
    const rows = showCompleted ? followUps : followUps.filter((f) => !isCompleted(f));
    return [...rows].sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime());
  }, [followUps, showCompleted]);

  const handleComplete = async (id: string) => {
    setCompletingId(id);
    try {
      await api.patch(`/crm/follow-ups/${id}/complete`);
      await load();
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setCompletingId(null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-bold text-slate-900">{t('title')}</h1>

      {forbidden ? (
        <Card>
          <p className="text-sm text-slate-600">{t('forbidden')}</p>
        </Card>
      ) : (
        <Card
          actions={
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={showCompleted}
                onChange={(e) => setShowCompleted(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-brand-700 focus:ring-brand-600"
              />
              {t('showCompleted')}
            </label>
          }
        >
          {error ? <p className="mb-2 text-sm text-red-600">{error}</p> : null}
          {loading ? (
            <p className="text-sm text-slate-500">{tc('loading')}</p>
          ) : visible.length === 0 ? (
            <p className="text-sm text-slate-500">{t('empty')}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-slate-100">
              {visible.map((followUp) => {
                const overdue = isOverdue(followUp);
                const completed = isCompleted(followUp);
                const related = followUp.lead
                  ? t('relatedLead', { name: followUp.lead.name })
                  : followUp.customer
                    ? t('relatedCustomer', { name: followUp.customer.name })
                    : null;
                return (
                  <li
                    key={followUp.id}
                    className={`flex flex-wrap items-center justify-between gap-x-3 gap-y-2 py-3 ${
                      overdue ? 'bg-red-50/60' : ''
                    }`}
                  >
                    <div className="flex min-w-0 flex-col gap-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-slate-800">{followUp.title}</span>
                        {overdue ? (
                          <Badge tone="red">{t('overdue')}</Badge>
                        ) : (
                          <Badge tone={statusTone(followUp.status)}>{followUp.status}</Badge>
                        )}
                      </div>
                      <span
                        className={`text-xs ${overdue ? 'font-medium text-red-700' : 'text-slate-500'}`}
                      >
                        {completed
                          ? t('completed', { date: formatDateTime(followUp.completedAt, locale) })
                          : t('due', { date: formatDateTime(followUp.dueAt, locale) })}
                      </span>
                      {related ? <span className="text-xs text-slate-500">{related}</span> : null}
                      {followUp.notes ? (
                        <span className="text-xs text-slate-500">{followUp.notes}</span>
                      ) : null}
                    </div>
                    {completed ? null : (
                      <Button
                        variant="secondary"
                        onClick={() => void handleComplete(followUp.id)}
                        disabled={completingId === followUp.id}
                      >
                        {completingId === followUp.id ? tc('saving') : t('complete')}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}
