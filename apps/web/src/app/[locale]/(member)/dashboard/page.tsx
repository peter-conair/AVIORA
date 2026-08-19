'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { api, ApiError } from '@/lib/api-client';
import type { DashboardResponse } from '@/lib/types';
import { Badge, statusTone } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { formatDate } from '@/lib/format';

export default function DashboardPage() {
  const t = useTranslations('dashboard');
  const tc = useTranslations('common');
  const locale = useLocale();

  const [data, setData] = useState<DashboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<DashboardResponse>('/dashboard/me')
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!data) return <p className="py-10 text-center text-sm text-slate-500">{tc('loading')}</p>;

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-bold text-slate-900">{t('title')}</h1>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card title={t('membership.title')}>
          {data.membership ? (
            <div className="flex flex-col gap-2 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="text-slate-500">{t('membership.plan')}</span>
                <span className="font-medium text-slate-800">{data.membership.planName}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-slate-500">{t('membership.status')}</span>
                <Badge tone={statusTone(data.membership.status)}>{data.membership.status}</Badge>
              </div>
              {data.membership.trialEndsAt ? (
                <p className="text-xs text-slate-500">
                  {t('membership.trialEnds', {
                    date: formatDate(data.membership.trialEndsAt, locale),
                  })}
                </p>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-slate-500">{t('membership.none')}</p>
          )}
        </Card>

        <Card title={t('goals.title')}>
          {data.goals.recent.length === 0 ? (
            <p className="text-sm text-slate-500">{t('goals.empty')}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {data.goals.recent.slice(0, 5).map((goal) => (
                <li key={goal.id} className="flex items-center justify-between gap-2 text-sm">
                  <span className="truncate text-slate-800">{goal.title}</span>
                  <Badge tone={statusTone(goal.status)}>{goal.status}</Badge>
                </li>
              ))}
            </ul>
          )}
          {Object.keys(data.goals.counts).length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-2 border-t border-slate-100 pt-3">
              {Object.entries(data.goals.counts).map(([key, count]) => (
                <Badge key={key} tone={statusTone(key)}>
                  {key}: {count}
                </Badge>
              ))}
            </div>
          ) : null}
          <div className="mt-3">
            <Link href="/goals" className="text-sm font-medium text-teal-700 hover:underline">
              {t('goals.viewAll')}
            </Link>
          </div>
        </Card>

        <Card title={t('learning.title')}>
          {data.learning.length === 0 ? (
            <p className="text-sm text-slate-500">{t('learning.empty')}</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {data.learning.map((item) => {
                const pct =
                  item.totalLessons > 0
                    ? Math.round((item.completedLessons / item.totalLessons) * 100)
                    : 0;
                return (
                  <li key={item.courseId} className="flex flex-col gap-1">
                    <div className="flex items-center justify-between gap-2 text-sm">
                      <span className="truncate font-medium text-slate-800">
                        {item.courseTitle}
                      </span>
                      <span className="whitespace-nowrap text-xs text-slate-500">
                        {t('learning.lessons', {
                          completed: item.completedLessons,
                          total: item.totalLessons,
                        })}
                      </span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
                      <div
                        className="h-full rounded-full bg-teal-600"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card title={t('teams.title')}>
          {data.teams.length === 0 ? (
            <p className="text-sm text-slate-500">{t('teams.empty')}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {data.teams.map((team) => (
                <li key={team.teamId} className="flex items-center justify-between gap-2 text-sm">
                  <span className="font-medium text-slate-800">{team.name}</span>
                  <span className="text-xs text-slate-500">
                    {t('teams.joined', { date: formatDate(team.joinedAt, locale) })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
