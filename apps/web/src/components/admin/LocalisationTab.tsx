'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { api, ApiError, isForbidden, issueFor, validationIssues } from '@/lib/api-client';
import type { LocalisationResponse, LocalisationView } from '@/lib/types';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';

/** The API's own shapes, so a typo is refused here rather than by the server. */
const COUNTRY_PATTERN = '[A-Za-z]{2}';
const CURRENCY_PATTERN = '[A-Za-z]{3}';
const LOCALE_PATTERN = '[a-z]{2}(-[A-Z]{2})?';

/** The zones this browser can name, for a suggestion list. Absent on old engines. */
function knownTimeZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  try {
    return intl.supportedValuesOf?.('timeZone') ?? [];
  } catch {
    return [];
  }
}

/**
 * Country, currency, timezone and language (docs/29 §2).
 *
 * This is a small form with an unusually large blast radius: the timezone is
 * what a "day" MEANS to this workspace, so analytics windows, renewal dates and
 * challenge boundaries all move with it. The screen therefore says what each
 * value decides, and surfaces the server's refusal verbatim rather than
 * flattening it into "something went wrong" — "that is not a currency this
 * platform can name" tells an administrator what to type next.
 */
export function LocalisationTab() {
  const t = useTranslations('admin.localisation');
  const tc = useTranslations('common');

  const [current, setCurrent] = useState<LocalisationView | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [country, setCountry] = useState('');
  const [currency, setCurrency] = useState('');
  const [timezone, setTimezone] = useState('');
  const [defaultLocale, setDefaultLocale] = useState('');
  const [supported, setSupported] = useState<string[]>([]);
  const [localeToAdd, setLocaleToAdd] = useState('');

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [issues, setIssues] = useState<ReturnType<typeof validationIssues>>([]);

  const timeZones = useMemo(() => knownTimeZones(), []);

  const apply = (view: LocalisationView) => {
    setCurrent(view);
    setCountry(view.country);
    setCurrency(view.currency);
    setTimezone(view.timezone);
    setDefaultLocale(view.defaultLocale);
    setSupported(view.supportedLocales);
  };

  useEffect(() => {
    let cancelled = false;
    api
      .get<LocalisationResponse>('/tenant/localisation')
      .then((res) => {
        if (!cancelled) apply(res.localisation);
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

  const addLocale = () => {
    const value = localeToAdd.trim();
    if (!value || supported.includes(value)) {
      setLocaleToAdd('');
      return;
    }
    setSupported((list) => [...list, value]);
    setLocaleToAdd('');
  };

  /**
   * Removing the default would ask the server to accept a workspace that
   * defaults to a language its own switcher refuses to offer — the API says so,
   * and the button simply is not offered rather than earning that refusal.
   */
  const removeLocale = (value: string) =>
    setSupported((list) => list.filter((entry) => entry !== value));

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    setSaveError(null);
    setIssues([]);
    setSaved(false);
    setSaving(true);
    try {
      const res = await api.put<LocalisationResponse>('/tenant/localisation', {
        country: country.toUpperCase(),
        currency: currency.toUpperCase(),
        timezone,
        defaultLocale,
        supportedLocales: supported,
      });
      apply(res.localisation);
      setSaved(true);
    } catch (err: unknown) {
      if (isForbidden(err)) setSaveError(t('forbidden'));
      else {
        setIssues(validationIssues(err));
        setSaveError(err instanceof ApiError ? err.message : tc('errorGeneric'));
      }
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <p className="text-sm text-slate-500">{tc('loading')}</p>;
  if (forbidden) return <p className="text-sm text-slate-600">{t('forbidden')}</p>;

  return (
    <div className="flex flex-col gap-4">
      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      <Card
        title={t('title')}
        actions={
          current ? (
            <Badge tone={current.source === 'localisation' ? 'teal' : 'gray'}>
              {t(`source.${current.source}`)}
            </Badge>
          ) : null
        }
      >
        <p className="mb-3 text-xs text-slate-500">{t('hint')}</p>
        <form onSubmit={handleSave} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input
            label={t('country')}
            required
            pattern={COUNTRY_PATTERN}
            maxLength={2}
            hint={t('countryHint')}
            value={country}
            error={issueFor(issues, 'country')}
            onChange={(e) => setCountry(e.target.value.toUpperCase())}
          />
          <Input
            label={t('currency')}
            required
            pattern={CURRENCY_PATTERN}
            maxLength={3}
            hint={t('currencyHint')}
            value={currency}
            error={issueFor(issues, 'currency')}
            onChange={(e) => setCurrency(e.target.value.toUpperCase())}
          />
          <Input
            label={t('timezone')}
            required
            maxLength={64}
            list="aviora-timezones"
            hint={t('timezoneHint')}
            className="sm:col-span-2"
            value={timezone}
            error={issueFor(issues, 'timezone')}
            onChange={(e) => setTimezone(e.target.value)}
          />
          <datalist id="aviora-timezones">
            {timeZones.map((zone) => (
              <option key={zone} value={zone} />
            ))}
          </datalist>

          <div className="flex flex-col gap-2 sm:col-span-2">
            <span className="text-sm font-medium text-slate-700">{t('supportedLocales')}</span>
            <p className="text-xs text-slate-500">{t('supportedLocalesHint')}</p>
            {supported.length === 0 ? (
              <p className="text-xs text-red-600">{t('supportedLocalesEmpty')}</p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {supported.map((entry) => (
                  <li
                    key={entry}
                    className="inline-flex items-center gap-1 rounded-full bg-slate-100 py-1 pe-1 ps-3 text-sm text-slate-700"
                  >
                    <span className="font-mono">{entry}</span>
                    {entry === defaultLocale ? (
                      <span className="text-xs text-slate-500">{t('isDefault')}</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => removeLocale(entry)}
                        aria-label={t('removeLocale', { locale: entry })}
                        className="rounded-full px-2 py-0.5 text-xs text-slate-500 hover:bg-slate-200 hover:text-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700"
                      >
                        ✕
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {issueFor(issues, 'supportedLocales') ? (
              <p className="text-xs text-red-600">{issueFor(issues, 'supportedLocales')}</p>
            ) : null}
            <div className="flex flex-wrap items-end gap-2">
              <Input
                label={t('addLocale')}
                pattern={LOCALE_PATTERN}
                maxLength={5}
                hint={t('addLocaleHint')}
                className="w-32"
                value={localeToAdd}
                onChange={(e) => setLocaleToAdd(e.target.value)}
                onKeyDown={(e) => {
                  // Enter adds the locale; it must not submit the whole form and
                  // save a list the administrator is still building.
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addLocale();
                  }
                }}
              />
              <Button type="button" variant="secondary" onClick={addLocale}>
                {t('addLocaleAction')}
              </Button>
            </div>
          </div>

          <Select
            label={t('defaultLocale')}
            required
            className="sm:col-span-2"
            value={defaultLocale}
            onChange={(e) => setDefaultLocale(e.target.value)}
          >
            <option value="">{t('choose')}</option>
            {supported.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </Select>
          {issueFor(issues, 'defaultLocale') ? (
            <p className="text-xs text-red-600 sm:col-span-2">
              {issueFor(issues, 'defaultLocale')}
            </p>
          ) : null}

          {saveError ? <p className="text-sm text-red-600 sm:col-span-2">{saveError}</p> : null}
          {issues.length > 0 ? (
            <ul className="flex flex-col gap-1 sm:col-span-2">
              {issues.map((issue, index) => (
                <li key={`${issue.path}-${index}`} className="break-words text-xs text-red-600">
                  {issue.path ? `${issue.path}: ` : ''}
                  {issue.message}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
            <Button type="submit" disabled={saving}>
              {saving ? tc('saving') : t('submit')}
            </Button>
            {saved ? <span className="text-sm text-teal-700">{t('savedNote')}</span> : null}
          </div>
        </form>
      </Card>
    </div>
  );
}
