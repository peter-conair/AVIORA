'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { api, ApiError } from '@/lib/api-client';
import {
  isPlatformAdmin,
  type CreateTenantResponse,
  type MeResponse,
  type PlatformTenant,
  type TenantsResponse,
} from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { PlatformAnalyticsSection } from '@/components/analytics/PlatformAnalyticsSection';

interface TenantFormState {
  code: string;
  name: string;
  slug: string;
  adminEmail: string;
  adminDisplayName: string;
  adminPassword: string;
  defaultLanguage: string;
}

const EMPTY_FORM: TenantFormState = {
  code: '',
  name: '',
  slug: '',
  adminEmail: '',
  adminDisplayName: '',
  adminPassword: '',
  defaultLanguage: 'th',
};

export default function PlatformPage() {
  const t = useTranslations('platform');
  const tc = useTranslations('common');
  const router = useRouter();

  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [tenants, setTenants] = useState<PlatformTenant[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [form, setForm] = useState<TenantFormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreateTenantResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<MeResponse>('/auth/me')
      .then((me) => {
        if (cancelled) return;
        if (!isPlatformAdmin(me.user)) {
          router.replace('/dashboard');
          return;
        }
        setAllowed(true);
        return api.get<TenantsResponse>('/platform/tenants').then((data) => {
          if (!cancelled) setTenants(data.tenants);
        });
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof ApiError ? err.message : tc('errorGeneric'));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const update = (field: keyof TenantFormState, value: string) =>
    setForm((f) => ({ ...f, [field]: value }));

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitError(null);
    setCreated(null);
    setSubmitting(true);
    try {
      const result = await api.post<CreateTenantResponse>('/platform/tenants', form);
      setCreated(result);
      setForm(EMPTY_FORM);
      const data = await api.get<TenantsResponse>('/platform/tenants');
      setTenants(data.tenants);
    } catch (err: unknown) {
      setSubmitError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setSubmitting(false);
    }
  };

  if (loadError) {
    return <p className="text-sm text-red-600">{loadError}</p>;
  }
  if (allowed === null) {
    return <p className="py-10 text-center text-sm text-slate-500">{t('checking')}</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-bold text-slate-900">{t('title')}</h1>

      {/* Cross-tenant measures, gated on the platform ROLE this page already
          checked — and checked again by the API (docs/28 §1). */}
      <PlatformAnalyticsSection />

      <Card title={t('tenantsTitle')}>
        {tenants.length === 0 ? (
          <p className="text-sm text-slate-500">{t('empty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[28rem] text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs uppercase text-slate-500">
                  <th className="py-2 pr-3">{t('code')}</th>
                  <th className="py-2 pr-3">{t('name')}</th>
                  <th className="py-2">{t('slug')}</th>
                </tr>
              </thead>
              <tbody>
                {tenants.map((tenant) => (
                  <tr key={tenant.id} className="border-b border-slate-100 last:border-0">
                    <td className="py-2 pr-3 font-mono text-xs text-slate-600">
                      {tenant.code ?? '—'}
                    </td>
                    <td className="py-2 pr-3 font-medium text-slate-800">{tenant.name}</td>
                    <td className="py-2 text-slate-500">{tenant.slug}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title={t('formTitle')}>
        {created ? (
          <p className="mb-4 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800 ring-1 ring-inset ring-green-600/20">
            {t('created', { name: created.tenant.name, id: created.adminUserId })}
          </p>
        ) : null}
        <form onSubmit={handleSubmit} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input
            label={t('code')}
            required
            value={form.code}
            onChange={(e) => update('code', e.target.value)}
          />
          <Input
            label={t('name')}
            required
            value={form.name}
            onChange={(e) => update('name', e.target.value)}
          />
          <Input
            label={t('slug')}
            required
            value={form.slug}
            onChange={(e) => update('slug', e.target.value)}
          />
          <Select
            label={t('defaultLanguage')}
            value={form.defaultLanguage}
            onChange={(e) => update('defaultLanguage', e.target.value)}
          >
            <option value="th">{t('languageTh')}</option>
            <option value="en">{t('languageEn')}</option>
          </Select>
          <Input
            label={t('adminEmail')}
            type="email"
            required
            value={form.adminEmail}
            onChange={(e) => update('adminEmail', e.target.value)}
          />
          <Input
            label={t('adminDisplayName')}
            required
            value={form.adminDisplayName}
            onChange={(e) => update('adminDisplayName', e.target.value)}
          />
          <Input
            label={t('adminPassword')}
            type="password"
            autoComplete="new-password"
            required
            minLength={10}
            value={form.adminPassword}
            onChange={(e) => update('adminPassword', e.target.value)}
          />
          <div className="flex items-end">
            <Button type="submit" disabled={submitting} className="w-full sm:w-auto">
              {submitting ? tc('saving') : t('submit')}
            </Button>
          </div>
          {submitError ? <p className="text-sm text-red-600 sm:col-span-2">{submitError}</p> : null}
        </form>
      </Card>
    </div>
  );
}
