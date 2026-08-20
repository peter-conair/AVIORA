'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { PlansTab } from '@/components/admin/PlansTab';
import { InvitationsTab } from '@/components/admin/InvitationsTab';
import { TeamsTab } from '@/components/admin/TeamsTab';
import { MembersTab } from '@/components/admin/MembersTab';
import { AuditTab } from '@/components/admin/AuditTab';
import { GamificationTab } from '@/components/admin/GamificationTab';
import { CommerceTab } from '@/components/admin/CommerceTab';
import { RanksTab } from '@/components/admin/RanksTab';
import { CompensationTab } from '@/components/admin/CompensationTab';
import { AutomationTab } from '@/components/admin/AutomationTab';
import { AnalyticsTab } from '@/components/admin/AnalyticsTab';
import { BrandingTab } from '@/components/admin/BrandingTab';
import { LocalisationTab } from '@/components/admin/LocalisationTab';
import { LegalTab } from '@/components/admin/LegalTab';

const TABS = [
  'plans',
  'invitations',
  'teams',
  'members',
  'gamification',
  'commerce',
  'growth',
  'compensation',
  'automation',
  'analytics',
  // Branding and localisation share one tab: an administrator opening a new
  // country changes the name, the currency and the timezone in one sitting, and
  // splitting them would make that one job into two screens.
  'branding',
  'legal',
  'audit',
] as const;
type Tab = (typeof TABS)[number];

export default function AdminPage() {
  const t = useTranslations('admin');
  const [tab, setTab] = useState<Tab>('plans');

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
              tab === key ? 'bg-teal-700 text-white' : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            {t(`tabs.${key}`)}
          </button>
        ))}
      </div>
      {tab === 'plans' ? <PlansTab /> : null}
      {tab === 'invitations' ? <InvitationsTab /> : null}
      {tab === 'teams' ? <TeamsTab /> : null}
      {tab === 'members' ? <MembersTab /> : null}
      {tab === 'gamification' ? <GamificationTab /> : null}
      {tab === 'commerce' ? <CommerceTab /> : null}
      {tab === 'growth' ? <RanksTab /> : null}
      {tab === 'compensation' ? <CompensationTab /> : null}
      {tab === 'automation' ? <AutomationTab /> : null}
      {tab === 'analytics' ? <AnalyticsTab /> : null}
      {tab === 'branding' ? (
        <div className="flex flex-col gap-4">
          <BrandingTab />
          <LocalisationTab />
        </div>
      ) : null}
      {tab === 'legal' ? <LegalTab /> : null}
      {tab === 'audit' ? <AuditTab /> : null}
    </div>
  );
}
