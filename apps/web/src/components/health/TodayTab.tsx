'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { api, ApiError, isForbidden } from '@/lib/api-client';
import {
  HABIT_CADENCES,
  METRIC_DEFAULT_UNITS,
  TRACKED_METRICS,
  type Habit,
  type HabitCadence,
  type HabitsResponse,
  type TrackedMetric,
} from '@/lib/types';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { ProfileCard } from '@/components/health/ProfileCard';

/** Matches the API's habit code rule, so the member sees the problem before the request does. */
const HABIT_CODE_PATTERN = '[a-z0-9-]{2,40}';

export function TodayTab() {
  const t = useTranslations('health');
  const tc = useTranslations('common');

  const [habits, setHabits] = useState<Habit[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Habits logged in this session — the API has no "was today logged?" read. */
  const [loggedToday, setLoggedToday] = useState<string[]>([]);
  const [loggingId, setLoggingId] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [cadence, setCadence] = useState<HabitCadence>('daily');
  const [targetUnit, setTargetUnit] = useState('');
  const [targetValue, setTargetValue] = useState('');
  const [creating, setCreating] = useState(false);
  const [habitError, setHabitError] = useState<string | null>(null);

  const [metric, setMetric] = useState<TrackedMetric>('weight_kg');
  const [metricValue, setMetricValue] = useState('');
  const [metricUnit, setMetricUnit] = useState(METRIC_DEFAULT_UNITS.weight_kg);
  const [recording, setRecording] = useState(false);
  const [metricError, setMetricError] = useState<string | null>(null);
  const [metricSaved, setMetricSaved] = useState(false);

  const loadHabits = useCallback(async () => {
    try {
      const res = await api.get<HabitsResponse>('/health/habits');
      setHabits(res.habits);
      setError(null);
    } catch (err: unknown) {
      if (isForbidden(err)) setForbidden(true);
      else setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadHabits().finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [loadHabits]);

  const handleLog = async (habitId: string) => {
    setError(null);
    setLoggingId(habitId);
    try {
      await api.post(`/health/habits/${habitId}/log`, { completed: true });
      setLoggedToday((current) => (current.includes(habitId) ? current : [...current, habitId]));
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setLoggingId(null);
    }
  };

  const handleCreateHabit = async (e: FormEvent) => {
    e.preventDefault();
    setHabitError(null);
    setCreating(true);
    try {
      const body: Record<string, unknown> = { code, name, cadence };
      if (targetUnit) body.targetUnit = targetUnit;
      if (targetValue) body.targetValue = Number(targetValue);
      await api.post('/health/habits', body);
      setName('');
      setCode('');
      setCadence('daily');
      setTargetUnit('');
      setTargetValue('');
      await loadHabits();
    } catch (err: unknown) {
      setHabitError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setCreating(false);
    }
  };

  const handleMetricChange = (next: TrackedMetric) => {
    setMetric(next);
    setMetricUnit(METRIC_DEFAULT_UNITS[next]);
    setMetricSaved(false);
  };

  const handleRecordMetric = async (e: FormEvent) => {
    e.preventDefault();
    setMetricError(null);
    setMetricSaved(false);
    setRecording(true);
    try {
      await api.post('/health/metrics', {
        metric,
        value: Number(metricValue),
        unit: metricUnit,
      });
      setMetricValue('');
      setMetricSaved(true);
    } catch (err: unknown) {
      setMetricError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setRecording(false);
    }
  };

  if (forbidden) {
    return (
      <Card>
        <p className="text-sm text-slate-600">{t('forbidden')}</p>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      <Card title={t('habits.title')}>
        <p className="mb-3 text-xs text-slate-500">{t('habits.hint')}</p>
        {loading ? (
          <p className="text-sm text-slate-500">{tc('loading')}</p>
        ) : habits.length === 0 ? (
          <p className="text-sm text-slate-500">{t('habits.empty')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-slate-100">
            {habits.map((habit) => {
              const done = loggedToday.includes(habit.id);
              // Only show a target when the member actually set one.
              const target =
                habit.targetUnit && habit.targetValue !== null && habit.targetValue !== undefined
                  ? t('habits.target', {
                      value: String(habit.targetValue),
                      unit: habit.targetUnit,
                    })
                  : habit.targetUnit
                    ? t('habits.targetUnitOnly', { unit: habit.targetUnit })
                    : null;
              return (
                <li
                  key={habit.id}
                  className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 py-2"
                >
                  <span className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-slate-800">{habit.name}</span>
                    <Badge tone="gray">
                      {habit.cadence === 'weekly'
                        ? t('habits.cadence.weekly')
                        : t('habits.cadence.daily')}
                    </Badge>
                    {target ? <span className="text-xs text-slate-500">{target}</span> : null}
                  </span>
                  {done ? (
                    <Badge tone="teal">{t('habits.logged')}</Badge>
                  ) : (
                    <Button
                      variant="secondary"
                      type="button"
                      disabled={loggingId === habit.id}
                      onClick={() => void handleLog(habit.id)}
                    >
                      {loggingId === habit.id ? tc('saving') : t('habits.log')}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card title={t('addHabit.title')}>
        <form onSubmit={handleCreateHabit} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input
            label={t('addHabit.name')}
            required
            maxLength={120}
            placeholder={t('addHabit.namePlaceholder')}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Input
            label={t('addHabit.code')}
            required
            pattern={HABIT_CODE_PATTERN}
            hint={t('addHabit.codeHint')}
            placeholder={t('addHabit.codePlaceholder')}
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <Select
            label={t('addHabit.cadence')}
            value={cadence}
            onChange={(e) => setCadence(e.target.value as HabitCadence)}
          >
            {HABIT_CADENCES.map((option) => (
              <option key={option} value={option}>
                {t(`habits.cadence.${option}`)}
              </option>
            ))}
          </Select>
          <Input
            label={t('addHabit.targetUnit')}
            maxLength={20}
            placeholder={t('addHabit.targetUnitPlaceholder')}
            value={targetUnit}
            onChange={(e) => setTargetUnit(e.target.value)}
          />
          <Input
            label={t('addHabit.targetValue')}
            type="number"
            min="0"
            step="any"
            inputMode="decimal"
            value={targetValue}
            onChange={(e) => setTargetValue(e.target.value)}
          />
          {habitError ? <p className="text-sm text-red-600 sm:col-span-2">{habitError}</p> : null}
          <div className="sm:col-span-2">
            <Button type="submit" disabled={creating}>
              {creating ? tc('saving') : t('addHabit.submit')}
            </Button>
          </div>
        </form>
      </Card>

      <Card title={t('metrics.title')}>
        <p className="mb-3 text-xs text-slate-500">{t('metrics.hint')}</p>
        <form onSubmit={handleRecordMetric} className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Select
            label={t('metrics.metric')}
            value={metric}
            onChange={(e) => handleMetricChange(e.target.value as TrackedMetric)}
          >
            {TRACKED_METRICS.map((option) => (
              <option key={option} value={option}>
                {t(`metrics.names.${option}`)}
              </option>
            ))}
          </Select>
          <Input
            label={t('metrics.value')}
            type="number"
            step="any"
            required
            inputMode="decimal"
            value={metricValue}
            onChange={(e) => {
              setMetricValue(e.target.value);
              setMetricSaved(false);
            }}
          />
          <Input
            label={t('metrics.unit')}
            required
            maxLength={20}
            value={metricUnit}
            onChange={(e) => setMetricUnit(e.target.value)}
          />
          {metricError ? <p className="text-sm text-red-600 sm:col-span-3">{metricError}</p> : null}
          <div className="flex flex-wrap items-center gap-3 sm:col-span-3">
            <Button type="submit" disabled={recording}>
              {recording ? tc('saving') : t('metrics.submit')}
            </Button>
            {metricSaved ? (
              <span className="text-sm text-teal-700">{t('metrics.saved')}</span>
            ) : null}
          </div>
        </form>
      </Card>

      <ProfileCard />
    </div>
  );
}
