'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { api, ApiError, isForbidden } from '@/lib/api-client';
import type { HealthSummary, MembersResponse } from '@/lib/types';
import { Card } from '@/components/ui/Card';
import { HealthSummaryView } from '@/components/health/HealthSummaryView';
import { shortId } from '@/lib/format';

/**
 * A summary someone chose to share. Losing that access is a normal state, not
 * a failure — a revoked (or never-given) grant renders as a calm explanation
 * in the API's own words rather than an error screen.
 */
export default function SharedMemberHealthPage() {
  const t = useTranslations('health');
  const tc = useTranslations('common');
  const params = useParams<{ memberId: string }>();
  const memberId = params.memberId;

  const [summary, setSummary] = useState<HealthSummary | null>(null);
  const [memberName, setMemberName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [notShared, setNotShared] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get<HealthSummary>(`/health/members/${encodeURIComponent(memberId)}/summary`)
      .then((res) => {
        if (!cancelled) setSummary(res);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // 403 here means "not shared with you" — show the API's wording.
        if (isForbidden(err)) {
          setNotShared(err instanceof ApiError ? err.message : t('coach.notShared'));
        } else {
          setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberId]);

  useEffect(() => {
    let cancelled = false;
    api
      .get<MembersResponse>('/members')
      .then((res) => {
        if (cancelled) return;
        setMemberName(res.members.find((m) => m.id === memberId)?.displayName ?? null);
      })
      .catch(() => {
        // Directory is admin-scoped in some workspaces — fall back to the id.
      });
    return () => {
      cancelled = true;
    };
  }, [memberId]);

  const backLink = (
    <Link href="/health" className="text-sm font-medium text-brand-700 hover:underline">
      {t('coach.back')}
    </Link>
  );

  return (
    <div className="flex flex-col gap-4">
      {backLink}

      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-bold text-slate-900">{t('coach.title')}</h1>
        <p className="text-sm text-slate-500">
          {t('coach.member', { name: memberName ?? shortId(memberId) })}
        </p>
      </div>

      {loading ? (
        <p className="py-10 text-center text-sm text-slate-500">{tc('loading')}</p>
      ) : notShared ? (
        <Card>
          <p className="text-sm text-slate-600">{notShared}</p>
          <p className="mt-2 text-xs text-slate-500">{t('coach.notSharedHint')}</p>
        </Card>
      ) : summary ? (
        <HealthSummaryView summary={summary} />
      ) : (
        <Card>
          <p className="text-sm text-red-600">{error ?? tc('errorGeneric')}</p>
        </Card>
      )}
    </div>
  );
}
