'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { PipelineTab } from '@/components/crm/PipelineTab';
import { LeadsTab } from '@/components/crm/LeadsTab';
import { CustomersTab } from '@/components/crm/CustomersTab';

const TABS = ['pipeline', 'leads', 'customers'] as const;
type Tab = (typeof TABS)[number];

export default function CrmPage() {
  const t = useTranslations('crm');
  const [tab, setTab] = useState<Tab>('pipeline');
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);

  // Opening a lead from the pipeline board hands off to the Leads tab's detail panel.
  const handleOpenLead = (leadId: string) => {
    setSelectedLeadId(leadId);
    setTab('leads');
  };

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-bold text-slate-900">{t('title')}</h1>
      <div className="flex gap-1 overflow-x-auto rounded-xl border border-slate-200 bg-white p-1">
        {TABS.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium ${
              tab === key ? 'bg-brand-700 text-white' : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            {t(`tabs.${key}`)}
          </button>
        ))}
      </div>
      {tab === 'pipeline' ? <PipelineTab onSelectLead={handleOpenLead} /> : null}
      {tab === 'leads' ? (
        <LeadsTab selectedLeadId={selectedLeadId} onSelectLead={setSelectedLeadId} />
      ) : null}
      {tab === 'customers' ? <CustomersTab /> : null}
    </div>
  );
}
