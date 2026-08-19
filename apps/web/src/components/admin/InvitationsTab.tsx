'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { api, ApiError } from '@/lib/api-client';
import type { Invitation, InvitationsResponse, MembershipPlan, PlansResponse } from '@/lib/types';
import { Badge, statusTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { formatDate } from '@/lib/format';

export function InvitationsTab() {
  const t = useTranslations('admin.invitations');
  const tc = useTranslations('common');
  const locale = useLocale();

  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [plans, setPlans] = useState<MembershipPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [email, setEmail] = useState('');
  const [planId, setPlanId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [createdEmail, setCreatedEmail] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.get<InvitationsResponse>('/invitations'),
      api.get<PlansResponse>('/membership-plans'),
    ])
      .then(([invRes, plansRes]) => {
        if (cancelled) return;
        setInvitations(invRes.invitations);
        setPlans(plansRes.plans);
        if (plansRes.plans.length > 0) setPlanId(plansRes.plans[0].id);
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

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setCreatedEmail(null);
    setSubmitting(true);
    try {
      const { invitation } = await api.post<{ invitation: Invitation }>('/invitations', {
        email,
        planId,
      });
      setCreatedEmail(invitation.email);
      setInvitations((list) => [invitation, ...list]);
      setEmail('');
    } catch (err: unknown) {
      setFormError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      <Card title={t('formTitle')}>
        {createdEmail ? (
          <p className="mb-4 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800 ring-1 ring-inset ring-green-600/20">
            {t('created', { email: createdEmail })}
          </p>
        ) : null}
        <form onSubmit={handleSubmit} className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Input
            label={t('email')}
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Select
            label={t('plan')}
            required
            value={planId}
            onChange={(e) => setPlanId(e.target.value)}
          >
            {plans.map((plan) => (
              <option key={plan.id} value={plan.id}>
                {plan.name}
              </option>
            ))}
          </Select>
          <div className="flex items-end">
            <Button type="submit" disabled={submitting || plans.length === 0}>
              {submitting ? tc('saving') : t('submit')}
            </Button>
          </div>
          {formError ? <p className="text-sm text-red-600 sm:col-span-3">{formError}</p> : null}
        </form>
      </Card>

      <Card title={t('listTitle')}>
        {loading ? (
          <p className="text-sm text-slate-500">{tc('loading')}</p>
        ) : invitations.length === 0 ? (
          <p className="text-sm text-slate-500">{t('empty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[26rem] text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs uppercase text-slate-500">
                  <th className="py-2 pr-3">{t('email')}</th>
                  <th className="py-2 pr-3">{t('status')}</th>
                  <th className="py-2">{t('expires')}</th>
                </tr>
              </thead>
              <tbody>
                {invitations.map((inv) => (
                  <tr key={inv.id} className="border-b border-slate-100 last:border-0">
                    <td className="py-2 pr-3 text-slate-800">{inv.email}</td>
                    <td className="py-2 pr-3">
                      <Badge tone={statusTone(inv.status)}>{inv.status}</Badge>
                    </td>
                    <td className="py-2 text-slate-500">{formatDate(inv.expiresAt, locale)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
