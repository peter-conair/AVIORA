'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { GoalsTab } from '@/components/prospecting/GoalsTab';
import { NameListTab } from '@/components/prospecting/NameListTab';
import { MemoryJoggerTab } from '@/components/prospecting/MemoryJoggerTab';
import { TrackerTab } from '@/components/prospecting/TrackerTab';
import { ProspectingReportTab } from '@/components/prospecting/ProspectingReportTab';

const TABS = ['goals', 'jogger', 'sponsor', 'customer', 'tracker', 'report'] as const;
type Tab = (typeof TABS)[number];

/**
 * The prospecting workbook (docs/56).
 *
 * Tab order follows the order the work actually happens in: jog the memory
 * first, because a blank name list is the problem the jogger exists to solve.
 */
export default function ProspectingPage() {
  const t = useTranslations('prospecting');
  const [tab, setTab] = useState<Tab>('goals');
  const [version, setVersion] = useState(0);

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
      {tab === 'goals' ? <GoalsTab /> : null}
      {tab === 'jogger' ? <MemoryJoggerTab onAdded={() => setVersion((v) => v + 1)} /> : null}
      {tab === 'sponsor' ? <NameListTab key={`s${version}`} list="sponsor" /> : null}
      {tab === 'customer' ? <NameListTab key={`c${version}`} list="customer" /> : null}
      {tab === 'tracker' ? <TrackerTab key={`t${version}`} /> : null}
      {tab === 'report' ? <ProspectingReportTab key={`r${version}`} /> : null}
    </div>
  );
}
