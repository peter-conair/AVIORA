'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { api, ApiError, isForbidden } from '@/lib/api-client';
import { rewardTypeKey, type RewardGrant, type RewardGrantsResponse } from '@/lib/types';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { formatDate } from '@/lib/format';

/**
 * The member's own reward grants, newest first (docs/27 §5).
 *
 * Two things this screen refuses to blur:
 *
 * - A revoked grant is SHOWN as revoked rather than dropped. The row is kept
 *   deliberately — hiding it would tell a member a reward they remember
 *   receiving never existed.
 * - A cash reward is a record, not a payment, and says so beside itself. A
 *   member who reads "cash" and is told nothing will wait for money that
 *   compensation, not rewards, would have to move.
 */
export default function MyRewardsPage() {
  const t = useTranslations('myRewards');
  const tc = useTranslations('common');
  const locale = useLocale();

  const [grants, setGrants] = useState<RewardGrant[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    api
      .get<RewardGrantsResponse>('/rewards/me')
      .then((res) => {
        if (!cancelled) setGrants(res.grants);
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

  /** Falls back to the raw type rather than mislabelling one this build cannot name. */
  const typeLabel = (type: string): string => {
    const key = rewardTypeKey(type);
    return key ? t(key) : type;
  };

  const sourceLabel = (sourceType: string): string => {
    if (sourceType === 'automation') return t('sourceAutomation');
    if (sourceType === 'manual') return t('sourceManual');
    return sourceType;
  };

  /**
   * Only an automated grant's reference names something a member can read — the
   * rule that granted it. A manual grant references the administrator's user id,
   * which says nothing to the person who received the reward.
   */
  const sourceCode = (grant: RewardGrant): string | null =>
    grant.sourceType === 'automation' ? grant.sourceRef : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-bold text-slate-900">{t('title')}</h1>
        <p className="text-sm text-slate-500">{t('intro')}</p>
      </div>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      {loading ? (
        <p className="py-10 text-center text-sm text-slate-500">{tc('loading')}</p>
      ) : forbidden ? (
        <Card>
          <p className="text-sm text-slate-600">{t('forbidden')}</p>
        </Card>
      ) : (
        <Card>
          {grants.length === 0 ? (
            <p className="text-sm text-slate-500">{t('empty')}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-slate-100">
              {grants.map((grant) => {
                const revoked = grant.status === 'revoked';
                const code = sourceCode(grant);
                return (
                  <li key={grant.id} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                      <span className="flex min-w-0 flex-col">
                        <span
                          className={`min-w-0 break-words text-sm font-medium ${
                            revoked ? 'text-slate-400 line-through' : 'text-slate-800'
                          }`}
                        >
                          {grant.reward.name}
                        </span>
                        <span className="text-xs text-slate-500">
                          {t('grantedOn', { date: formatDate(grant.grantedAt, locale) })}
                        </span>
                      </span>
                      {revoked ? (
                        <Badge tone="gray">{t('revoked')}</Badge>
                      ) : (
                        <Badge tone="teal">{typeLabel(grant.reward.type)}</Badge>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      {revoked ? (
                        <span className="text-xs text-slate-500">
                          {typeLabel(grant.reward.type)}
                        </span>
                      ) : null}
                      <span className="min-w-0 break-words text-xs text-slate-500">
                        {sourceLabel(grant.sourceType)}
                      </span>
                      {code ? (
                        <span className="min-w-0 break-all text-xs text-slate-400">{code}</span>
                      ) : null}
                    </div>

                    {/* Said next to the reward itself, not in a footnote: a
                        member must not read "cash" and expect a transfer. */}
                    {grant.reward.type === 'cash' ? (
                      <p className="min-w-0 break-words rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
                        {t('cashNote')}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}
