'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { api, ApiError } from '@/lib/api-client';
import { Card } from '@/components/ui/Card';
import type { LearningPathResponse } from '@/lib/types';

/**
 * The learning path (docs/67).
 *
 * Every stage answers both questions side by side — what to know, what to do —
 * because a reading list is not a plan and a task list with nothing behind it
 * is guesswork.
 *
 * The current stage is the earliest gap, not the furthest thing achieved, and
 * it is the only one open by default. Somebody selling on four names is one
 * short conversation from running out of people, and a path that congratulated
 * them for reaching stage two would be lying politely.
 */
export function LearningPathTab() {
  const t = useTranslations('path');
  const tc = useTranslations('common');
  const locale = useLocale();

  const [data, setData] = useState<LearningPathResponse | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<LearningPathResponse>(`/learning-path?locale=${locale}`)
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setOpen(res.currentStageKey);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locale]);

  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!data) return <p className="text-sm text-slate-500">{tc('loading')}</p>;

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <p className="text-sm text-slate-600">{t('intro')}</p>
        <p className="mt-1 text-sm font-medium text-slate-800">
          {t('progress', { done: data.clearedCount, total: data.total })}
        </p>
      </Card>

      {data.stages.map((stage) => {
        const isOpen = open === stage.key;
        const isCurrent = stage.key === data.currentStageKey;
        return (
          <Card key={stage.key}>
            <button
              type="button"
              onClick={() => setOpen(isOpen ? null : stage.key)}
              aria-expanded={isOpen}
              className="flex w-full items-center justify-between gap-2 text-left"
            >
              <span
                className={`min-w-0 font-medium ${
                  stage.cleared ? 'text-slate-400' : 'text-slate-800'
                }`}
              >
                {stage.label}
              </span>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${
                  stage.cleared
                    ? 'bg-brand-50 text-brand-700'
                    : isCurrent
                      ? 'bg-amber-100 text-amber-800'
                      : 'bg-slate-100 text-slate-400'
                }`}
              >
                {stage.cleared ? '✓' : isCurrent ? t('youAreHere') : t('later')}
              </span>
            </button>

            {isOpen ? (
              <div className="mt-3 flex flex-col gap-3">
                {stage.know.length > 0 ? (
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                      {t('toKnow')}
                    </p>
                    <ul className="mt-1 flex flex-col divide-y divide-slate-100">
                      {stage.know.map((course) => (
                        <li
                          key={course.code}
                          className="flex items-center justify-between gap-2 py-2"
                        >
                          <Link
                            href={`/${locale}/learning`}
                            className="min-w-0 text-sm text-brand-700 underline-offset-2 hover:underline"
                          >
                            {course.title}
                          </Link>
                          <span className="shrink-0 text-xs text-slate-400">
                            {course.status === 'completed'
                              ? t('done')
                              : course.status === 'in_progress'
                                ? t('reading')
                                : t('lessons', { count: course.lessonCount })}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {stage.do.length > 0 ? (
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                      {t('toDo')}
                    </p>
                    <ul className="mt-1 flex flex-col divide-y divide-slate-100">
                      {stage.do.map((action) => (
                        <li
                          key={action.key}
                          className="flex items-center justify-between gap-2 py-2"
                        >
                          <Link
                            href={`/${locale}${action.href}`}
                            className={`min-w-0 text-sm ${
                              action.done
                                ? 'text-slate-400 line-through'
                                : 'text-slate-700 underline-offset-2 hover:underline'
                            }`}
                          >
                            {action.label}
                          </Link>
                          <span
                            className={`shrink-0 text-xs ${
                              action.done ? 'text-brand-700' : 'text-slate-400'
                            }`}
                          >
                            {action.done ? '✓' : t('notYet')}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  // The last stage has no finish line, and saying so is kinder
                  // than an empty box that looks broken.
                  <p className="text-sm text-slate-500">{t('noEnd')}</p>
                )}
              </div>
            ) : null}
          </Card>
        );
      })}
    </div>
  );
}
