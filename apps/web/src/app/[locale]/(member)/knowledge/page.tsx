'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { api, ApiError, isForbidden } from '@/lib/api-client';
import type {
  HealthGoal,
  HealthGoalsResponse,
  KnowledgeSearchHit,
  KnowledgeSearchResponse,
} from '@/lib/types';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { ProductCard } from '@/components/knowledge/ProductCard';

const SEARCH_DEBOUNCE_MS = 350;
const MIN_QUERY_LENGTH = 2;

/** Where a search hit takes the reader; topics have no page of their own yet. */
function hitHref(hit: KnowledgeSearchHit): string | null {
  switch (hit.kind) {
    case 'health_goal':
      return `/knowledge/journey/${encodeURIComponent(hit.code)}`;
    case 'article':
      return `/knowledge/articles/${encodeURIComponent(hit.code)}`;
    case 'ingredient':
      return `/knowledge/ingredients/${encodeURIComponent(hit.code)}`;
    default:
      return null;
  }
}

export default function KnowledgePage() {
  const t = useTranslations('knowledge');
  const tc = useTranslations('common');

  const [goals, setGoals] = useState<HealthGoal[]>([]);
  const [goalsLoading, setGoalsLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<KnowledgeSearchResponse | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .get<HealthGoalsResponse>('/knowledge/health-goals')
      .then((res) => {
        if (!cancelled) setGoals(res.healthGoals);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (isForbidden(err)) setForbidden(true);
        else setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
      })
      .finally(() => {
        if (!cancelled) setGoalsLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      setResults(null);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      api
        .get<KnowledgeSearchResponse>(`/knowledge/search?q=${encodeURIComponent(trimmed)}`)
        .then((res) => {
          if (!cancelled) setResults(res);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          if (isForbidden(err)) setForbidden(true);
          else setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  if (forbidden) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-xl font-bold text-slate-900">{t('title')}</h1>
        <Card>
          <p className="text-sm text-slate-600">{t('forbidden')}</p>
        </Card>
      </div>
    );
  }

  const searchActive = query.trim().length >= MIN_QUERY_LENGTH;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-bold text-slate-900">{t('title')}</h1>
        <p className="text-sm text-slate-500">{t('intro')}</p>
      </div>

      <Card>
        <Input
          label={t('searchLabel')}
          type="search"
          placeholder={t('searchPlaceholder')}
          hint={t('searchHint')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </Card>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      {searchActive ? (
        <>
          {searching && !results ? (
            <p className="py-6 text-center text-sm text-slate-500">{tc('loading')}</p>
          ) : null}

          {results ? (
            <>
              <Card title={t('searchKnowledgeTitle')}>
                <p className="mb-3 text-xs text-slate-500">{t('knowledgeFirstNote')}</p>
                {results.knowledge.length === 0 ? (
                  <p className="text-sm text-slate-500">{t('searchKnowledgeEmpty')}</p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {results.knowledge.map((hit) => {
                      const href = hitHref(hit);
                      const inner = (
                        <>
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge tone="teal">{t(`kinds.${hit.kind}`)}</Badge>
                            <span className="text-sm font-medium text-slate-900">{hit.title}</span>
                          </div>
                          {hit.summary ? (
                            <p className="mt-1 text-sm text-slate-600">{hit.summary}</p>
                          ) : null}
                        </>
                      );
                      return (
                        <li key={`${hit.kind}-${hit.id}`}>
                          {href ? (
                            <Link
                              href={href}
                              className="block rounded-lg border border-slate-200 p-3 hover:border-brand-600 hover:bg-brand-50/40"
                            >
                              {inner}
                            </Link>
                          ) : (
                            <div className="rounded-lg border border-slate-200 p-3">{inner}</div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Card>

              <Card title={t('searchProductsTitle')}>
                <p className="mb-3 text-xs text-slate-500">{t('productsLastNote')}</p>
                {results.products.length === 0 ? (
                  <p className="text-sm text-slate-500">{t('searchProductsEmpty')}</p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {results.products.map((product) => (
                      <ProductCard key={product.id} product={product} />
                    ))}
                  </ul>
                )}
              </Card>
            </>
          ) : null}
        </>
      ) : goalsLoading ? (
        <p className="py-10 text-center text-sm text-slate-500">{tc('loading')}</p>
      ) : goals.length === 0 ? (
        <Card>
          <p className="text-sm text-slate-500">{t('goalsEmpty')}</p>
        </Card>
      ) : (
        <Card title={t('goalsTitle')}>
          <p className="mb-3 text-xs text-slate-500">{t('goalsHint')}</p>
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {goals.map((goal) => (
              <li key={goal.id}>
                <Link
                  href={`/knowledge/journey/${encodeURIComponent(goal.code)}`}
                  className="flex h-full flex-col gap-1 rounded-lg border border-slate-200 p-3 hover:border-brand-600 hover:bg-brand-50/40"
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-slate-900">{goal.name}</span>
                    {goal.tenantId === null ? <Badge tone="gray">{t('shared')}</Badge> : null}
                  </span>
                  {goal.description ? (
                    <span className="text-sm text-slate-600">{goal.description}</span>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
