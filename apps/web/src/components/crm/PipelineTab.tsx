'use client';

import { useEffect, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { api, ApiError, isForbidden } from '@/lib/api-client';
import type { CrmLead, CrmLeadsResponse, CrmPipelineResponse } from '@/lib/types';
import { Card } from '@/components/ui/Card';
import { formatDate } from '@/lib/format';

interface PipelineTabProps {
  onSelectLead: (leadId: string) => void;
}

export function PipelineTab({ onSelectLead }: PipelineTabProps) {
  const t = useTranslations('crm');
  const tc = useTranslations('common');
  const locale = useLocale();

  const [pipeline, setPipeline] = useState<CrmPipelineResponse | null>(null);
  const [leads, setLeads] = useState<CrmLead[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.get<CrmPipelineResponse>('/crm/pipeline'),
      api.get<CrmLeadsResponse>('/crm/leads?status=open'),
    ])
      .then(([pipelineRes, leadsRes]) => {
        if (cancelled) return;
        setPipeline(pipelineRes);
        setLeads(leadsRes.leads);
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

  const leadsByStage = useMemo(() => {
    const map: Record<string, CrmLead[]> = {};
    for (const lead of leads) {
      const key = lead.stageId ?? '';
      (map[key] ??= []).push(lead);
    }
    return map;
  }, [leads]);

  if (forbidden) {
    return (
      <Card>
        <p className="text-sm text-slate-600">{t('forbidden')}</p>
      </Card>
    );
  }
  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (loading || !pipeline) {
    return <p className="py-10 text-center text-sm text-slate-500">{tc('loading')}</p>;
  }

  const totalOpenLeads = pipeline.stages.reduce((sum, stage) => sum + stage.openLeads, 0);
  const summary: [string, number][] = [
    ['openLeads', totalOpenLeads],
    ['customers', pipeline.customers],
    ['openFollowUps', pipeline.openFollowUps],
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {summary.map(([key, value]) => (
          <div key={key} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <p className="text-xs font-semibold uppercase text-slate-500">{t(`summary.${key}`)}</p>
            <p className="mt-1 text-2xl font-bold text-brand-700">{value}</p>
          </div>
        ))}
      </div>

      {pipeline.stages.length === 0 ? (
        <Card>
          <p className="text-sm text-slate-500">{t('pipeline.empty')}</p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {pipeline.stages.map((stage) => {
            const stageLeads = leadsByStage[stage.id] ?? [];
            return (
              <section
                key={stage.id}
                className="flex flex-col rounded-xl border border-slate-200 bg-white p-3 shadow-sm"
              >
                <header className="mb-2 flex items-center justify-between gap-2 border-b border-slate-100 pb-2">
                  <h3 className="text-sm font-semibold text-slate-900">{stage.name}</h3>
                  <span className="whitespace-nowrap rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-800 ring-1 ring-inset ring-brand-600/20">
                    {t('pipeline.openLeads', { count: stage.openLeads })}
                  </span>
                </header>
                {stageLeads.length === 0 ? (
                  <p className="text-sm text-slate-500">{t('pipeline.noLeads')}</p>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {stageLeads.map((lead) => (
                      <li key={lead.id}>
                        <button
                          type="button"
                          onClick={() => onSelectLead(lead.id)}
                          className="flex w-full flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left hover:bg-slate-50"
                        >
                          <span className="text-sm font-medium text-slate-800">{lead.name}</span>
                          <span className="flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
                            {lead.source ? <span>{lead.source}</span> : null}
                            <span>
                              {lead.lastContactAt
                                ? t('pipeline.lastContact', {
                                    date: formatDate(lead.lastContactAt, locale),
                                  })
                                : t('pipeline.noContact')}
                            </span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
