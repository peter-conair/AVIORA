'use client';

import { Suspense, useState, type FormEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { api, ApiError, setTenantId } from '@/lib/api-client';
import {
  isPlatformAdmin,
  type LoginResponse,
  type MeResponse,
  type TenantSummary,
} from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { DevUserPicker } from '@/components/dev/DevUserPicker';

function SignInForm() {
  const t = useTranslations('auth');
  const tc = useTranslations('common');
  const router = useRouter();
  const searchParams = useSearchParams();
  const accepted = searchParams.get('accepted') === '1';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tenantChoices, setTenantChoices] = useState<TenantSummary[] | null>(null);

  /**
   * Where a freshly signed-in caller belongs — asked once, of the server.
   *
   * Shared with the developer picker on purpose: a shortcut that lands
   * somewhere the real form would not is a shortcut that hides the bug you
   * were about to look for.
   */
  const routeAfterSignIn = async () => {
    const me = await api.get<MeResponse>('/auth/me');
    if (isPlatformAdmin(me.user)) {
      router.push('/platform');
      return;
    }
    if (me.tenants.length === 1) {
      setTenantId(me.tenants[0].tenantId);
      router.push('/dashboard');
      return;
    }
    setTenantChoices(me.tenants);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.post<LoginResponse>('/auth/login', { email, password });
      await routeAfterSignIn();
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 401) {
        setError(t('invalidCredentials'));
      } else if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError(tc('errorGeneric'));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handlePickTenant = (tenantId: string) => {
    setTenantId(tenantId);
    router.push('/dashboard');
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center gap-4 px-4 py-8">
      <div className="text-center">
        <h1 className="text-3xl font-bold tracking-tight text-brand-700">AVIORA</h1>
        <p className="mt-1 text-sm text-slate-500">{t('title')}</p>
      </div>

      {accepted ? (
        <p className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800 ring-1 ring-inset ring-green-600/20">
          {t('acceptedBanner')}
        </p>
      ) : null}

      {tenantChoices ? (
        <Card title={t('pickTenant')}>
          <p className="mb-3 text-sm text-slate-500">{t('pickTenantHint')}</p>
          {tenantChoices.length === 0 ? (
            <p className="text-sm text-slate-500">{t('noTenants')}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {tenantChoices.map((tn) => (
                <li key={tn.tenantId}>
                  <button
                    type="button"
                    onClick={() => handlePickTenant(tn.tenantId)}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-left text-sm font-medium text-slate-800 hover:border-brand-600 hover:bg-brand-50"
                  >
                    {tn.name}
                    <span className="block text-xs font-normal text-slate-400">{tn.slug}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : (
        <Card>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <Input
              label={t('email')}
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <Input
              label={t('password')}
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {error ? <p className="text-sm text-red-600">{error}</p> : null}
            <Button type="submit" disabled={submitting}>
              {submitting ? t('signingIn') : t('submit')}
            </Button>
          </form>
        </Card>
      )}

      {/* Compiled away entirely in a production build: `NODE_ENV` is inlined at
          build time, so the picker and its request never reach the bundle. The
          API keeps its own flag regardless — this only decides whether to ask. */}
      {process.env.NODE_ENV !== 'production' && !tenantChoices ? (
        <DevUserPicker onSignedIn={routeAfterSignIn} />
      ) : null}
    </main>
  );
}

export default function SignInPage() {
  return (
    <Suspense>
      <SignInForm />
    </Suspense>
  );
}
