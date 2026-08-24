'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { api, ApiError, isForbidden } from '@/lib/api-client';
import {
  NOTIFICATION_TYPES,
  type NotificationPreference,
  type NotificationPreferencesResponse,
} from '@/lib/types';
import { Card } from '@/components/ui/Card';

type PreferenceMap = Record<string, { inApp: boolean; email: boolean }>;

/** Every known type gets a row, defaulting to in-app on / email off when unset server-side. */
function buildPreferenceMap(preferences: NotificationPreference[]): PreferenceMap {
  const map: PreferenceMap = {};
  for (const { type } of NOTIFICATION_TYPES) map[type] = { inApp: true, email: false };
  for (const pref of preferences) {
    map[pref.type] = { inApp: pref.inApp, email: pref.email };
  }
  return map;
}

export default function NotificationSettingsPage() {
  const t = useTranslations('notificationSettings');
  const tc = useTranslations('common');

  const [preferences, setPreferences] = useState<PreferenceMap>(() => buildPreferenceMap([]));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [savingType, setSavingType] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<NotificationPreferencesResponse>('/notifications/preferences')
      .then((res) => {
        if (!cancelled) setPreferences(buildPreferenceMap(res.preferences));
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

  const handleToggle = async (type: string, channel: 'inApp' | 'email', value: boolean) => {
    const previous = preferences[type];
    const next = { ...previous, [channel]: value };
    setPreferences((current) => ({ ...current, [type]: next }));
    setSavingType(type);
    setError(null);
    try {
      await api.post('/notifications/preferences', { type, inApp: next.inApp, email: next.email });
    } catch (err: unknown) {
      // Roll back the optimistic flip so the UI never claims an unsaved setting.
      setPreferences((current) => ({ ...current, [type]: previous }));
      setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setSavingType(null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-bold text-slate-900">{t('title')}</h1>
      <p className="text-sm text-slate-500">{t('hint')}</p>

      {forbidden ? (
        <Card>
          <p className="text-sm text-slate-600">{t('forbidden')}</p>
        </Card>
      ) : (
        <Card>
          {error ? <p className="mb-2 text-sm text-red-600">{error}</p> : null}
          {loading ? (
            <p className="text-sm text-slate-500">{tc('loading')}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-slate-100">
              {NOTIFICATION_TYPES.map(({ type, messageKey }) => {
                const pref = preferences[type];
                return (
                  <li
                    key={type}
                    className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3"
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="text-sm font-medium text-slate-800">
                        {t(`types.${messageKey}`)}
                      </span>
                      <span className="font-mono text-xs text-slate-400">{type}</span>
                    </span>
                    <span className="flex items-center gap-4">
                      {(['inApp', 'email'] as const).map((channel) => (
                        <label
                          key={channel}
                          className="flex items-center gap-2 text-sm text-slate-600"
                        >
                          <input
                            type="checkbox"
                            checked={pref[channel]}
                            disabled={savingType === type}
                            onChange={(e) => void handleToggle(type, channel, e.target.checked)}
                            className="h-4 w-4 rounded border-slate-300 text-brand-700 focus:ring-brand-600"
                          />
                          {t(channel)}
                        </label>
                      ))}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}
