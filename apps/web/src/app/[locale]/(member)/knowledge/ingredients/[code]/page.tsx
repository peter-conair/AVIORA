'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { api, ApiError, isForbidden } from '@/lib/api-client';
import type { IngredientDetail, IngredientResponse } from '@/lib/types';
import { Card } from '@/components/ui/Card';
import { EvidenceList } from '@/components/knowledge/EvidenceList';
import { ProductCard } from '@/components/knowledge/ProductCard';

export default function IngredientPage() {
  const t = useTranslations('knowledge');
  const tc = useTranslations('common');
  const params = useParams<{ code: string }>();
  const code = params.code;

  const [ingredient, setIngredient] = useState<IngredientDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get<IngredientResponse>(`/knowledge/ingredients/${encodeURIComponent(code)}`)
      .then((res) => {
        if (!cancelled) setIngredient(res.ingredient);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (isForbidden(err)) setForbidden(true);
        else if (err instanceof ApiError && err.status === 404) setError(t('ingredientNotFound'));
        else setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  const backLink = (
    <Link href="/knowledge" className="text-sm font-medium text-brand-700 hover:underline">
      {t('backToKnowledge')}
    </Link>
  );

  if (forbidden) {
    return (
      <div className="flex flex-col gap-4">
        {backLink}
        <Card>
          <p className="text-sm text-slate-600">{t('forbidden')}</p>
        </Card>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-4">
        {backLink}
        <p className="py-10 text-center text-sm text-slate-500">{tc('loading')}</p>
      </div>
    );
  }

  if (!ingredient) {
    return (
      <div className="flex flex-col gap-4">
        {backLink}
        <Card>
          <p className="text-sm text-red-600">{error ?? tc('errorGeneric')}</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {backLink}

      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-bold text-slate-900">{ingredient.name}</h1>
        {ingredient.summary ? <p className="text-sm text-slate-600">{ingredient.summary}</p> : null}
      </div>

      {ingredient.safetyNotes ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
          <h2 className="text-xs font-semibold uppercase text-amber-900">{t('safetyNotes')}</h2>
          <p className="mt-1 text-sm text-amber-900">{ingredient.safetyNotes}</p>
        </div>
      ) : null}

      <Card title={t('evidence')}>
        <EvidenceList evidence={ingredient.evidence} />
      </Card>

      <Card title={t('productsWithIngredient')}>
        <p className="mb-3 text-xs text-slate-500">{t('productsLastNote')}</p>
        {ingredient.products.length === 0 ? (
          <p className="text-sm text-slate-500">{t('productsEmpty')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {ingredient.products.map((product) => (
              <ProductCard key={product.id} product={product} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
