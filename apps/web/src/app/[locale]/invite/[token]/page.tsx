'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { api, ApiError, setTenantId } from '@/lib/api-client';
import type { AcceptInvitationResponse, InvitationPublicInfo } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { formatDate } from '@/lib/format';

const MIN_PASSWORD_LENGTH = 10;

export default function InvitePage() {
  const t = useTranslations('invite');
  const tc = useTranslations('common');
  const locale = useLocale();
  const router = useRouter();
  const params = useParams<{ token: string }>();
  const token = params.token;

  const [info, setInfo] = useState<InvitationPublicInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ invitation: InvitationPublicInfo }>(`/invitations/${token}`)
      .then((data) => {
        if (!cancelled) setInfo(data.invitation);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(
          err instanceof ApiError && err.status !== 500 ? t('invalid') : tc('errorGeneric'),
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setPasswordError(null);
    setSubmitError(null);
    if (password.length < MIN_PASSWORD_LENGTH) {
      setPasswordError(t('passwordTooShort'));
      return;
    }
    setSubmitting(true);
    try {
      const result = await api.post<AcceptInvitationResponse>(`/invitations/${token}/accept`, {
        displayName,
        password,
      });
      setTenantId(result.tenantId);
      router.push('/sign-in?accepted=1');
    } catch (err: unknown) {
      setSubmitError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center gap-4 px-4 py-8">
      <div className="text-center">
        <h1 className="text-3xl font-bold tracking-tight text-teal-700">AVIORA</h1>
      </div>

      {loading ? (
        <p className="text-center text-sm text-slate-500">{t('loading')}</p>
      ) : loadError ? (
        <Card>
          <p className="text-sm text-red-600">{loadError}</p>
        </Card>
      ) : info ? (
        <Card title={t('title', { tenant: info.tenantName })}>
          <dl className="mb-4 flex flex-col gap-1 text-sm">
            <div className="flex justify-between gap-2">
              <dt className="text-slate-500">{t('plan')}</dt>
              <dd className="font-medium text-slate-800">{info.planName}</dd>
            </div>
            {info.trialDays > 0 ? (
              <div className="flex justify-between gap-2">
                <dt className="text-slate-500">{t('trial')}</dt>
                <dd className="font-medium text-slate-800">
                  {t('trialDays', { days: info.trialDays })}
                </dd>
              </div>
            ) : null}
            <div className="flex justify-between gap-2">
              <dt className="text-slate-500">{t('expires')}</dt>
              <dd className="font-medium text-slate-800">{formatDate(info.expiresAt, locale)}</dd>
            </div>
          </dl>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <Input label={t('email')} type="email" value={info.email} readOnly disabled />
            <Input
              label={t('displayName')}
              required
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
            <Input
              label={t('password')}
              type="password"
              autoComplete="new-password"
              required
              minLength={MIN_PASSWORD_LENGTH}
              hint={t('passwordHint')}
              error={passwordError ?? undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {submitError ? <p className="text-sm text-red-600">{submitError}</p> : null}
            <Button type="submit" disabled={submitting}>
              {submitting ? t('submitting') : t('submit')}
            </Button>
          </form>
        </Card>
      ) : null}
    </main>
  );
}
