'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { api, ApiError, isForbidden } from '@/lib/api-client';
import {
  CHALLENGE_SOURCES,
  type Challenge,
  type ChallengeLeaderboardResponse,
  type ChallengesResponse,
} from '@/lib/types';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { formatDate } from '@/lib/format';

export default function ChallengesPage() {
  const t = useTranslations('challenges');
  const tc = useTranslations('common');
  const locale = useLocale();

  const [challenges, setChallenges] = useState<Challenge[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joiningId, setJoiningId] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [board, setBoard] = useState<ChallengeLeaderboardResponse | null>(null);
  const [boardLoading, setBoardLoading] = useState(false);
  const [boardForbidden, setBoardForbidden] = useState(false);
  const [boardError, setBoardError] = useState<string | null>(null);

  const loadChallenges = useCallback(async () => {
    const res = await api.get<ChallengesResponse>('/challenges');
    setChallenges(res.challenges);
  }, []);

  const loadBoard = useCallback(
    async (challengeId: string) => {
      setBoard(null);
      setBoardError(null);
      setBoardForbidden(false);
      setBoardLoading(true);
      try {
        setBoard(
          await api.get<ChallengeLeaderboardResponse>(`/challenges/${challengeId}/leaderboard`),
        );
      } catch (err: unknown) {
        if (isForbidden(err)) setBoardForbidden(true);
        else setBoardError(err instanceof ApiError ? err.message : tc('errorGeneric'));
      } finally {
        setBoardLoading(false);
      }
    },
    [tc],
  );

  useEffect(() => {
    let cancelled = false;
    loadChallenges()
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

  const handleSelect = (challengeId: string) => {
    if (selectedId === challengeId) {
      setSelectedId(null);
      setBoard(null);
      return;
    }
    setSelectedId(challengeId);
    void loadBoard(challengeId);
  };

  const handleToggleJoin = async (challenge: Challenge) => {
    setError(null);
    setJoiningId(challenge.id);
    try {
      if (challenge.joined) await api.delete(`/challenges/${challenge.id}/join`);
      else await api.post(`/challenges/${challenge.id}/join`);
      await loadChallenges();
      if (selectedId === challenge.id) await loadBoard(challenge.id);
    } catch (err: unknown) {
      if (isForbidden(err)) setError(t('joinForbidden'));
      else setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setJoiningId(null);
    }
  };

  const sourceLabel = (source: string): string =>
    (CHALLENGE_SOURCES as readonly string[]).includes(source)
      ? t(`sources.${source as (typeof CHALLENGE_SOURCES)[number]}`)
      : source;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-bold text-slate-900">{t('title')}</h1>
        <p className="text-sm text-slate-500">{t('intro')}</p>
      </div>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      {forbidden ? (
        <Card>
          <p className="text-sm text-slate-600">{t('forbidden')}</p>
        </Card>
      ) : loading ? (
        <p className="py-10 text-center text-sm text-slate-500">{tc('loading')}</p>
      ) : challenges.length === 0 ? (
        <Card>
          <p className="text-sm text-slate-500">{t('empty')}</p>
        </Card>
      ) : (
        <ul className="flex flex-col gap-4">
          {challenges.map((challenge) => {
            const open = selectedId === challenge.id;
            return (
              <li key={challenge.id}>
                <Card
                  title={challenge.name}
                  actions={
                    challenge.completedAt ? (
                      <Badge tone="green">{t('completed')}</Badge>
                    ) : challenge.joined ? (
                      <Badge tone="teal">{t('joinedBadge')}</Badge>
                    ) : null
                  }
                >
                  <div className="flex flex-col gap-3">
                    {challenge.description ? (
                      <p className="text-sm text-slate-600">{challenge.description}</p>
                    ) : null}

                    <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                      <div className="flex gap-1">
                        <dt>{t('source')}:</dt>
                        <dd className="font-medium text-slate-700">
                          {sourceLabel(challenge.source)}
                        </dd>
                      </div>
                      <div className="flex gap-1">
                        <dt>{t('target')}:</dt>
                        <dd className="font-medium text-slate-700">
                          {t('targetValue', { value: challenge.targetValue })}
                        </dd>
                      </div>
                      <div className="flex gap-1">
                        <dt>{t('dates')}:</dt>
                        <dd className="font-medium text-slate-700">
                          {formatDate(challenge.startsOn, locale)} –{' '}
                          {formatDate(challenge.endsOn, locale)}
                        </dd>
                      </div>
                    </dl>

                    {!challenge.joined ? (
                      <p className="text-xs text-slate-500">{t('joinVisibilityNote')}</p>
                    ) : null}

                    <div className="flex flex-wrap items-center gap-3">
                      <Button
                        type="button"
                        variant={challenge.joined ? 'secondary' : 'primary'}
                        disabled={joiningId === challenge.id}
                        onClick={() => void handleToggleJoin(challenge)}
                      >
                        {joiningId === challenge.id
                          ? tc('saving')
                          : challenge.joined
                            ? t('leave')
                            : t('join')}
                      </Button>
                      <button
                        type="button"
                        onClick={() => handleSelect(challenge.id)}
                        aria-expanded={open}
                        className="text-sm font-medium text-teal-700 hover:underline"
                      >
                        {open ? t('hideLeaderboard') : t('showLeaderboard')}
                      </button>
                    </div>

                    {open ? (
                      <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                        {boardForbidden ? (
                          <p className="text-sm text-slate-600">{t('forbidden')}</p>
                        ) : boardError ? (
                          <p className="text-sm text-red-600">{boardError}</p>
                        ) : boardLoading || !board ? (
                          <p className="text-sm text-slate-500">{tc('loading')}</p>
                        ) : (
                          <div className="flex flex-col gap-3">
                            <p className="text-xs text-slate-500">
                              {t('participantCount', { count: board.participantCount })}
                            </p>

                            {board.leaderboard.length === 0 ? (
                              <p className="text-sm text-slate-500">{t('leaderboardEmpty')}</p>
                            ) : (
                              <ol className="flex flex-col gap-2">
                                {board.leaderboard.map((row, index) => {
                                  const ratio =
                                    board.challenge.targetValue > 0
                                      ? Math.min(
                                          100,
                                          Math.round(
                                            (row.progress / board.challenge.targetValue) * 100,
                                          ),
                                        )
                                      : 0;
                                  return (
                                    <li
                                      key={row.memberId}
                                      className={`flex flex-col gap-1 rounded-lg p-2 ${
                                        row.isMe
                                          ? 'bg-teal-50 ring-1 ring-inset ring-teal-600/20'
                                          : 'bg-white'
                                      }`}
                                    >
                                      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                                        <span className="flex min-w-0 flex-wrap items-center gap-2">
                                          <span className="text-xs font-semibold text-slate-400">
                                            {index + 1}
                                          </span>
                                          <span className="min-w-0 break-words text-sm text-slate-800">
                                            {row.displayName ?? t('unknownMember')}
                                          </span>
                                          {row.isMe ? <Badge tone="teal">{t('you')}</Badge> : null}
                                          {row.completedAt ? (
                                            <Badge tone="green">{t('completed')}</Badge>
                                          ) : null}
                                        </span>
                                        <span className="text-xs text-slate-500">
                                          {t('progressOf', {
                                            progress: row.progress,
                                            target: board.challenge.targetValue,
                                          })}
                                        </span>
                                      </div>
                                      <div
                                        className="h-2 w-full overflow-hidden rounded-full bg-slate-100"
                                        aria-hidden="true"
                                      >
                                        <div
                                          className="h-full rounded-full bg-teal-700"
                                          style={{ width: `${ratio}%` }}
                                        />
                                      </div>
                                    </li>
                                  );
                                })}
                              </ol>
                            )}

                            {/* The API's own wording about who is visible here — kept verbatim. */}
                            <p className="rounded-lg bg-slate-100 p-2 text-xs text-slate-600">
                              {board.privacyNote}
                            </p>
                          </div>
                        )}
                      </div>
                    ) : null}
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
