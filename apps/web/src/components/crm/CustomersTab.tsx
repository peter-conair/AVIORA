'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { api, ApiError, isForbidden } from '@/lib/api-client';
import type { CrmCustomer, CrmCustomersResponse } from '@/lib/types';
import { Badge, statusTone } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { CustomerCard } from './CustomerCard';
import { formatDate } from '@/lib/format';

export function CustomersTab() {
  const t = useTranslations('crm');
  const tc = useTranslations('common');
  const locale = useLocale();

  const [customers, setCustomers] = useState<CrmCustomer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  /** The index card opens under the row, so the list stays the way in. */
  const [openId, setOpenId] = useState<string | null>(null);

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
                  <td className="py-2 pr-3 font-medium text-slate-800">
                    <button
                      type="button"
                      onClick={() => setOpenId(openId === customer.id ? null : customer.id)}
                      aria-expanded={openId === customer.id}
                      className="text-left underline-offset-2 hover:underline"
                    >
                      {customer.name}
                    </button>
                  </td>
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
      {/* The card opens under the list rather than on a page of its own: the
          list is how somebody finds a customer, and losing it to navigate back
          is the friction that stops cards being kept up to date. */}
      {openId ? (
        <div className="mt-4">
          <CustomerCard customerId={openId} />
        </div>
      ) : null}
    </Card>
  );
}
