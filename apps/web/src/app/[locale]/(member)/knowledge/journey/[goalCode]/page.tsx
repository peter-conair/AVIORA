'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { api, ApiError, isForbidden } from '@/lib/api-client';
import type { JourneyResponse } from '@/lib/types';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { EvidenceList } from '@/components/knowledge/EvidenceList';
import { ProductCard } from '@/components/knowledge/ProductCard';

interface StepProps {
  step: number;
  title: string;
  hint?: string;
  last?: boolean;
  children: ReactNode;
}

/** One numbered stop on the goal → topics → articles → ingredients → products path. */
function JourneyStep({ step, title, hint, last = false, children }: StepProps) {
  return (
    <li className="flex gap-3">
      <div className="flex flex-col items-center">
        <span
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
            last ? 'bg-slate-200 text-slate-700' : 'bg-brand-700 text-white'
          }`}
          aria-hidden="true"
        >
          {step}
        </span>
        <span className="mt-1 w-px flex-1 bg-slate-200" aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1 pb-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-700">{title}</h2>
        {hint ? <p className="mt-0.5 text-xs text-slate-500">{hint}</p> : null}
        <div className="mt-2">{children}</div>
      </div>
    </li>
  );
}

export default function JourneyPage() {
  const t = useTranslations('knowledge');
  const tc = useTranslations('common');
  const params = useParams<{ goalCode: string }>();
  const goalCode = params.goalCode;

  const [journey, setJourney] = useState<JourneyResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get<JourneyResponse>(`/knowledge/journey/${encodeURIComponent(goalCode)}`)
      .then((res) => {
        if (!cancelled) setJourney(res);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (isForbidden(err)) setForbidden(true);
        else if (err instanceof ApiError && err.status === 404) setError(t('goalNotFound'));
        else setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goalCode]);

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

  if (!journey) {
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
        <h1 className="text-xl font-bold text-slate-900">{journey.goal.name}</h1>
        {journey.goal.description ? (
          <p className="text-sm text-slate-600">{journey.goal.description}</p>
        ) : null}
      </div>

      <p className="rounded-xl border border-slate-200 bg-slate-100 p-3 text-xs text-slate-600">
        {journey.safetyNotice}
      </p>

      <p className="text-xs text-slate-500">{t('journeyPathHint')}</p>

      <ol className="flex flex-col">
        <JourneyStep step={1} title={t('stepGoal')} hint={t('stepGoalHint')}>
          <Card>
            <p className="text-sm text-slate-800">{journey.goal.name}</p>
            {journey.goal.description ? (
              <p className="mt-1 text-sm text-slate-600">{journey.goal.description}</p>
            ) : null}
          </Card>
        </JourneyStep>

        <JourneyStep step={2} title={t('stepTopics')} hint={t('stepTopicsHint')}>
          {journey.topics.length === 0 ? (
            <p className="text-sm text-slate-500">{t('topicsEmpty')}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {journey.topics.map((topic) => (
                <li
                  key={topic.id}
                  className="rounded-lg border border-slate-200 bg-white p-3 text-sm"
                >
                  <span className="font-medium text-slate-900">{topic.name}</span>
                  {topic.summary ? <p className="mt-0.5 text-slate-600">{topic.summary}</p> : null}
                </li>
              ))}
            </ul>
          )}
        </JourneyStep>

        <JourneyStep step={3} title={t('stepArticles')} hint={t('stepArticlesHint')}>
          {journey.articles.length === 0 ? (
            <p className="text-sm text-slate-500">{t('articlesEmpty')}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {journey.articles.map((article) => (
                <li key={article.id}>
                  <Link
                    href={`/knowledge/articles/${encodeURIComponent(article.slug)}`}
                    className="block rounded-lg border border-slate-200 bg-white p-3 hover:border-brand-600 hover:bg-brand-50/40"
                  >
                    <span className="text-sm font-medium text-slate-900">{article.title}</span>
                    {article.summary ? (
                      <p className="mt-0.5 text-sm text-slate-600">{article.summary}</p>
                    ) : null}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </JourneyStep>

        <JourneyStep step={4} title={t('stepIngredients')} hint={t('stepIngredientsHint')}>
          {journey.ingredients.length === 0 ? (
            <p className="text-sm text-slate-500">{t('ingredientsEmpty')}</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {journey.ingredients.map((ingredient) => (
                <li
                  key={ingredient.id}
                  className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-white p-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Link
                      href={`/knowledge/ingredients/${encodeURIComponent(ingredient.code)}`}
                      className="text-sm font-medium text-brand-700 hover:underline"
                    >
                      {ingredient.name}
                    </Link>
                    {ingredient.productIds.length > 0 ? (
                      <Badge tone="gray">
                        {t('linkedProducts', { count: ingredient.productIds.length })}
                      </Badge>
                    ) : null}
                  </div>
                  {ingredient.summary ? (
                    <p className="text-sm text-slate-600">{ingredient.summary}</p>
                  ) : null}
                  {ingredient.safetyNotes ? (
                    <p className="rounded-lg bg-amber-50 p-2 text-xs text-amber-900">
                      {t('safetyNotes')}: {ingredient.safetyNotes}
                    </p>
                  ) : null}
                  <div>
                    <h3 className="mb-1 text-xs font-semibold uppercase text-slate-500">
                      {t('evidence')}
                    </h3>
                    <EvidenceList evidence={ingredient.evidence} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </JourneyStep>

        <JourneyStep step={5} title={t('stepProducts')} hint={t('stepProductsHint')} last>
          {journey.products.length === 0 ? (
            <p className="text-sm text-slate-500">{t('productsEmpty')}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {journey.products.map((product) => (
                <ProductCard key={product.id} product={product} />
              ))}
            </ul>
          )}
        </JourneyStep>
      </ol>
    </div>
  );
}
