'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { api, ApiError, isForbidden, issueFor, validationIssues } from '@/lib/api-client';
import type { TaxRule, TaxRulesResponse, TaxUpsertResponse } from '@/lib/types';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { formatBasisPoints } from '@/lib/format';

const COUNTRY_PATTERN = '[A-Za-z]{2}';

/**
 * Tax rules (docs/29 §4).
 *
 * The rate is stored and edited in BASIS POINTS and the field says so — 700 is
 * 7%, and a field that accepted "7" into a basis-points column would be wrong
 * by a factor of a hundred in the customer's favour or the tenant's.
 *
 * The API's own disclosure is rendered VERBATIM. It is the sentence that stops
 * a field labelled "tax" from being read as a tax engine, and paraphrasing it
 * into something friendlier is how the promise quietly gets bigger than the
 * feature.
 */
export function TaxRulesCard() {
  const t = useTranslations('admin.commerce.tax');
  const tc = useTranslations('common');
  const locale = useLocale();

  const [rules, setRules] = useState<TaxRule[]>([]);
  const [tenantCountry, setTenantCountry] = useState('');
  const [wouldResolve, setWouldResolve] = useState<TaxRule | null>(null);
  const [disclosure, setDisclosure] = useState('');
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [country, setCountry] = useState('');
  const [region, setRegion] = useState('');
  const [rateBasisPoints, setRateBasisPoints] = useState('');
  const [inclusive, setInclusive] = useState(false);
  const [label, setLabel] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState<TaxRule | null>(null);
  const [issues, setIssues] = useState<ReturnType<typeof validationIssues>>([]);

  const load = useCallback(async () => {
    const res = await api.get<TaxRulesResponse>('/tax/rules');
    setRules(res.rules);
    setTenantCountry(res.tenantCountry);
    setWouldResolve(res.wouldResolve);
    setDisclosure(res.disclosure);
    return res;
  }, []);

  useEffect(() => {
    let cancelled = false;
    load()
      .then((res) => {
        // The tenant's own country is the one an order resolves against, so it
        // is what a first rule should almost always be for.
        if (!cancelled) setCountry((value) => value || res.tenantCountry);
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

  const handleUpsert = async (e: FormEvent) => {
    e.preventDefault();
    setSaveError(null);
    setIssues([]);
    setSaved(null);
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        country: country.toUpperCase(),
        // Null is the country-wide rule. An empty box is that, not a region
        // called "".
        region: region.trim() ? region.trim() : null,
        rateBasisPoints: Number(rateBasisPoints),
        inclusive,
        label,
      };
      const res = await api.put<TaxUpsertResponse>('/tax/rules', payload);
      setSaved(res.rule);
      setDisclosure(res.disclosure);
      await load();
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

  /** Load an existing rule into the form — upsert is by (country, region). */
  const edit = (rule: TaxRule) => {
    setCountry(rule.country);
    setRegion(rule.region ?? '');
    setRateBasisPoints(String(rule.rateBasisPoints));
    setInclusive(rule.inclusive);
    setLabel(rule.label);
    setSaved(null);
  };

  const disclosureBlock = disclosure ? (
    <div className="rounded-lg border border-slate-300 bg-slate-50 p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-600">
        {t('disclosureTitle')}
      </p>
      {/* The API's words, unedited. */}
      <p className="mt-1 break-words text-sm text-slate-700">{disclosure}</p>
    </div>
  ) : null;

  return (
    <div className="flex flex-col gap-4">
      <Card title={t('title')}>
        <p className="mb-3 text-xs text-slate-500">{t('hint')}</p>
        {disclosureBlock}
        {forbidden ? (
          <p className="mt-3 text-sm text-slate-600">{t('forbidden')}</p>
        ) : loading ? (
          <p className="mt-3 text-sm text-slate-500">{tc('loading')}</p>
        ) : (
          <>
            <p className="mt-3 text-xs text-slate-600">
              {t('tenantCountry', { country: tenantCountry || '—' })}
            </p>
            <p className="text-xs text-slate-600">
              {wouldResolve
                ? t('wouldResolve', {
                    label: wouldResolve.label,
                    basisPoints: wouldResolve.rateBasisPoints,
                    percent: formatBasisPoints(wouldResolve.rateBasisPoints, locale),
                  })
                : t('wouldResolveNone')}
            </p>
            {error ? <p className="mt-2 text-sm text-red-600">{error}</p> : null}
            {rules.length === 0 ? (
              <p className="mt-3 text-sm text-slate-500">{t('empty')}</p>
            ) : (
              <ul className="mt-3 flex flex-col divide-y divide-slate-100">
                {rules.map((rule) => (
                  <li
                    key={rule.id}
                    className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-3 first:pt-0 last:pb-0"
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="min-w-0 break-words text-sm font-medium text-slate-800">
                        {rule.label}
                      </span>
                      <span className="block break-words text-xs text-slate-500">
                        {rule.country}
                        {rule.region ? ` · ${rule.region}` : ` · ${t('countryWide')}`}
                      </span>
                    </span>
                    <span className="flex items-center gap-2">
                      <Badge tone={rule.inclusive ? 'amber' : 'gray'}>
                        {rule.inclusive ? t('inclusiveBadge') : t('exclusiveBadge')}
                      </Badge>
                      <span className="whitespace-nowrap text-sm font-semibold text-slate-900">
                        {t('rateValue', {
                          basisPoints: rule.rateBasisPoints,
                          percent: formatBasisPoints(rule.rateBasisPoints, locale),
                        })}
                      </span>
                      <button
                        type="button"
                        onClick={() => edit(rule)}
                        className="rounded-lg px-2 py-1 text-xs font-medium text-teal-800 hover:bg-teal-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700"
                      >
                        {t('editAction')}
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </Card>

      {forbidden ? null : (
        <Card title={t('formTitle')}>
          <p className="mb-3 text-xs text-slate-500">{t('formHint')}</p>
          <form onSubmit={handleUpsert} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
              label={t('region')}
              maxLength={80}
              hint={t('regionHint')}
              value={region}
              error={issueFor(issues, 'region')}
              onChange={(e) => setRegion(e.target.value)}
            />
            <Input
              label={t('rateBasisPoints')}
              type="number"
              min="0"
              max="10000"
              step="1"
              inputMode="numeric"
              required
              hint={t('rateHint')}
              value={rateBasisPoints}
              error={issueFor(issues, 'rateBasisPoints')}
              onChange={(e) => setRateBasisPoints(e.target.value)}
            />
            <Input
              label={t('label')}
              required
              maxLength={80}
              hint={t('labelHint')}
              value={label}
              error={issueFor(issues, 'label')}
              onChange={(e) => setLabel(e.target.value)}
            />
            <label className="flex items-start gap-2 sm:col-span-2">
              <input
                type="checkbox"
                checked={inclusive}
                onChange={(e) => setInclusive(e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 text-teal-700 focus:ring-teal-600"
              />
              <span className="flex min-w-0 flex-col">
                <span className="text-sm font-medium text-slate-700">{t('inclusive')}</span>
                <span className="text-xs text-slate-500">{t('inclusiveHint')}</span>
              </span>
            </label>
            {rateBasisPoints ? (
              <p className="text-xs text-slate-600 sm:col-span-2">
                {t('ratePreview', {
                  basisPoints: Number(rateBasisPoints),
                  percent: formatBasisPoints(Number(rateBasisPoints), locale),
                })}
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
              {saved ? (
                <span className="text-sm text-teal-700">
                  {t('savedNote', {
                    country: saved.country,
                    region: saved.region ?? t('countryWide'),
                  })}
                </span>
              ) : null}
            </div>
          </form>
        </Card>
      )}
    </div>
  );
}
