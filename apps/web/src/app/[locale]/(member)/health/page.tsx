'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { TodayTab } from '@/components/health/TodayTab';
import { ProgressTab } from '@/components/health/ProgressTab';
import { SharingTab } from '@/components/health/SharingTab';

const TABS = ['today', 'progress', 'sharing'] as const;
type Tab = (typeof TABS)[number];

export default function HealthPage() {
  const t = useTranslations('health');
  const [tab, setTab] = useState<Tab>('today');

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-bold text-slate-900">{t('title')}</h1>
        <p className="text-sm text-slate-500">{t('intro')}</p>
      </div>

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

      {tab === 'today' ? <TodayTab /> : null}
      {tab === 'progress' ? <ProgressTab /> : null}
      {tab === 'sharing' ? <SharingTab /> : null}
    </div>
  );
}
