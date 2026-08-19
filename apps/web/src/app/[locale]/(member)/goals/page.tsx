'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { api, ApiError } from '@/lib/api-client';
import type { Goal, GoalResponse, GoalsResponse } from '@/lib/types';
import { Badge, statusTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { formatDate } from '@/lib/format';

const CATEGORIES = ['health', 'fitness', 'nutrition', 'mindfulness', 'learning', 'other'] as const;

export default function GoalsPage() {
  const t = useTranslations('goals');
  const tc = useTranslations('common');
  const locale = useLocale();

  const [goals, setGoals] = useState<Goal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<string>(CATEGORIES[0]);
  const [targetDate, setTargetDate] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [completingId, setCompletingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<GoalsResponse>('/goals')
      .then((data) => {
        if (!cancelled) setGoals(data.goals);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      const body: Record<string, string> = { title, category };
      if (targetDate) body.targetDate = targetDate;
      const { goal } = await api.post<GoalResponse>('/goals', body);
      setGoals((g) => [goal, ...g]);
      setTitle('');
      setTargetDate('');
    } catch (err: unknown) {
      setFormError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleComplete = async (id: string) => {
    setCompletingId(id);
    try {
      const { goal } = await api.patch<GoalResponse>(`/goals/${id}`, { status: 'completed' });
      setGoals((list) => list.map((g) => (g.id === id ? goal : g)));
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setCompletingId(null);
    }
  };

  const categoryLabel = (value: string): string =>
    (CATEGORIES as readonly string[]).includes(value)
      ? t(`categories.${value as (typeof CATEGORIES)[number]}`)
      : value;

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-bold text-slate-900">{t('title')}</h1>

      <Card title={t('form.title')}>
        <form onSubmit={handleCreate} className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Input
            label={t('form.titleLabel')}
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="sm:col-span-3"
          />
          <Select
            label={t('form.category')}
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {t(`categories.${c}`)}
              </option>
            ))}
          </Select>
          <Input
            label={t('form.targetDate')}
            type="date"
            value={targetDate}
            onChange={(e) => setTargetDate(e.target.value)}
          />
          <div className="flex items-end">
            <Button type="submit" disabled={submitting} className="w-full sm:w-auto">
              {submitting ? t('form.submitting') : t('form.submit')}
            </Button>
          </div>
          {formError ? <p className="text-sm text-red-600 sm:col-span-3">{formError}</p> : null}
        </form>
      </Card>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      <Card>
        {loading ? (
          <p className="text-sm text-slate-500">{tc('loading')}</p>
        ) : goals.length === 0 ? (
          <p className="text-sm text-slate-500">{t('empty')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-slate-100">
            {goals.map((goal) => (
              <li key={goal.id} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-slate-800">{goal.title}</span>
                  <Badge tone={statusTone(goal.status)}>{goal.status}</Badge>
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                  {goal.category ? <span>{categoryLabel(goal.category)}</span> : null}
                  {goal.targetDate ? (
                    <span>{t('target', { date: formatDate(goal.targetDate, locale) })}</span>
                  ) : null}
                </div>
                {goal.status !== 'completed' ? (
                  <div>
                    <Button
                      variant="secondary"
                      onClick={() => handleComplete(goal.id)}
                      disabled={completingId === goal.id}
                    >
                      {completingId === goal.id ? t('completing') : t('markCompleted')}
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
