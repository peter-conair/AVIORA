'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { api, ApiError, isForbidden } from '@/lib/api-client';
import {
  AUTOMATION_ACTION_TYPES,
  COMPENSATION_METRICS,
  COUPON_KINDS,
  isAutomationActionType,
  isAutomationPayloadCondition,
  isFulfilledRewardType,
  isMoneyMetric,
  METRIC_GRAPHS,
  metricGraphKey,
  metricWalksAGraph,
  RANK_COMPARATORS,
  RANK_WINDOWS,
  rankMetricKey,
  rankWindowKey,
  REWARD_TYPES,
  rewardTypeKey,
  toAutomationActions,
  toAutomationConditions,
  toExecutionResult,
  toRewardConfig,
  TRIGGER_EVENTS,
  triggerEventKey,
  type AutomationAction,
  type AutomationActionType,
  type AutomationCondition,
  type AutomationExecution,
  type AutomationExecutionsResponse,
  type AutomationRule,
  type AutomationRulesResponse,
  type CompensationMetric,
  type CouponKind,
  type Member,
  type MembersResponse,
  type MetricGraph,
  type RankComparator,
  type RankWindow,
  type RewardDefinition,
  type RewardDefinitionsResponse,
  type RewardGrant,
  type RewardGrantsResponse,
  type RewardType,
} from '@/lib/types';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { formatDateTime, formatMoney } from '@/lib/format';

/** Matches the API's own code rules, so the mistake is caught before the request. */
const CODE_PATTERN = '[a-z0-9-]{2,40}';
const CURRENCY_PATTERN = '[A-Z]{3}';
const PAYLOAD_PATH_PATTERN = '(payload\\.)?[A-Za-z0-9_]+(\\.[A-Za-z0-9_]+)*';

/** Statuses this build has wording for; anything else is shown verbatim. */
const RULE_STATUSES: readonly string[] = ['active', 'disabled', 'archived'];
const EXECUTION_STATUSES = ['success', 'failed', 'skipped', 'running'] as const;
const REWARD_STATUSES: readonly string[] = ['active', 'archived'];

/**
 * A payload matcher compares for equality, so the value's TYPE decides what it
 * can ever match: `"1"` is not `1` and `"true"` is not `true`. Asking outright
 * beats guessing from the characters someone typed.
 */
const PAYLOAD_VALUE_KINDS = ['text', 'number', 'true', 'false'] as const;
type PayloadValueKind = (typeof PAYLOAD_VALUE_KINDS)[number];

interface MetricConditionDraft {
  kind: 'metric';
  metric: CompensationMetric;
  comparator: RankComparator;
  threshold: string;
  window: RankWindow;
  graph: MetricGraph;
}

interface PayloadConditionDraft {
  kind: 'payload';
  payloadPath: string;
  valueKind: PayloadValueKind;
  value: string;
}

type ConditionDraft = MetricConditionDraft | PayloadConditionDraft;

interface ActionDraft {
  type: AutomationActionType;
  title: string;
  body: string;
  rewardCode: string;
  notes: string;
  dueInDays: string;
  courseId: string;
}

function emptyMetricCondition(): MetricConditionDraft {
  return {
    kind: 'metric',
    metric: 'personal_volume',
    comparator: 'gte',
    threshold: '',
    window: 'lifetime',
    graph: 'referral',
  };
}

function emptyPayloadCondition(): PayloadConditionDraft {
  return { kind: 'payload', payloadPath: '', valueKind: 'text', value: '' };
}

function emptyAction(): ActionDraft {
  return {
    type: 'send_notification',
    title: '',
    body: '',
    rewardCode: '',
    notes: '',
    dueInDays: '',
    courseId: '',
  };
}

/** The literal a payload matcher will be compared against, typed as chosen. */
function payloadValue(draft: PayloadConditionDraft): string | number | boolean {
  if (draft.valueKind === 'true') return true;
  if (draft.valueKind === 'false') return false;
  if (draft.valueKind === 'number') return Number(draft.value);
  return draft.value;
}

/**
 * Automation and rewards (docs/27). Both are tenant machinery rather than member
 * capabilities, so everything here is permission-scoped and nothing is gated by
 * an entitlement (docs/27 §4).
 *
 * The screen says out loud the two things the engine guarantees and a form
 * cannot show by itself: an event produced by an automation action never
 * triggers another rule, and a cash reward is recorded rather than paid.
 */
