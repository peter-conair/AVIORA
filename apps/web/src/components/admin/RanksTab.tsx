'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { api, ApiError, isForbidden } from '@/lib/api-client';
import {
  isMoneyMetric,
  RANK_COMPARATORS,
  RANK_METRICS,
  RANK_WINDOWS,
  rankMetricKey,
  rankWindowKey,
  REFERRAL_TYPES,
  referralTypeKey,
  type Member,
  type MembersResponse,
  type RankComparator,
  type RankDefinition,
  type RankEvaluateResponse,
  type RankMetric,
  type RanksResponse,
  type RankWindow,
  type ReferralEdge,
  type ReferralResponse,
  type ReferralsResponse,
  type ReferralType,
} from '@/lib/types';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { formatDate, formatMoney } from '@/lib/format';

/** Matches the API's own code rule, so the mistake is caught before the request. */
const RANK_CODE_PATTERN = '[a-z0-9-]{2,40}';

interface QualificationDraft {
  metric: RankMetric;
  comparator: RankComparator;
  threshold: string;
  window: RankWindow;
  legVolumeMinor: string;
}

function emptyQualification(): QualificationDraft {
  return {
    metric: 'personal_volume',
    comparator: 'gte',
    threshold: '',
    window: 'lifetime',
    legVolumeMinor: '',
  };
}

