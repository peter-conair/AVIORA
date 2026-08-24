'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { api, ApiError, isForbidden } from '@/lib/api-client';
import type { BoardCell, BoardResponse } from '@/lib/types';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { CourseLockNotice } from '@/components/learning/CourseLockNotice';

/**
 * The leader's release board (docs/73 §9).
 *
 * Deliberately ONE COURSE AT A TIME rather than a members × courses matrix.
 * The matrix is the right mental model and the wrong screen: it does not fit a
 * phone, which docs/72 exists because this product is used on. Reading down a
 * single course's column is the same act, and it is also the shape of the real
 * decision — "open week three for these six people", not "review thirty cells".
 */
export default function LearningBoardPage() {
  const t = useTranslations('learning');
  const tc = useTranslations('common');

  const [board, setBoard] = useState<BoardResponse | null>(null);
  const [courseId, setCourseId] = useState<string>('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.get<BoardResponse>('/learning/assignments/board');
      setBoard(res);
      setCourseId((current) => current || (res.courses[0]?.id ?? ''));
    } catch (err: unknown) {
      if (isForbidden(err)) setForbidden(true);
      else setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    }
  }, [tc]);

  useEffect(() => {
    void load();
  }, [load]);

  const course = board?.courses.find((c) => c.id === courseId) ?? null;
  const rows = useMemo(() => {
    if (!board || !courseId) return [];
    const cells = new Map<string, BoardCell>(
      board.cells.filter((c) => c.courseId === courseId).map((c) => [c.memberId, c]),
    );
    return board.members.map((member) => ({ member, cell: cells.get(member.id) ?? null }));
  }, [board, courseId]);

  const toggle = (memberId: string) => {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(memberId)) next.delete(memberId);
      else next.add(memberId);
      return next;
    });
  };

  const act = async (kind: 'assign' | 'hold' | 'withdraw') => {
    if (!course || picked.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      if (kind === 'withdraw') {
        // Withdrawing takes an assignment id, so the row is looked up rather
        // than guessed; a member with no row has nothing to withdraw, which is
        // already the state the caller wanted.
        for (const memberId of picked) {
          const { assignments } = await api.get<{
            assignments: { id: string; courseId: string }[];
          }>(`/learning/assignments?memberId=${memberId}`);
          const row = assignments.find((a) => a.courseId === course.id);
          if (row) await api.delete(`/learning/assignments/${row.id}`);
        }
      } else if (kind === 'assign') {
        await api.post('/learning/assignments', {
          memberIds: [...picked],
          courseId: course.id,
        });
      } else {
        await api.post('/learning/assignments/hold', {
          memberIds: [...picked],
          courseId: course.id,
          reason,
        });
      }
      setPicked(new Set());
      setReason('');
      await load();
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setBusy(false);
    }
  };

  if (forbidden) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-xl font-bold text-slate-900">{t('boardTitle')}</h1>
        <Card>
          <p className="text-sm text-slate-600">{t('boardForbidden')}</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-bold text-slate-900">{t('boardTitle')}</h1>
      <p className="text-sm text-slate-500">{t('boardIntro')}</p>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      {board === null ? (
        <p className="py-10 text-center text-sm text-slate-500">{tc('loading')}</p>
      ) : board.members.length === 0 ? (
        <Card>
          <p className="text-sm text-slate-600">{t('boardNoMembers')}</p>
        </Card>
      ) : (
        <>
          <Card>
            <Select
              label={t('boardCourse')}
              value={courseId}
              onChange={(e) => {
                setCourseId(e.target.value);
                setPicked(new Set());
              }}
            >
              {board.courses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                  {c.releasePolicy === 'open' ? ` — ${t('policyOpen')}` : ''}
                </option>
              ))}
            </Select>
            {course?.releasePolicy === 'open' ? (
              // Saying so up front beats a 409 after they have picked six
              // people (docs/73 §2 — the tenant owns the library's openness).
              <p className="mt-2 text-xs text-slate-500">{t('boardOpenCourseNote')}</p>
            ) : null}
          </Card>

          <Card>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-medium text-slate-600">
                {t('boardSelected', { count: picked.size })}
              </span>
              <Button
                variant="ghost"
                onClick={() =>
                  setPicked((current) =>
                    current.size === rows.length
                      ? new Set()
                      : new Set(rows.map((r) => r.member.id)),
                  )
                }
              >
                {picked.size === rows.length ? t('boardClear') : t('boardSelectAll')}
              </Button>
            </div>

            <ul className="flex flex-col divide-y divide-slate-100">
              {rows.map(({ member, cell }) => (
                <li key={member.id} className="flex items-start gap-3 py-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={picked.has(member.id)}
                    onChange={() => toggle(member.id)}
                    aria-label={member.displayName}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-slate-800">{member.displayName}</span>
                      {cell?.visible ? (
                        <Badge tone="green">{t('boardOpen')}</Badge>
                      ) : (
                        <Badge tone="gray">{t('boardLocked')}</Badge>
                      )}
                      {cell && cell.totalLessons > 0 ? (
                        <span className="text-xs text-slate-500">
                          {t('progress', {
                            completed: cell.completedLessons,
                            total: cell.totalLessons,
                          })}
                        </span>
                      ) : null}
                    </div>
                    {cell && !cell.visible ? <CourseLockNotice lock={cell.lock} /> : null}
                  </div>
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => act('assign')} disabled={busy || picked.size === 0}>
                  {t('boardRelease')}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => act('withdraw')}
                  disabled={busy || picked.size === 0}
                >
                  {t('boardWithdraw')}
                </Button>
              </div>
              <div className="flex flex-col gap-2 border-t border-slate-100 pt-3">
                {/* A hold needs a reason the MEMBER will read, so the field is
                    beside the button rather than behind a confirm dialog
                    (docs/73 §5). */}
                <Input
                  label={t('boardHoldReason')}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder={t('boardHoldPlaceholder')}
                />
                <Button
                  variant="secondary"
                  onClick={() => act('hold')}
                  disabled={busy || picked.size === 0 || reason.trim().length === 0}
                >
                  {t('boardHold')}
                </Button>
              </div>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
