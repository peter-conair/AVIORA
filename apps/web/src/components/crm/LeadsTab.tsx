'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { api, ApiError, isForbidden } from '@/lib/api-client';
import {
  CRM_LEAD_STATUSES,
  type CrmLead,
  type CrmLeadsResponse,
  type CrmStage,
  type CrmStagesResponse,
} from '@/lib/types';
import { Badge, statusTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { LeadDetail } from '@/components/crm/LeadDetail';
import { formatDate } from '@/lib/format';

interface LeadsTabProps {
  selectedLeadId: string | null;
  onSelectLead: (leadId: string | null) => void;
}

const KNOWN_STATUSES: readonly string[] = CRM_LEAD_STATUSES;

export function LeadsTab({ selectedLeadId, onSelectLead }: LeadsTabProps) {
  const t = useTranslations('crm');
  const tc = useTranslations('common');
  const locale = useLocale();

  const [leads, setLeads] = useState<CrmLead[]>([]);
  const [stages, setStages] = useState<CrmStage[]>([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [source, setSource] = useState('');
  const [notes, setNotes] = useState('');
  const [stageId, setStageId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // Set when the server refused because this contact is already on someone's
  // book. Holding it in state is what turns a dead end into a choice.
  const [duplicateOwner, setDuplicateOwner] = useState<string | null>(null);

  const loadLeads = useCallback(async () => {
    const query = statusFilter ? `?status=${encodeURIComponent(statusFilter)}` : '';
    try {
      const res = await api.get<CrmLeadsResponse>(`/crm/leads${query}`);
      setLeads(res.leads);
      setError(null);
    } catch (err: unknown) {
      if (isForbidden(err)) setForbidden(true);
      else setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter]);

  useEffect(() => {
    let cancelled = false;
    // Stage list is needed for the create form and the detail panel's stage select.
    api
      .get<CrmStagesResponse>('/crm/stages')
      .then((res) => {
        if (!cancelled) setStages(res.stages);
      })
      .catch(() => {
        // Stage-less mode: leads can still be created and listed.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void loadLeads().finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [loadLeads]);

  const submitLead = async (allowDuplicate: boolean) => {
    setFormError(null);
    setSubmitting(true);
    try {
      const body: Record<string, string | boolean> = { name };
      if (email) body.email = email;
      if (phone) body.phone = phone;
      if (source) body.source = source;
      if (notes) body.notes = notes;
      if (stageId) body.stageId = stageId;
      if (allowDuplicate) body.allowDuplicate = true;
      await api.post('/crm/leads', body);
      setName('');
      setEmail('');
      setPhone('');
      setSource('');
      setNotes('');
      setStageId('');
      setDuplicateOwner(null);
      await loadLeads();
    } catch (err: unknown) {
      if (err instanceof ApiError && err.code === 'CONFLICT') {
        // Not a failure the user should have to decode — name who holds the
        // contact and offer the way through, or the block is a dead end and
        // they will retype the address slightly wrong to get past it.
        const owner = (err.details as { ownerName?: string } | undefined)?.ownerName;
        setDuplicateOwner(owner ?? t('leads.duplicateUnknownOwner'));
        return;
      }
      setFormError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    setDuplicateOwner(null);
    await submitLead(false);
  };

  if (forbidden) {
    return (
      <Card>
        <p className="text-sm text-slate-600">{t('forbidden')}</p>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      <Card title={t('leads.formTitle')}>
        <form onSubmit={handleCreate} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input
            label={t('leads.name')}
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Input
            label={t('leads.email')}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Input
            label={t('leads.phone')}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
          <Input
            label={t('leads.source')}
            placeholder={t('leads.sourcePlaceholder')}
            value={source}
            onChange={(e) => setSource(e.target.value)}
          />
          <Input
            label={t('leads.notes')}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
          <Select
            label={t('leads.stage')}
            value={stageId}
            onChange={(e) => setStageId(e.target.value)}
          >
            <option value="">{t('leads.noStage')}</option>
            {stages.map((stage) => (
              <option key={stage.id} value={stage.id}>
                {stage.name}
              </option>
            ))}
          </Select>
          {formError ? <p className="text-sm text-red-600 sm:col-span-2">{formError}</p> : null}
          {duplicateOwner ? (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 sm:col-span-2">
              <p className="text-sm text-amber-900">
                {t('leads.duplicateWarning', { owner: duplicateOwner })}
              </p>
              <button
                type="button"
                disabled={submitting}
                onClick={() => void submitLead(true)}
                className="mt-2 rounded-md border border-amber-400 px-3 py-1.5 text-sm font-medium text-amber-900 disabled:opacity-50"
              >
                {t('leads.duplicateCreateAnyway')}
              </button>
            </div>
          ) : null}
          <div className="sm:col-span-2">
            <Button type="submit" disabled={submitting}>
              {submitting ? tc('saving') : t('leads.submit')}
            </Button>
          </div>
        </form>
      </Card>

      <Card
        title={t('leads.listTitle')}
        actions={
          <div className="w-36">
            <Select
              aria-label={t('leads.filterStatus')}
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="">{t('leads.statusAll')}</option>
              {CRM_LEAD_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {t(`status.${status}`)}
                </option>
              ))}
            </Select>
          </div>
        }
      >
        {loading ? (
          <p className="text-sm text-slate-500">{tc('loading')}</p>
        ) : leads.length === 0 ? (
          <p className="text-sm text-slate-500">{t('leads.empty')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-slate-100">
            {leads.map((lead) => {
              const active = lead.id === selectedLeadId;
              return (
                <li key={lead.id}>
                  <button
                    type="button"
                    onClick={() => onSelectLead(active ? null : lead.id)}
                    aria-current={active ? 'true' : undefined}
                    className={`flex w-full flex-wrap items-center justify-between gap-x-2 gap-y-1 rounded-lg px-2 py-2 text-left text-sm ${
                      active ? 'bg-teal-50 ring-1 ring-inset ring-teal-600/20' : 'hover:bg-slate-50'
                    }`}
                  >
                    <span className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="font-medium text-slate-800">{lead.name}</span>
                      {lead.stage ? (
                        <span className="text-xs text-slate-500">{lead.stage.name}</span>
                      ) : null}
                      {lead.source ? (
                        <span className="text-xs text-slate-400">{lead.source}</span>
                      ) : null}
                    </span>
                    <span className="flex items-center gap-2">
                      <Badge tone={lead.convertedCustomerId ? 'green' : statusTone(lead.status)}>
                        {lead.convertedCustomerId
                          ? t('leads.converted')
                          : KNOWN_STATUSES.includes(lead.status)
                            ? t(`status.${lead.status}`)
                            : lead.status}
                      </Badge>
                      <span className="text-xs text-slate-500">
                        {formatDate(lead.createdAt, locale)}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {selectedLeadId ? (
        <LeadDetail
          key={selectedLeadId}
          leadId={selectedLeadId}
          stages={stages}
          onChanged={() => void loadLeads()}
          onClose={() => onSelectLead(null)}
        />
      ) : (
        <Card>
          <p className="text-sm text-slate-500">{t('leads.select')}</p>
        </Card>
      )}
    </div>
  );
}
