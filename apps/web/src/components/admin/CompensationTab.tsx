'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { api, ApiError, isForbidden } from '@/lib/api-client';
import {
  metricWalksAGraph,
  bonusTypeKey,
  COMPENSATION_METRICS,
  COMPENSATION_WINDOWS,
  isMoneyMetric,
  METRIC_GRAPHS,
  metricGraphKey,
  PAYOUT_KINDS,
  RANK_COMPARATORS,
  rankMetricKey,
  rankWindowKey,
  toConditions,
  toEntryBasis,
  toPayout,
  type CommissionEntry,
  type CommissionRun,
  type CommissionRunResponse,
  type CommissionRunsResponse,
  type CompensationMetric,
  type CompensationPlan,
  type CompensationPlansResponse,
  type CompensationWindow,
  type CreateRunResponse,
  type Member,
  type MembersResponse,
  type MetricGraph,
  type PayoutKind,
  type Placement,
  type PlacementsResponse,
  type RankComparator,
  type RuleCondition,
  type RulePayout,
  type RunEntriesResponse,
} from '@/lib/types';
import { Badge, statusTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { formatDate, formatMoney } from '@/lib/format';

/** Matches the API's own code rules, so the mistake is caught before the request. */
const CODE_PATTERN = '[a-z0-9-]{2,40}';
const BONUS_TYPE_PATTERN = '[a-z0-9_]{2,40}';
const CURRENCY_PATTERN = '[A-Z]{3}';

/** Statuses this build has wording for; anything else is shown verbatim. */
const PLAN_STATUSES: readonly string[] = ['active', 'archived'];
const RUN_STATUSES: readonly string[] = ['draft', 'approved'];

interface ConditionDraft {
  metric: CompensationMetric;
  comparator: RankComparator;
  threshold: string;
  window: CompensationWindow;
  graph: MetricGraph;
  legVolumeMinor: string;
}

function emptyCondition(): ConditionDraft {
  return {
    metric: 'personal_volume',
    comparator: 'gte',
    threshold: '',
    window: 'period',
    graph: 'compensation',
    legVolumeMinor: '',
  };
}

/**
 * Compensation configuration (docs/26). Plans, rules, runs and the placement
 * graph are all permission-scoped: a tenant owner holds no membership plan, so
 * the `growth.compensation` entitlement gates the member-facing earnings view
 * and nothing here (docs/26 §6).
 */
export function CompensationTab() {
  const t = useTranslations('admin.compensation');
  const tgr = useTranslations('admin.growth');
  const tg = useTranslations('growth');
  const te = useTranslations('earnings');
  const tc = useTranslations('common');
  const locale = useLocale();

  const [plans, setPlans] = useState<CompensationPlan[]>([]);
  const [runs, setRuns] = useState<CommissionRun[]>([]);
  const [placements, setPlacements] = useState<Placement[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Plan form
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [currency, setCurrency] = useState('');
  const [savingPlan, setSavingPlan] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [planCreated, setPlanCreated] = useState<string | null>(null);

  // Rule form
  const [rulePlanId, setRulePlanId] = useState('');
  const [ruleCode, setRuleCode] = useState('');
  const [ruleName, setRuleName] = useState('');
  const [bonusType, setBonusType] = useState('fixed_cash');
  const [priority, setPriority] = useState('100');
  const [conditions, setConditions] = useState<ConditionDraft[]>([]);
  const [payoutKind, setPayoutKind] = useState<PayoutKind>('fixed');
  const [amountMinor, setAmountMinor] = useState('');
  const [percent, setPercent] = useState('');
  const [basis, setBasis] = useState<CompensationMetric>('downline_volume');
  const [basisWindow, setBasisWindow] = useState<CompensationWindow>('period');
  const [basisGraph, setBasisGraph] = useState<MetricGraph>('compensation');
  const [basisLegVolumeMinor, setBasisLegVolumeMinor] = useState('');
  const [capMinor, setCapMinor] = useState('');
  const [savingRule, setSavingRule] = useState(false);
  const [ruleError, setRuleError] = useState<string | null>(null);
  const [ruleCreated, setRuleCreated] = useState<string | null>(null);

  // Run form and the runs behind it
  const [runPlanId, setRunPlanId] = useState('');
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [savingRun, setSavingRun] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  /** Distinguishes "made a run" from "this period already had one" (docs/26 §4). */
  const [runCreated, setRunCreated] = useState<boolean | null>(null);
  const [busyRunId, setBusyRunId] = useState<string | null>(null);
  const [entriesRunId, setEntriesRunId] = useState<string | null>(null);
  const [entries, setEntries] = useState<CommissionEntry[]>([]);
  const [entriesLoading, setEntriesLoading] = useState(false);

  // Placement graph
  const [uplineId, setUplineId] = useState('');
  const [downlineId, setDownlineId] = useState('');
  const [savingPlacement, setSavingPlacement] = useState(false);
  const [placementError, setPlacementError] = useState<string | null>(null);
  /** Ended placements are history, not noise — off by default, never dropped. */
  const [includeEnded, setIncludeEnded] = useState(false);
  const [endingId, setEndingId] = useState<string | null>(null);

  const loadPlans = useCallback(async () => {
    const res = await api.get<CompensationPlansResponse>('/compensation/plans');
    setPlans(res.plans);
  }, []);

  const loadRuns = useCallback(async () => {
    const res = await api.get<CommissionRunsResponse>('/compensation/runs');
    setRuns(res.runs);
  }, []);

  const loadPlacements = useCallback(async (withEnded: boolean) => {
    const res = await api.get<PlacementsResponse>(
      `/compensation/graph?includeEnded=${withEnded ? 'true' : 'false'}`,
    );
    setPlacements(res.placements);
  }, []);

  useEffect(() => {
    let cancelled = false;

    // Members only feed the placement pickers; not having them must not hide
    // the plans.
    api
      .get<MembersResponse>('/members')
      .then((res) => {
        if (!cancelled) setMembers(res.members);
      })
      .catch(() => undefined);

    Promise.all([loadPlans(), loadRuns(), loadPlacements(false)])
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

  const graphLabel = (graph: string): string => {
    const key = metricGraphKey(graph);
    return key ? tg(key) : graph;
  };

  const comparatorLabel = (comparator: string): string =>
    (RANK_COMPARATORS as readonly string[]).includes(comparator)
      ? tgr(`comparators.${comparator}`)
      : comparator;

  const bonusLabel = (value: string): string => {
    const key = bonusTypeKey(value);
    return key ? te(key) : value;
  };

  const planStatusLabel = (status: string): string =>
    PLAN_STATUSES.includes(status) ? t(`statuses.${status}`) : status;

  const runStatusLabel = (status: string): string =>
    RUN_STATUSES.includes(status) ? t(`runStatuses.${status}`) : status;

  const countFormat = (value: number): string =>
    new Intl.NumberFormat(locale === 'th' ? 'th-TH' : 'en-GB').format(value);

  /**
   * Money metrics are minor units of the PLAN's currency and divide by 100 once,
   * at render. Counts never divide — a threshold of 3 qualified legs is 3.
   */
  const metricAmount = (metric: string, value: number, planCurrency: string): string =>
    isMoneyMetric(metric) && planCurrency
      ? formatMoney(value, planCurrency, locale)
      : countFormat(value);

  const conditionText = (condition: RuleCondition, planCurrency: string): string => {
    const shared = {
      metric: metricLabel(condition.metric),
      comparator: comparatorLabel(condition.comparator),
      threshold: metricAmount(condition.metric, condition.threshold, planCurrency),
      window: windowLabel(condition.window),
    };
    // Personal volume and completed courses are about one member. Naming a
    // graph beside them would describe a traversal that never happens.
    return metricWalksAGraph(condition.metric)
      ? t('conditionLine', { ...shared, graph: graphLabel(condition.graph ?? 'compensation') })
      : t('conditionLineNoGraph', shared);
  };

  /** The payout as a sentence a person can check against the plan document. */
  const payoutText = (payout: RulePayout | null, planCurrency: string): string => {
    if (!payout) return t('payoutUnreadable');
    if (payout.kind === 'fixed') {
      return t('payoutFixed', { amount: formatMoney(payout.amountMinor, planCurrency, locale) });
    }
    const shared = {
      percent: countFormat(payout.percent),
      metric: metricLabel(payout.basis),
      window: windowLabel(payout.basisWindow ?? 'period'),
    };
    const parts = [
      metricWalksAGraph(payout.basis)
        ? t('payoutPercent', { ...shared, graph: graphLabel(payout.basisGraph ?? 'compensation') })
        : t('payoutPercentNoGraph', shared),
    ];
    if (payout.capMinor) {
      parts.push(t('payoutCap', { cap: formatMoney(payout.capMinor, planCurrency, locale) }));
    }
    return parts.join(' · ');
  };

  const updateCondition = (index: number, patch: Partial<ConditionDraft>) =>
    setConditions((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const handleCreatePlan = async (e: FormEvent) => {
    e.preventDefault();
    setPlanError(null);
    setPlanCreated(null);
    setSavingPlan(true);
    try {
      const body: Record<string, unknown> = { code, name };
      if (description) body.description = description;
      if (currency) body.currency = currency.toUpperCase();
      await api.post('/compensation/plans', body);
      setPlanCreated(name);
      setCode('');
      setName('');
      setDescription('');
      setCurrency('');
      await loadPlans();
    } catch (err: unknown) {
      if (isForbidden(err)) setPlanError(t('forbidden'));
      else setPlanError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setSavingPlan(false);
    }
  };

  const handleAddRule = async (e: FormEvent) => {
    e.preventDefault();
    setRuleError(null);
    setRuleCreated(null);
    setSavingRule(true);
    try {
      const payout: Record<string, unknown> =
        payoutKind === 'fixed'
          ? { kind: 'fixed', amountMinor: Number(amountMinor) }
          : {
              kind: 'percent',
              percent: Number(percent),
              basis,
              basisWindow,
              basisGraph,
            };
      if (payoutKind === 'percent') {
        if (capMinor) payout.capMinor = Number(capMinor);
        // The API rejects a qualified_legs basis without it, so it is sent
        // only where it means something.
        if (basis === 'qualified_legs' && basisLegVolumeMinor) {
          payout.basisParams = { legVolumeMinor: Number(basisLegVolumeMinor) };
        }
      }
      await api.post(`/compensation/plans/${rulePlanId}/rules`, {
        code: ruleCode,
        name: ruleName,
        bonusType,
        priority: Number(priority),
        conditions: conditions.map((row) => {
          const condition: Record<string, unknown> = {
            metric: row.metric,
            comparator: row.comparator,
            threshold: Number(row.threshold),
            window: row.window,
            graph: row.graph,
          };
          if (row.metric === 'qualified_legs' && row.legVolumeMinor) {
            condition.params = { legVolumeMinor: Number(row.legVolumeMinor) };
          }
          return condition;
        }),
        payout,
      });
      setRuleCreated(ruleName);
      setRuleCode('');
      setRuleName('');
      setConditions([]);
      setAmountMinor('');
      setPercent('');
      setCapMinor('');
      setBasisLegVolumeMinor('');
      await loadPlans();
    } catch (err: unknown) {
      if (isForbidden(err)) setRuleError(t('forbidden'));
      else setRuleError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setSavingRule(false);
    }
  };

  const handleCreateRun = async (e: FormEvent) => {
    e.preventDefault();
    setRunError(null);
    setRunCreated(null);
    setSavingRun(true);
    try {
      const res = await api.post<CreateRunResponse>('/compensation/runs', {
        planId: runPlanId,
        periodStart,
        periodEnd,
      });
      // Asking twice for the same period returns the first run rather than a
      // second payout — worth saying, because nothing new happened.
      setRunCreated(res.created);
      await loadRuns();
    } catch (err: unknown) {
      if (isForbidden(err)) setRunError(t('forbidden'));
      else setRunError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setSavingRun(false);
    }
  };

  const openEntries = async (run: CommissionRun) => {
    setRunError(null);
    setEntriesRunId(run.id);
    setEntriesLoading(true);
    try {
      const res = await api.get<RunEntriesResponse>(`/compensation/runs/${run.id}/entries`);
      setEntries(res.entries);
    } catch (err: unknown) {
      setEntries([]);
      if (isForbidden(err)) setRunError(t('forbidden'));
      else setRunError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setEntriesLoading(false);
    }
  };

  const handleRecompute = async (run: CommissionRun) => {
    setRunError(null);
    setBusyRunId(run.id);
    try {
      await api.post<CommissionRunResponse>(`/compensation/runs/${run.id}/recompute`);
      await loadRuns();
      if (entriesRunId === run.id) await openEntries(run);
    } catch (err: unknown) {
      if (isForbidden(err)) setRunError(t('forbidden'));
      else setRunError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setBusyRunId(null);
    }
  };

  const handleApprove = async (run: CommissionRun) => {
    // Approving freezes the run and emits a CommissionEarned per entry. There
    // is no undo, so it gets an explicit confirmation (docs/26 §4).
    if (!window.confirm(t('approveConfirm'))) return;
    setRunError(null);
    setBusyRunId(run.id);
    try {
      await api.post<CommissionRunResponse>(`/compensation/runs/${run.id}/approve`);
      await loadRuns();
    } catch (err: unknown) {
      if (isForbidden(err)) setRunError(t('forbidden'));
      else setRunError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setBusyRunId(null);
    }
  };

  const handleToggleEntries = async (run: CommissionRun) => {
    if (entriesRunId === run.id) {
      setEntriesRunId(null);
      setEntries([]);
      return;
    }
    await openEntries(run);
  };

  const handleToggleEnded = async (withEnded: boolean) => {
    setIncludeEnded(withEnded);
    setPlacementError(null);
    try {
      await loadPlacements(withEnded);
    } catch (err: unknown) {
      if (isForbidden(err)) setPlacementError(t('forbidden'));
      else setPlacementError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    }
  };

  const handleCreatePlacement = async (e: FormEvent) => {
    e.preventDefault();
    setPlacementError(null);
    setSavingPlacement(true);
    try {
      await api.post('/compensation/graph', {
        uplineMemberId: uplineId,
        downlineMemberId: downlineId,
      });
      setDownlineId('');
      await loadPlacements(includeEnded);
    } catch (err: unknown) {
      if (isForbidden(err)) setPlacementError(t('forbidden'));
      else setPlacementError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setSavingPlacement(false);
    }
  };

  const handleEndPlacement = async (id: string) => {
    setPlacementError(null);
    setEndingId(id);
    try {
      // Ending stamps effective_to rather than deleting, so a run replayed over
      // an old period still pays the line that existed then.
      await api.delete(`/compensation/graph/${id}`);
      await loadPlacements(includeEnded);
    } catch (err: unknown) {
      if (isForbidden(err)) setPlacementError(t('forbidden'));
      else setPlacementError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setEndingId(null);
    }
  };

  /** The list names both ends; the member roster is only a fallback. */
  const memberName = (displayName: string | null | undefined, id: string): string =>
    displayName ?? members.find((member) => member.id === id)?.displayName ?? id;

  return (
    <div className="flex flex-col gap-4">
      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      <Card title={t('plansTitle')}>
        <p className="mb-3 text-xs text-slate-500">{t('plansHint')}</p>
        {forbidden ? (
          <p className="text-sm text-slate-600">{t('forbidden')}</p>
        ) : loading ? (
          <p className="text-sm text-slate-500">{tc('loading')}</p>
        ) : plans.length === 0 ? (
          <p className="text-sm text-slate-500">{t('plansEmpty')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-slate-100">
            {plans.map((plan) => (
              <li key={plan.id} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <span className="flex min-w-0 flex-col">
                    <span className="min-w-0 break-words text-sm font-medium text-slate-800">
                      {plan.name}
                    </span>
                    <span className="block break-all text-xs text-slate-500">
                      {plan.code} · {plan.currency}
                    </span>
                  </span>
                  <Badge tone={statusTone(plan.status)}>{planStatusLabel(plan.status)}</Badge>
                </div>

                {plan.rules.length === 0 ? (
                  <p className="text-xs text-slate-500">{t('rulesEmpty')}</p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {plan.rules.map((rule) => {
                      const ruleConditions = toConditions(rule.conditions);
                      return (
                        <li
                          key={rule.id}
                          className="flex flex-col gap-1 rounded-lg border border-slate-200 p-3"
                        >
                          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                            <span className="min-w-0 break-words text-sm text-slate-800">
                              {rule.name}
                            </span>
                            <Badge tone="gray">{bonusLabel(rule.bonusType)}</Badge>
                          </div>
                          <span className="block break-all text-xs text-slate-500">
                            {rule.code} · {t('priorityLabel', { priority: rule.priority })}
                          </span>
                          {ruleConditions.length === 0 ? (
                            <p className="text-xs text-slate-500">{t('noConditions')}</p>
                          ) : (
                            <ul className="flex flex-col gap-0.5">
                              {ruleConditions.map((condition, index) => (
                                <li
                                  key={`${rule.id}-${condition.metric}-${index}`}
                                  className="min-w-0 break-words text-xs text-slate-600"
                                >
                                  {conditionText(condition, plan.currency)}
                                </li>
                              ))}
                            </ul>
                          )}
                          <p className="min-w-0 break-words text-xs font-medium text-teal-800">
                            {payoutText(toPayout(rule.payout), plan.currency)}
                          </p>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {forbidden ? null : (
        <>
          <Card title={t('planFormTitle')}>
            <form onSubmit={handleCreatePlan} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Input
                label={t('code')}
                required
                pattern={CODE_PATTERN}
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
                label={t('description')}
                maxLength={2000}
                className="sm:col-span-2"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
              <Input
                label={t('currency')}
                pattern={CURRENCY_PATTERN}
                maxLength={3}
                hint={t('currencyHint')}
                className="sm:col-span-2"
                value={currency}
                onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              />
              {planError ? <p className="text-sm text-red-600 sm:col-span-2">{planError}</p> : null}
              <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
                <Button type="submit" disabled={savingPlan}>
                  {savingPlan ? tc('saving') : t('submitPlan')}
                </Button>
                {planCreated ? (
                  <span className="text-sm text-teal-700">
                    {t('planCreated', { name: planCreated })}
                  </span>
                ) : null}
              </div>
            </form>
          </Card>

          <Card title={t('ruleFormTitle')}>
            <p className="mb-3 text-xs text-slate-500">{t('ruleFormHint')}</p>
            {plans.length === 0 ? (
              <p className="text-sm text-slate-500">{t('plansUnavailable')}</p>
            ) : (
              <form onSubmit={handleAddRule} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Select
                  label={t('plan')}
                  required
                  className="sm:col-span-2"
                  value={rulePlanId}
                  onChange={(e) => setRulePlanId(e.target.value)}
                >
                  <option value="">{tgr('choose')}</option>
                  {plans.map((plan) => (
                    <option key={plan.id} value={plan.id}>
                      {plan.name}
                    </option>
                  ))}
                </Select>
                <Input
                  label={t('ruleCode')}
                  required
                  pattern={CODE_PATTERN}
                  hint={t('codeHint')}
                  value={ruleCode}
                  onChange={(e) => setRuleCode(e.target.value)}
                />
                <Input
                  label={t('ruleName')}
                  required
                  maxLength={160}
                  value={ruleName}
                  onChange={(e) => setRuleName(e.target.value)}
                />
                <Input
                  label={t('bonusType')}
                  required
                  pattern={BONUS_TYPE_PATTERN}
                  hint={t('bonusTypeHint')}
                  value={bonusType}
                  onChange={(e) => setBonusType(e.target.value)}
                />
                <Input
                  label={t('priority')}
                  type="number"
                  min="0"
                  max="10000"
                  step="1"
                  inputMode="numeric"
                  hint={t('priorityHint')}
                  value={priority}
                  onChange={(e) => setPriority(e.target.value)}
                />

                <div className="flex flex-col gap-3 sm:col-span-2">
                  <span className="text-sm font-semibold text-slate-800">
                    {t('conditionsTitle')}
                  </span>
                  {conditions.length === 0 ? (
                    <p className="text-xs text-slate-500">{t('conditionsEmpty')}</p>
                  ) : null}
                  {conditions.map((row, index) => (
                    <div
                      key={index}
                      className="grid grid-cols-1 gap-3 rounded-lg border border-slate-200 p-3 sm:grid-cols-2"
                    >
                      <Select
                        label={t('metric')}
                        value={row.metric}
                        onChange={(e) =>
                          updateCondition(index, { metric: e.target.value as CompensationMetric })
                        }
                      >
                        {COMPENSATION_METRICS.map((option) => (
                          <option key={option} value={option}>
                            {metricLabel(option)}
                          </option>
                        ))}
                      </Select>
                      <Select
                        label={t('comparator')}
                        value={row.comparator}
                        onChange={(e) =>
                          updateCondition(index, { comparator: e.target.value as RankComparator })
                        }
                      >
                        {RANK_COMPARATORS.map((option) => (
                          <option key={option} value={option}>
                            {tgr(`comparators.${option}`)}
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
                        onChange={(e) => updateCondition(index, { threshold: e.target.value })}
                      />
                      <Select
                        label={t('window')}
                        value={row.window}
                        onChange={(e) =>
                          updateCondition(index, { window: e.target.value as CompensationWindow })
                        }
                      >
                        {COMPENSATION_WINDOWS.map((option) => (
                          <option key={option} value={option}>
                            {windowLabel(option)}
                          </option>
                        ))}
                      </Select>
                      <Select
                        label={t('graph')}
                        className="sm:col-span-2"
                        value={row.graph}
                        onChange={(e) =>
                          updateCondition(index, { graph: e.target.value as MetricGraph })
                        }
                      >
                        {METRIC_GRAPHS.map((option) => (
                          <option key={option} value={option}>
                            {graphLabel(option)}
                          </option>
                        ))}
                      </Select>
                      {row.metric === 'qualified_legs' ? (
                        <Input
                          label={tgr('legVolumeMinor')}
                          type="number"
                          min="1"
                          max="1000000000000"
                          step="1"
                          inputMode="numeric"
                          required
                          hint={tgr('legVolumeHint')}
                          className="sm:col-span-2"
                          value={row.legVolumeMinor}
                          onChange={(e) =>
                            updateCondition(index, { legVolumeMinor: e.target.value })
                          }
                        />
                      ) : null}
                      <div className="sm:col-span-2">
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={() =>
                            setConditions((rows) => rows.filter((_, i) => i !== index))
                          }
                        >
                          {t('removeCondition')}
                        </Button>
                      </div>
                    </div>
                  ))}
                  <div>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => setConditions((rows) => [...rows, emptyCondition()])}
                    >
                      {t('addCondition')}
                    </Button>
                  </div>
                </div>

                <div className="flex flex-col gap-3 sm:col-span-2">
                  <span className="text-sm font-semibold text-slate-800">{t('payoutTitle')}</span>
                  <Select
                    label={t('payoutKind')}
                    value={payoutKind}
                    onChange={(e) => setPayoutKind(e.target.value as PayoutKind)}
                  >
                    {PAYOUT_KINDS.map((option) => (
                      <option key={option} value={option}>
                        {t(`payoutKinds.${option}`)}
                      </option>
                    ))}
                  </Select>
                  {payoutKind === 'fixed' ? (
                    <Input
                      label={t('amountMinorInput')}
                      type="number"
                      min="1"
                      max="1000000000"
                      step="1"
                      inputMode="numeric"
                      required
                      hint={t('minorHint')}
                      value={amountMinor}
                      onChange={(e) => setAmountMinor(e.target.value)}
                    />
                  ) : (
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <Input
                        label={t('percent')}
                        type="number"
                        min="0.01"
                        max="100"
                        step="0.01"
                        inputMode="decimal"
                        required
                        hint={t('percentHint')}
                        value={percent}
                        onChange={(e) => setPercent(e.target.value)}
                      />
                      <Select
                        label={t('basis')}
                        value={basis}
                        onChange={(e) => setBasis(e.target.value as CompensationMetric)}
                      >
                        {COMPENSATION_METRICS.map((option) => (
                          <option key={option} value={option}>
                            {metricLabel(option)}
                          </option>
                        ))}
                      </Select>
                      <Select
                        label={t('basisWindow')}
                        value={basisWindow}
                        onChange={(e) => setBasisWindow(e.target.value as CompensationWindow)}
                      >
                        {COMPENSATION_WINDOWS.map((option) => (
                          <option key={option} value={option}>
                            {windowLabel(option)}
                          </option>
                        ))}
                      </Select>
                      <Select
                        label={t('basisGraph')}
                        value={basisGraph}
                        onChange={(e) => setBasisGraph(e.target.value as MetricGraph)}
                      >
                        {METRIC_GRAPHS.map((option) => (
                          <option key={option} value={option}>
                            {graphLabel(option)}
                          </option>
                        ))}
                      </Select>
                      {basis === 'qualified_legs' ? (
                        <Input
                          label={tgr('legVolumeMinor')}
                          type="number"
                          min="1"
                          max="1000000000000"
                          step="1"
                          inputMode="numeric"
                          required
                          hint={tgr('legVolumeHint')}
                          className="sm:col-span-2"
                          value={basisLegVolumeMinor}
                          onChange={(e) => setBasisLegVolumeMinor(e.target.value)}
                        />
                      ) : null}
                      <Input
                        label={t('capMinorInput')}
                        type="number"
                        min="1"
                        max="1000000000"
                        step="1"
                        inputMode="numeric"
                        hint={t('capHint')}
                        className="sm:col-span-2"
                        value={capMinor}
                        onChange={(e) => setCapMinor(e.target.value)}
                      />
                    </div>
                  )}
                  <p className="text-xs text-slate-500">{t('windowNote')}</p>
                </div>

                {ruleError ? (
                  <p className="text-sm text-red-600 sm:col-span-2">{ruleError}</p>
                ) : null}
                <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
                  <Button type="submit" disabled={savingRule}>
                    {savingRule ? tc('saving') : t('submitRule')}
                  </Button>
                  {ruleCreated ? (
                    <span className="text-sm text-teal-700">
                      {t('ruleCreated', { name: ruleCreated })}
                    </span>
                  ) : null}
                </div>
              </form>
            )}
          </Card>
        </>
      )}

      <Card title={t('runsTitle')}>
        <p className="mb-3 text-xs text-slate-500">{t('runsHint')}</p>

        {forbidden ? (
          <p className="text-sm text-slate-600">{t('forbidden')}</p>
        ) : (
          <>
            {plans.length === 0 ? (
              <p className="text-sm text-slate-500">{t('plansUnavailable')}</p>
            ) : (
              <form onSubmit={handleCreateRun} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Select
                  label={t('plan')}
                  required
                  className="sm:col-span-2"
                  value={runPlanId}
                  onChange={(e) => setRunPlanId(e.target.value)}
                >
                  <option value="">{tgr('choose')}</option>
                  {plans.map((plan) => (
                    <option key={plan.id} value={plan.id}>
                      {plan.name}
                    </option>
                  ))}
                </Select>
                <Input
                  label={t('periodStart')}
                  type="date"
                  required
                  value={periodStart}
                  onChange={(e) => setPeriodStart(e.target.value)}
                />
                <Input
                  label={t('periodEnd')}
                  type="date"
                  required
                  value={periodEnd}
                  onChange={(e) => setPeriodEnd(e.target.value)}
                />
                <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
                  <Button type="submit" disabled={savingRun}>
                    {savingRun ? tc('saving') : t('submitRun')}
                  </Button>
                  {runCreated === null ? null : (
                    <span className="text-sm text-teal-700">
                      {runCreated ? t('runCreated') : t('runExisted')}
                    </span>
                  )}
                </div>
              </form>
            )}

            {/* One place for every failure on this card — creating a run,
                recomputing one, approving one, or reading its entries. */}
            {runError ? <p className="mt-3 text-sm text-red-600">{runError}</p> : null}

            <div className="mt-4 border-t border-slate-100 pt-3">
              {loading ? (
                <p className="text-sm text-slate-500">{tc('loading')}</p>
              ) : runs.length === 0 ? (
                <p className="text-sm text-slate-500">{t('runsEmpty')}</p>
              ) : (
                <ul className="flex flex-col divide-y divide-slate-100">
                  {runs.map((run) => {
                    const draft = run.status === 'draft';
                    const busy = busyRunId === run.id;
                    const open = entriesRunId === run.id;
                    return (
                      <li key={run.id} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
                        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                          <span className="flex min-w-0 flex-col">
                            <span className="min-w-0 break-words text-sm font-medium text-slate-800">
                              {run.plan?.name ?? run.planId}
                            </span>
                            <span className="text-xs text-slate-500">
                              {t('runPeriod', {
                                start: formatDate(run.periodStart, locale),
                                end: formatDate(run.periodEnd, locale),
                              })}
                            </span>
                          </span>
                          <Badge tone={draft ? 'amber' : 'green'}>
                            {runStatusLabel(run.status)}
                          </Badge>
                        </div>

                        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                          <span className="text-sm font-bold text-slate-900">
                            {formatMoney(run.totalMinor, run.currency, locale)}
                          </span>
                          <span className="text-xs text-slate-500">
                            {t('runEntryCount', { count: run.entryCount })}
                          </span>
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            type="button"
                            variant="ghost"
                            disabled={entriesLoading && open}
                            onClick={() => void handleToggleEntries(run)}
                          >
                            {open ? t('hideEntries') : t('viewEntries')}
                          </Button>
                          {draft ? (
                            <>
                              <Button
                                type="button"
                                variant="secondary"
                                disabled={busy}
                                onClick={() => void handleRecompute(run)}
                              >
                                {busy ? tc('saving') : t('recompute')}
                              </Button>
                              <Button
                                type="button"
                                disabled={busy}
                                onClick={() => void handleApprove(run)}
                              >
                                {busy ? tc('saving') : t('approve')}
                              </Button>
                            </>
                          ) : (
                            <span className="text-xs text-slate-500">
                              {t('approvedOn', { date: formatDate(run.approvedAt, locale) })}
                            </span>
                          )}
                        </div>

                        {open ? (
                          <div className="rounded-lg bg-slate-50 p-3">
                            {entriesLoading ? (
                              <p className="text-sm text-slate-500">{tc('loading')}</p>
                            ) : entries.length === 0 ? (
                              <p className="text-sm text-slate-500">{t('entriesEmpty')}</p>
                            ) : (
                              <ul className="flex flex-col divide-y divide-slate-200">
                                {entries.map((entry) => {
                                  const entryBasis = toEntryBasis(entry.basis);
                                  return (
                                    <li key={entry.id} className="flex flex-col gap-1 py-2">
                                      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                                        <span className="min-w-0 break-words text-sm text-slate-800">
                                          {memberName(entry.member?.displayName, entry.memberId)}
                                        </span>
                                        <span className="text-sm font-semibold text-slate-900">
                                          {formatMoney(entry.amountMinor, entry.currency, locale)}
                                        </span>
                                      </div>
                                      <span className="min-w-0 break-words text-xs text-slate-500">
                                        {entry.rule?.name ?? entry.ruleId} ·{' '}
                                        {bonusLabel(entry.bonusType)}
                                      </span>
                                      {entryBasis.conditions.length > 0 ? (
                                        <ul className="flex flex-col gap-0.5">
                                          {entryBasis.conditions.map((condition, index) => (
                                            <li
                                              key={`${entry.id}-${condition.metric}-${index}`}
                                              className="min-w-0 break-words text-xs text-slate-600"
                                            >
                                              {t('basisRow', {
                                                metric: metricLabel(condition.metric),
                                                value: metricAmount(
                                                  condition.metric,
                                                  condition.value,
                                                  entry.currency,
                                                ),
                                                threshold: metricAmount(
                                                  condition.metric,
                                                  condition.threshold,
                                                  entry.currency,
                                                ),
                                              })}
                                            </li>
                                          ))}
                                        </ul>
                                      ) : null}
                                      <span className="min-w-0 break-words text-xs text-slate-600">
                                        {payoutText(entryBasis.payout, entry.currency)}
                                      </span>
                                    </li>
                                  );
                                })}
                              </ul>
                            )}
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </>
        )}
      </Card>

      {forbidden ? null : (
        <Card title={t('placementsTitle')}>
          <p className="mb-3 text-xs text-slate-500">{t('placementsHint')}</p>
          {members.length === 0 ? (
            <p className="text-sm text-slate-500">{tgr('membersUnavailable')}</p>
          ) : (
            <form
              onSubmit={handleCreatePlacement}
              className="grid grid-cols-1 gap-4 sm:grid-cols-2"
            >
              <Select
                label={t('upline')}
                required
                value={uplineId}
                onChange={(e) => setUplineId(e.target.value)}
              >
                <option value="">{tgr('choose')}</option>
                {members.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.displayName}
                  </option>
                ))}
              </Select>
              <Select
                label={t('downline')}
                required
                value={downlineId}
                onChange={(e) => setDownlineId(e.target.value)}
              >
                <option value="">{tgr('choose')}</option>
                {members.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.displayName}
                  </option>
                ))}
              </Select>
              <div className="sm:col-span-2">
                <Button type="submit" disabled={savingPlacement}>
                  {savingPlacement ? tc('saving') : t('submitPlacement')}
                </Button>
              </div>
            </form>
          )}

          {placementError ? <p className="mt-3 text-sm text-red-600">{placementError}</p> : null}

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
            {loading ? (
              <p className="text-sm text-slate-500">{tc('loading')}</p>
            ) : placements.length === 0 ? (
              <p className="text-sm text-slate-500">{t('placementsEmpty')}</p>
            ) : (
              <ul className="flex flex-col divide-y divide-slate-100">
                {placements.map((placement) => {
                  const ended = !!placement.effectiveTo;
                  return (
                    <li
                      key={placement.id}
                      className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2"
                    >
                      <span className="flex min-w-0 flex-col">
                        <span
                          className={`min-w-0 break-words text-sm ${
                            ended ? 'text-slate-400 line-through' : 'text-slate-800'
                          }`}
                        >
                          {memberName(placement.uplineDisplayName, placement.uplineMemberId)} →{' '}
                          {memberName(placement.downlineDisplayName, placement.downlineMemberId)}
                        </span>
                        <span className="text-xs text-slate-500">
                          {tg('since', { date: formatDate(placement.effectiveFrom, locale) })}
                        </span>
                      </span>
                      {ended ? (
                        <Badge tone="gray">{t('placementEnded')}</Badge>
                      ) : (
                        <button
                          type="button"
                          disabled={endingId === placement.id}
                          onClick={() => void handleEndPlacement(placement.id)}
                          className="text-sm font-medium text-slate-500 hover:underline disabled:opacity-50"
                        >
                          {endingId === placement.id ? tc('saving') : t('endPlacement')}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
