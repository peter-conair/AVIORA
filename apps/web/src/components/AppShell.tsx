'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Link, usePathname, useRouter } from '@/i18n/navigation';
import { api, getTenantId, setTenantId } from '@/lib/api-client';
import { isPlatformAdmin, type AuthUser, type MeResponse, type TenantSummary } from '@/lib/types';
import { NotificationBell } from '@/components/NotificationBell';
import { NavIcon } from '@/components/NavIcon';
import { HOME, visibleGroups, visibleTabs, type NavItem } from '@/lib/navigation';

interface AppShellProps {
  children: ReactNode;
}

interface BrandingResponse {
  branding?: {
    appName?: string | null;
    hiddenFeatures?: string[];
    colors?: Record<string, string> | null;
    fontStack?: string | null;
  };
}

/**
 * A tenant's colours become CSS custom properties on the shell, and nothing
 * else. They are DATA — validated colour values — so they can be set as
 * variables; a tenant never supplies a stylesheet, because a stylesheet is
 * code running in another member's browser (docs/29 §1).
 */
function brandStyle(
  colors: Record<string, string> | null | undefined,
  fontStack: string | null | undefined,
): React.CSSProperties {
  const style: Record<string, string> = {};
  for (const [token, value] of Object.entries(colors ?? {})) {
    style[`--brand-${token}`] = value;
  }
  if (fontStack) style['--brand-font'] = fontStack;
  return style as React.CSSProperties;
}