export function AutomationTab() {
  const t = useTranslations('admin.automation');
  const tcomp = useTranslations('admin.compensation');
  const tgr = useTranslations('admin.growth');
  const tg = useTranslations('growth');
  const tr = useTranslations('myRewards');
  const tc = useTranslations('common');
  const locale = useLocale();

  const [rules, setRules] = useState<AutomationRule[]>([]);
  const [executions, setExecutions] = useState<AutomationExecution[]>([]);
  const [definitions, setDefinitions] = useState<RewardDefinition[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  /**
   * The currency the rules list names. Money-valued thresholds are minor units
   * and need one; until it arrives — or if a response ever omits it — they are
   * shown as minor units and labelled so, rather than divided against a
   * currency nobody stated.
   */
  const [currency, setCurrency] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Rule form
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [triggerEvent, setTriggerEvent] = useState<string>('GoalCompleted');
  const [priority, setPriority] = useState('100');
  const [conditions, setConditions] = useState<ConditionDraft[]>([]);
  const [actions, setActions] = useState<ActionDraft[]>([emptyAction()]);
  const [savingRule, setSavingRule] = useState(false);
  const [ruleError, setRuleError] = useState<string | null>(null);
  const [ruleCreated, setRuleCreated] = useState<string | null>(null);
  const [busyRuleId, setBusyRuleId] = useState<string | null>(null);

  // Executions
  const [statusFilter, setStatusFilter] = useState('');
  const [ruleFilter, setRuleFilter] = useState('');
  const [executionsLoading, setExecutionsLoading] = useState(false);

  // Reward definition form
  const [rewardCode, setRewardCode] = useState('');
  const [rewardName, setRewardName] = useState('');
  const [rewardType, setRewardType] = useState<RewardType>('points');
  const [points, setPoints] = useState('');
  const [badgeCode, setBadgeCode] = useState('');
  const [badgeName, setBadgeName] = useState('');
  const [courseId, setCourseId] = useState('');
  const [couponKind, setCouponKind] = useState<CouponKind>('percent');
  const [couponValue, setCouponValue] = useState('');
  const [couponCurrency, setCouponCurrency] = useState('');
  const [minSubtotalMinor, setMinSubtotalMinor] = useState('');
  const [expiresInDays, setExpiresInDays] = useState('');
  const [savingReward, setSavingReward] = useState(false);
  const [rewardError, setRewardError] = useState<string | null>(null);
  const [rewardCreated, setRewardCreated] = useState<string | null>(null);

  // Manual grants
  const [grantMemberId, setGrantMemberId] = useState('');
  const [grantRewardCode, setGrantRewardCode] = useState('');
  const [savingGrant, setSavingGrant] = useState(false);
  const [grantError, setGrantError] = useState<string | null>(null);
  /** Every grant the workspace has made, newest first — revoked ones included. */
  const [grants, setGrants] = useState<RewardGrant[]>([]);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  /** Kept apart from the form's error so a failed revoke is reported where it happened. */
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const loadRules = useCallback(async () => {
    const res = await api.get<AutomationRulesResponse>('/automation/rules');
    setRules(res.rules);
    // The rules name the currency their thresholds are quoted in, so nothing
    // has to infer one from the rank ladder or a compensation plan.
    setCurrency(res.currency ?? null);
  }, []);

  const loadDefinitions = useCallback(async () => {
    const res = await api.get<RewardDefinitionsResponse>('/rewards/definitions');
    setDefinitions(res.definitions);
  }, []);

  const loadGrants = useCallback(async () => {
    const res = await api.get<RewardGrantsResponse>('/rewards/grants');
    setGrants(res.grants);
  }, []);

  const loadExecutions = useCallback(async (status: string, ruleId: string) => {
    const query = new URLSearchParams();
    if (status) query.set('status', status);
    if (ruleId) query.set('ruleId', ruleId);
    const suffix = query.toString();
    const res = await api.get<AutomationExecutionsResponse>(
      `/automation/executions${suffix ? `?${suffix}` : ''}`,
    );
    setExecutions(res.executions);
  }, []);

  useEffect(() => {
    let cancelled = false;

    // Members only feed the grant picker; not having them must not hide the
    // rules, so the roster is best-effort.
    api
      .get<MembersResponse>('/members')
      .then((res) => {
        if (!cancelled) setMembers(res.members);
      })
      .catch(() => undefined);

    Promise.all([loadRules(), loadDefinitions(), loadExecutions('', ''), loadGrants()])
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

  const eventLabel = (eventName: string): string => {
    const key = triggerEventKey(eventName);
    return key ? t(key) : eventName;
  };

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

  const ruleStatusLabel = (status: string): string =>
    RULE_STATUSES.includes(status) ? t(`statuses.${status}`) : status;

  const executionStatusLabel = (status: string): string =>
    (EXECUTION_STATUSES as readonly string[]).includes(status)
      ? t(`executionStatuses.${status}`)
      : status;

  const rewardStatusLabel = (status: string): string =>
    REWARD_STATUSES.includes(status) ? t(`rewardStatuses.${status}`) : status;

  const rewardTypeLabel = (type: string): string => {
    const key = rewardTypeKey(type);
    return key ? tr(key) : type;
  };

  const countFormat = (value: number): string =>
    new Intl.NumberFormat(locale === 'th' ? 'th-TH' : 'en-GB').format(value);

  /**
   * Money metrics are minor units and divide by 100 exactly once, in the
   * formatter. Counts never divide — a threshold of 3 qualified legs is 3.
   */
  const metricAmount = (metric: string, value: number): string => {
    if (!isMoneyMetric(metric)) return countFormat(value);
    return currency
      ? formatMoney(value, currency, locale)
      : t('minorUnits', { value: countFormat(value) });
  };

  const conditionText = (condition: AutomationCondition): string => {
    if (isAutomationPayloadCondition(condition)) {
      return t('payloadCondition', {
        path: condition.payloadPath,
        value: String(condition.value),
      });
    }
    const shared = {
      metric: metricLabel(condition.metric),
      comparator: comparatorLabel(condition.comparator),
      threshold: metricAmount(condition.metric, condition.threshold),
      window: windowLabel(condition.window),
    };
    // Personal volume and completed courses are about one member; naming a
    // graph beside them would describe a traversal that never happens.
    return metricWalksAGraph(condition.metric)
      ? tcomp('conditionLine', { ...shared, graph: graphLabel(condition.graph ?? 'referral') })
      : tcomp('conditionLineNoGraph', shared);
  };

  const rewardLabel = (rewardCodeValue: string): string =>
    definitions.find((definition) => definition.code === rewardCodeValue)?.name ?? rewardCodeValue;

  /** Falls back to the raw type rather than mislabelling an action this build cannot name. */
  const actionTypeLabel = (type: string): string =>
    isAutomationActionType(type) ? t(`actionTypes.${type}`) : type;

  /** The action as a clause, so the rule reads as one sentence a person can check. */
  const actionText = (action: AutomationAction): string => {
    const text = (key: string): string => {
      const value = action[key];
      return typeof value === 'string' ? value : '';
    };
    switch (action.type) {
      case 'send_notification':
        return t('actionNotify', { title: text('title') });
      case 'grant_reward':
        return t('actionGrantReward', { reward: rewardLabel(text('rewardCode')) });
      case 'create_followup':
        return t('actionFollowUp', { title: text('title') });
      case 'assign_course':
        return t('actionAssignCourse');
      default:
        return action.type;
    }
  };

  const ruleSentence = (rule: AutomationRule): string => {
    const ruleConditions = toAutomationConditions(rule.conditions).map(conditionText);
    const ruleActions = toAutomationActions(rule.actions).map(actionText);
    const joiner = t('joiner');
    const shared = {
      trigger: eventLabel(rule.triggerEvent),
      actions: ruleActions.join(joiner),
    };
    return ruleConditions.length === 0
      ? t('sentenceNoConditions', shared)
      : t('sentence', { ...shared, conditions: ruleConditions.join(joiner) });
  };

  /** What a definition grants, as a phrase; recorded types say so outright. */
  const configText = (definition: RewardDefinition): string => {
    const config = toRewardConfig(definition.config);
    switch (definition.type) {
      case 'points':
        return t('configPoints', { points: countFormat(config.points ?? 0) });
      case 'badge':
        return t('configBadge', { code: config.badgeCode ?? '' });
      case 'course_access':
        return t('configCourse', { id: config.courseId ?? '' });
      case 'coupon': {
        if (!config.coupon) return t('configRecorded');
        if (config.coupon.kind === 'percent') {
          return t('configCouponPercent', { percent: countFormat(config.coupon.value) });
        }
        const couponCurrencyCode = config.coupon.currency ?? currency;
        return t('configCouponFixed', {
          amount: couponCurrencyCode
            ? formatMoney(config.coupon.value, couponCurrencyCode, locale)
            : t('minorUnits', { value: countFormat(config.coupon.value) }),
        });
      }
      default:
        return t('configRecorded');
    }
  };

  const updateCondition = (index: number, patch: Partial<MetricConditionDraft>) =>
    setConditions((rows) =>
      rows.map((row, i) => (i === index && row.kind === 'metric' ? { ...row, ...patch } : row)),
    );

  const updatePayload = (index: number, patch: Partial<PayloadConditionDraft>) =>
    setConditions((rows) =>
      rows.map((row, i) => (i === index && row.kind === 'payload' ? { ...row, ...patch } : row)),
    );

  const updateAction = (index: number, patch: Partial<ActionDraft>) =>
    setActions((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const handleCreateRule = async (e: FormEvent) => {
    e.preventDefault();
    setRuleError(null);
    setRuleCreated(null);
    setSavingRule(true);
    try {
      await api.post('/automation/rules', {
        code,
        name,
        triggerEvent,
        priority: Number(priority),
        conditions: conditions.map((row) =>
          row.kind === 'metric'
            ? {
                metric: row.metric,
                comparator: row.comparator,
                threshold: Number(row.threshold),
                window: row.window,
                graph: row.graph,
              }
            : {
                payloadPath: row.payloadPath,
                comparator: 'eq',
                value: payloadValue(row),
              },
        ),
        actions: actions.map((row) => {
          switch (row.type) {
            case 'send_notification':
              return {
                type: row.type,
                title: row.title,
                ...(row.body ? { body: row.body } : {}),
              };
            case 'grant_reward':
              return { type: row.type, rewardCode: row.rewardCode };
            case 'create_followup':
              return {
                type: row.type,
                title: row.title,
                ...(row.notes ? { notes: row.notes } : {}),
                ...(row.dueInDays ? { dueInDays: Number(row.dueInDays) } : {}),
              };
            default:
              return { type: row.type, courseId: row.courseId };
          }
        }),
      });
      setRuleCreated(name);
      setCode('');
      setName('');
      setConditions([]);
      setActions([emptyAction()]);
      await loadRules();
    } catch (err: unknown) {
      if (isForbidden(err)) setRuleError(t('forbidden'));
      else setRuleError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setSavingRule(false);
    }
  };

  const handleToggleRule = async (rule: AutomationRule) => {
    setRuleError(null);
    setBusyRuleId(rule.id);
    try {
      await api.patch(`/automation/rules/${rule.id}`, {
        status: rule.status === 'active' ? 'disabled' : 'active',
      });
      await loadRules();
    } catch (err: unknown) {
      if (isForbidden(err)) setRuleError(t('forbidden'));
      else setRuleError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setBusyRuleId(null);
    }
  };

  const handleFilterExecutions = async (status: string, ruleId: string) => {
    setStatusFilter(status);
    setRuleFilter(ruleId);
    setError(null);
    setExecutionsLoading(true);
    try {
      await loadExecutions(status, ruleId);
    } catch (err: unknown) {
      if (isForbidden(err)) setForbidden(true);
      else setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setExecutionsLoading(false);
    }
  };

  const handleCreateReward = async (e: FormEvent) => {
    e.preventDefault();
    setRewardError(null);
    setRewardCreated(null);
    setSavingReward(true);
    try {
      const config: Record<string, unknown> = {};
      if (rewardType === 'points') config.points = Number(points);
      if (rewardType === 'badge') {
        config.badgeCode = badgeCode;
        if (badgeName) config.badgeName = badgeName;
      }
      if (rewardType === 'course_access') config.courseId = courseId;
      if (rewardType === 'coupon') {
        config.kind = couponKind;
        config.value = Number(couponValue);
        if (couponKind === 'fixed' && couponCurrency) config.currency = couponCurrency;
        if (minSubtotalMinor) config.minSubtotalMinor = Number(minSubtotalMinor);
        if (expiresInDays) config.expiresInDays = Number(expiresInDays);
      }
      await api.post('/rewards/definitions', {
        code: rewardCode,
        name: rewardName,
        type: rewardType,
        // Recorded types carry whatever the tenant wants, which here is nothing.
        ...(isFulfilledRewardType(rewardType) ? { config } : {}),
      });
      setRewardCreated(rewardName);
      setRewardCode('');
      setRewardName('');
      setPoints('');
      setBadgeCode('');
      setBadgeName('');
      setCourseId('');
      setCouponValue('');
      setCouponCurrency('');
      setMinSubtotalMinor('');
      setExpiresInDays('');
      await loadDefinitions();
    } catch (err: unknown) {
      if (isForbidden(err)) setRewardError(t('forbidden'));
      else setRewardError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setSavingReward(false);
    }
  };

  const handleGrant = async (e: FormEvent) => {
    e.preventDefault();
    setGrantError(null);
    setSavingGrant(true);
    try {
      await api.post('/rewards/grants', {
        rewardCode: grantRewardCode,
        memberId: grantMemberId,
      });
      // Re-read rather than splice the response in: the list is the tenant's,
      // ordered by the server, and the grant route names no member.
      await loadGrants();
    } catch (err: unknown) {
      if (isForbidden(err)) setGrantError(t('forbidden'));
      else setGrantError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setSavingGrant(false);
    }
  };

  const handleRevoke = async (grant: RewardGrant) => {
    // Revoking keeps the row and undoes nothing already fulfilled, which is not
    // what "revoke" sounds like — so it is said before it happens.
    if (!window.confirm(t('revokeConfirm'))) return;
    setRevokeError(null);
    setRevokingId(grant.id);
    try {
      await api.delete(`/rewards/grants/${grant.id}`);
      await loadGrants();
    } catch (err: unknown) {
      if (isForbidden(err)) setRevokeError(t('forbidden'));
      else setRevokeError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setRevokingId(null);
    }
  };

  /** The list names the member; the roster is only a fallback. */
  const memberName = (displayName: string | undefined, id: string): string =>
    displayName ?? members.find((member) => member.id === id)?.displayName ?? id;

  const grantSourceLabel = (sourceType: string): string => {
    if (sourceType === 'automation') return tr('sourceAutomation');
    if (sourceType === 'manual') return tr('sourceManual');
    return sourceType;
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

      <Card title={t('rulesTitle')}>
        <p className="mb-3 text-xs text-slate-500">{t('rulesHint')}</p>
        {loading ? (
          <p className="text-sm text-slate-500">{tc('loading')}</p>
        ) : rules.length === 0 ? (
          <p className="text-sm text-slate-500">{t('rulesEmpty')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-slate-100">
            {rules.map((rule) => (
              <li key={rule.id} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <span className="flex min-w-0 flex-col">
                    <span className="min-w-0 break-words text-sm font-medium text-slate-800">
                      {rule.name}
                    </span>
                    <span className="block break-all text-xs text-slate-500">
                      {rule.code} · {t('priorityLabel', { priority: rule.priority })}
                    </span>
                  </span>
                  <Badge tone={rule.status === 'active' ? 'teal' : 'gray'}>
                    {ruleStatusLabel(rule.status)}
                  </Badge>
                </div>

                {/* The rule as one sentence: when … if … then …. A tenant owner
                    should be able to check it against what they meant without
                    reading JSON. */}
                <p className="min-w-0 break-words text-sm text-slate-700">{ruleSentence(rule)}</p>

                {rule.status === 'archived' ? null : (
                  <div>
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={busyRuleId === rule.id}
                      onClick={() => void handleToggleRule(rule)}
                    >
                      {busyRuleId === rule.id
                        ? tc('saving')
                        : rule.status === 'active'
                          ? t('disable')
                          : t('enable')}
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {ruleError ? <p className="mt-3 text-sm text-red-600">{ruleError}</p> : null}
      </Card>

      <Card title={t('ruleFormTitle')}>
        <p className="mb-3 text-xs text-slate-500">{t('ruleFormHint')}</p>
        <form onSubmit={handleCreateRule} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
          <Select
            label={t('trigger')}
            required
            value={triggerEvent}
            onChange={(e) => setTriggerEvent(e.target.value)}
          >
            {TRIGGER_EVENTS.map((option) => (
              <option key={option} value={option}>
                {eventLabel(option)}
              </option>
            ))}
          </Select>
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
          <p className="text-xs text-slate-500 sm:col-span-2">{t('triggerHint')}</p>

          <div className="flex flex-col gap-3 sm:col-span-2">
            <span className="text-sm font-semibold text-slate-800">{t('conditionsTitle')}</span>
            {conditions.length === 0 ? (
              <p className="text-xs text-slate-500">{t('conditionsEmpty')}</p>
            ) : null}
            {conditions.map((row, index) => (
              <div
                key={index}
                className="grid grid-cols-1 gap-3 rounded-lg border border-slate-200 p-3 sm:grid-cols-2"
              >
                {row.kind === 'metric' ? (
                  <>
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
                        updateCondition(index, { window: e.target.value as RankWindow })
                      }
                    >
                      {RANK_WINDOWS.map((option) => (
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
                  </>
                ) : (
                  <>
                    <Input
                      label={t('payloadPath')}
                      required
                      pattern={PAYLOAD_PATH_PATTERN}
                      hint={t('payloadPathHint')}
                      value={row.payloadPath}
                      onChange={(e) => updatePayload(index, { payloadPath: e.target.value })}
                    />
                    <Select
                      label={t('payloadValueKind')}
                      value={row.valueKind}
                      onChange={(e) =>
                        updatePayload(index, { valueKind: e.target.value as PayloadValueKind })
                      }
                    >
                      {PAYLOAD_VALUE_KINDS.map((option) => (
                        <option key={option} value={option}>
                          {t(`payloadValueKinds.${option}`)}
                        </option>
                      ))}
                    </Select>
                    {row.valueKind === 'text' || row.valueKind === 'number' ? (
                      <Input
                        label={t('payloadValue')}
                        type={row.valueKind === 'number' ? 'number' : 'text'}
                        inputMode={row.valueKind === 'number' ? 'numeric' : undefined}
                        required
                        hint={t('payloadValueHint')}
                        className="sm:col-span-2"
                        value={row.value}
                        onChange={(e) => updatePayload(index, { value: e.target.value })}
                      />
                    ) : null}
                  </>
                )}
                <div className="sm:col-span-2">
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setConditions((rows) => rows.filter((_, i) => i !== index))}
                  >
                    {t('removeCondition')}
                  </Button>
                </div>
              </div>
            ))}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setConditions((rows) => [...rows, emptyMetricCondition()])}
              >
                {t('addMetricCondition')}
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => setConditions((rows) => [...rows, emptyPayloadCondition()])}
              >
                {t('addPayloadCondition')}
              </Button>
            </div>
          </div>

          <div className="flex flex-col gap-3 sm:col-span-2">
            <span className="text-sm font-semibold text-slate-800">{t('actionsTitle')}</span>
            {actions.length === 0 ? (
              <p className="text-xs text-red-600">{t('actionsEmpty')}</p>
            ) : null}
            {actions.map((row, index) => (
              <div
                key={index}
                className="grid grid-cols-1 gap-3 rounded-lg border border-slate-200 p-3 sm:grid-cols-2"
              >
                <Select
                  label={t('actionType')}
                  className="sm:col-span-2"
                  value={row.type}
                  onChange={(e) =>
                    updateAction(index, { type: e.target.value as AutomationActionType })
                  }
                >
                  {AUTOMATION_ACTION_TYPES.map((option) => (
                    <option key={option} value={option}>
                      {t(`actionTypes.${option}`)}
                    </option>
                  ))}
                </Select>
                {row.type === 'send_notification' ? (
                  <>
                    <Input
                      label={t('notificationTitle')}
                      required
                      maxLength={160}
                      value={row.title}
                      onChange={(e) => updateAction(index, { title: e.target.value })}
                    />
                    <Input
                      label={t('notificationBody')}
                      maxLength={2000}
                      value={row.body}
                      onChange={(e) => updateAction(index, { body: e.target.value })}
                    />
                  </>
                ) : null}
                {row.type === 'grant_reward' ? (
                  <Select
                    label={t('reward')}
                    required
                    className="sm:col-span-2"
                    value={row.rewardCode}
                    onChange={(e) => updateAction(index, { rewardCode: e.target.value })}
                  >
                    <option value="">{tgr('choose')}</option>
                    {definitions.map((definition) => (
                      <option key={definition.id} value={definition.code}>
                        {definition.name}
                      </option>
                    ))}
                  </Select>
                ) : null}
                {row.type === 'create_followup' ? (
                  <>
                    <Input
                      label={t('followUpTitle')}
                      required
                      maxLength={160}
                      value={row.title}
                      onChange={(e) => updateAction(index, { title: e.target.value })}
                    />
                    <Input
                      label={t('dueInDays')}
                      type="number"
                      min="0"
                      max="3650"
                      step="1"
                      inputMode="numeric"
                      value={row.dueInDays}
                      onChange={(e) => updateAction(index, { dueInDays: e.target.value })}
                    />
                    <Input
                      label={t('followUpNotes')}
                      maxLength={2000}
                      className="sm:col-span-2"
                      value={row.notes}
                      onChange={(e) => updateAction(index, { notes: e.target.value })}
                    />
                  </>
                ) : null}
                {row.type === 'assign_course' ? (
                  <Input
                    label={t('courseId')}
                    required
                    hint={t('courseIdHint')}
                    className="sm:col-span-2"
                    value={row.courseId}
                    onChange={(e) => updateAction(index, { courseId: e.target.value })}
                  />
                ) : null}
                <div className="sm:col-span-2">
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setActions((rows) => rows.filter((_, i) => i !== index))}
                  >
                    {t('removeAction')}
                  </Button>
                </div>
              </div>
            ))}
            <div>
              <Button
                type="button"
                variant="secondary"
                onClick={() => setActions((rows) => [...rows, emptyAction()])}
              >
                {t('addAction')}
              </Button>
            </div>
            {/* The refused actions are named, not hidden: a tenant owner looking
                for "send an email" deserves to know why it is not offered. */}
            <p className="text-xs text-slate-500">{t('actionsRefused')}</p>
          </div>

          {ruleError ? <p className="text-sm text-red-600 sm:col-span-2">{ruleError}</p> : null}
          <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
            <Button type="submit" disabled={savingRule || actions.length === 0}>
              {savingRule ? tc('saving') : t('submitRule')}
            </Button>
            {ruleCreated ? (
              <span className="text-sm text-teal-700">
                {t('ruleCreated', { name: ruleCreated })}
              </span>
            ) : null}
          </div>
        </form>
      </Card>

      <Card title={t('executionsTitle')}>
        <p className="mb-3 text-xs text-slate-500">{t('executionsHint')}</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Select
            label={t('filterStatus')}
            value={statusFilter}
            onChange={(e) => void handleFilterExecutions(e.target.value, ruleFilter)}
          >
            <option value="">{t('filterAll')}</option>
            {EXECUTION_STATUSES.map((option) => (
              <option key={option} value={option}>
                {t(`executionStatuses.${option}`)}
              </option>
            ))}
          </Select>
          <Select
            label={t('filterRule')}
            value={ruleFilter}
            onChange={(e) => void handleFilterExecutions(statusFilter, e.target.value)}
          >
            <option value="">{t('filterAll')}</option>
            {rules.map((rule) => (
              <option key={rule.id} value={rule.id}>
                {rule.name}
              </option>
            ))}
          </Select>
        </div>

        <div className="mt-4 border-t border-slate-100 pt-3">
          {loading || executionsLoading ? (
            <p className="text-sm text-slate-500">{tc('loading')}</p>
          ) : executions.length === 0 ? (
            <p className="text-sm text-slate-500">{t('executionsEmpty')}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-slate-100">
              {executions.map((execution) => {
                const result = toExecutionResult(execution.result);
                const failed = execution.status === 'failed';
                return (
                  <li key={execution.id} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                      <span className="flex min-w-0 flex-col">
                        <span className="min-w-0 break-words text-sm font-medium text-slate-800">
                          {execution.rule?.name ?? execution.ruleId}
                        </span>
                        <span className="min-w-0 break-words text-xs text-slate-500">
                          {eventLabel(
                            execution.rule?.triggerEvent ?? result.eventName ?? execution.eventId,
                          )}{' '}
                          · {formatDateTime(execution.createdAt, locale)}
                        </span>
                      </span>
                      <Badge
                        tone={failed ? 'red' : execution.status === 'success' ? 'green' : 'gray'}
                      >
                        {executionStatusLabel(execution.status)}
                      </Badge>
                    </div>

                    {result.skippedBecause ? (
                      <p className="min-w-0 break-words text-xs text-slate-500">
                        {t('skippedBecause', { reason: result.skippedBecause })}
                      </p>
                    ) : null}

                    {/* One action failing does not silence the rest, so the log
                        names which one failed rather than the rule as a whole. */}
                    {result.actions
                      .filter((action) => action.status === 'failed')
                      .map((action, index) => (
                        <p
                          key={`${execution.id}-${action.type}-${index}`}
                          className="min-w-0 break-words text-xs text-red-600"
                        >
                          {t('actionFailed', {
                            action: actionTypeLabel(action.type),
                            error: action.error ?? '',
                          })}
                        </p>
                      ))}

                    {failed && result.actions.length === 0 && execution.error ? (
                      <p className="min-w-0 break-words text-xs text-red-600">{execution.error}</p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </Card>

      <Card title={t('rewardsTitle')}>
        <p className="mb-3 text-xs text-slate-500">{t('rewardsHint')}</p>
        {loading ? (
          <p className="text-sm text-slate-500">{tc('loading')}</p>
        ) : definitions.length === 0 ? (
          <p className="text-sm text-slate-500">{t('rewardsEmpty')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-slate-100">
            {definitions.map((definition) => (
              <li key={definition.id} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <span className="flex min-w-0 flex-col">
                    <span className="min-w-0 break-words text-sm font-medium text-slate-800">
                      {definition.name}
                    </span>
                    <span className="block break-all text-xs text-slate-500">
                      {definition.code} · {rewardStatusLabel(definition.status)}
                    </span>
                  </span>
                  <Badge tone="teal">{rewardTypeLabel(definition.type)}</Badge>
                </div>
                <p className="min-w-0 break-words text-xs text-slate-600">
                  {configText(definition)}
                </p>
                {definition.type === 'cash' ? (
                  <p className="min-w-0 break-words text-xs text-amber-700">{tr('cashNote')}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={t('rewardFormTitle')}>
        <form onSubmit={handleCreateReward} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input
            label={t('code')}
            required
            pattern={CODE_PATTERN}
            hint={t('codeHint')}
            value={rewardCode}
            onChange={(e) => setRewardCode(e.target.value)}
          />
          <Input
            label={t('rewardName')}
            required
            maxLength={160}
            value={rewardName}
            onChange={(e) => setRewardName(e.target.value)}
          />
          <Select
            label={t('rewardType')}
            className="sm:col-span-2"
            value={rewardType}
            onChange={(e) => setRewardType(e.target.value as RewardType)}
          >
            {REWARD_TYPES.map((option) => (
              <option key={option} value={option}>
                {rewardTypeLabel(option)}
              </option>
            ))}
          </Select>

          {rewardType === 'points' ? (
            <Input
              label={t('points')}
              type="number"
              min="1"
              max="1000000"
              step="1"
              inputMode="numeric"
              required
              hint={t('pointsHint')}
              className="sm:col-span-2"
              value={points}
              onChange={(e) => setPoints(e.target.value)}
            />
          ) : null}

          {rewardType === 'badge' ? (
            <>
              <Input
                label={t('badgeCode')}
                required
                pattern={CODE_PATTERN}
                hint={t('codeHint')}
                value={badgeCode}
                onChange={(e) => setBadgeCode(e.target.value)}
              />
              <Input
                label={t('badgeName')}
                maxLength={80}
                value={badgeName}
                onChange={(e) => setBadgeName(e.target.value)}
              />
            </>
          ) : null}

          {rewardType === 'course_access' ? (
            <Input
              label={t('courseId')}
              required
              hint={t('courseIdHint')}
              className="sm:col-span-2"
              value={courseId}
              onChange={(e) => setCourseId(e.target.value)}
            />
          ) : null}

          {rewardType === 'coupon' ? (
            <>
              <Select
                label={t('couponKind')}
                value={couponKind}
                onChange={(e) => setCouponKind(e.target.value as CouponKind)}
              >
                {COUPON_KINDS.map((option) => (
                  <option key={option} value={option}>
                    {t(`couponKinds.${option}`)}
                  </option>
                ))}
              </Select>
              <Input
                label={couponKind === 'percent' ? t('couponValuePercent') : t('couponValueFixed')}
                type="number"
                min="1"
                max={couponKind === 'percent' ? '100' : '1000000000'}
                step="1"
                inputMode="numeric"
                required
                hint={couponKind === 'percent' ? t('percentHint') : t('minorHint')}
                value={couponValue}
                onChange={(e) => setCouponValue(e.target.value)}
              />
              {couponKind === 'fixed' ? (
                <Input
                  label={t('couponCurrency')}
                  pattern={CURRENCY_PATTERN}
                  maxLength={3}
                  hint={t('couponCurrencyHint')}
                  value={couponCurrency}
                  onChange={(e) => setCouponCurrency(e.target.value.toUpperCase())}
                />
              ) : null}
              <Input
                label={t('minSubtotalMinor')}
                type="number"
                min="1"
                max="1000000000"
                step="1"
                inputMode="numeric"
                hint={t('minorHint')}
                value={minSubtotalMinor}
                onChange={(e) => setMinSubtotalMinor(e.target.value)}
              />
              <Input
                label={t('expiresInDays')}
                type="number"
                min="1"
                max="3650"
                step="1"
                inputMode="numeric"
                className="sm:col-span-2"
                value={expiresInDays}
                onChange={(e) => setExpiresInDays(e.target.value)}
              />
            </>
          ) : null}

          {isFulfilledRewardType(rewardType) ? null : (
            <p className="text-xs text-slate-500 sm:col-span-2">
              {rewardType === 'cash' ? tr('cashNote') : t('configRecorded')}
            </p>
          )}

          {rewardError ? <p className="text-sm text-red-600 sm:col-span-2">{rewardError}</p> : null}
          <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
            <Button type="submit" disabled={savingReward}>
              {savingReward ? tc('saving') : t('submitReward')}
            </Button>
            {rewardCreated ? (
              <span className="text-sm text-teal-700">
                {t('rewardCreated', { name: rewardCreated })}
              </span>
            ) : null}
          </div>
        </form>
      </Card>

      <Card title={t('grantTitle')}>
        <p className="mb-3 text-xs text-slate-500">{t('grantHint')}</p>
        {members.length === 0 ? (
          <p className="text-sm text-slate-500">{tgr('membersUnavailable')}</p>
        ) : definitions.length === 0 ? (
          <p className="text-sm text-slate-500">{t('rewardsEmpty')}</p>
        ) : (
          <form onSubmit={handleGrant} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Select
              label={t('member')}
              required
              value={grantMemberId}
              onChange={(e) => setGrantMemberId(e.target.value)}
            >
              <option value="">{tgr('choose')}</option>
              {members.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.displayName}
                </option>
              ))}
            </Select>
            <Select
              label={t('reward')}
              required
              value={grantRewardCode}
              onChange={(e) => setGrantRewardCode(e.target.value)}
            >
              <option value="">{tgr('choose')}</option>
              {definitions.map((definition) => (
                <option key={definition.id} value={definition.code}>
                  {definition.name}
                </option>
              ))}
            </Select>
            <div className="sm:col-span-2">
              <Button type="submit" disabled={savingGrant}>
                {savingGrant ? tc('saving') : t('submitGrant')}
              </Button>
            </div>
          </form>
        )}

        {grantError ? <p className="mt-3 text-sm text-red-600">{grantError}</p> : null}
      </Card>

      <Card title={t('grantsTitle')}>
        <p className="mb-3 text-xs text-slate-500">{t('grantsHint')}</p>
        {loading ? (
          <p className="text-sm text-slate-500">{tc('loading')}</p>
        ) : grants.length === 0 ? (
          <p className="text-sm text-slate-500">{t('grantsEmpty')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-slate-100">
            {grants.map((grant) => {
              const revoked = grant.status === 'revoked';
              return (
                <li
                  key={grant.id}
                  className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2"
                >
                  <span className="flex min-w-0 flex-col">
                    <span
                      className={`min-w-0 break-words text-sm ${
                        revoked ? 'text-slate-400 line-through' : 'text-slate-800'
                      }`}
                    >
                      {t('grantedTo', {
                        member: memberName(grant.member?.displayName, grant.memberId),
                        reward: grant.reward.name,
                      })}
                    </span>
                    <span className="min-w-0 break-words text-xs text-slate-500">
                      {formatDateTime(grant.grantedAt, locale)} ·{' '}
                      {grantSourceLabel(grant.sourceType)}
                      {grant.sourceType === 'automation' && grant.sourceRef
                        ? ` · ${grant.sourceRef}`
                        : ''}
                    </span>
                  </span>
                  {/* A revoked grant stays on the list, shown as revoked: the
                      row is the history of what was given and taken back. */}
                  {revoked ? (
                    <Badge tone="gray">{tr('revoked')}</Badge>
                  ) : (
                    <button
                      type="button"
                      disabled={revokingId === grant.id}
                      onClick={() => void handleRevoke(grant)}
                      className="text-sm font-medium text-slate-500 hover:underline disabled:opacity-50"
                    >
                      {revokingId === grant.id ? tc('saving') : t('revoke')}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {revokeError ? <p className="mt-3 text-sm text-red-600">{revokeError}</p> : null}
      </Card>
    </div>
  );
}
