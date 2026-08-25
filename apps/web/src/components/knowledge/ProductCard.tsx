'use client';

import { useLocale, useTranslations } from 'next-intl';
import { API_URL } from '@/lib/api-client';
import type { KnowledgeProduct } from '@/lib/types';
import { formatDate } from '@/lib/format';

interface ProductCardProps {
  product: KnowledgeProduct;
}

/**
 * Products are always the LAST step of the journey (spec §74) and are shown
 * brand-neutrally: brand name as a plain label, never a logo or ranking cue.
 *
 * The thumbnail (docs/74 §7) is deliberately SMALL and to the side. A member
 * asking "is this the one on my shelf" is answered instantly by a picture and
 * badly by a paragraph — but this is a place to read, not a shop window, so the
 * picture sits beside the words rather than above them, and a product with no
 * picture looks like the same card rather than a broken one.
 */
export function ProductCard({ product }: ProductCardProps) {
  const t = useTranslations('knowledge');
  const locale = useLocale();

  const image = product.images?.[0];
  // OUR copy when there is one. The source URL is the fallback, not the plan:
  // a CDN nobody here controls can move, and every picture in the catalogue
  // would go blank at once (docs/74 §7).
  const src = image
    ? image.storedPath
      ? `${API_URL}/knowledge/product-images/${image.id}/content`
      : image.url
    : null;

  return (
    <li className="flex gap-3 rounded-lg border border-slate-200 bg-white p-3">
      {image && src ? (
        // A plain <img>, not next/image: the source is a third-party CDN this
        // app configures no loader for, and the catalogue records a URL rather
        // than a file it owns (docs/74 §7).
        <img
          src={src}
          alt={image.alt ?? product.name}
          loading="lazy"
          className="h-16 w-16 shrink-0 rounded-md border border-slate-100 bg-white object-contain"
        />
      ) : null}
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-sm font-medium text-slate-900">{product.name}</span>
          <span className="text-xs text-slate-500">{product.brand.name}</span>
        </div>
        {product.description ? (
          <p className="text-sm text-slate-600">{product.description}</p>
        ) : null}
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
      </div>
    </li>
  );
}
