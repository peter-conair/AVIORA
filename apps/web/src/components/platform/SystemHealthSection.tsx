'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { api, ApiError, isForbidden } from '@/lib/api-client';
import type { AiSpendResponse, JobsHealthResponse, QueueHealthResponse } from '@/lib/types';
import { Card } from '@/components/ui/Card';
import { Stat } from '@/components/analytics/Stat';
import { formatCount, formatMoney } from '@/lib/format';

/**
 * System health (docs/36 §4) — the platform's own machinery, on screen.
 *
 * This exists because docs/35 §5 leaves an operator a job: a scheduler run left
 * `claimed` is never retried, so somebody has to notice it. A number that lives
 * only behind `curl` is a number nobody notices, which is close enough to not
 * measuring it. The stale-run panel is therefore the loudest thing here, and it
 * says plainly what has to be done about it.
 */
export function SystemHealthSection() {
  const t = useTranslations('systemHealth');
  const tc = useTranslations('common');
  const locale = useLocale();

  const [queue, setQueue] = useState<QueueHealthResponse | null>(null);
  const [jobs, setJobs] = useState<JobsHealthResponse | null>(null);
  const [ai, setAi] = useState<AiSpendResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.get<QueueHealthResponse>('/platform/observability/queue'),
      api.get<JobsHealthResponse>('/platform/observability/jobs'),
      api.get<AiSpendResponse>('/platform/observability/ai'),
    ])
      .then(([q, j, a]) => {
        if (cancelled) return;
        setQueue(q);
        setJobs(j);
        setAi(a);
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
  }, []);

  const age = (seconds: number | null): string => {
    if (seconds === null) return t('none');
    if (seconds < 90) return t('seconds', { count: Math.round(seconds) });
    if (seconds < 90 * 60) return t('minutes', { count: Math.round(seconds / 60) });
    return t('hours', { count: Math.round(seconds / 3600) });
  };

  if (forbidden) {
    return (
      <Card title={t('title')}>
        <p className="text-sm text-slate-600">{t('forbidden')}</p>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-bold text-slate-900">{t('title')}</h2>
        <p className="text-sm text-slate-500">{t('intro')}</p>
      </div>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      {loading ? <p className="py-8 text-center text-sm text-slate-500">{tc('loading')}</p> : null}

      {jobs ? (
        <Card title={t('staleTitle')}>
          {jobs.stale.count === 0 ? (
            <p className="text-sm text-slate-600">{t('staleNone')}</p>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-900">
                {t('staleWarning', {
                  count: jobs.stale.count,
                  minutes: jobs.stale.thresholdMinutes,
                })}
              </p>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[28rem] text-left text-sm">
                  <thead>
                    <tr className="text-xs uppercase tracking-wide text-slate-500">
                      <th className="py-1 pr-3">{t('staleJob')}</th>
                      <th className="py-1 pr-3">{t('staleTenant')}</th>
                      <th className="py-1">{t('staleFor')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {jobs.stale.runs.map((run) => (
                      <tr key={run.id} className="border-t border-slate-100">
                        <td className="py-1 pr-3 font-medium text-slate-900">{run.job}</td>
                        <td className="py-1 pr-3 font-mono text-xs text-slate-500">
                          {run.tenantId ? run.tenantId.slice(0, 8) : t('none')}
                        </td>
                        <td className="py-1 text-slate-700">{age(run.claimedForSeconds)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </Card>
      ) : null}

      {queue ? (
        <Card title={t('queueTitle')}>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label={t('pending')} value={formatCount(queue.pending, locale)} />
            <Stat label={t('failing')} value={formatCount(queue.failing, locale)} />
            <Stat label={t('processed')} value={formatCount(queue.processedInWindow, locale)} />
            <Stat label={t('oldest')} value={age(queue.oldestPendingAgeSeconds)} />
          </div>
        </Card>
      ) : null}

      {ai ? (
        <Card title={t('aiTitle')}>
          <div className="flex flex-col gap-3">
            <p className="text-sm text-slate-500">{t('aiIntro')}</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Stat
                label={t('aiTotal')}
                value={formatMoney(ai.totalCostMinor, ai.currency, locale)}
              />
              <Stat
                label={t('aiRequests')}
                value={formatCount(
                  ai.usage.reduce((n, u) => n + u.requests, 0),
                  locale,
                )}
              />
              <Stat
                label={t('aiTokens')}
                value={formatCount(
                  ai.usage.reduce((n, u) => n + u.inputTokens + u.outputTokens, 0),
                  locale,
                )}
              />
            </div>
            {ai.unpricedModels.length > 0 ? (
              <p className="text-sm text-slate-600">
                {t('unpriced', { models: ai.unpricedModels.join(', ') })}
              </p>
            ) : null}
          </div>
        </Card>
      ) : null}
    </div>
  );
}
