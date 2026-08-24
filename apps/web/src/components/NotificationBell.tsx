'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Link, useRouter } from '@/i18n/navigation';
import { api, isForbidden } from '@/lib/api-client';
import type { AppNotification, NotificationsResponse } from '@/lib/types';
import { formatRelativeTime } from '@/lib/format';

const POLL_INTERVAL_MS = 60_000;

export function NotificationBell() {
  const t = useTranslations('notifications');
  const tc = useTranslations('common');
  const locale = useLocale();
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  /** Badge poll — unread only, cheap enough to run on a timer. */
  const loadUnread = useCallback(async () => {
    try {
      const res = await api.get<NotificationsResponse>('/notifications?unread=true');
      setUnreadCount(res.unreadCount);
      setNotifications((current) => (current.length === 0 ? res.notifications : current));
      setUnavailable(false);
    } catch (err: unknown) {
      // Out of scope or transient — degrade to a silent bell rather than breaking the shell.
      if (isForbidden(err)) setUnavailable(true);
    }
  }, []);

  useEffect(() => {
    void loadUnread();
    const timer = window.setInterval(() => void loadUnread(), POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [loadUnread]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  const handleToggle = async () => {
    const next = !open;
    setOpen(next);
    if (!next) return;
    setLoading(true);
    try {
      // The panel shows recent history, not just unread items.
      const res = await api.get<NotificationsResponse>('/notifications');
      setNotifications(res.notifications);
      setUnreadCount(res.unreadCount);
      setUnavailable(false);
    } catch (err: unknown) {
      if (isForbidden(err)) setUnavailable(true);
    } finally {
      setLoading(false);
    }
  };

  const handleOpenNotification = async (notification: AppNotification) => {
    setOpen(false);
    if (!notification.readAt) {
      setNotifications((current) =>
        current.map((n) =>
          n.id === notification.id ? { ...n, readAt: new Date().toISOString() } : n,
        ),
      );
      setUnreadCount((count) => Math.max(0, count - 1));
      try {
        await api.patch(`/notifications/${notification.id}/read`);
      } catch {
        // Best effort — the poll re-syncs the count within a minute.
      }
    }
    if (notification.link) {
      if (/^https?:\/\//.test(notification.link)) window.location.assign(notification.link);
      else router.push(notification.link);
    }
  };

  const handleMarkAllRead = async () => {
    setNotifications((current) =>
      current.map((n) => (n.readAt ? n : { ...n, readAt: new Date().toISOString() })),
    );
    setUnreadCount(0);
    try {
      await api.post('/notifications/read-all');
    } catch {
      // Best effort — the next poll restores the true count.
    }
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => void handleToggle()}
        aria-label={unreadCount > 0 ? t('unreadCount', { count: unreadCount }) : t('bell')}
        aria-expanded={open}
        aria-haspopup="true"
        className="relative rounded-lg p-1.5 text-slate-600 hover:bg-slate-100 hover:text-slate-800"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-5 w-5"
        >
          <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.7 21a2 2 0 0 1-3.4 0" />
        </svg>
        {unreadCount > 0 ? (
          <span className="absolute -right-0.5 -top-0.5 min-w-[1.1rem] rounded-full bg-brand-700 px-1 text-[0.65rem] font-bold leading-[1.1rem] text-white">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        ) : null}
      </button>

      {open ? (
        <>
          <button
            type="button"
            aria-label={t('close')}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-10 cursor-default"
          />
          <div
            role="region"
            aria-label={t('title')}
            // On narrow screens the bell sits too far left for a right-anchored
            // panel to fit, so the panel spans the viewport instead; from sm up
            // it hangs off the bell as a normal dropdown.
            className="fixed inset-x-4 top-16 z-20 rounded-xl border border-slate-200 bg-white shadow-lg sm:absolute sm:inset-x-auto sm:end-0 sm:top-auto sm:mt-2 sm:w-80"
          >
            <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-3 py-2">
              <h2 className="text-sm font-semibold text-slate-900">{t('title')}</h2>
              <button
                type="button"
                onClick={() => void handleMarkAllRead()}
                disabled={unreadCount === 0}
                className="text-xs font-medium text-brand-700 hover:underline disabled:text-slate-400 disabled:no-underline"
              >
                {t('markAllRead')}
              </button>
            </div>

            <div className="max-h-80 overflow-y-auto">
              {unavailable ? (
                <p className="px-3 py-4 text-sm text-slate-500">{t('unavailable')}</p>
              ) : loading ? (
                <p className="px-3 py-4 text-sm text-slate-500">{tc('loading')}</p>
              ) : notifications.length === 0 ? (
                <p className="px-3 py-4 text-sm text-slate-500">{t('empty')}</p>
              ) : (
                <ul className="flex flex-col divide-y divide-slate-100">
                  {notifications.map((notification) => (
                    <li key={notification.id}>
                      <button
                        type="button"
                        onClick={() => void handleOpenNotification(notification)}
                        className={`flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-slate-50 ${
                          notification.readAt ? '' : 'bg-brand-50/60'
                        }`}
                      >
                        <span className="flex items-center gap-2">
                          {notification.readAt ? null : (
                            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-brand-700" />
                          )}
                          <span className="text-sm font-medium text-slate-800">
                            {notification.title}
                          </span>
                        </span>
                        {notification.body ? (
                          <span className="text-xs text-slate-600">{notification.body}</span>
                        ) : null}
                        <span className="text-xs text-slate-400">
                          {formatRelativeTime(notification.createdAt, locale)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="border-t border-slate-100 px-3 py-2">
              <Link
                href="/settings/notifications"
                onClick={() => setOpen(false)}
                className="text-xs font-medium text-brand-700 hover:underline"
              >
                {t('preferences')}
              </Link>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
