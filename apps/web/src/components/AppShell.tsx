'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Link, usePathname, useRouter } from '@/i18n/navigation';
import { api, getTenantId, setTenantId } from '@/lib/api-client';
import { isPlatformAdmin, type AuthUser, type MeResponse, type TenantSummary } from '@/lib/types';
import { NotificationBell } from '@/components/NotificationBell';

interface AppShellProps {
  children: ReactNode;
}

interface NavItem {
  href: string;
  key:
    | 'dashboard'
    | 'goals'
    | 'learning'
    | 'knowledge'
    | 'assistant'
    | 'crm'
    | 'followUps'
    | 'teams'
    | 'leader'
    | 'admin'
    | 'platform';
}

const BASE_NAV: NavItem[] = [
  { href: '/dashboard', key: 'dashboard' },
  { href: '/goals', key: 'goals' },
  { href: '/learning', key: 'learning' },
  { href: '/knowledge', key: 'knowledge' },
  { href: '/assistant', key: 'assistant' },
  { href: '/crm', key: 'crm' },
  { href: '/follow-ups', key: 'followUps' },
  { href: '/teams', key: 'teams' },
  { href: '/leader', key: 'leader' },
  { href: '/admin', key: 'admin' },
];

export function AppShell({ children }: AppShellProps) {
  const t = useTranslations('shell');
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();

  const [user, setUser] = useState<AuthUser | null>(null);
  const [tenants, setTenants] = useState<TenantSummary[]>([]);
  const [selectedTenant, setSelectedTenant] = useState<string>('');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .get<MeResponse>('/auth/me')
      .then((data) => {
        if (cancelled) return;
        setUser(data.user);
        setTenants(data.tenants);
        const stored = getTenantId();
        const valid = data.tenants.some((tn) => tn.tenantId === stored);
        if (valid && stored) {
          setSelectedTenant(stored);
        } else if (data.tenants.length > 0) {
          setTenantId(data.tenants[0].tenantId);
          setSelectedTenant(data.tenants[0].tenantId);
        }
        setReady(true);
      })
      .catch(() => {
        // 401 handling (refresh + redirect) is done inside the api client.
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleTenantChange = (tenantId: string) => {
    setTenantId(tenantId);
    setSelectedTenant(tenantId);
    // Full reload so every page refetches with the new tenant scope.
    window.location.reload();
  };

  const handleSignOut = async () => {
    try {
      await api.post('/auth/logout');
    } catch {
      // Ignore — cookies may already be gone.
    }
    setTenantId(null);
    router.push('/sign-in');
  };

  const otherLocale = locale === 'th' ? 'en' : 'th';
  const nav: NavItem[] = isPlatformAdmin(user)
    ? [...BASE_NAV, { href: '/platform', key: 'platform' }]
    : BASE_NAV;

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
          <Link href="/dashboard" className="text-lg font-bold tracking-tight text-teal-700">
            AVIORA
          </Link>
          <div className="ml-auto flex items-center gap-2">
            {user ? <NotificationBell /> : null}
            {tenants.length > 0 ? (
              <select
                aria-label={t('tenant')}
                value={selectedTenant}
                onChange={(e) => handleTenantChange(e.target.value)}
                className="max-w-[10rem] rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-700 focus:outline-none focus:ring-2 focus:ring-teal-600"
              >
                {tenants.map((tn) => (
                  <option key={tn.tenantId} value={tn.tenantId}>
                    {tn.name}
                  </option>
                ))}
              </select>
            ) : null}
            <button
              type="button"
              onClick={() => router.replace(pathname, { locale: otherLocale })}
              className="rounded-lg border border-slate-300 px-2 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
              aria-label={t('language')}
            >
              {otherLocale === 'th' ? 'ไทย' : 'EN'}
            </button>
            <button
              type="button"
              onClick={handleSignOut}
              className="rounded-lg px-2 py-1.5 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-800"
            >
              {t('signOut')}
            </button>
          </div>
        </div>
        <nav className="mx-auto flex max-w-5xl gap-1 overflow-x-auto px-4 pb-2">
          {nav.map((item) => {
            const active = pathname.startsWith(item.href);
            return (
              <Link
                key={item.key}
                href={item.href}
                className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium ${
                  active ? 'bg-teal-700 text-white' : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                {t(`nav.${item.key}`)}
              </Link>
            );
          })}
        </nav>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6">
        {ready ? (
          children
        ) : (
          <p className="py-10 text-center text-sm text-slate-500">{t('loading')}</p>
        )}
      </main>
    </div>
  );
}
