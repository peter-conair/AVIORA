'use client';

import { useLocale, useTranslations } from 'next-intl';
import type { KnowledgeProduct } from '@/lib/types';
import { formatDate } from '@/lib/format';

interface ProductCardProps {
  product: KnowledgeProduct;
}

/**
 * Products are always the LAST step of the journey (spec §74) and are shown
 * brand-neutrally: brand name as a plain label, never a logo or ranking cue.
 */
export function ProductCard({ product }: ProductCardProps) {
  const t = useTranslations('knowledge');
  const locale = useLocale();

  return (
    <li className="flex flex-col gap-1 rounded-lg border border-slate-200 bg-white p-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-sm font-medium text-slate-900">{product.name}</span>
        <span className="text-xs text-slate-500">{product.brand.name}</span>
      </div>
      {product.description ? <p className="text-sm text-slate-600">{product.description}</p> : null}
      {product.safetyNotes ? (
        <p className="text-xs text-amber-800">
          {t('safetyNotes')}: {product.safetyNotes}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
        {product.lastVerifiedAt !== undefined ? (
          <span>{t('lastVerified', { date: formatDate(product.lastVerifiedAt, locale) })}</span>
        ) : null}
        {product.sourceUrl ? (
          <a
            href={product.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-brand-700 hover:underline"
          >
            {t('sourceLink')}
          </a>
        ) : null}
      </div>
    </li>
  );
}
