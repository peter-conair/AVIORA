'use client';

import { useEffect, useId, useState, type FormEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { api, ApiError, isForbidden } from '@/lib/api-client';
import type {
  HealthGoal,
  HealthGoalsResponse,
  HealthProfile,
  HealthProfileResponse,
} from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { formatDate } from '@/lib/format';

/** The API caps focus goals at 10; the form stops the member before the request does. */
const MAX_FOCUS_GOALS = 10;

/**
 * The member's own lifestyle notes and the health goals they want to focus on.
 * Both are self-scoped: nobody else can edit them, and only people the member
 * shares with can read them.
 */
export function ProfileCard() {
  const t = useTranslations('health');
  const tc = useTranslations('common');
  const locale = useLocale();
  const notesId = useId();

  const [profile, setProfile] = useState<HealthProfile | null>(null);
  const [goals, setGoals] = useState<HealthGoal[]>([]);
  const [notes, setNotes] = useState('');
  const [focusGoalIds, setFocusGoalIds] = useState<string[]>([]);

  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .get<HealthProfileResponse>('/health/me')
      .then((res) => {
        if (cancelled) return;
        setProfile(res.profile);
        setNotes(res.profile?.lifestyleNotes ?? '');
        setFocusGoalIds(res.profile?.focusGoalIds ?? []);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (isForbidden(err)) setForbidden(true);
        else setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    api
      .get<HealthGoalsResponse>('/knowledge/health-goals')
      .then((res) => {
        if (!cancelled) setGoals(res.healthGoals);
      })
      .catch(() => {
        // The knowledge library may be out of scope — notes still work without it.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleGoal = (goalId: string) => {
    setSaved(false);
    setFocusGoalIds((current) =>
      current.includes(goalId)
        ? current.filter((id) => id !== goalId)
        : current.length >= MAX_FOCUS_GOALS
          ? current
          : [...current, goalId],
    );
  };

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setSaving(true);
    try {
      const res = await api.put<HealthProfileResponse>('/health/me', {
        lifestyleNotes: notes,
        focusGoalIds,
      });
      setProfile(res.profile);
      setSaved(true);
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setSaving(false);
    }
  };

  if (forbidden) {
    return (
      <Card title={t('profile.title')}>
        <p className="text-sm text-slate-600">{t('forbidden')}</p>
      </Card>
    );
  }

  if (loading) {
    return (
      <Card title={t('profile.title')}>
        <p className="text-sm text-slate-500">{tc('loading')}</p>
      </Card>
    );
  }

  const atLimit = focusGoalIds.length >= MAX_FOCUS_GOALS;

  return (
    <Card title={t('profile.title')}>
      <form onSubmit={handleSave} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <label htmlFor={notesId} className="text-sm font-medium text-slate-700">
            {t('profile.notes')}
          </label>
          <textarea
            id={notesId}
            rows={4}
            maxLength={4000}
            value={notes}
            onChange={(e) => {
              setNotes(e.target.value);
              setSaved(false);
            }}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-600"
          />
          <p className="text-xs text-slate-500">{t('profile.notesHint')}</p>
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium text-slate-700">{t('profile.focusGoals')}</legend>
          <p className="text-xs text-slate-500">
            {t('profile.focusGoalsHint', { max: MAX_FOCUS_GOALS })}
          </p>
          {goals.length === 0 ? (
            <p className="text-sm text-slate-500">{t('profile.focusGoalsUnavailable')}</p>
          ) : (
            <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2">
              {goals.map((goal) => {
                const checked = focusGoalIds.includes(goal.id);
                return (
                  <li key={goal.id}>
                    <label className="flex items-start gap-2 rounded-lg px-2 py-1.5 text-sm text-slate-700 hover:bg-slate-50">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!checked && atLimit}
                        onChange={() => toggleGoal(goal.id)}
                        className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 text-brand-700 focus:ring-brand-600 disabled:opacity-40"
                      />
                      <span className="min-w-0">{goal.name}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </fieldset>

        {error ? <p className="text-sm text-red-600">{error}</p> : null}

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={saving}>
            {saving ? tc('saving') : t('profile.save')}
          </Button>
          {saved ? <span className="text-sm text-brand-700">{t('profile.saved')}</span> : null}
          {profile ? (
            <span className="text-xs text-slate-500">
              {t('profile.updatedAt', { date: formatDate(profile.updatedAt, locale) })}
            </span>
          ) : null}
        </div>
      </form>
    </Card>
  );
}
