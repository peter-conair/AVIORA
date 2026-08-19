'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { api, ApiError, isForbidden } from '@/lib/api-client';
import type { HealthSummary } from '@/lib/types';
import { Card } from '@/components/ui/Card';
import { HealthSummaryView } from '@/components/health/HealthSummaryView';

export function ProgressTab() {
  const t = useTranslations('health');
  const tc = useTranslations('common');

  const [summary, setSummary] = useState<HealthSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<HealthSummary>('/health/me/summary')
      .then((res) => {
        if (!cancelled) setSummary(res);
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

  if (forbidden) {
    return (
      <Card>
        <p className="text-sm text-slate-600">{t('forbidden')}</p>
      </Card>
    );
  }

  if (loading) {
    return <p className="py-10 text-center text-sm text-slate-500">{tc('loading')}</p>;
  }

  if (!summary) {
    return (
      <Card>
        <p className="text-sm text-red-600">{error ?? tc('errorGeneric')}</p>
      </Card>
    );
  }

  return <HealthSummaryView summary={summary} />;
}
