'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { api, ApiError } from '@/lib/api-client';
import type {
  EntitlementCatalogItem,
  EntitlementCatalogResponse,
  MembershipPlan,
  PlansResponse,
} from '@/lib/types';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';

export function PlansTab() {
  const t = useTranslations('admin.plans');
  const tc = useTranslations('common');

  const [plans, setPlans] = useState<MembershipPlan[]>([]);
  const [catalog, setCatalog] = useState<EntitlementCatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [trialDays, setTrialDays] = useState('');
  const [price, setPrice] = useState('');
  const [billingCycle, setBillingCycle] = useState('');
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.get<PlansResponse>('/membership-plans'),
      api.get<EntitlementCatalogResponse>('/membership-plans/entitlements/catalog'),
    ])
      .then(([plansRes, catalogRes]) => {
        if (cancelled) return;
        setPlans(plansRes.plans);
        setCatalog(catalogRes.entitlements);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleKey = (key: string) =>
    setSelectedKeys((keys) =>
      keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key],
    );

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setCreated(false);
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = { code, name };
      if (trialDays !== '') body.trialDays = Number(trialDays);
      if (price !== '') body.price = Number(price);
      if (billingCycle !== '') body.billingCycle = billingCycle;
      if (selectedKeys.length > 0) body.entitlementKeys = selectedKeys;
      await api.post('/membership-plans', body);
      setCreated(true);
      setCode('');
      setName('');
      setTrialDays('');
      setPrice('');
      setBillingCycle('');
      setSelectedKeys([]);
      const plansRes = await api.get<PlansResponse>('/membership-plans');
      setPlans(plansRes.plans);
    } catch (err: unknown) {
      setFormError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      <Card title={t('listTitle')}>
        {loading ? (
          <p className="text-sm text-slate-500">{tc('loading')}</p>
        ) : plans.length === 0 ? (
          <p className="text-sm text-slate-500">{t('empty')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-slate-100">
            {plans.map((plan) => (
              <li key={plan.id} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-slate-800">{plan.name}</span>
                  <span className="font-mono text-xs text-slate-400">{plan.code}</span>
                </div>
                <p className="text-xs text-slate-500">
                  {t('summary', {
                    trialDays: plan.trialDays,
                    price: plan.price ?? '—',
                    cycle: plan.billingCycle ?? '—',
                  })}
                </p>
                {plan.planEntitlements.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {plan.planEntitlements.map((pe) => (
                      <Badge key={pe.entitlement.key} tone="teal">
                        {pe.entitlement.key}
                      </Badge>
                    ))}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={t('formTitle')}>
        {created ? (
          <p className="mb-4 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800 ring-1 ring-inset ring-green-600/20">
            {t('created')}
          </p>
        ) : null}
        <form onSubmit={handleSubmit} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input
            label={t('code')}
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <Input
            label={t('name')}
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Input
            label={t('trialDays')}
            type="number"
            min={0}
            value={trialDays}
            onChange={(e) => setTrialDays(e.target.value)}
          />
          <Input
            label={t('price')}
            type="number"
            min={0}
            step="0.01"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
          <Input
            label={t('billingCycle')}
            placeholder={t('billingCyclePlaceholder')}
            value={billingCycle}
            onChange={(e) => setBillingCycle(e.target.value)}
          />
          <fieldset className="sm:col-span-2">
            <legend className="mb-2 text-sm font-medium text-slate-700">{t('entitlements')}</legend>
            {catalog.length === 0 ? (
              <p className="text-xs text-slate-500">{t('noEntitlements')}</p>
            ) : (
              <div className="flex flex-col gap-2">
                {catalog.map((item) => (
                  <label key={item.key} className="flex items-start gap-2 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-700 focus:ring-brand-600"
                      checked={selectedKeys.includes(item.key)}
                      onChange={() => toggleKey(item.key)}
                    />
                    <span>
                      <span className="font-mono text-xs">{item.key}</span>
                      {item.description ? (
                        <span className="block text-xs text-slate-500">{item.description}</span>
                      ) : null}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </fieldset>
          {formError ? <p className="text-sm text-red-600 sm:col-span-2">{formError}</p> : null}
          <div>
            <Button type="submit" disabled={submitting}>
              {submitting ? tc('saving') : t('submit')}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
