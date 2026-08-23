'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { api, ApiError, isForbidden } from '@/lib/api-client';
import type { HealthGrantsResponse, Member, MembersResponse } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { formatDate, shortId } from '@/lib/format';

export function SharingTab() {
  const t = useTranslations('health');
  const tc = useTranslations('common');
  const locale = useLocale();

  const [grants, setGrants] = useState<HealthGrantsResponse>({ given: [], received: [] });
  const [members, setMembers] = useState<Member[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [granteeId, setGranteeId] = useState('');
  const [sharing, setSharing] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const loadGrants = useCallback(async () => {
    try {
      const res = await api.get<HealthGrantsResponse>('/health/grants');
      setGrants(res);
      setError(null);
    } catch (err: unknown) {
      if (isForbidden(err)) setForbidden(true);
      else setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadGrants().finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [loadGrants]);

  useEffect(() => {
    let cancelled = false;
    // The member directory is admin-scoped in some workspaces. Without it the
    // member can still share — they just type the id instead of picking a name.
    api
      .get<MembersResponse>('/members')
      .then((res) => {
        if (!cancelled) setMembers(res.members);
      })
      .catch(() => {
        if (!cancelled) setMembers(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** A member's name when the directory is readable, otherwise a short id. */
  const nameFor = (memberId: string): string =>
    members?.find((m) => m.id === memberId)?.displayName ?? shortId(memberId);

  const handleShare = async (e: FormEvent) => {
    e.preventDefault();
    if (!granteeId) return;
    setError(null);
    setSharing(true);
    try {
      await api.post(`/health/grants/${granteeId}`);
      setGranteeId('');
      await loadGrants();
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setSharing(false);
    }
  };

  const handleRevoke = async (memberId: string) => {
    setError(null);
    setRevokingId(memberId);
    try {
      await api.delete(`/health/grants/${memberId}`);
      await loadGrants();
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setRevokingId(null);
    }
  };

  if (forbidden) {
    return (
      <Card>
        <p className="text-sm text-slate-600">{t('forbidden')}</p>
      </Card>
    );
  }

  const alreadyShared = new Set(grants.given.map((grant) => grant.granteeMemberId));
  const selectable = (members ?? []).filter((member) => !alreadyShared.has(member.id));

  return (
    <div className="flex flex-col gap-4">
      <p className="rounded-xl border border-brand-600/20 bg-brand-50 p-3 text-sm text-brand-900">
        {t('sharing.privacyNote')}
      </p>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      <Card title={t('sharing.shareTitle')}>
        <form onSubmit={handleShare} className="flex flex-col gap-3">
          {members ? (
            <Select
              label={t('sharing.shareSelect')}
              value={granteeId}
              onChange={(e) => setGranteeId(e.target.value)}
            >
              <option value="">{t('sharing.sharePlaceholder')}</option>
              {selectable.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.displayName}
                </option>
              ))}
            </Select>
          ) : (
            <Input
              label={t('sharing.shareMemberId')}
              hint={t('sharing.shareMemberIdHint')}
              value={granteeId}
              onChange={(e) => setGranteeId(e.target.value)}
            />
          )}
          {members && selectable.length === 0 ? (
            <p className="text-sm text-slate-500">{t('sharing.shareEmpty')}</p>
          ) : null}
          <div>
            <Button type="submit" disabled={sharing || !granteeId}>
              {sharing ? tc('saving') : t('sharing.shareSubmit')}
            </Button>
          </div>
        </form>
      </Card>

      <Card title={t('sharing.givenTitle')}>
        {loading ? (
          <p className="text-sm text-slate-500">{tc('loading')}</p>
        ) : grants.given.length === 0 ? (
          <p className="text-sm text-slate-500">{t('sharing.givenEmpty')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-slate-100">
            {grants.given.map((grant) => (
              <li
                key={grant.id}
                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 py-2"
              >
                <span className="flex min-w-0 flex-col">
                  <span className="text-sm font-medium text-slate-800">
                    {nameFor(grant.granteeMemberId)}
                  </span>
                  <span className="text-xs text-slate-500">
                    {t('sharing.grantedAt', { date: formatDate(grant.grantedAt, locale) })}
                  </span>
                </span>
                <Button
                  variant="ghost"
                  type="button"
                  disabled={revokingId === grant.granteeMemberId}
                  onClick={() => void handleRevoke(grant.granteeMemberId)}
                >
                  {revokingId === grant.granteeMemberId ? tc('saving') : t('sharing.revoke')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={t('sharing.receivedTitle')}>
        {loading ? (
          <p className="text-sm text-slate-500">{tc('loading')}</p>
        ) : grants.received.length === 0 ? (
          <p className="text-sm text-slate-500">{t('sharing.receivedEmpty')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-slate-100">
            {grants.received.map((grant) => (
              <li
                key={grant.id}
                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 py-2"
              >
                <span className="flex min-w-0 flex-col">
                  <span className="text-sm font-medium text-slate-800">
                    {nameFor(grant.memberId)}
                  </span>
                  <span className="text-xs text-slate-500">
                    {t('sharing.grantedAt', { date: formatDate(grant.grantedAt, locale) })}
                  </span>
                </span>
                <Link
                  href={`/health/members/${encodeURIComponent(grant.memberId)}`}
                  className="text-sm font-medium text-brand-700 hover:underline"
                >
                  {t('sharing.viewSummary')}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
