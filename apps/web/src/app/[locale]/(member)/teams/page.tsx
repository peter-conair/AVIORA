'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { api, ApiError } from '@/lib/api-client';
import {
  buildTeamTree,
  type LeadershipHistoryEntry,
  type LeadershipHistoryResponse,
  type MembersResponse,
  type Team,
  type TeamDashboardResponse,
  type TeamDetail,
  type TeamDetailResponse,
  type TeamMemberEntry,
  type TeamMembersResponse,
  type TeamMetrics,
  type TeamsResponse,
} from '@/lib/types';
import { Badge, statusTone } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { formatDate } from '@/lib/format';

function isForbidden(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 403 || err.code === 'FORBIDDEN');
}

type MetricKey = keyof TeamMetrics;

const METRIC_KEYS: MetricKey[] = ['members', 'newMembers30d', 'goalsCompleted', 'coursesCompleted'];

export default function TeamsPage() {
  const t = useTranslations('teams');
  const tc = useTranslations('common');
  const locale = useLocale();

  const [teams, setTeams] = useState<Team[]>([]);
  const [memberNames, setMemberNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [listForbidden, setListForbidden] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TeamDetail | null>(null);
  const [teamMembers, setTeamMembers] = useState<TeamMemberEntry[] | null>(null);
  const [dashboard, setDashboard] = useState<TeamDashboardResponse | null>(null);
  const [history, setHistory] = useState<LeadershipHistoryEntry[] | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailForbidden, setDetailForbidden] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  const loadDetail = useCallback(
    async (teamId: string) => {
      setSelectedId(teamId);
      setDetail(null);
      setTeamMembers(null);
      setDashboard(null);
      setHistory(null);
      setHistoryOpen(false);
      setDetailError(null);
      setDetailForbidden(false);
      setDetailLoading(true);

      try {
        const detailRes = await api.get<TeamDetailResponse>(`/teams/${teamId}`);
        setDetail(detailRes.team);
      } catch (err: unknown) {
        if (isForbidden(err)) setDetailForbidden(true);
        else setDetailError(err instanceof ApiError ? err.message : tc('errorGeneric'));
        setDetailLoading(false);
        return;
      }

      // Secondary panels are best-effort: a scoped leader may lack access to some of them.
      const [membersRes, dashboardRes, historyRes] = await Promise.all([
        api.get<TeamMembersResponse>(`/teams/${teamId}/members`).catch(() => null),
        api.get<TeamDashboardResponse>(`/teams/${teamId}/dashboard`).catch(() => null),
        api.get<LeadershipHistoryResponse>(`/teams/${teamId}/leadership-history`).catch(() => null),
      ]);
      setTeamMembers(membersRes ? membersRes.members : null);
      setDashboard(dashboardRes);
      setHistory(historyRes ? historyRes.leaderships : null);
      setDetailLoading(false);
    },
    [tc],
  );

  useEffect(() => {
    let cancelled = false;

    // Optional member-name lookup — tolerated to fail for scoped leaders.
    api
      .get<MembersResponse>('/members')
      .then((res) => {
        if (cancelled) return;
        const map: Record<string, string> = {};
        for (const m of res.members) map[m.id] = m.displayName;
        setMemberNames(map);
      })
      .catch(() => {
        // Outside the caller's scope — raw ids are shown instead.
      });

    api
      .get<TeamsResponse>('/teams')
      .then((res) => {
        if (cancelled) return;
        setTeams(res.teams);
        const requested =
          typeof window !== 'undefined'
            ? new URLSearchParams(window.location.search).get('team')
            : null;
        const initial =
          requested && res.teams.some((tn) => tn.id === requested)
            ? requested
            : (res.teams[0]?.id ?? null);
        if (initial) void loadDetail(initial);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (isForbidden(err)) setListForbidden(true);
        else setListError(err instanceof ApiError ? err.message : tc('errorGeneric'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rows = useMemo(() => buildTeamTree(teams), [teams]);
  const teamsById = useMemo(() => {
    const map: Record<string, Team> = {};
    for (const team of teams) map[team.id] = team;
    return map;
  }, [teams]);

  const parentName = detail?.parentTeamId ? teamsById[detail.parentTeamId]?.name : undefined;

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-bold text-slate-900">{t('title')}</h1>
      <p className="text-sm text-slate-500">{t('scopeHint')}</p>

      {listForbidden ? (
        <Card>
          <p className="text-sm text-slate-600">{t('forbidden')}</p>
        </Card>
      ) : listError ? (
        <p className="text-sm text-red-600">{listError}</p>
      ) : loading ? (
        <p className="py-10 text-center text-sm text-slate-500">{tc('loading')}</p>
      ) : teams.length === 0 ? (
        <Card>
          <p className="text-sm text-slate-500">{t('empty')}</p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
          <Card title={t('treeTitle')} className="self-start">
            <ul className="flex flex-col gap-0.5">
              {rows.map(({ team, depth }) => {
                const active = team.id === selectedId;
                return (
                  <li key={team.id}>
                    <button
                      type="button"
                      onClick={() => void loadDetail(team.id)}
                      aria-current={active ? 'true' : undefined}
                      style={{ paddingInlineStart: `${0.5 + depth * 0.85}rem` }}
                      className={`flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg py-1.5 pe-2 text-left text-sm ${
                        active
                          ? 'bg-brand-50 font-semibold text-brand-800 ring-1 ring-inset ring-brand-600/20'
                          : 'text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      {depth > 0 ? (
                        <span aria-hidden className="text-slate-300">
                          └
                        </span>
                      ) : null}
                      <span className="min-w-0 break-words">{team.name}</span>
                      <span className="font-mono text-[0.65rem] text-slate-400">{team.code}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </Card>

          <div className="flex flex-col gap-4">
            {detailForbidden ? (
              <Card>
                <p className="text-sm text-slate-600">{t('forbidden')}</p>
              </Card>
            ) : detailError ? (
              <Card>
                <p className="text-sm text-red-600">{detailError}</p>
              </Card>
            ) : detailLoading ? (
              <Card>
                <p className="text-sm text-slate-500">{tc('loading')}</p>
              </Card>
            ) : !detail ? (
              <Card>
                <p className="text-sm text-slate-500">{t('selectHint')}</p>
              </Card>
            ) : (
              <>
                <Card title={detail.name} actions={<Badge tone="teal">{detail.code}</Badge>}>
                  <div className="flex flex-col gap-3 text-sm">
                    {detail.description ? (
                      <p className="text-slate-600">{detail.description}</p>
                    ) : null}
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
                      <span>
                        {t('parent')}: {parentName ?? t('noParent')}
                      </span>
                      <span>{t('memberCount', { count: detail.memberCount })}</span>
                    </div>

                    <div>
                      <h3 className="mb-1 text-xs font-semibold uppercase text-slate-500">
                        {t('children')}
                      </h3>
                      {detail.children.length === 0 ? (
                        <p className="text-sm text-slate-500">{t('noChildren')}</p>
                      ) : (
                        <ul className="flex flex-wrap gap-2">
                          {detail.children.map((child) => (
                            <li key={child.id}>
                              <button
                                type="button"
                                onClick={() => void loadDetail(child.id)}
                                className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-200"
                              >
                                {child.name}
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>

                    <div>
                      <h3 className="mb-1 text-xs font-semibold uppercase text-slate-500">
                        {t('leaders')}
                      </h3>
                      {detail.teamLeaderships.length === 0 ? (
                        <p className="text-sm text-slate-500">{t('noLeaders')}</p>
                      ) : (
                        <ul className="flex flex-col gap-1">
                          {detail.teamLeaderships.map((leader, idx) => {
                            const id = leader.member?.id ?? leader.memberId;
                            const name =
                              leader.member?.displayName ??
                              (id ? memberNames[id] : undefined) ??
                              t('unknownMember');
                            return (
                              <li
                                key={id ?? idx}
                                className="flex flex-wrap items-center gap-x-2 gap-y-1"
                              >
                                <span className="text-slate-800">{name}</span>
                                {leader.leadershipRole ? (
                                  <Badge tone="teal">{leader.leadershipRole}</Badge>
                                ) : null}
                                {leader.isPrimary ? (
                                  <Badge tone="green">{t('primary')}</Badge>
                                ) : null}
                                {leader.effectiveFrom ? (
                                  <span className="text-xs text-slate-500">
                                    {t('since', { date: formatDate(leader.effectiveFrom, locale) })}
                                  </span>
                                ) : null}
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>

                    <div>
                      <h3 className="mb-1 text-xs font-semibold uppercase text-slate-500">
                        {t('membersTitle')}
                      </h3>
                      {teamMembers === null ? (
                        <p className="text-sm text-slate-500">{t('sectionUnavailable')}</p>
                      ) : teamMembers.length === 0 ? (
                        <p className="text-sm text-slate-500">{t('noMembers')}</p>
                      ) : (
                        <ul className="flex flex-col divide-y divide-slate-100">
                          {teamMembers.map((tm) => (
                            <li
                              key={tm.memberId}
                              className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 py-1.5"
                            >
                              <span className="flex flex-wrap items-center gap-2">
                                <span className="text-slate-800">
                                  {tm.member?.displayName ??
                                    memberNames[tm.memberId] ??
                                    t('unknownMember')}
                                </span>
                                {tm.member?.status ? (
                                  <Badge tone={statusTone(tm.member.status)}>
                                    {tm.member.status}
                                  </Badge>
                                ) : null}
                                {tm.membershipType ? (
                                  <span className="text-xs text-slate-400">
                                    {tm.membershipType}
                                  </span>
                                ) : null}
                              </span>
                              <span className="text-xs text-slate-500">
                                {t('joined', { date: formatDate(tm.joinedAt, locale) })}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                </Card>

                <Card title={t('dashboard.title')}>
                  {dashboard === null ? (
                    <p className="text-sm text-slate-500">{t('sectionUnavailable')}</p>
                  ) : (
                    <div className="flex flex-col gap-4">
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        {(
                          [
                            ['direct', dashboard.direct],
                            ['organization', dashboard.organization],
                          ] as const
                        ).map(([scope, metrics]) => (
                          <div
                            key={scope}
                            className="rounded-lg border border-slate-200 bg-slate-50 p-3"
                          >
                            <h3 className="mb-2 text-xs font-semibold uppercase text-slate-500">
                              {t(`dashboard.${scope}`)}
                            </h3>
                            <dl className="flex flex-col gap-1.5 text-sm">
                              {METRIC_KEYS.map((key) => (
                                <div key={key} className="flex items-center justify-between gap-2">
                                  <dt className="text-slate-500">{t(`dashboard.${key}`)}</dt>
                                  <dd className="font-semibold text-slate-900">{metrics[key]}</dd>
                                </div>
                              ))}
                            </dl>
                          </div>
                        ))}
                      </div>

                      <div>
                        <h3 className="mb-1 text-xs font-semibold uppercase text-slate-500">
                          {t('dashboard.childTeams')}
                        </h3>
                        {dashboard.children.length === 0 ? (
                          <p className="text-sm text-slate-500">{t('noChildren')}</p>
                        ) : (
                          <ul className="flex flex-col divide-y divide-slate-100">
                            {dashboard.children.map((child) => (
                              <li
                                key={child.id}
                                className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 py-1.5 text-sm"
                              >
                                <button
                                  type="button"
                                  onClick={() => void loadDetail(child.id)}
                                  className="text-left font-medium text-brand-700 hover:underline"
                                >
                                  {child.name}
                                  <span className="ms-2 font-mono text-xs text-slate-400">
                                    {child.code}
                                  </span>
                                </button>
                                <span className="text-xs text-slate-500">
                                  {t('dashboard.organizationMembers', {
                                    count: child.organizationMembers,
                                  })}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </div>
                  )}
                </Card>

                <Card
                  title={t('history.title')}
                  actions={
                    <button
                      type="button"
                      onClick={() => setHistoryOpen((open) => !open)}
                      aria-expanded={historyOpen}
                      className="text-sm font-medium text-brand-700 hover:underline"
                    >
                      {historyOpen ? t('history.hide') : t('history.show')}
                    </button>
                  }
                >
                  {!historyOpen ? (
                    <p className="text-sm text-slate-500">{t('history.collapsed')}</p>
                  ) : history === null ? (
                    <p className="text-sm text-slate-500">{t('sectionUnavailable')}</p>
                  ) : history.length === 0 ? (
                    <p className="text-sm text-slate-500">{t('history.empty')}</p>
                  ) : (
                    <ul className="flex flex-col divide-y divide-slate-100">
                      {history.map((entry, idx) => (
                        <li
                          key={`${entry.memberId}-${entry.effectiveFrom}-${idx}`}
                          className="flex flex-col gap-1 py-2"
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm text-slate-800">
                              {memberNames[entry.memberId] ?? t('unknownMember')}
                            </span>
                            <Badge tone="teal">{entry.leadershipRole}</Badge>
                            {entry.isPrimary ? <Badge tone="green">{t('primary')}</Badge> : null}
                            <Badge tone={statusTone(entry.status)}>{entry.status}</Badge>
                          </div>
                          <span className="text-xs text-slate-500">
                            {formatDate(entry.effectiveFrom, locale)} →{' '}
                            {entry.effectiveTo ? formatDate(entry.effectiveTo, locale) : t('now')}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
