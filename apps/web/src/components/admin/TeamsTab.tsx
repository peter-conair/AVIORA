'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { api, ApiError } from '@/lib/api-client';
import type {
  Member,
  MembersResponse,
  Team,
  TeamDescendantsResponse,
  TeamDetail,
  TeamDetailResponse,
  TeamMemberEntry,
  TeamMembersResponse,
  TeamsResponse,
} from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { formatDate } from '@/lib/format';

export function TeamsTab() {
  const t = useTranslations('admin.teams');
  const tc = useTranslations('common');
  const locale = useLocale();

  const [teams, setTeams] = useState<Team[]>([]);
  const [allMembers, setAllMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create form
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [parentTeamId, setParentTeamId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Detail
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TeamDetail | null>(null);
  const [teamMembers, setTeamMembers] = useState<TeamMemberEntry[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [leaderId, setLeaderId] = useState('');
  const [newMemberId, setNewMemberId] = useState('');
  const [assigning, setAssigning] = useState(false);
  const [adding, setAdding] = useState(false);

  // Move team — ids that can never be the new parent (the team itself + its subtree).
  const [excludedIds, setExcludedIds] = useState<string[]>([]);
  const [moveParentId, setMoveParentId] = useState('');
  const [moving, setMoving] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.get<TeamsResponse>('/teams'), api.get<MembersResponse>('/members')])
      .then(([teamsRes, membersRes]) => {
        if (cancelled) return;
        setTeams(teamsRes.teams);
        setAllMembers(membersRes.members);
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

  const loadDetail = async (teamId: string) => {
    setSelectedTeamId(teamId);
    setDetail(null);
    setTeamMembers([]);
    setDetailError(null);
    setMoveError(null);
    setDetailLoading(true);
    try {
      const [detailRes, membersRes, descendantsRes] = await Promise.all([
        api.get<TeamDetailResponse>(`/teams/${teamId}`),
        api.get<TeamMembersResponse>(`/teams/${teamId}/members`),
        api.get<TeamDescendantsResponse>(`/teams/${teamId}/descendants`),
      ]);
      setDetail(detailRes.team);
      setTeamMembers(membersRes.members);
      setExcludedIds(descendantsRes.teams.map((tn) => tn.id).concat(teamId));
      setMoveParentId(detailRes.team.parentTeamId ?? '');
    } catch (err: unknown) {
      setDetailError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setDetailLoading(false);
    }
  };

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      const body: Record<string, string> = { code, name };
      if (description) body.description = description;
      if (parentTeamId) body.parentTeamId = parentTeamId;
      await api.post('/teams', body);
      setCode('');
      setName('');
      setDescription('');
      setParentTeamId('');
      const teamsRes = await api.get<TeamsResponse>('/teams');
      setTeams(teamsRes.teams);
    } catch (err: unknown) {
      setFormError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleAssignLeader = async () => {
    if (!selectedTeamId || !leaderId) return;
    setAssigning(true);
    setDetailError(null);
    try {
      await api.post(`/teams/${selectedTeamId}/leaders`, { memberId: leaderId });
      setLeaderId('');
      await loadDetail(selectedTeamId);
    } catch (err: unknown) {
      setDetailError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setAssigning(false);
    }
  };

  const handleAddMember = async () => {
    if (!selectedTeamId || !newMemberId) return;
    setAdding(true);
    setDetailError(null);
    try {
      await api.post(`/teams/${selectedTeamId}/members`, { memberId: newMemberId });
      setNewMemberId('');
      await loadDetail(selectedTeamId);
    } catch (err: unknown) {
      setDetailError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setAdding(false);
    }
  };

  const handleMove = async () => {
    if (!selectedTeamId) return;
    setMoving(true);
    setMoveError(null);
    try {
      await api.patch(`/teams/${selectedTeamId}/move`, { newParentId: moveParentId || null });
      const teamsRes = await api.get<TeamsResponse>('/teams');
      setTeams(teamsRes.teams);
      await loadDetail(selectedTeamId);
    } catch (err: unknown) {
      // The API rejects cycles with a 400 — surface its message verbatim.
      setMoveError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setMoving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      <Card title={t('formTitle')}>
        <form onSubmit={handleCreate} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input
            label={t('code')}
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <Input
            label={t('name')}
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Input
            label={t('description')}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <Select
            label={t('parent')}
            value={parentTeamId}
            onChange={(e) => setParentTeamId(e.target.value)}
          >
            <option value="">{t('noParent')}</option>
            {teams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </Select>
          {formError ? <p className="text-sm text-red-600 sm:col-span-2">{formError}</p> : null}
          <div>
            <Button type="submit" disabled={submitting}>
              {submitting ? tc('saving') : t('submit')}
            </Button>
          </div>
        </form>
      </Card>

      <Card title={t('listTitle')}>
        {loading ? (
          <p className="text-sm text-slate-500">{tc('loading')}</p>
        ) : teams.length === 0 ? (
          <p className="text-sm text-slate-500">{t('empty')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-slate-100">
            {teams.map((team) => (
              <li key={team.id} className="py-2 first:pt-0 last:pb-0">
                <button
                  type="button"
                  onClick={() =>
                    selectedTeamId === team.id ? setSelectedTeamId(null) : loadDetail(team.id)
                  }
                  className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-slate-50"
                >
                  <span>
                    <span className="font-medium text-slate-800">{team.name}</span>
                    <span className="ml-2 font-mono text-xs text-slate-400">{team.code}</span>
                  </span>
                  <span className="text-xs text-brand-700">
                    {selectedTeamId === team.id ? t('close') : t('detail')}
                  </span>
                </button>

                {selectedTeamId === team.id ? (
                  <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
                    {detailLoading ? (
                      <p className="text-sm text-slate-500">{tc('loading')}</p>
                    ) : (
                      <div className="flex flex-col gap-3">
                        {detailError ? <p className="text-sm text-red-600">{detailError}</p> : null}
                        {detail ? (
                          <>
                            <p className="text-xs text-slate-500">
                              {t('memberCount', { count: detail.memberCount })}
                            </p>
                            <div>
                              <h3 className="mb-1 text-xs font-semibold uppercase text-slate-500">
                                {t('leaders')}
                              </h3>
                              {detail.teamLeaderships.length === 0 ? (
                                <p className="text-sm text-slate-500">{t('noLeaders')}</p>
                              ) : (
                                <ul className="flex flex-wrap gap-2 text-sm text-slate-800">
                                  {detail.teamLeaderships.map((l, idx) => (
                                    <li
                                      key={l.member?.id ?? l.memberId ?? idx}
                                      className="rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-800 ring-1 ring-inset ring-brand-600/20"
                                    >
                                      {l.member?.displayName ?? l.memberId}
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </div>
                            <div>
                              <h3 className="mb-1 text-xs font-semibold uppercase text-slate-500">
                                {t('membersTitle')}
                              </h3>
                              {teamMembers.length === 0 ? (
                                <p className="text-sm text-slate-500">{t('noMembers')}</p>
                              ) : (
                                <ul className="flex flex-col gap-1 text-sm">
                                  {teamMembers.map((tm) => (
                                    <li
                                      key={tm.memberId}
                                      className="flex items-center justify-between gap-2"
                                    >
                                      <span className="text-slate-800">
                                        {tm.member.displayName}
                                      </span>
                                      <span className="text-xs text-slate-500">
                                        {formatDate(tm.joinedAt, locale)}
                                      </span>
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </div>
                            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                              <div className="flex items-end gap-2">
                                <div className="flex-1">
                                  <Select
                                    label={t('assignLeader')}
                                    value={leaderId}
                                    onChange={(e) => setLeaderId(e.target.value)}
                                  >
                                    <option value="">{t('selectMember')}</option>
                                    {allMembers.map((m) => (
                                      <option key={m.id} value={m.id}>
                                        {m.displayName}
                                      </option>
                                    ))}
                                  </Select>
                                </div>
                                <Button
                                  variant="secondary"
                                  onClick={handleAssignLeader}
                                  disabled={assigning || !leaderId}
                                >
                                  {t('add')}
                                </Button>
                              </div>
                              <div className="flex items-end gap-2">
                                <div className="flex-1">
                                  <Select
                                    label={t('addMember')}
                                    value={newMemberId}
                                    onChange={(e) => setNewMemberId(e.target.value)}
                                  >
                                    <option value="">{t('selectMember')}</option>
                                    {allMembers.map((m) => (
                                      <option key={m.id} value={m.id}>
                                        {m.displayName}
                                      </option>
                                    ))}
                                  </Select>
                                </div>
                                <Button
                                  variant="secondary"
                                  onClick={handleAddMember}
                                  disabled={adding || !newMemberId}
                                >
                                  {t('add')}
                                </Button>
                              </div>
                            </div>

                            <div className="border-t border-slate-200 pt-3">
                              <div className="flex items-end gap-2">
                                <div className="flex-1">
                                  <Select
                                    label={t('moveTitle')}
                                    value={moveParentId}
                                    onChange={(e) => setMoveParentId(e.target.value)}
                                  >
                                    <option value="">{t('moveToRoot')}</option>
                                    {teams
                                      .filter((candidate) => !excludedIds.includes(candidate.id))
                                      .map((candidate) => (
                                        <option key={candidate.id} value={candidate.id}>
                                          {candidate.name}
                                        </option>
                                      ))}
                                  </Select>
                                </div>
                                <Button
                                  variant="secondary"
                                  onClick={handleMove}
                                  disabled={moving || moveParentId === (detail.parentTeamId ?? '')}
                                >
                                  {moving ? tc('saving') : t('move')}
                                </Button>
                              </div>
                              <p className="mt-1 text-xs text-slate-500">{t('moveHint')}</p>
                              {moveError ? (
                                <p className="mt-1 text-sm text-red-600">{moveError}</p>
                              ) : null}
                            </div>
                          </>
                        ) : null}
                      </div>
                    )}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
