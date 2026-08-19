'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { api, ApiError, isForbidden } from '@/lib/api-client';
import { toParagraphs, type ArticleDetail, type ArticleResponse } from '@/lib/types';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { formatDate } from '@/lib/format';

export default function ArticlePage() {
  const t = useTranslations('knowledge');
  const tc = useTranslations('common');
  const locale = useLocale();
  const params = useParams<{ slug: string }>();
  const slug = params.slug;

  const [article, setArticle] = useState<ArticleDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get<ArticleResponse>(`/knowledge/articles/${encodeURIComponent(slug)}`)
      .then((res) => {
        if (!cancelled) setArticle(res.article);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (isForbidden(err)) setForbidden(true);
        else if (err instanceof ApiError && err.status === 404) setError(t('articleNotFound'));
        else setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  const backLink = (
    <Link href="/knowledge" className="text-sm font-medium text-teal-700 hover:underline">
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

  if (!article) {
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

      <article className="flex flex-col gap-3">
        <header className="flex flex-col gap-2">
          <h1 className="text-xl font-bold text-slate-900">{article.title}</h1>
          <p className="text-xs text-slate-500">
            {t('updatedAt', { date: formatDate(article.updatedAt, locale) })}
          </p>
          {article.summary ? <p className="text-sm text-slate-600">{article.summary}</p> : null}
          {article.topics.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5">
              {article.topics.map((topic) => (
                <li key={topic.id}>
                  <Badge tone="teal">{topic.name}</Badge>
                </li>
              ))}
            </ul>
          ) : null}
        </header>

        <Card>
          <div className="flex flex-col gap-3">
            {toParagraphs(article.body).map((paragraph, index) => (
              <p key={index} className="whitespace-pre-line text-sm leading-6 text-slate-800">
                {paragraph}
              </p>
            ))}
          </div>
        </Card>

        <Card title={t('ingredientsMentioned')}>
          {article.ingredients.length === 0 ? (
            <p className="text-sm text-slate-500">{t('ingredientsEmpty')}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {article.ingredients.map((ingredient) => (
                <li key={ingredient.id}>
                  <Link
                    href={`/knowledge/ingredients/${encodeURIComponent(ingredient.code)}`}
                    className="block rounded-lg border border-slate-200 p-3 hover:border-teal-600 hover:bg-teal-50/40"
                  >
                    <span className="text-sm font-medium text-teal-700">{ingredient.name}</span>
                    {ingredient.summary ? (
                      <p className="mt-0.5 text-sm text-slate-600">{ingredient.summary}</p>
                    ) : null}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </article>
    </div>
  );
}
