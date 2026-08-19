'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { api, ApiError } from '@/lib/api-client';
import { roleLabel, type Member, type MembersResponse } from '@/lib/types';
import { Badge, statusTone } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { formatDate } from '@/lib/format';

export function MembersTab() {
  const t = useTranslations('admin.members');
  const tc = useTranslations('common');
  const locale = useLocale();

  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<MembersResponse>('/members')
      .then((data) => {
        if (!cancelled) setMembers(data.members);
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

  return (
    <Card title={t('title')}>
      {error ? <p className="mb-2 text-sm text-red-600">{error}</p> : null}
      {loading ? (
        <p className="text-sm text-slate-500">{tc('loading')}</p>
      ) : members.length === 0 ? (
        <p className="text-sm text-slate-500">{t('empty')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-xs uppercase text-slate-500">
                <th className="py-2 pr-3">{t('name')}</th>
                <th className="py-2 pr-3">{t('email')}</th>
                <th className="py-2 pr-3">{t('roles')}</th>
                <th className="py-2 pr-3">{t('status')}</th>
                <th className="py-2">{t('joined')}</th>
              </tr>
            </thead>
            <tbody>
              {members.map((member) => (
                <tr key={member.id} className="border-b border-slate-100 last:border-0">
                  <td className="py-2 pr-3 font-medium text-slate-800">{member.displayName}</td>
                  <td className="py-2 pr-3 text-slate-600">{member.email}</td>
                  <td className="py-2 pr-3">
                    <div className="flex flex-wrap gap-1">
                      {member.roles.map((role, idx) => {
                        const label = roleLabel(role);
                        return label ? (
                          <Badge key={`${member.id}-${idx}`} tone="teal">
                            {label}
                          </Badge>
                        ) : null;
                      })}
                    </div>
                  </td>
                  <td className="py-2 pr-3">
                    <Badge tone={statusTone(member.status)}>{member.status}</Badge>
                  </td>
                  <td className="py-2 text-slate-500">{formatDate(member.joinedAt, locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
