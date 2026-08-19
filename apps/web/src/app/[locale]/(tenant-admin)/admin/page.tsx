'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { PlansTab } from '@/components/admin/PlansTab';
import { InvitationsTab } from '@/components/admin/InvitationsTab';
import { TeamsTab } from '@/components/admin/TeamsTab';
import { MembersTab } from '@/components/admin/MembersTab';
import { AuditTab } from '@/components/admin/AuditTab';

const TABS = ['plans', 'invitations', 'teams', 'members', 'audit'] as const;
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
      {tab === 'audit' ? <AuditTab /> : null}
    </div>
  );
}
