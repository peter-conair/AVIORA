'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { api, ApiError } from '@/lib/api-client';
import type { LeaderDashboardResponse, LeaderTeamSummary } from '@/lib/types';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { TeamAnalyticsSection } from '@/components/analytics/TeamAnalyticsSection';
import { formatDate } from '@/lib/format';

export default function LeaderPage() {
  const t = useTranslations('leader');
  const tc = useTranslations('common');
  const locale = useLocale();

  const [teams, setTeams] = useState<LeaderTeamSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .get<LeaderDashboardResponse>('/dashboard/leader')
      .then((res) => {
        if (!cancelled) setTeams(res.teams);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && (err.status === 403 || err.code === 'FORBIDDEN')) {
          setForbidden(true);
        } else {
          setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-bold text-slate-900">{t('title')}</h1>

      {forbidden ? (
        <Card>
          <p className="text-sm text-slate-600">{t('forbidden')}</p>
        </Card>
      ) : error ? (
        <p className="text-sm text-red-600">{error}</p>
      ) : teams === null ? (
        <p className="py-10 text-center text-sm text-slate-500">{tc('loading')}</p>
      ) : teams.length === 0 ? (
        <Card>
          <p className="text-sm text-slate-600">{t('empty')}</p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {teams.map((entry) => (
            <Card
              key={entry.team.id}
              title={entry.team.name}
              actions={<Badge tone="teal">{entry.leadershipRole}</Badge>}
            >
              <div className="flex flex-col gap-3">
                <p className="text-xs text-slate-500">
                  <span className="font-mono">{entry.team.code}</span>
                  <span className="mx-2">·</span>
                  {t('since', { date: formatDate(entry.since, locale) })}
                </p>

                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                    <p className="text-xs text-slate-500">{t('directMembers')}</p>
                    <p className="text-lg font-bold text-slate-900">{entry.directMembers}</p>
                  </div>
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                    <p className="text-xs text-slate-500">{t('organizationMembers')}</p>
                    <p className="text-lg font-bold text-slate-900">{entry.organizationMembers}</p>
                  </div>
                </div>

                <p className="text-xs text-slate-500">
                  {t('childTeams', { count: entry.childTeams })}
                </p>

                <Link
                  href={{ pathname: '/teams', query: { team: entry.team.id } }}
                  className="text-sm font-medium text-teal-700 hover:underline"
                >
                  {t('viewInOrg')}
                </Link>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Team analytics live here rather than at a route of their own: this page
          is already "the teams I lead", and a second route would be a second
          place to decide what that scope is (docs/28 §1). */}
      <TeamAnalyticsSection />
    </div>
  );
}