export function RanksTab() {
  const t = useTranslations('admin.growth');
  const tg = useTranslations('growth');
  const tc = useTranslations('common');
  const locale = useLocale();

  const [ranks, setRanks] = useState<RankDefinition[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  /** Named by the ladder response — never inferred, never defaulted. */
  const [currency, setCurrency] = useState('');
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Rank form
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [level, setLevel] = useState('');
  const [requalifyWindowDays, setRequalifyWindowDays] = useState('');
  const [qualifications, setQualifications] = useState<QualificationDraft[]>([]);
  const [savingRank, setSavingRank] = useState(false);
  const [rankError, setRankError] = useState<string | null>(null);
  const [rankCreated, setRankCreated] = useState<string | null>(null);

  // Evaluation
  const [evaluating, setEvaluating] = useState(false);
  const [evaluateError, setEvaluateError] = useState<string | null>(null);
  const [evaluated, setEvaluated] = useState<RankEvaluateResponse | null>(null);

  // Referral form and the tenant-wide graph behind it.
  const [referrerId, setReferrerId] = useState('');
  const [referredId, setReferredId] = useState('');
  const [relationshipType, setRelationshipType] = useState<ReferralType>('referral');
  const [savingReferral, setSavingReferral] = useState(false);
  const [referralError, setReferralError] = useState<string | null>(null);
  const [edges, setEdges] = useState<ReferralEdge[]>([]);
  const [edgesLoading, setEdgesLoading] = useState(true);
  /** Ended edges are history, not noise — off by default, never dropped. */
  const [includeEnded, setIncludeEnded] = useState(false);
  const [endingId, setEndingId] = useState<string | null>(null);

  const loadRanks = useCallback(async () => {
    const res = await api.get<RanksResponse>('/ranks');
    setRanks(res.ranks);
    // The thresholds and the code they are denominated in arrive together, so a
    // rank can never be rendered against a currency from somewhere else.
    setCurrency(res.currency);
  }, []);

  const loadEdges = useCallback(async (withEnded: boolean) => {
    const res = await api.get<ReferralsResponse>(
      `/referrals?includeEnded=${withEnded ? 'true' : 'false'}`,
    );
    setEdges(res.referrals);
  }, []);

  useEffect(() => {
    let cancelled = false;

    // Members only feed the edge pickers; not having them must not hide the ladder.
    api
      .get<MembersResponse>('/members')
      .then((res) => {
        if (!cancelled) setMembers(res.members);
      })
      .catch(() => undefined);

    // A separate permission from the ladder (`referral.manage`), so it fails on
    // its own and reports on its own rather than blanking the tab.
    loadEdges(false)
      .catch((err: unknown) => {
        if (cancelled) return;
        setReferralError(
          isForbidden(err)
            ? t('forbidden')
            : err instanceof ApiError
              ? err.message
              : tc('errorGeneric'),
        );
      })
      .finally(() => {
        if (!cancelled) setEdgesLoading(false);
      });

    loadRanks()
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

  const metricLabel = (metric: string): string => {
    const key = rankMetricKey(metric);
    return key ? tg(key) : metric;
  };

  const windowLabel = (window: string): string => {
    const key = rankWindowKey(window);
    return key ? tg(key) : window;
  };

  const typeLabel = (type: string): string => {
    const key = referralTypeKey(type);
    return key ? tg(key) : type;
  };

  const comparatorLabel = (comparator: string): string =>
    (RANK_COMPARATORS as readonly string[]).includes(comparator)
      ? t(`comparators.${comparator}`)
      : comparator;

  /**
   * Money thresholds divide by 100 once, at render. Counts never divide. The
   * currency arrives with the ranks it belongs to, so the guard only holds for
   * the instant before the first response lands.
   */
  const thresholdLabel = (metric: string, threshold: number): string =>
    isMoneyMetric(metric) && currency
      ? formatMoney(threshold, currency, locale)
      : new Intl.NumberFormat(locale === 'th' ? 'th-TH' : 'en-GB').format(threshold);

  const updateQualification = (index: number, patch: Partial<QualificationDraft>) =>
    setQualifications((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const handleCreateRank = async (e: FormEvent) => {
    e.preventDefault();
    setRankError(null);
    setRankCreated(null);
    setSavingRank(true);
    try {
      const body: Record<string, unknown> = {
        code,
        name,
        level: Number(level),
        qualifications: qualifications.map((row) => {
          const rule: Record<string, unknown> = {
            metric: row.metric,
            comparator: row.comparator,
            threshold: Number(row.threshold),
            window: row.window,
          };
          // A qualified_legs rule is rejected by the API without this, so it is
          // sent only where it means something.
          if (row.metric === 'qualified_legs' && row.legVolumeMinor) {
            rule.params = { legVolumeMinor: Number(row.legVolumeMinor) };
          }
          return rule;
        }),
      };
      if (requalifyWindowDays) body.requalifyWindowDays = Number(requalifyWindowDays);
      await api.post('/ranks', body);
      setRankCreated(name);
      setCode('');
      setName('');
      setLevel('');
      setRequalifyWindowDays('');
      setQualifications([]);
      await loadRanks();
    } catch (err: unknown) {
      if (isForbidden(err)) setRankError(t('forbidden'));
      else setRankError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setSavingRank(false);
    }
  };

  const handleEvaluate = async () => {
    setEvaluateError(null);
    setEvaluated(null);
    setEvaluating(true);
    try {
      // No memberId: the whole workspace, as of now.
      const res = await api.post<RankEvaluateResponse>('/ranks/evaluate', {});
      setEvaluated(res);
    } catch (err: unknown) {
      if (isForbidden(err)) setEvaluateError(t('forbidden'));
      else setEvaluateError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setEvaluating(false);
    }
  };

  const handleToggleEnded = async (withEnded: boolean) => {
    setIncludeEnded(withEnded);
    setReferralError(null);
    setEdgesLoading(true);
    try {
      await loadEdges(withEnded);
    } catch (err: unknown) {
      if (isForbidden(err)) setReferralError(t('forbidden'));
      else setReferralError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setEdgesLoading(false);
    }
  };

  const handleCreateReferral = async (e: FormEvent) => {
    e.preventDefault();
    setReferralError(null);
    setSavingReferral(true);
    try {
      await api.post<ReferralResponse>('/referrals', {
        referrerMemberId: referrerId,
        referredMemberId: referredId,
        type: relationshipType,
      });
      setReferredId('');
      await loadEdges(includeEnded);
    } catch (err: unknown) {
      if (isForbidden(err)) setReferralError(t('forbidden'));
      else setReferralError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setSavingReferral(false);
    }
  };

  const handleEndReferral = async (id: string) => {
    setReferralError(null);
    setEndingId(id);
    try {
      await api.delete<ReferralResponse>(`/referrals/${id}`);
      // Ending stamps effective_to rather than deleting, so the row leaves this
      // list only because the list is showing active edges — reloading is what
      // makes that visible either way.
      await loadEdges(includeEnded);
    } catch (err: unknown) {
      if (isForbidden(err)) setReferralError(t('forbidden'));
      else setReferralError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setEndingId(null);
    }
  };

  /** The list names both ends; the member roster is only a fallback. */
  const edgeName = (name: string | null | undefined, id: string | undefined): string =>
    name ?? members.find((member) => member.id === id)?.displayName ?? id ?? '—';

  return (
    <div className="flex flex-col gap-4">
      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      <Card title={t('ladderTitle')}>
        <p className="mb-3 text-xs text-slate-500">{t('ladderHint')}</p>
        {forbidden ? (
          <p className="text-sm text-slate-600">{t('forbidden')}</p>
        ) : loading ? (
          <p className="text-sm text-slate-500">{tc('loading')}</p>
        ) : ranks.length === 0 ? (
          <p className="text-sm text-slate-500">{t('ladderEmpty')}</p>
        ) : (
          <ol className="flex flex-col divide-y divide-slate-100">
            {[...ranks]
              .sort((a, b) => a.level - b.level)
              .map((rank) => (
                <li key={rank.id} className="flex flex-col gap-2 py-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <span className="flex min-w-0 flex-col">
                      <span className="min-w-0 break-words text-sm font-medium text-slate-800">
                        {rank.name}
                      </span>
                      <span className="block break-all text-xs text-slate-500">{rank.code}</span>
                    </span>
                    <Badge tone="gray">{t('level', { level: rank.level })}</Badge>
                  </div>
                  {rank.qualifications.length === 0 ? (
                    <p className="text-xs text-slate-500">{t('noQualifications')}</p>
                  ) : (
                    <ul className="flex flex-col gap-1">
                      {rank.qualifications.map((qualification, index) => (
                        <li
                          key={qualification.id ?? `${rank.id}-${index}`}
                          className="min-w-0 break-words text-xs text-slate-600"
                        >
                          {t('rule', {
                            metric: metricLabel(qualification.metric),
                            comparator: comparatorLabel(qualification.comparator),
                            threshold: thresholdLabel(
                              qualification.metric,
                              qualification.threshold,
                            ),
                            window: windowLabel(qualification.window),
                          })}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
          </ol>
        )}
      </Card>

      {forbidden ? null : (
        <>
          <Card title={t('formTitle')}>
            <form onSubmit={handleCreateRank} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Input
                label={t('code')}
                required
                pattern={RANK_CODE_PATTERN}
                hint={t('codeHint')}
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
              <Input
                label={t('name')}
                required
                maxLength={160}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <Input
                label={t('levelInput')}
                type="number"
                min="0"
                max="1000"
                step="1"
                inputMode="numeric"
                required
                hint={t('levelHint')}
                value={level}
                onChange={(e) => setLevel(e.target.value)}
              />
              <Input
                label={t('requalifyWindowDays')}
                type="number"
                min="1"
                max="3650"
                step="1"
                inputMode="numeric"
                hint={t('requalifyHint')}
                value={requalifyWindowDays}
                onChange={(e) => setRequalifyWindowDays(e.target.value)}
              />

              <div className="flex flex-col gap-3 sm:col-span-2">
                <span className="text-sm font-semibold text-slate-800">
                  {t('qualificationsTitle')}
                </span>
                {qualifications.length === 0 ? (
                  <p className="text-xs text-slate-500">{t('qualificationsEmpty')}</p>
                ) : null}
                {qualifications.map((row, index) => (
                  <div
                    key={index}
                    className="grid grid-cols-1 gap-3 rounded-lg border border-slate-200 p-3 sm:grid-cols-2"
                  >
                    <Select
                      label={t('metric')}
                      value={row.metric}
                      onChange={(e) =>
                        updateQualification(index, { metric: e.target.value as RankMetric })
                      }
                    >
                      {RANK_METRICS.map((option) => (
                        <option key={option} value={option}>
                          {metricLabel(option)}
                        </option>
                      ))}
                    </Select>
                    <Select
                      label={t('comparator')}
                      value={row.comparator}
                      onChange={(e) =>
                        updateQualification(index, {
                          comparator: e.target.value as RankComparator,
                        })
                      }
                    >
                      {RANK_COMPARATORS.map((option) => (
                        <option key={option} value={option}>
                          {t(`comparators.${option}`)}
                        </option>
                      ))}
                    </Select>
                    <Input
                      label={t('threshold')}
                      type="number"
                      min="0"
                      max="1000000000000"
                      step="1"
                      inputMode="numeric"
                      required
                      hint={t('thresholdHint')}
                      value={row.threshold}
                      onChange={(e) => updateQualification(index, { threshold: e.target.value })}
                    />
                    <Select
                      label={t('window')}
                      value={row.window}
                      onChange={(e) =>
                        updateQualification(index, { window: e.target.value as RankWindow })
                      }
                    >
                      {RANK_WINDOWS.map((option) => (
                        <option key={option} value={option}>
                          {windowLabel(option)}
                        </option>
                      ))}
                    </Select>
                    {row.metric === 'qualified_legs' ? (
                      <Input
                        label={t('legVolumeMinor')}
                        type="number"
                        min="1"
                        max="1000000000000"
                        step="1"
                        inputMode="numeric"
                        required
                        hint={t('legVolumeHint')}
                        className="sm:col-span-2"
                        value={row.legVolumeMinor}
                        onChange={(e) =>
                          updateQualification(index, { legVolumeMinor: e.target.value })
                        }
                      />
                    ) : null}
                    <div className="sm:col-span-2">
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() =>
                          setQualifications((rows) => rows.filter((_, i) => i !== index))
                        }
                      >
                        {t('removeQualification')}
                      </Button>
                    </div>
                  </div>
                ))}
                <div>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => setQualifications((rows) => [...rows, emptyQualification()])}
                  >
                    {t('addQualification')}
                  </Button>
                </div>
              </div>

              {rankError ? <p className="text-sm text-red-600 sm:col-span-2">{rankError}</p> : null}
              <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
                <Button type="submit" disabled={savingRank}>
                  {savingRank ? tc('saving') : t('submitRank')}
                </Button>
                {rankCreated ? (
                  <span className="text-sm text-teal-700">
                    {t('rankCreated', { name: rankCreated })}
                  </span>
                ) : null}
              </div>
            </form>
          </Card>

          <Card title={t('evaluateTitle')}>
            <div className="flex flex-col gap-3">
              <p className="text-xs text-slate-500">{t('evaluateHint')}</p>
              <div className="flex flex-wrap items-center gap-3">
                <Button type="button" disabled={evaluating} onClick={() => void handleEvaluate()}>
                  {evaluating ? tc('saving') : t('evaluate')}
                </Button>
                {evaluated ? (
                  <span className="text-sm text-teal-700">
                    {t('evaluateDone', {
                      evaluated: evaluated.evaluated,
                      changed: evaluated.changed,
                    })}
                  </span>
                ) : null}
              </div>
              {evaluateError ? <p className="text-sm text-red-600">{evaluateError}</p> : null}
            </div>
          </Card>

          <Card title={t('referralsTitle')}>
            <p className="mb-3 text-xs text-slate-500">{t('referralsHint')}</p>
            {members.length === 0 ? (
              <p className="text-sm text-slate-500">{t('membersUnavailable')}</p>
            ) : (
              <form
                onSubmit={handleCreateReferral}
                className="grid grid-cols-1 gap-4 sm:grid-cols-2"
              >
                <Select
                  label={t('referrer')}
                  required
                  value={referrerId}
                  onChange={(e) => setReferrerId(e.target.value)}
                >
                  <option value="">{t('choose')}</option>
                  {members.map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.displayName}
                    </option>
                  ))}
                </Select>
                <Select
                  label={t('referred')}
                  required
                  value={referredId}
                  onChange={(e) => setReferredId(e.target.value)}
                >
                  <option value="">{t('choose')}</option>
                  {members.map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.displayName}
                    </option>
                  ))}
                </Select>
                <Select
                  label={t('relationshipType')}
                  className="sm:col-span-2"
                  value={relationshipType}
                  onChange={(e) => setRelationshipType(e.target.value as ReferralType)}
                >
                  {REFERRAL_TYPES.map((option) => (
                    <option key={option} value={option}>
                      {typeLabel(option)}
                    </option>
                  ))}
                </Select>
                <div className="sm:col-span-2">
                  <Button type="submit" disabled={savingReferral}>
                    {savingReferral ? tc('saving') : t('submitReferral')}
                  </Button>
                </div>
              </form>
            )}

            {/* One place for every failure on this card — writing an edge,
                ending one, or reading the list back. */}
            {referralError ? <p className="mt-3 text-sm text-red-600">{referralError}</p> : null}

            <div className="mt-4 flex flex-col gap-2 border-t border-slate-100 pt-3">
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-slate-300 text-teal-700 focus:ring-teal-600"
                  checked={includeEnded}
                  onChange={(e) => void handleToggleEnded(e.target.checked)}
                />
                <span>{t('showEnded')}</span>
              </label>
              {edgesLoading ? (
                <p className="text-sm text-slate-500">{tc('loading')}</p>
              ) : edges.length === 0 ? (
                <p className="text-sm text-slate-500">{t('referralsEmpty')}</p>
              ) : (
                <ul className="flex flex-col divide-y divide-slate-100">
                  {edges.map((edge) => {
                    const ended = !!edge.effectiveTo;
                    return (
                      <li
                        key={edge.id}
                        className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2"
                      >
                        <span className="flex min-w-0 flex-col">
                          <span
                            className={`min-w-0 break-words text-sm ${
                              ended ? 'text-slate-400 line-through' : 'text-slate-800'
                            }`}
                          >
                            {edgeName(edge.referrerDisplayName, edge.referrerMemberId)} →{' '}
                            {edgeName(edge.referredDisplayName, edge.referredMemberId)}
                          </span>
                          <span className="text-xs text-slate-500">
                            {typeLabel(edge.relationshipType)} ·{' '}
                            {tg('since', { date: formatDate(edge.effectiveFrom, locale) })}
                          </span>
                        </span>
                        {ended ? (
                          <Badge tone="gray">{t('referralEnded')}</Badge>
                        ) : (
                          <button
                            type="button"
                            disabled={endingId === edge.id}
                            onClick={() => void handleEndReferral(edge.id)}
                            className="text-sm font-medium text-slate-500 hover:underline disabled:opacity-50"
                          >
                            {endingId === edge.id ? tc('saving') : t('endReferral')}
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
