'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { api, ApiError, isForbidden } from '@/lib/api-client';
import type { CrmCustomer, CrmCustomersResponse } from '@/lib/types';
import { Badge, statusTone } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { formatDate } from '@/lib/format';

export function CustomersTab() {
  const t = useTranslations('crm');
  const tc = useTranslations('common');
  const locale = useLocale();

  const [customers, setCustomers] = useState<CrmCustomer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .get<CrmCustomersResponse>('/crm/customers')
      .then((res) => {
        if (!cancelled) setCustomers(res.customers);
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

  if (forbidden) {
    return (
      <Card>
        <p className="text-sm text-slate-600">{t('forbidden')}</p>
      </Card>
    );
  }

  return (
    <Card title={t('customers.title')}>
      {error ? <p className="mb-2 text-sm text-red-600">{error}</p> : null}
      {loading ? (
        <p className="text-sm text-slate-500">{tc('loading')}</p>
      ) : customers.length === 0 ? (
        <p className="text-sm text-slate-500">{t('customers.empty')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[32rem] text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-xs uppercase text-slate-500">
                <th className="py-2 pr-3">{t('customers.name')}</th>
                <th className="py-2 pr-3">{t('customers.email')}</th>
                <th className="py-2 pr-3">{t('customers.phone')}</th>
                <th className="py-2 pr-3">{t('customers.status')}</th>
                <th className="py-2">{t('customers.created')}</th>
              </tr>
            </thead>
            <tbody>
              {customers.map((customer) => (
                <tr key={customer.id} className="border-b border-slate-100 last:border-0">
                  <td className="py-2 pr-3 font-medium text-slate-800">{customer.name}</td>
                  <td className="py-2 pr-3 text-slate-600">{customer.email ?? '—'}</td>
                  <td className="py-2 pr-3 text-slate-600">{customer.phone ?? '—'}</td>
                  <td className="py-2 pr-3">
                    <Badge tone={statusTone(customer.status)}>{customer.status}</Badge>
                  </td>
                  <td className="py-2 text-slate-500">{formatDate(customer.createdAt, locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
