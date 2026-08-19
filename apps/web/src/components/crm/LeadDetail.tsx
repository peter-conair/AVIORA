'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { api, ApiError, isForbidden } from '@/lib/api-client';
import {
  CRM_CHANNELS,
  CRM_LEAD_STATUSES,
  isOverdue,
  type CrmChannel,
  type CrmLeadDetail,
  type CrmLeadDetailResponse,
  type CrmStage,
} from '@/lib/types';
import { Badge, statusTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { formatDate, formatDateTime } from '@/lib/format';

interface LeadDetailProps {
  leadId: string;
  stages: CrmStage[];
  onChanged: () => void;
  onClose: () => void;
}

/** `datetime-local` gives a local wall-clock string — convert to an absolute ISO instant. */
function toIsoDateTime(value: string): string | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const KNOWN_STATUSES: readonly string[] = CRM_LEAD_STATUSES;
const KNOWN_CHANNELS: readonly string[] = CRM_CHANNELS;

export function LeadDetail({ leadId, stages, onChanged, onClose }: LeadDetailProps) {
  const t = useTranslations('crm');
  const tc = useTranslations('common');
  const locale = useLocale();

  const [lead, setLead] = useState<CrmLeadDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [busy, setBusy] = useState(false);

  const [followUpTitle, setFollowUpTitle] = useState('');
  const [followUpDueAt, setFollowUpDueAt] = useState('');
  const [followUpError, setFollowUpError] = useState<string | null>(null);

  const [interactionSummary, setInteractionSummary] = useState('');
  const [interactionChannel, setInteractionChannel] = useState<CrmChannel>('note');
  const [interactionError, setInteractionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setForbidden(false);
    try {
      const res = await api.get<CrmLeadDetailResponse>(`/crm/leads/${leadId}`);
      setLead(res.lead);
    } catch (err: unknown) {
      if (isForbidden(err)) setForbidden(true);
      else setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadId]);

  useEffect(() => {
    void load();
  }, [load]);

  const runAction = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
      onChanged();
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setBusy(false);
    }
  };

  const handleStageChange = (stageId: string) =>
    void runAction(() => api.patch(`/crm/leads/${leadId}`, { stageId: stageId || null }));

  const handleConvert = () => void runAction(() => api.post(`/crm/leads/${leadId}/convert`));

  const handleMarkLost = () =>
    void runAction(() => api.patch(`/crm/leads/${leadId}`, { status: 'lost' }));

  const handleAddFollowUp = async (e: FormEvent) => {
    e.preventDefault();
    setFollowUpError(null);
    const dueAt = toIsoDateTime(followUpDueAt);
    if (!dueAt) return;
    setBusy(true);
    try {
      await api.post('/crm/follow-ups', { title: followUpTitle, dueAt, leadId });
      setFollowUpTitle('');
      setFollowUpDueAt('');
      await load();
      onChanged();
    } catch (err: unknown) {
      setFollowUpError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setBusy(false);
    }
  };

  const handleLogInteraction = async (e: FormEvent) => {
    e.preventDefault();
    setInteractionError(null);
    setBusy(true);
    try {
      await api.post('/crm/interactions', {
        summary: interactionSummary,
        channel: interactionChannel,
        leadId,
      });
      setInteractionSummary('');
      setInteractionChannel('note');
      await load();
      onChanged();
    } catch (err: unknown) {
      setInteractionError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setBusy(false);
    }
  };

  if (forbidden) {
    return (
      <Card>
        <p className="text-sm text-slate-600">{t('forbidden')}</p>
      </Card>
    );
  }
  if (loading && !lead) {
    return (
      <Card>
        <p className="text-sm text-slate-500">{tc('loading')}</p>
      </Card>
    );
  }
  if (!lead) {
    return (
      <Card>
        <p className="text-sm text-red-600">{error ?? tc('errorGeneric')}</p>
      </Card>
    );
  }

  const converted = Boolean(lead.convertedCustomerId);

  return (
    <Card
      title={lead.name}
      actions={
        <button
          type="button"
          onClick={onClose}
          className="text-sm font-medium text-teal-700 hover:underline"
        >
          {t('leads.close')}
        </button>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <p className="text-sm text-red-600">{error}</p> : null}

        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={converted ? 'green' : statusTone(lead.status)}>
            {converted
              ? t('leads.converted')
              : KNOWN_STATUSES.includes(lead.status)
                ? t(`status.${lead.status}`)
                : lead.status}
          </Badge>
          {lead.source ? <span className="text-xs text-slate-500">{lead.source}</span> : null}
          <span className="text-xs text-slate-500">
            {t('leads.created', { date: formatDate(lead.createdAt, locale) })}
          </span>
        </div>

        <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
          <div className="flex items-center justify-between gap-2">
            <dt className="text-slate-500">{t('leads.email')}</dt>
            <dd className="min-w-0 truncate text-slate-800">{lead.email ?? '—'}</dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-slate-500">{t('leads.phone')}</dt>
            <dd className="text-slate-800">{lead.phone ?? '—'}</dd>
          </div>
        </dl>

        {lead.notes ? <p className="text-sm text-slate-600">{lead.notes}</p> : null}

        <div className="flex flex-col gap-3 border-t border-slate-100 pt-3 sm:flex-row sm:items-end">
          <div className="flex-1">
            <Select
              label={t('leads.stage')}
              value={lead.stageId ?? ''}
              disabled={busy}
              onChange={(e) => handleStageChange(e.target.value)}
            >
              <option value="">{t('leads.noStage')}</option>
              {stages.map((stage) => (
                <option key={stage.id} value={stage.id}>
                  {stage.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-wrap gap-2">
            {converted ? (
              <p className="text-xs text-slate-500">{t('leads.convertedHint')}</p>
            ) : (
              <>
                <Button onClick={handleConvert} disabled={busy}>
                  {t('leads.convert')}
                </Button>
                <Button
                  variant="secondary"
                  onClick={handleMarkLost}
                  disabled={busy || lead.status === 'lost'}
                >
                  {t('leads.markLost')}
                </Button>
              </>
            )}
          </div>
        </div>

        <div className="border-t border-slate-100 pt-3">
          <h3 className="mb-2 text-xs font-semibold uppercase text-slate-500">
            {t('followUps.title')}
          </h3>
          {lead.followUps.length === 0 ? (
            <p className="text-sm text-slate-500">{t('followUps.empty')}</p>
          ) : (
            <ul className="mb-3 flex flex-col divide-y divide-slate-100">
              {lead.followUps.map((followUp) => (
                <li
                  key={followUp.id}
                  className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 py-1.5 text-sm"
                >
                  <span className="text-slate-800">{followUp.title}</span>
                  <span className="flex items-center gap-2">
                    <span className="text-xs text-slate-500">
                      {t('followUps.due', { date: formatDateTime(followUp.dueAt, locale) })}
                    </span>
                    {isOverdue(followUp) ? (
                      <Badge tone="red">{t('followUps.overdue')}</Badge>
                    ) : (
                      <Badge tone={statusTone(followUp.status)}>{followUp.status}</Badge>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <form onSubmit={handleAddFollowUp} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input
              label={t('followUps.titleLabel')}
              required
              value={followUpTitle}
              onChange={(e) => setFollowUpTitle(e.target.value)}
            />
            <Input
              label={t('followUps.dueAt')}
              type="datetime-local"
              required
              value={followUpDueAt}
              onChange={(e) => setFollowUpDueAt(e.target.value)}
            />
            {followUpError ? (
              <p className="text-sm text-red-600 sm:col-span-2">{followUpError}</p>
            ) : null}
            <div className="sm:col-span-2">
              <Button type="submit" variant="secondary" disabled={busy}>
                {t('followUps.submit')}
              </Button>
            </div>
          </form>
        </div>

        <div className="border-t border-slate-100 pt-3">
          <h3 className="mb-2 text-xs font-semibold uppercase text-slate-500">
            {t('interactions.title')}
          </h3>
          {lead.interactions.length === 0 ? (
            <p className="text-sm text-slate-500">{t('interactions.empty')}</p>
          ) : (
            <ol className="mb-3 flex flex-col gap-2 border-s border-slate-200 ps-3">
              {lead.interactions.map((interaction) => (
                <li key={interaction.id} className="flex flex-col gap-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="teal">
                      {KNOWN_CHANNELS.includes(interaction.channel)
                        ? t(`interactions.channels.${interaction.channel}`)
                        : interaction.channel}
                    </Badge>
                    <span className="text-xs text-slate-500">
                      {formatDateTime(interaction.occurredAt, locale)}
                    </span>
                  </div>
                  <p className="text-sm text-slate-800">{interaction.summary}</p>
                </li>
              ))}
            </ol>
          )}
          <form onSubmit={handleLogInteraction} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Select
              label={t('interactions.channel')}
              value={interactionChannel}
              onChange={(e) => setInteractionChannel(e.target.value as CrmChannel)}
            >
              {CRM_CHANNELS.map((channel) => (
                <option key={channel} value={channel}>
                  {t(`interactions.channels.${channel}`)}
                </option>
              ))}
            </Select>
            <Input
              label={t('interactions.summary')}
              required
              value={interactionSummary}
              onChange={(e) => setInteractionSummary(e.target.value)}
            />
            {interactionError ? (
              <p className="text-sm text-red-600 sm:col-span-2">{interactionError}</p>
            ) : null}
            <div className="sm:col-span-2">
              <Button type="submit" variant="secondary" disabled={busy}>
                {t('interactions.submit')}
              </Button>
            </div>
          </form>
        </div>
      </div>
    </Card>
  );
}
