'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { api, ApiError, isForbidden } from '@/lib/api-client';
import {
  CHALLENGE_SOURCES,
  GAMIFICATION_EVENTS,
  isKnownGamificationEvent,
  needsSourceRef,
  type ChallengeSource,
  type GamificationEvent,
  type GamificationRule,
  type GamificationRulesResponse,
} from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';

/** Matches the API's code rule, so the mistake is caught before the request. */
const CODE_PATTERN = '[a-z0-9-]{2,40}';

export function GamificationTab() {
  const t = useTranslations('admin.gamification');
  const tch = useTranslations('admin.challenges');
  const te = useTranslations('events');
  const tc = useTranslations('common');

  const [rules, setRules] = useState<GamificationRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Rule form
  const [eventName, setEventName] = useState<GamificationEvent>(GAMIFICATION_EVENTS[0]);
  const [points, setPoints] = useState('');
  const [badgeCode, setBadgeCode] = useState('');
  const [badgeName, setBadgeName] = useState('');
  const [savingRule, setSavingRule] = useState(false);
  const [ruleError, setRuleError] = useState<string | null>(null);

  // Challenge form
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [source, setSource] = useState<ChallengeSource>('habit');
  const [sourceRef, setSourceRef] = useState('');
  const [targetValue, setTargetValue] = useState('');
  const [startsOn, setStartsOn] = useState('');
  const [endsOn, setEndsOn] = useState('');
  const [creating, setCreating] = useState(false);
  const [challengeError, setChallengeError] = useState<string | null>(null);
  const [challengeCreated, setChallengeCreated] = useState<string | null>(null);

  const loadRules = useCallback(async () => {
    const res = await api.get<GamificationRulesResponse>('/gamification/rules');
    setRules(res.rules);
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadRules()
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

  const handleSaveRule = async (e: FormEvent) => {
    e.preventDefault();
    setRuleError(null);
    setSavingRule(true);
    try {
      const body: Record<string, unknown> = { eventName, points: Number(points) };
      if (badgeCode) body.badgeCode = badgeCode;
      if (badgeName) body.badgeName = badgeName;
      await api.post('/gamification/rules', body);
      setPoints('');
      setBadgeCode('');
      setBadgeName('');
      await loadRules();
    } catch (err: unknown) {
      if (isForbidden(err)) setRuleError(t('forbidden'));
      else setRuleError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setSavingRule(false);
    }
  };

  const handleCreateChallenge = async (e: FormEvent) => {
    e.preventDefault();
    setChallengeError(null);
    setChallengeCreated(null);
    setCreating(true);
    try {
      const body: Record<string, unknown> = {
        code,
        name,
        source,
        targetValue: Number(targetValue),
        startsOn,
        endsOn,
      };
      if (description) body.description = description;
      if (needsSourceRef(source) && sourceRef) body.sourceRef = sourceRef;
      await api.post('/challenges', body);
      setChallengeCreated(name);
      setCode('');
      setName('');
      setDescription('');
      setSourceRef('');
      setTargetValue('');
      setStartsOn('');
      setEndsOn('');
    } catch (err: unknown) {
      if (isForbidden(err)) setChallengeError(tch('forbidden'));
      else setChallengeError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setCreating(false);
    }
  };

  const eventLabel = (value: string): string =>
    isKnownGamificationEvent(value) ? te(value) : value;

  return (
    <div className="flex flex-col gap-4">
      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      <Card title={t('rulesTitle')}>
        <p className="mb-3 text-xs text-slate-500">{t('rulesHint')}</p>
        {forbidden ? (
          <p className="text-sm text-slate-600">{t('forbidden')}</p>
        ) : loading ? (
          <p className="text-sm text-slate-500">{tc('loading')}</p>
        ) : rules.length === 0 ? (
          <p className="text-sm text-slate-500">{t('rulesEmpty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[20rem] text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs uppercase text-slate-500">
                  <th scope="col" className="py-2 pe-3 font-semibold">
                    {t('event')}
                  </th>
                  <th scope="col" className="py-2 pe-3 font-semibold">
                    {t('points')}
                  </th>
                  <th scope="col" className="py-2 font-semibold">
                    {t('badge')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rules.map((rule) => (
                  <tr key={rule.id}>
                    <td className="py-2 pe-3 text-slate-800">{eventLabel(rule.eventName)}</td>
                    <td className="py-2 pe-3 font-semibold text-slate-900">{rule.points}</td>
                    <td className="py-2 text-slate-600">
                      {rule.badgeName ?? rule.badgeCode ?? t('noBadge')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {forbidden ? null : (
        <Card title={t('formTitle')}>
          <form onSubmit={handleSaveRule} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Select
              label={t('event')}
              value={eventName}
              onChange={(e) => setEventName(e.target.value as GamificationEvent)}
            >
              {GAMIFICATION_EVENTS.map((option) => (
                <option key={option} value={option}>
                  {te(option)}
                </option>
              ))}
            </Select>
            <Input
              label={t('points')}
              type="number"
              min="0"
              max="10000"
              step="1"
              inputMode="numeric"
              required
              value={points}
              onChange={(e) => setPoints(e.target.value)}
            />
            <Input
              label={t('badgeCode')}
              pattern={CODE_PATTERN}
              hint={t('badgeCodeHint')}
              value={badgeCode}
              onChange={(e) => setBadgeCode(e.target.value)}
            />
            <Input
              label={t('badgeName')}
              maxLength={80}
              value={badgeName}
              onChange={(e) => setBadgeName(e.target.value)}
            />
            {ruleError ? <p className="text-sm text-red-600 sm:col-span-2">{ruleError}</p> : null}
            <div className="sm:col-span-2">
              <Button type="submit" disabled={savingRule}>
                {savingRule ? tc('saving') : t('submit')}
              </Button>
            </div>
          </form>
        </Card>
      )}

      <Card title={tch('formTitle')}>
        <p className="mb-3 text-xs text-slate-500">{tch('hint')}</p>
        <form onSubmit={handleCreateChallenge} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input
            label={tch('code')}
            required
            pattern={CODE_PATTERN}
            hint={tch('codeHint')}
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <Input
            label={tch('name')}
            required
            maxLength={160}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Input
            label={tch('description')}
            maxLength={2000}
            className="sm:col-span-2"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <Select
            label={tch('source')}
            value={source}
            onChange={(e) => setSource(e.target.value as ChallengeSource)}
          >
            {CHALLENGE_SOURCES.map((option) => (
              <option key={option} value={option}>
                {tch(`sources.${option}`)}
              </option>
            ))}
          </Select>
          {needsSourceRef(source) ? (
            <Input
              label={tch('sourceRef')}
              maxLength={80}
              hint={tch('sourceRefHint')}
              value={sourceRef}
              onChange={(e) => setSourceRef(e.target.value)}
            />
          ) : null}
          <Input
            label={tch('targetValue')}
            type="number"
            min="1"
            max="10000"
            step="1"
            inputMode="numeric"
            required
            value={targetValue}
            onChange={(e) => setTargetValue(e.target.value)}
          />
          <Input
            label={tch('startsOn')}
            type="date"
            required
            value={startsOn}
            onChange={(e) => setStartsOn(e.target.value)}
          />
          <Input
            label={tch('endsOn')}
            type="date"
            required
            value={endsOn}
            onChange={(e) => setEndsOn(e.target.value)}
          />
          {challengeError ? (
            <p className="text-sm text-red-600 sm:col-span-2">{challengeError}</p>
          ) : null}
          <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
            <Button type="submit" disabled={creating}>
              {creating ? tc('saving') : tch('submit')}
            </Button>
            {challengeCreated ? (
              <span className="text-sm text-teal-700">
                {tch('created', { name: challengeCreated })}
              </span>
            ) : null}
          </div>
        </form>
      </Card>
    </div>
  );
}
