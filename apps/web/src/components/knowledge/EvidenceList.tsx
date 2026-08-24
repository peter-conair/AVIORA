'use client';

import { useLocale, useTranslations } from 'next-intl';
import type { EvidenceReference } from '@/lib/types';
import { formatDate } from '@/lib/format';

interface EvidenceListProps {
  evidence: EvidenceReference[];
}

/** Evidence behind an ingredient — external links always open in a new tab. */
export function EvidenceList({ evidence }: EvidenceListProps) {
  const t = useTranslations('knowledge');
  const locale = useLocale();

  if (evidence.length === 0) {
    return <p className="text-xs text-slate-500">{t('evidenceEmpty')}</p>;
  }

  return (
    <ul className="flex flex-col gap-2">
      {evidence.map((item, index) => (
        <li key={`${item.title}-${index}`} className="flex flex-col gap-0.5">
          <span className="text-sm text-slate-800">{item.title}</span>
          {item.summary ? <span className="text-xs text-slate-600">{item.summary}</span> : null}
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
            {item.source ? <span>{item.source}</span> : null}
            {item.verifiedAt ? (
              <span>{t('verifiedAt', { date: formatDate(item.verifiedAt, locale) })}</span>
            ) : null}
            {item.url ? (
              <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-brand-700 hover:underline"
              >
                {t('openEvidence')}
              </a>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
