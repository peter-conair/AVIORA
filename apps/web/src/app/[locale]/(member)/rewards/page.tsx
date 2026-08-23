'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { api, ApiError, isForbidden } from '@/lib/api-client';
import {
  isKnownGamificationEvent,
  levelProgressPercent,
  type GamificationLeaderboardResponse,
  type GamificationLeaderboardRow,
  type GamificationStanding,
  type MemberMeResponse,
} from '@/lib/types';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { formatDate } from '@/lib/format';

export default function RewardsPage() {
  const t = useTranslations('rewards');
  const te = useTranslations('events');
  const tc = useTranslations('common');
  const locale = useLocale();

  const [standing, setStanding] = useState<GamificationStanding | null>(null);
  const [leaderboard, setLeaderboard] = useState<GamificationLeaderboardRow[] | null>(null);
  const [myMemberId, setMyMemberId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    // Highlighting our own row needs our member id; without it the board still renders.
    api
      .get<MemberMeResponse>('/members/me')
      .then((res) => {
        if (!cancelled) setMyMemberId(res.member?.id ?? null);
      })
      .catch(() => undefined);

    // The tenant board is a separate read — it may be unavailable without the
    // member's own standing being unavailable too.
    api
      .get<GamificationLeaderboardResponse>('/gamification/leaderboard')
      .then((res) => {
        if (!cancelled) setLeaderboard(res.leaderboard);
      })
      .catch(() => {
        if (!cancelled) setLeaderboard(null);
      });

    api
      .get<GamificationStanding>('/gamification/me')
      .then((res) => {
        if (!cancelled) setStanding(res);
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

  const eventLabel = (eventName: string): string =>
    isKnownGamificationEvent(eventName) ? te(eventName) : eventName;

  if (forbidden) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-xl font-bold text-slate-900">{t('title')}</h1>
        <Card>
          <p className="text-sm text-slate-600">{t('forbidden')}</p>
        </Card>
      </div>
    );
  }

  const percent = standing ? levelProgressPercent(standing) : 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-bold text-slate-900">{t('title')}</h1>
        <p className="text-sm text-slate-500">{t('intro')}</p>
      </div>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      {loading ? (
        <p className="py-10 text-center text-sm text-slate-500">{tc('loading')}</p>
      ) : !standing ? (
        <Card>
          <p className="text-sm text-slate-500">{t('standingUnavailable')}</p>
        </Card>
      ) : (
        <>
          <Card title={t('standingTitle')}>
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <span className="text-2xl font-bold text-brand-700">
                  {t('points', { points: standing.points })}
                </span>
                <span className="text-sm text-slate-600">
                  {t('level', { level: standing.level })}
                </span>
              </div>
              <div
                className="h-2 w-full overflow-hidden rounded-full bg-slate-100"
                aria-hidden="true"
              >
                <div
                  className="h-full rounded-full bg-brand-700"
                  style={{ width: `${percent}%` }}
                />
              </div>
              <p className="text-xs text-slate-500">
                {t('toNextLevel', { points: standing.pointsToNextLevel })}
              </p>
            </div>
          </Card>

          <Card title={t('badgesTitle')}>
            {standing.badges.length === 0 ? (
              <p className="text-sm text-slate-500">{t('badgesEmpty')}</p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {standing.badges.map((badge) => (
                  <li
                    key={badge.badgeCode}
                    className="flex flex-col gap-0.5 rounded-lg bg-brand-50 px-3 py-2 ring-1 ring-inset ring-brand-600/20"
                  >
                    <span className="text-sm font-medium text-brand-800">{badge.badgeName}</span>
                    <span className="text-xs text-brand-700/80">
                      {t('awardedAt', { date: formatDate(badge.awardedAt, locale) })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title={t('recentTitle')}>
            {standing.recent.length === 0 ? (
              <p className="text-sm text-slate-500">{t('recentEmpty')}</p>
            ) : (
              <ul className="flex flex-col divide-y divide-slate-100">
                {standing.recent.map((entry, index) => (
                  <li
                    key={`${entry.eventName}-${entry.createdAt}-${index}`}
                    className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2"
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="text-sm text-slate-800">{eventLabel(entry.eventName)}</span>
                      <span className="text-xs text-slate-500">
                        {formatDate(entry.createdAt, locale)}
                      </span>
                    </span>
                    <Badge tone="teal">{t('pointsEarned', { points: entry.points })}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title={t('leaderboardTitle')}>
            <p className="mb-3 text-xs text-slate-500">{t('leaderboardHint')}</p>
            {leaderboard === null ? (
              <p className="text-sm text-slate-500">{t('leaderboardUnavailable')}</p>
            ) : leaderboard.length === 0 ? (
              <p className="text-sm text-slate-500">{t('leaderboardEmpty')}</p>
            ) : (
              <ol className="flex flex-col gap-1">
                {leaderboard.map((row) => {
                  const mine = !!myMemberId && row.memberId === myMemberId;
                  return (
                    <li
                      key={row.memberId}
                      className={`flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg px-2 py-1.5 ${
                        mine ? 'bg-brand-50 ring-1 ring-inset ring-brand-600/20' : ''
                      }`}
                    >
                      <span className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="text-xs font-semibold text-slate-400">{row.rank}</span>
                        <span className="min-w-0 break-words text-sm text-slate-800">
                          {row.displayName ?? t('unknownMember')}
                        </span>
                        {mine ? <Badge tone="teal">{t('you')}</Badge> : null}
                      </span>
                      <span className="text-sm font-semibold text-slate-900">
                        {t('points', { points: row.points })}
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
