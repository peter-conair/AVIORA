'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { api, ApiError, isForbidden } from '@/lib/api-client';
import {
  COACH_QUESTIONS,
  type AnalyticsWindow,
  type CoachAnswerResponse,
  type CoachQuestion,
} from '@/lib/types';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { HealthExclusionNote } from '@/components/analytics/HealthExclusionNote';

interface TeamCoachProps {
  /** The window the leader chose on the dashboard above — one selector, one scope. */
  windowKey: AnalyticsWindow;
}

/**
 * The AI Team Coach (docs/28 §4).
 *
 * A leader picks one of eight questions; nothing else is offered, because the
 * eight are the questions the platform can answer from measures it actually
 * computes, and a ninth would mean inventing the measure behind it.
 *
 * The answer always arrives with the numbers it used, and those numbers are
 * shown beside it — an AI answer a leader cannot check is an answer they
 * should not act on.
 */
export function TeamCoach({ windowKey }: TeamCoachProps) {
  const t = useTranslations('analytics.coach');
  const tc = useTranslations('common');

  const [asking, setAsking] = useState<CoachQuestion | null>(null);
  const [result, setResult] = useState<CoachAnswerResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [limitMessage, setLimitMessage] = useState<string | null>(null);
  const [notEntitled, setNotEntitled] = useState(false);

  const ask = async (question: CoachQuestion) => {
    if (asking) return;
    setAsking(question);
    setError(null);
    setLimitMessage(null);
    try {
      // The question CODE, not the visible label: the API accepts either, and
      // sending the code keeps the request identical in Thai and in English.
      const res = await api.post<CoachAnswerResponse>('/ai/coach/team', {
        question,
        window: windowKey,
      });
      setResult(res);
    } catch (err: unknown) {
      setResult(null);
      if (err instanceof ApiError && err.code === 'RATE_LIMITED') {
        setLimitMessage(err.message);
      } else if (err instanceof ApiError && err.code === 'ENTITLEMENT_REQUIRED') {
        setNotEntitled(true);
      } else if (isForbidden(err)) {
        setNotEntitled(true);
      } else {
        setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
      }
    } finally {
      setAsking(null);
    }
  };

  return (
    <Card title={t('title')}>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-slate-600">{t('intro')}</p>

        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {COACH_QUESTIONS.map((question) => (
            <li key={question} className="min-w-0">
              <button
                type="button"
                disabled={asking !== null}
                onClick={() => void ask(question)}
                className={`w-full rounded-lg border px-3 py-2 text-start text-sm transition-colors disabled:opacity-60 ${
                  result?.question === question
                    ? 'border-teal-700 bg-teal-50 text-teal-900'
                    : 'border-slate-200 text-slate-700 hover:bg-slate-50'
                }`}
              >
                <span className="break-words">{t(`questions.${question}`)}</span>
              </button>
            </li>
          ))}
        </ul>

        {asking ? <p className="text-sm text-slate-500">{t('thinking')}</p> : null}
        {limitMessage ? <p className="text-sm text-amber-800">{limitMessage}</p> : null}
        {notEntitled ? <p className="text-sm text-slate-600">{t('notEntitled')}</p> : null}
        {error ? <p className="text-sm text-red-600">{error}</p> : null}

        {result ? (
          <div className="flex flex-col gap-3 border-t border-slate-100 pt-3">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="min-w-0 break-words text-sm font-semibold text-slate-900">
                {t(`questions.${result.question}`)}
              </h3>
              {/* A refusal is an ANSWER the platform stands behind (docs/28 §6),
                  so it is labelled as considered — never as a failure. */}
              <Badge tone={result.answeredBy === 'policy' ? 'amber' : 'teal'}>
                {result.answeredBy === 'policy'
                  ? t('answeredByPolicy')
                  : t('answeredByModel', { model: result.model ?? '—' })}
              </Badge>
              <Badge tone="gray">{t('teamsInScope', { count: result.teamsInScope })}</Badge>
            </div>

            <p className="whitespace-pre-line break-words rounded-xl bg-slate-100 p-3 text-sm text-slate-800">
              {result.answer}
            </p>

            {result.answeredBy === 'policy' ? (
              <p className="text-xs text-slate-500">{t('policyNote')}</p>
            ) : null}

            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                {t('factsTitle')}
              </span>
              {result.facts.length === 0 ? (
                <p className="text-sm text-slate-500">{t('factsEmpty')}</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {result.facts.map((fact, index) => (
                    <li
                      key={`${result.question}-fact-${index}`}
                      className="min-w-0 break-words text-sm text-slate-700"
                    >
                      {fact}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {result.citations.length > 0 ? (
              <ul className="flex flex-wrap gap-1">
                {result.citations.map((citation, index) => (
                  <li key={`${result.question}-cite-${index}`}>
                    <Badge tone="gray">{citation.title}</Badge>
                  </li>
                ))}
              </ul>
            ) : null}

            {/* The coach answers from the leader dashboard's numbers, so the same
                caveat about what "inactive" means travels with its answer. */}
            <HealthExclusionNote definitions={result.definitions} />
          </div>
        ) : null}
      </div>
    </Card>
  );
}
