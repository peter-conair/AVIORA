'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { api, ApiError, isForbidden } from '@/lib/api-client';
import type {
  CommunitiesResponse,
  CommunityFeedResponse,
  CommunitySummary,
  MemberMeResponse,
  Team,
  TeamCommunityResponse,
  TeamsResponse,
} from '@/lib/types';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { formatRelativeTime } from '@/lib/format';

export default function CommunityPage() {
  const t = useTranslations('community');
  const tc = useTranslations('common');
  const locale = useLocale();

  const [communities, setCommunities] = useState<CommunitySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Offered only when the member has no space yet — one click opens their team's. */
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [openingTeamId, setOpeningTeamId] = useState<string | null>(null);

  const [myMemberId, setMyMemberId] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [feed, setFeed] = useState<CommunityFeedResponse | null>(null);
  const [feedLoading, setFeedLoading] = useState(false);
  const [feedForbidden, setFeedForbidden] = useState(false);
  const [feedError, setFeedError] = useState<string | null>(null);

  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>({});
  const [busyPostId, setBusyPostId] = useState<string | null>(null);

  const loadCommunities = useCallback(async (): Promise<CommunitySummary[]> => {
    const res = await api.get<CommunitiesResponse>('/community');
    setCommunities(res.communities);
    return res.communities;
  }, []);

  const openFeed = useCallback(
    async (communityId: string) => {
      setSelectedId(communityId);
      setFeed(null);
      setFeedError(null);
      setFeedForbidden(false);
      setFeedLoading(true);
      try {
        setFeed(await api.get<CommunityFeedResponse>(`/community/${communityId}/feed`));
      } catch (err: unknown) {
        if (isForbidden(err)) setFeedForbidden(true);
        else setFeedError(err instanceof ApiError ? err.message : tc('errorGeneric'));
      } finally {
        setFeedLoading(false);
      }
    },
    [tc],
  );

  useEffect(() => {
    let cancelled = false;

    // Knowing our own member id is what makes "remove" appear on our own posts.
    api
      .get<MemberMeResponse>('/members/me')
      .then((res) => {
        if (!cancelled) setMyMemberId(res.member?.id ?? null);
      })
      .catch(() => {
        // Without it the remove action simply stays hidden.
      });

    loadCommunities()
      .then((list) => {
        if (cancelled) return;
        if (list.length > 0) {
          void openFeed(list[0].id);
        } else {
          // No space yet — offer to open the member's own team space.
          api
            .get<TeamsResponse>('/teams')
            .then((res) => {
              if (!cancelled) setTeams(res.teams);
            })
            .catch(() => {
              if (!cancelled) setTeams([]);
            });
        }
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

  const handleOpenTeamSpace = async (teamId: string) => {
    setError(null);
    setOpeningTeamId(teamId);
    try {
      const res = await api.get<TeamCommunityResponse>(`/community/teams/${teamId}`);
      await loadCommunities();
      await openFeed(res.community.id);
    } catch (err: unknown) {
      if (isForbidden(err)) setError(t('openTeamForbidden'));
      else setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setOpeningTeamId(null);
    }
  };

  const handlePost = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedId || !draft.trim()) return;
    setFeedError(null);
    setPosting(true);
    try {
      await api.post(`/community/${selectedId}/posts`, { body: draft.trim() });
      setDraft('');
      await openFeed(selectedId);
      await loadCommunities().catch(() => undefined);
    } catch (err: unknown) {
      setFeedError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setPosting(false);
    }
  };

  const handleToggleReaction = async (postId: string, reacted: boolean) => {
    if (!selectedId) return;
    setFeedError(null);
    setBusyPostId(postId);
    try {
      if (reacted) await api.delete(`/community/posts/${postId}/reactions`);
      else await api.post(`/community/posts/${postId}/reactions`, { kind: 'like' });
      await openFeed(selectedId);
    } catch (err: unknown) {
      setFeedError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setBusyPostId(null);
    }
  };

  const handleComment = async (postId: string) => {
    if (!selectedId) return;
    const body = (commentDrafts[postId] ?? '').trim();
    if (!body) return;
    setFeedError(null);
    setBusyPostId(postId);
    try {
      await api.post(`/community/posts/${postId}/comments`, { body });
      setCommentDrafts((current) => ({ ...current, [postId]: '' }));
      await openFeed(selectedId);
    } catch (err: unknown) {
      setFeedError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setBusyPostId(null);
    }
  };

  const handleRemove = async (postId: string) => {
    if (!selectedId) return;
    setFeedError(null);
    setBusyPostId(postId);
    try {
      await api.delete(`/community/posts/${postId}`);
      await openFeed(selectedId);
      await loadCommunities().catch(() => undefined);
    } catch (err: unknown) {
      // A moderator elsewhere in the tree may still refuse — say so calmly.
      if (isForbidden(err)) setFeedError(t('removeForbidden'));
      else setFeedError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setBusyPostId(null);
    }
  };

  const authorName = (displayName: string | null): string => displayName ?? t('unknownAuthor');

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
      ) : communities.length === 0 ? (
        <Card title={t('emptyTitle')}>
          <p className="text-sm text-slate-500">{t('empty')}</p>
          {teams === null ? (
            <p className="mt-3 text-sm text-slate-500">{tc('loading')}</p>
          ) : teams.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">{t('noTeams')}</p>
          ) : (
            <ul className="mt-3 flex flex-wrap gap-2">
              {teams.map((team) => (
                <li key={team.id}>
                  <Button
                    variant="secondary"
                    type="button"
                    disabled={openingTeamId !== null}
                    onClick={() => void handleOpenTeamSpace(team.id)}
                  >
                    {openingTeamId === team.id
                      ? tc('loading')
                      : t('openTeamSpace', { team: team.name })}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
          <Card title={t('spacesTitle')} className="self-start">
            <ul className="flex flex-col gap-0.5">
              {communities.map((space) => {
                const active = space.id === selectedId;
                return (
                  <li key={space.id}>
                    <button
                      type="button"
                      onClick={() => void openFeed(space.id)}
                      aria-current={active ? 'true' : undefined}
                      className={`flex w-full flex-wrap items-center justify-between gap-x-2 gap-y-0.5 rounded-lg px-2 py-1.5 text-left text-sm ${
                        active
                          ? 'bg-teal-50 font-semibold text-teal-800 ring-1 ring-inset ring-teal-600/20'
                          : 'text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      <span className="min-w-0 break-words">{space.name}</span>
                      <span className="text-xs text-slate-500">
                        {t('postCount', { count: space.postCount })}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </Card>

          <div className="flex flex-col gap-4">
            {feedForbidden ? (
              <Card>
                <p className="text-sm text-slate-600">{t('forbidden')}</p>
              </Card>
            ) : (
              <>
                {feedError ? <p className="text-sm text-red-600">{feedError}</p> : null}

                <Card title={t('composerTitle')}>
                  <form onSubmit={handlePost} className="flex flex-col gap-2">
                    <label htmlFor="community-composer" className="sr-only">
                      {t('composerLabel')}
                    </label>
                    <textarea
                      id="community-composer"
                      rows={3}
                      maxLength={4000}
                      value={draft}
                      placeholder={t('composerPlaceholder')}
                      onChange={(e) => setDraft(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-teal-600"
                    />
                    <div>
                      <Button type="submit" disabled={posting || draft.trim().length === 0}>
                        {posting ? tc('saving') : t('postSubmit')}
                      </Button>
                    </div>
                  </form>
                </Card>

                <Card title={feed?.community.name ?? t('feedTitle')}>
                  {feedLoading ? (
                    <p className="text-sm text-slate-500">{tc('loading')}</p>
                  ) : !feed || feed.posts.length === 0 ? (
                    <p className="text-sm text-slate-500">{t('feedEmpty')}</p>
                  ) : (
                    <ul className="flex flex-col divide-y divide-slate-100">
                      {feed.posts.map((post) => {
                        const mine = !!myMemberId && post.author.id === myMemberId;
                        const busy = busyPostId === post.id;
                        return (
                          <li key={post.id} className="flex flex-col gap-2 py-3 first:pt-0">
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                              <span className="text-sm font-medium text-slate-800">
                                {authorName(post.author.displayName)}
                              </span>
                              <span className="text-xs text-slate-500">
                                {formatRelativeTime(post.createdAt, locale)}
                              </span>
                              {post.pinned ? <Badge tone="amber">{t('pinned')}</Badge> : null}
                            </div>

                            <p className="whitespace-pre-wrap break-words text-sm text-slate-700">
                              {post.body}
                            </p>

                            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void handleToggleReaction(post.id, post.reactedByMe)}
                                aria-pressed={post.reactedByMe}
                                className={`rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset disabled:opacity-50 ${
                                  post.reactedByMe
                                    ? 'bg-teal-50 text-teal-800 ring-teal-600/20'
                                    : 'bg-slate-50 text-slate-600 ring-slate-300 hover:bg-slate-100'
                                }`}
                              >
                                {post.reactedByMe ? t('liked') : t('like')}
                                <span className="ms-1 text-slate-500">{post.reactionCount}</span>
                              </button>
                              {mine ? (
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => void handleRemove(post.id)}
                                  className="text-xs font-medium text-slate-500 hover:text-red-700 disabled:opacity-50"
                                >
                                  {t('remove')}
                                </button>
                              ) : null}
                            </div>

                            {post.comments.length > 0 ? (
                              <ul className="flex flex-col gap-1.5 border-s-2 border-slate-100 ps-3">
                                {post.comments.map((comment) => (
                                  <li key={comment.id} className="flex flex-col gap-0.5">
                                    <span className="flex flex-wrap items-center gap-x-2">
                                      <span className="text-xs font-medium text-slate-700">
                                        {authorName(comment.author.displayName)}
                                      </span>
                                      <span className="text-xs text-slate-400">
                                        {formatRelativeTime(comment.createdAt, locale)}
                                      </span>
                                    </span>
                                    <span className="whitespace-pre-wrap break-words text-sm text-slate-600">
                                      {comment.body}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            ) : null}

                            <div className="flex flex-wrap items-center gap-2">
                              <label htmlFor={`comment-${post.id}`} className="sr-only">
                                {t('commentLabel')}
                              </label>
                              <input
                                id={`comment-${post.id}`}
                                maxLength={4000}
                                value={commentDrafts[post.id] ?? ''}
                                placeholder={t('commentPlaceholder')}
                                onChange={(e) =>
                                  setCommentDrafts((current) => ({
                                    ...current,
                                    [post.id]: e.target.value,
                                  }))
                                }
                                className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-teal-600"
                              />
                              <Button
                                variant="secondary"
                                type="button"
                                disabled={
                                  busy || (commentDrafts[post.id] ?? '').trim().length === 0
                                }
                                onClick={() => void handleComment(post.id)}
                              >
                                {t('commentSubmit')}
                              </Button>
                            </div>
                          </li>
                        );
                      })}
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
