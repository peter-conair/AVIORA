'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { api, ApiError, isForbidden } from '@/lib/api-client';
import {
  API_KEY_SCOPES,
  isWebhookDeliveryStatus,
  isWebhookEndpointStatus,
  permissionLabelKey,
  triggerEventKey,
  WEBHOOK_DELIVERY_STATUSES,
  type ApiKeyCreatedResponse,
  type ApiKeySummary,
  type ApiKeysResponse,
  type WebhookDeliveriesResponse,
  type WebhookDelivery,
  type WebhookEndpoint,
  type WebhookEndpointCreatedResponse,
  type WebhookEndpointsResponse,
} from '@/lib/types';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { formatDateTime } from '@/lib/format';

/** The secret shown once, held only long enough for a person to copy it. */
interface RevealedSecret {
  secret: string;
  url: string;
}

/** The key shown once, on the same terms. */
interface RevealedKey {
  key: string;
  name: string;
}

/**
 * The scopes the API named when it refused a key.
 *
 * DECISION. The contract says a key may never hold a scope its creator lacks
 * (docs/30 §3), and asks this picker to offer only what the administrator
 * actually holds — but no route returns the caller's own permission set, so
 * the screen cannot know it in advance. What it can do is never lose the one
 * answer it does get: the API refuses with the missing scopes NAMED, and those
 * names are kept here, unticked and disabled, so the same refusal cannot be
 * walked into twice.
 */
function refusedScopesFrom(err: unknown): string[] {
  if (!(err instanceof ApiError)) return [];
  const details = err.details;
  if (typeof details !== 'object' || details === null) return [];
  const missing = (details as Record<string, unknown>).missingScopes;
  if (!Array.isArray(missing)) return [];
  return missing.filter((scope): scope is string => typeof scope === 'string');
}