/** Longest match wins, so /orders does not light up while you are on /orders/3. */
function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppShell({ children }: AppShellProps) {
  const t = useTranslations('shell');
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();

  const [user, setUser] = useState<AuthUser | null>(null);
  const [tenants, setTenants] = useState<TenantSummary[]>([]);
  const [selectedTenant, setSelectedTenant] = useState<string>('');
  const [ready, setReady] = useState(false);
  const [hidden, setHidden] = useState<string[]>([]);
  const [appName, setAppName] = useState<string | null>(null);
  const [colors, setColors] = useState<Record<string, string> | null>(null);
  const [fontStack, setFontStack] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

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

  // Branding decides which entries are OFFERED. It never decides what is
  // permitted — a hidden route still answers if typed (docs/29 §1).
  useEffect(() => {
    let cancelled = false;
    api
      .get<BrandingResponse>('/tenant/branding')
      .then((data) => {
        if (cancelled) return;
        setHidden(data.branding?.hiddenFeatures ?? []);
        setAppName(data.branding?.appName ?? null);
        setColors(data.branding?.colors ?? null);
        setFontStack(data.branding?.fontStack ?? null);
      })
      .catch(() => {
        // A tenant that has never opened the branding screen simply hides nothing.
      });
    return () => {
      cancelled = true;
    };
  }, [selectedTenant]);

  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    menuButtonRef.current?.focus();
  }, []);

  // The menu is a layer over the page: Escape closes it, and the page behind
  // must not scroll underneath a sheet somebody is reading.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMenu();
    };
    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    menuRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [menuOpen, closeMenu]);

  // Navigating away closes it. Leaving a sheet open over a new page is the
  // small rudeness that makes an app feel unfinished.
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

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
  const groups = visibleGroups(hidden, isPlatformAdmin(user));
  const tabs = visibleTabs(hidden);

  const label = (item: NavItem) => t(`nav.${item.key}`);

  const sideLink = (item: NavItem) => {
    const active = isActive(pathname, item.href);
    return (
      <Link
        key={item.key}
        href={item.href}
        aria-current={active ? 'page' : undefined}
        className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
          active
            ? 'bg-brand-50 font-semibold text-brand-800'
            : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
        }`}
      >
        <NavIcon name={item.icon} className="h-4 w-4 shrink-0" />
        <span className="truncate">{label(item)}</span>
      </Link>
    );
  };

  return (
    <div
      className="min-h-screen bg-slate-50 [font-family:var(--brand-font,inherit)]"
      style={brandStyle(colors, fontStack)}
    >
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-3">
          <Link
            href={HOME.href}
            className="truncate text-lg font-bold tracking-tight text-brand-700 [color:var(--brand-primary,currentColor)]"
          >
            {appName ?? 'AVIORA'}
          </Link>
          <div className="ml-auto flex min-w-0 items-center gap-1.5">
            {user ? <NotificationBell /> : null}
            {tenants.length > 1 ? (
              <select
                aria-label={t('tenant')}
                value={selectedTenant}
                onChange={(e) => handleTenantChange(e.target.value)}
                className="max-w-[8.5rem] truncate rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-700 focus:outline-none focus:ring-2 focus:ring-brand-600"
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
              className="hidden rounded-lg px-2 py-1.5 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-800 sm:block"
            >
              {t('signOut')}
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-6xl gap-6 px-4 py-6">
        {/* Wide screens have room to show the whole map at once. */}
        <nav aria-label={t('primaryNav')} className="hidden w-56 shrink-0 md:block">
          <div className="sticky top-20 space-y-5">
            <div>{sideLink(HOME)}</div>
            {groups.map((group) => (
              <div key={group.key}>
                <p className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
                  {t(`groups.${group.key}`)}
                </p>
                <div className="space-y-0.5">{group.items.map(sideLink)}</div>
              </div>
            ))}
          </div>
        </nav>

        {/* pb-24 on small screens keeps the bottom bar off the last paragraph. */}
        <main className="min-w-0 flex-1 pb-24 md:pb-0">
          {ready ? (
            children
          ) : (
            <p className="py-10 text-center text-sm text-slate-500">{t('loading')}</p>
          )}
        </main>
      </div>

      {/* Phone: four thumb-reachable destinations, and everything else one tap away. */}
      <nav
        aria-label={t('primaryNav')}
        className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        <div className="mx-auto flex max-w-lg items-stretch">
          {tabs.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.key}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={`flex flex-1 flex-col items-center gap-0.5 px-1 py-2 text-[11px] font-medium ${
                  active
                    ? 'text-brand-700 [color:var(--brand-primary,currentColor)]'
                    : 'text-slate-500'
                }`}
              >
                <NavIcon name={item.icon} />
                <span className="w-full truncate text-center">{label(item)}</span>
              </Link>
            );
          })}
          <button
            ref={menuButtonRef}
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-expanded={menuOpen}
            aria-haspopup="dialog"
            className={`flex flex-1 flex-col items-center gap-0.5 px-1 py-2 text-[11px] font-medium ${
              menuOpen ? 'text-brand-700' : 'text-slate-500'
            }`}
          >
            <NavIcon name={menuOpen ? 'close' : 'menu'} />
            <span className="w-full truncate text-center">{t('menu')}</span>
          </button>
        </div>
      </nav>

      {menuOpen ? (
        <div className="fixed inset-0 z-40 md:hidden">
          <button
            type="button"
            aria-label={t('closeMenu')}
            onClick={closeMenu}
            className="absolute inset-0 bg-slate-900/40"
          />
          <div
            ref={menuRef}
            role="dialog"
            aria-modal="true"
            aria-label={t('primaryNav')}
            tabIndex={-1}
            className="absolute inset-x-0 bottom-0 max-h-[80vh] overflow-y-auto rounded-t-2xl bg-white pb-[calc(env(safe-area-inset-bottom)+1rem)] shadow-xl focus:outline-none"
          >
            <div className="sticky top-0 flex items-center justify-between border-b border-slate-100 bg-white px-4 py-3">
              <p className="text-sm font-semibold text-slate-800">{t('menu')}</p>
              <button
                type="button"
                onClick={closeMenu}
                className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100"
                aria-label={t('closeMenu')}
              >
                <NavIcon name="close" />
              </button>
            </div>
            <div className="space-y-5 px-4 py-4">
              {groups.map((group) => (
                <section key={group.key}>
                  <p className="flex items-center gap-2 pb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                    <NavIcon name={group.icon} className="h-4 w-4" />
                    {t(`groups.${group.key}`)}
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    {group.items.map((item) => {
                      const active = isActive(pathname, item.href);
                      return (
                        <Link
                          key={item.key}
                          href={item.href}
                          aria-current={active ? 'page' : undefined}
                          className={`flex items-center gap-2 rounded-xl border px-3 py-2.5 text-sm font-medium ${
                            active
                              ? 'border-brand-600 bg-brand-50 text-brand-800'
                              : 'border-slate-200 text-slate-700 hover:bg-slate-50'
                          }`}
                        >
                          <NavIcon name={item.icon} className="h-4 w-4 shrink-0" />
                          <span className="truncate">{label(item)}</span>
                        </Link>
                      );
                    })}
                  </div>
                </section>
              ))}
              <button
                type="button"
                onClick={handleSignOut}
                className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50 sm:hidden"
              >
                {t('signOut')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