/** `YYYY-MM-DD` from a date input becomes an instant the API will accept. */
function endOfDayIso(day: string): string {
  return new Date(`${day}T23:59:59`).toISOString();
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Webhooks and API keys (docs/30) — the two ways a tenant's own systems reach
 * this one.
 *
 * Both halves are built around a single rule that the UI has to carry rather
 * than merely obey: a secret and a key are shown exactly once, by the route
 * that mints them, and no listing carries either. So nothing on this screen
 * reads a credential out of a list — the panels below render only what a
 * creation response just handed back, and they say plainly that it will not
 * come again.
 */
export function IntegrationsTab() {
  const t = useTranslations('admin.integrations');
  // Event names are already named for people on the automation tab; a webhook
  // subscribing to GoalCompleted and a rule triggering on it are the same event.
  const tauto = useTranslations('admin.automation');
  const tc = useTranslations('common');
  const locale = useLocale();

  const [endpoints, setEndpoints] = useState<WebhookEndpoint[]>([]);
  const [subscribableEvents, setSubscribableEvents] = useState<string[]>([]);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [apiKeys, setApiKeys] = useState<ApiKeySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Endpoint form
  const [url, setUrl] = useState('');
  const [description, setDescription] = useState('');
  const [chosenEvents, setChosenEvents] = useState<string[]>([]);
  const [savingEndpoint, setSavingEndpoint] = useState(false);
  const [endpointError, setEndpointError] = useState<string | null>(null);
  const [revealedSecret, setRevealedSecret] = useState<RevealedSecret | null>(null);
  const [busyEndpointId, setBusyEndpointId] = useState<string | null>(null);
  const [endpointListError, setEndpointListError] = useState<string | null>(null);
  const [deletedNote, setDeletedNote] = useState<number | null>(null);

  // Delivery log
  const [statusFilter, setStatusFilter] = useState('');
  const [endpointFilter, setEndpointFilter] = useState('');
  const [deliveriesLoading, setDeliveriesLoading] = useState(false);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [deliveryError, setDeliveryError] = useState<string | null>(null);

  // Key form
  const [keyName, setKeyName] = useState('');
  const [keyExpiresAt, setKeyExpiresAt] = useState('');
  const [chosenScopes, setChosenScopes] = useState<string[]>([]);
  const [refusedScopes, setRefusedScopes] = useState<string[]>([]);
  const [savingKey, setSavingKey] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [revealedKey, setRevealedKey] = useState<RevealedKey | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [keyListError, setKeyListError] = useState<string | null>(null);

  const loadEndpoints = useCallback(async () => {
    const res = await api.get<WebhookEndpointsResponse>('/webhooks/endpoints');
    setEndpoints(res.endpoints);
    setSubscribableEvents(res.subscribableEvents ?? []);
  }, []);

  const loadDeliveries = useCallback(async (status: string, endpointId: string) => {
    const query = new URLSearchParams();
    if (status) query.set('status', status);
    if (endpointId) query.set('endpointId', endpointId);
    const suffix = query.toString();
    const res = await api.get<WebhookDeliveriesResponse>(
      `/webhooks/deliveries${suffix ? `?${suffix}` : ''}`,
    );
    setDeliveries(res.deliveries);
  }, []);

  const loadKeys = useCallback(async () => {
    const res = await api.get<ApiKeysResponse>('/api-keys');
    setApiKeys(res.apiKeys);
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([loadEndpoints(), loadDeliveries('', ''), loadKeys()])
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
    return key ? tauto(key) : eventName;
  };

  const scopeLabel = (scope: string): string => {
    const key = permissionLabelKey(scope);
    return key ? t(key) : scope;
  };

  const endpointStatusLabel = (status: string): string =>
    isWebhookEndpointStatus(status) ? t(`statuses.${status}`) : status;

  const deliveryStatusLabel = (status: string): string =>
    isWebhookDeliveryStatus(status) ? t(`deliveryStatuses.${status}`) : status;

  const endpointName = (endpointId: string): string =>
    endpoints.find((endpoint) => endpoint.id === endpointId)?.url ?? endpointId;

  const toggleEvent = (eventName: string) =>
    setChosenEvents((rows) =>
      rows.includes(eventName) ? rows.filter((row) => row !== eventName) : [...rows, eventName],
    );

  const toggleScope = (scope: string) =>
    setChosenScopes((rows) =>
      rows.includes(scope) ? rows.filter((row) => row !== scope) : [...rows, scope],
    );

  const handleCreateEndpoint = async (e: FormEvent) => {
    e.preventDefault();
    setEndpointError(null);
    // A previous secret disappears the moment another endpoint is created —
    // two "shown once" panels on one screen is an invitation to copy the wrong one.
    setRevealedSecret(null);
    if (chosenEvents.length === 0) {
      setEndpointError(t('eventsRequired'));
      return;
    }
    setSavingEndpoint(true);
    try {
      const res = await api.post<WebhookEndpointCreatedResponse>('/webhooks/endpoints', {
        url,
        events: chosenEvents,
        ...(description ? { description } : {}),
      });
      // The ONLY place in this file that reads a secret, and it reads it from
      // the creation response — never from a listing, where it is not present.
      setRevealedSecret({ secret: res.secret, url: res.endpoint.url });
      setUrl('');
      setDescription('');
      setChosenEvents([]);
      await loadEndpoints();
    } catch (err: unknown) {
      if (isForbidden(err)) setEndpointError(t('forbidden'));
      else setEndpointError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setSavingEndpoint(false);
    }
  };

  const handleToggleEndpoint = async (endpoint: WebhookEndpoint) => {
    setEndpointListError(null);
    setBusyEndpointId(endpoint.id);
    try {
      await api.patch(`/webhooks/endpoints/${endpoint.id}`, {
        status: endpoint.status === 'active' ? 'paused' : 'active',
      });
      await loadEndpoints();
    } catch (err: unknown) {
      if (isForbidden(err)) setEndpointListError(t('forbidden'));
      else setEndpointListError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setBusyEndpointId(null);
    }
  };

  const handleDeleteEndpoint = async (endpoint: WebhookEndpoint) => {
    // The delivery log goes with it and neither comes back, which "delete" on
    // its own does not say.
    if (!window.confirm(t('deleteConfirm'))) return;
    setEndpointListError(null);
    setDeletedNote(null);
    setBusyEndpointId(endpoint.id);
    try {
      const res = await api.delete<{ deletedDeliveries?: number }>(
        `/webhooks/endpoints/${endpoint.id}`,
      );
      setDeletedNote(res?.deletedDeliveries ?? 0);
      if (endpointFilter === endpoint.id) setEndpointFilter('');
      await Promise.all([
        loadEndpoints(),
        loadDeliveries(statusFilter, endpointFilter === endpoint.id ? '' : endpointFilter),
      ]);
    } catch (err: unknown) {
      if (isForbidden(err)) setEndpointListError(t('forbidden'));
      else setEndpointListError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setBusyEndpointId(null);
    }
  };

  const handleFilterDeliveries = async (status: string, endpointId: string) => {
    setStatusFilter(status);
    setEndpointFilter(endpointId);
    setDeliveryError(null);
    setDeliveriesLoading(true);
    try {
      await loadDeliveries(status, endpointId);
    } catch (err: unknown) {
      if (isForbidden(err)) setDeliveryError(t('forbidden'));
      else setDeliveryError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setDeliveriesLoading(false);
    }
  };

  const handleRetry = async (delivery: WebhookDelivery) => {
    setDeliveryError(null);
    setRetryingId(delivery.id);
    try {
      await api.post(`/webhooks/deliveries/${delivery.id}/retry`);
      await loadDeliveries(statusFilter, endpointFilter);
    } catch (err: unknown) {
      if (isForbidden(err)) setDeliveryError(t('forbidden'));
      else setDeliveryError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setRetryingId(null);
    }
  };

  const handleCreateKey = async (e: FormEvent) => {
    e.preventDefault();
    setKeyError(null);
    setRevealedKey(null);
    if (chosenScopes.length === 0) {
      setKeyError(t('scopesRequired'));
      return;
    }
    setSavingKey(true);
    try {
      const res = await api.post<ApiKeyCreatedResponse>('/api-keys', {
        name: keyName,
        scopes: chosenScopes,
        ...(keyExpiresAt ? { expiresAt: endOfDayIso(keyExpiresAt) } : {}),
      });
      setRevealedKey({ key: res.key, name: res.apiKey.name });
      setKeyName('');
      setKeyExpiresAt('');
      setChosenScopes([]);
      await loadKeys();
    } catch (err: unknown) {
      const refused = refusedScopesFrom(err);
      if (refused.length > 0) {
        // The API named them, so the screen keeps the names rather than
        // reducing a specific answer to "forbidden".
        setRefusedScopes((rows) => Array.from(new Set([...rows, ...refused])));
        setChosenScopes((rows) => rows.filter((scope) => !refused.includes(scope)));
        setKeyError(err instanceof ApiError ? err.message : tc('errorGeneric'));
      } else if (isForbidden(err)) {
        setKeyError(t('forbidden'));
      } else {
        setKeyError(err instanceof ApiError ? err.message : tc('errorGeneric'));
      }
    } finally {
      setSavingKey(false);
    }
  };

  const handleRevoke = async (apiKey: ApiKeySummary) => {
    // Immediate and permanent, and anything still calling with it breaks now.
    if (!window.confirm(t('revokeConfirm'))) return;
    setKeyListError(null);
    setRevokingId(apiKey.id);
    try {
      await api.delete(`/api-keys/${apiKey.id}`);
      await loadKeys();
    } catch (err: unknown) {
      if (isForbidden(err)) setKeyListError(t('forbidden'));
      else setKeyListError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setRevokingId(null);
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

      <Card title={t('endpointsTitle')}>
        <p className="mb-3 text-xs text-slate-500">{t('endpointsHint')}</p>
        {loading ? (
          <p className="text-sm text-slate-500">{tc('loading')}</p>
        ) : endpoints.length === 0 ? (
          <p className="text-sm text-slate-500">{t('endpointsEmpty')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-slate-100">
            {endpoints.map((endpoint) => (
              <li key={endpoint.id} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <span className="flex min-w-0 flex-col">
                    {/* A URL is long and has no spaces; on a 360 px screen it
                        has to be allowed to break mid-string or it pushes the
                        whole page sideways. */}
                    <span className="min-w-0 break-all text-sm font-medium text-slate-800">
                      {endpoint.url}
                    </span>
                    <span className="min-w-0 break-words text-xs text-slate-500">
                      {endpoint.description ? `${endpoint.description} · ` : ''}
                      {t('endpointAdded', { when: formatDateTime(endpoint.createdAt, locale) })}
                    </span>
                  </span>
                  <Badge tone={endpoint.status === 'active' ? 'teal' : 'gray'}>
                    {endpointStatusLabel(endpoint.status)}
                  </Badge>
                </div>

                <p className="min-w-0 break-words text-xs text-slate-600">
                  {t('endpointEventsLabel')}{' '}
                  {endpoint.events.map((eventName) => eventLabel(eventName)).join(' · ')}
                </p>

                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busyEndpointId === endpoint.id}
                    onClick={() => void handleToggleEndpoint(endpoint)}
                  >
                    {busyEndpointId === endpoint.id
                      ? tc('saving')
                      : endpoint.status === 'active'
                        ? t('pause')
                        : t('resume')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busyEndpointId === endpoint.id}
                    onClick={() => void handleDeleteEndpoint(endpoint)}
                  >
                    {t('delete')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {deletedNote !== null ? (
          <p className="mt-3 text-sm text-slate-600">{t('deleted', { count: deletedNote })}</p>
        ) : null}
        {endpointListError ? (
          <p className="mt-3 text-sm text-red-600">{endpointListError}</p>
        ) : null}
      </Card>

      {/* Shown once, and the panel says so in the same breath as the value.
          A secret rendered without that sentence is one somebody will assume
          they can come back for. */}
      {revealedSecret ? (
        <Card className="border-amber-300 bg-amber-50">
          <h2 className="text-base font-semibold text-amber-900">{t('secretTitle')}</h2>
          <p className="mt-2 text-sm text-amber-900">{t('secretWarning')}</p>
          <p className="mt-1 text-sm font-medium text-amber-900">{t('secretLost')}</p>
          <p className="mt-3 text-xs break-all text-amber-800">
            {t('secretFor', { url: revealedSecret.url })}
          </p>
          <code className="mt-1 block w-full rounded-lg border border-amber-300 bg-white p-3 font-mono text-xs break-all text-slate-900">
            {revealedSecret.secret}
          </code>
          <div className="mt-3">
            <Button type="button" variant="secondary" onClick={() => setRevealedSecret(null)}>
              {t('secretDismiss')}
            </Button>
          </div>
        </Card>
      ) : null}

      <Card title={t('endpointFormTitle')}>
        <p className="mb-3 text-xs text-slate-500">{t('endpointFormHint')}</p>
        <form onSubmit={handleCreateEndpoint} className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Input
              label={t('url')}
              type="url"
              required
              maxLength={2048}
              pattern="https://.*"
              hint={t('urlHint')}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <Input
              label={t('description')}
              maxLength={300}
              hint={t('descriptionHint')}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium text-slate-700">{t('eventsLabel')}</legend>
            {/* The catalog comes from the server, so this list can never offer
                an event the server would refuse — and there is no "all"
                option to tick (docs/30 §7). */}
            <p className="text-xs text-slate-500">{t('eventsHint')}</p>
            <div className="max-h-64 overflow-y-auto rounded-lg border border-slate-200 p-2">
              {subscribableEvents.map((eventName) => (
                <label
                  key={eventName}
                  className="flex items-start gap-2 rounded-md p-1.5 text-sm text-slate-700 hover:bg-slate-50"
                >
                  <input
                    type="checkbox"
                    className="mt-1 h-4 w-4 shrink-0 rounded border-slate-300 text-brand-700 focus:ring-brand-600"
                    checked={chosenEvents.includes(eventName)}
                    onChange={() => toggleEvent(eventName)}
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="min-w-0 break-words">{eventLabel(eventName)}</span>
                    <span className="min-w-0 font-mono text-xs break-all text-slate-400">
                      {eventName}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            <p className="text-xs text-slate-500">
              {t('eventsChosen', { count: chosenEvents.length })}
            </p>
          </fieldset>

          <div>
            <Button type="submit" disabled={savingEndpoint}>
              {savingEndpoint ? tc('saving') : t('submitEndpoint')}
            </Button>
          </div>
          {endpointError ? <p className="text-sm text-red-600">{endpointError}</p> : null}
        </form>
      </Card>

      <Card title={t('deliveriesTitle')}>
        <p className="mb-3 text-xs text-slate-500">{t('deliveriesHint')}</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Select
            label={t('filterStatus')}
            value={statusFilter}
            onChange={(e) => void handleFilterDeliveries(e.target.value, endpointFilter)}
          >
            <option value="">{t('filterAll')}</option>
            {WEBHOOK_DELIVERY_STATUSES.map((option) => (
              <option key={option} value={option}>
                {t(`deliveryStatuses.${option}`)}
              </option>
            ))}
          </Select>
          <Select
            label={t('filterEndpoint')}
            value={endpointFilter}
            onChange={(e) => void handleFilterDeliveries(statusFilter, e.target.value)}
          >
            <option value="">{t('filterAll')}</option>
            {endpoints.map((endpoint) => (
              <option key={endpoint.id} value={endpoint.id}>
                {endpoint.url}
              </option>
            ))}
          </Select>
        </div>

        <div className="mt-4 border-t border-slate-100 pt-3">
          {loading || deliveriesLoading ? (
            <p className="text-sm text-slate-500">{tc('loading')}</p>
          ) : deliveries.length === 0 ? (
            <p className="text-sm text-slate-500">{t('deliveriesEmpty')}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-slate-100">
              {deliveries.map((delivery) => {
                const failed = delivery.status === 'failed';
                return (
                  <li key={delivery.id} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                      <span className="flex min-w-0 flex-col">
                        <span className="min-w-0 break-words text-sm font-medium text-slate-800">
                          {eventLabel(delivery.eventName)}
                        </span>
                        <span className="min-w-0 break-all text-xs text-slate-500">
                          {endpointName(delivery.endpointId)} ·{' '}
                          {formatDateTime(delivery.createdAt, locale)}
                        </span>
                      </span>
                      <Badge
                        tone={failed ? 'red' : delivery.status === 'delivered' ? 'green' : 'amber'}
                      >
                        {deliveryStatusLabel(delivery.status)}
                      </Badge>
                    </div>

                    {/* Attempts, the code and the error are the three things a
                        support answer needs; none of them is inferable from
                        the status word alone. */}
                    <p className="min-w-0 break-words text-xs text-slate-600">
                      {t('attemptsLabel', { count: delivery.attempts })} ·{' '}
                      {delivery.responseCode === null
                        ? t('noResponse')
                        : t('responseLabel', { code: delivery.responseCode })}
                    </p>

                    {delivery.error ? (
                      <p className="min-w-0 break-words text-xs text-red-600">{delivery.error}</p>
                    ) : null}

                    {delivery.deliveredAt ? (
                      <p className="min-w-0 break-words text-xs text-slate-500">
                        {t('deliveredAtLabel', {
                          when: formatDateTime(delivery.deliveredAt, locale),
                        })}
                      </p>
                    ) : delivery.nextAttemptAt ? (
                      <p className="min-w-0 break-words text-xs text-slate-500">
                        {t('nextAttempt', {
                          when: formatDateTime(delivery.nextAttemptAt, locale),
                        })}
                      </p>
                    ) : null}

                    {delivery.status === 'delivered' ? null : (
                      <div>
                        <Button
                          type="button"
                          variant="ghost"
                          disabled={retryingId === delivery.id}
                          onClick={() => void handleRetry(delivery)}
                        >
                          {retryingId === delivery.id ? tc('saving') : t('retry')}
                        </Button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <p className="mt-3 text-xs text-slate-500">{t('retryHint')}</p>
          {deliveryError ? <p className="mt-3 text-sm text-red-600">{deliveryError}</p> : null}
        </div>
      </Card>

      <Card title={t('keysTitle')}>
        <p className="mb-3 text-xs text-slate-500">{t('keysHint')}</p>
        {loading ? (
          <p className="text-sm text-slate-500">{tc('loading')}</p>
        ) : apiKeys.length === 0 ? (
          <p className="text-sm text-slate-500">{t('keysEmpty')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-slate-100">
            {apiKeys.map((apiKey) => (
              <li key={apiKey.id} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <span className="flex min-w-0 flex-col">
                    <span className="min-w-0 break-words text-sm font-medium text-slate-800">
                      {apiKey.name}
                    </span>
                    {/* The prefix, which is all a listing has: enough to tell
                        two keys apart, useless to authenticate with. */}
                    <span className="min-w-0 font-mono text-xs break-all text-slate-500">
                      {apiKey.prefix}
                    </span>
                  </span>
                  <Badge tone={apiKey.revokedAt ? 'red' : 'teal'}>
                    {apiKey.revokedAt
                      ? t('revokedOn', { when: formatDateTime(apiKey.revokedAt, locale) })
                      : apiKey.expiresAt
                        ? t('expiresOn', { when: formatDateTime(apiKey.expiresAt, locale) })
                        : t('expiresNever')}
                  </Badge>
                </div>

                <p className="min-w-0 break-words text-xs text-slate-600">
                  {t('keyScopesLabel')}{' '}
                  {apiKey.scopes.map((scope) => scopeLabel(scope)).join(' · ')}
                </p>

                {/* Whether a key is still in traffic is the question an
                    operator asks before pulling it (docs/30 §3). */}
                <p className="min-w-0 break-words text-xs text-slate-500">
                  {apiKey.lastUsedAt
                    ? t('lastUsed', { when: formatDateTime(apiKey.lastUsedAt, locale) })
                    : t('lastUsedNever')}
                </p>

                {apiKey.revokedAt ? null : (
                  <div>
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={revokingId === apiKey.id}
                      onClick={() => void handleRevoke(apiKey)}
                    >
                      {revokingId === apiKey.id ? tc('saving') : t('revoke')}
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {keyListError ? <p className="mt-3 text-sm text-red-600">{keyListError}</p> : null}
      </Card>

      {revealedKey ? (
        <Card className="border-amber-300 bg-amber-50">
          <h2 className="text-base font-semibold text-amber-900">{t('keyTitle')}</h2>
          <p className="mt-2 text-sm text-amber-900">{t('keyWarning')}</p>
          <p className="mt-1 text-sm font-medium text-amber-900">{t('keyLost')}</p>
          <p className="mt-3 text-xs break-words text-amber-800">
            {t('keyFor', { name: revealedKey.name })}
          </p>
          <code className="mt-1 block w-full rounded-lg border border-amber-300 bg-white p-3 font-mono text-xs break-all text-slate-900">
            {revealedKey.key}
          </code>
          <div className="mt-3">
            <Button type="button" variant="secondary" onClick={() => setRevealedKey(null)}>
              {t('keyDismiss')}
            </Button>
          </div>
        </Card>
      ) : null}

      <Card title={t('keyFormTitle')}>
        <p className="mb-3 text-xs text-slate-500">{t('keyFormHint')}</p>
        <form onSubmit={handleCreateKey} className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Input
              label={t('keyName')}
              required
              maxLength={120}
              value={keyName}
              onChange={(e) => setKeyName(e.target.value)}
            />
            <Input
              label={t('keyExpiresAt')}
              type="date"
              min={todayIso()}
              hint={t('keyExpiresAtHint')}
              value={keyExpiresAt}
              onChange={(e) => setKeyExpiresAt(e.target.value)}
            />
          </div>

          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium text-slate-700">{t('scopesLabel')}</legend>
            <p className="text-xs text-slate-500">{t('scopesHint')}</p>
            <p className="text-xs text-slate-500">{t('noWildcards')}</p>
            <div className="max-h-64 overflow-y-auto rounded-lg border border-slate-200 p-2">
              {API_KEY_SCOPES.map((scope) => {
                const unavailable = refusedScopes.includes(scope);
                return (
                  <label
                    key={scope}
                    className={`flex items-start gap-2 rounded-md p-1.5 text-sm hover:bg-slate-50 ${
                      unavailable ? 'text-slate-400' : 'text-slate-700'
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 shrink-0 rounded border-slate-300 text-brand-700 focus:ring-brand-600"
                      checked={chosenScopes.includes(scope)}
                      disabled={unavailable}
                      onChange={() => toggleScope(scope)}
                    />
                    <span className="flex min-w-0 flex-col">
                      <span className="min-w-0 break-words">{scopeLabel(scope)}</span>
                      <span className="min-w-0 font-mono text-xs break-all text-slate-400">
                        {scope}
                        {unavailable ? ` · ${t('scopeUnavailable')}` : ''}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
            <p className="text-xs text-slate-500">
              {t('scopesChosen', { count: chosenScopes.length })}
            </p>
          </fieldset>

          <div>
            <Button type="submit" disabled={savingKey}>
              {savingKey ? tc('saving') : t('submitKey')}
            </Button>
          </div>

          {refusedScopes.length > 0 ? (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
              <p className="text-sm font-medium text-amber-900">{t('scopeRefusedTitle')}</p>
              <p className="mt-1 text-xs text-amber-900">{t('scopeRefusedHint')}</p>
              <p className="mt-2 min-w-0 break-words text-xs text-amber-900">
                {refusedScopes.map((scope) => scopeLabel(scope)).join(' · ')}
              </p>
            </div>
          ) : null}
          {keyError ? <p className="text-sm text-red-600">{keyError}</p> : null}
        </form>
      </Card>
    </div>
  );
}
