'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { api, ApiError } from '@/lib/api-client';
import type {
  BoardResponse,
  Course,
  CourseProgress,
  CoursesResponse,
  LessonCompleteResponse,
  ProgressResponse,
} from '@/lib/types';
import { Badge, statusTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { CourseLockNotice } from '@/components/learning/CourseLockNotice';
import { LessonVideo } from '@/components/learning/LessonVideo';
import { Link } from '@/i18n/navigation';

export default function LearningPage() {
  const t = useTranslations('learning');
  const tc = useTranslations('common');

  const [courses, setCourses] = useState<Course[]>([]);
  const [progressMap, setProgressMap] = useState<Record<string, CourseProgress>>({});
  const [loading, setLoading] = useState(true);
  const [notEntitled, setNotEntitled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /**
   * Whether this reader may release courses to other people. Discovered by
   * asking, rather than by decoding a permission client-side: the server is the
   * only thing that knows, and a link that 403s is worse than no link.
   */
  const [canAssign, setCanAssign] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .get<BoardResponse>('/learning/assignments/board')
      .then(() => {
        if (!cancelled) setCanAssign(true);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Playback heartbeat. Deliberately fire-and-forget: a lost report costs those
   * seconds, and a failure here must never interrupt somebody watching.
   */
  const reportProgress = useCallback(
    (lessonId: string, positionSeconds: number, watchedDeltaSeconds: number) => {
      void api
        .post(`/learning/lessons/${lessonId}/progress`, { positionSeconds, watchedDeltaSeconds })
        .catch(() => undefined);
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.get<CoursesResponse>('/courses'),
      api.get<ProgressResponse>('/learning/progress'),
    ])
      .then(([coursesRes, progressRes]) => {
        if (cancelled) return;
        setCourses(coursesRes.courses);
        const map: Record<string, CourseProgress> = {};
        for (const p of progressRes.progress) map[p.courseId] = p;
        setProgressMap(map);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.code === 'ENTITLEMENT_REQUIRED') {
          setNotEntitled(true);
        } else if (err instanceof ApiError && err.status === 403) {
          setNotEntitled(true);
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
  }, []);

  const handleStart = async (courseId: string) => {
    setBusy(courseId);
    setError(null);
    try {
      await api.post(`/courses/${courseId}/start`);
      const progressRes = await api.get<ProgressResponse>('/learning/progress');
      const map: Record<string, CourseProgress> = {};
      for (const p of progressRes.progress) map[p.courseId] = p;
      setProgressMap(map);
    } catch (err: unknown) {
      if (err instanceof ApiError && (err.code === 'ENTITLEMENT_REQUIRED' || err.status === 403)) {
        setNotEntitled(true);
      } else {
        setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
      }
    } finally {
      setBusy(null);
    }
  };

  const handleCompleteLesson = async (courseId: string, lessonId: string) => {
    setBusy(lessonId);
    setError(null);
    try {
      const { progress } = await api.post<LessonCompleteResponse>(`/lessons/${lessonId}/complete`);
      setProgressMap((m) => ({ ...m, [courseId]: progress }));
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setBusy(null);
    }
  };

  if (notEntitled) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-xl font-bold text-slate-900">{t('title')}</h1>
        <Card>
          <p className="text-sm text-slate-600">{t('notEntitled')}</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-bold text-slate-900">{t('title')}</h1>
        {canAssign ? (
          <Link
            href="/learning/board"
            className="text-sm font-medium text-slate-600 underline hover:text-slate-900"
          >
            {t('boardLink')}
          </Link>
        ) : null}
      </div>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      {loading ? (
        <p className="py-10 text-center text-sm text-slate-500">{tc('loading')}</p>
      ) : courses.length === 0 ? (
        <Card>
          <p className="text-sm text-slate-500">{t('empty')}</p>
        </Card>
      ) : (
        courses.map((course) => {
          // Listed with its reason rather than dropped from the list. This is
          // the member's own curriculum, and a course that silently vanishes
          // teaches them the app is unreliable (docs/73 §5).
          if (!course.visible) {
            return (
              <Card key={course.id} title={course.title}>
                <CourseLockNotice lock={course.lock} />
              </Card>
            );
          }
          const progress = progressMap[course.id];
          const completedIds = progress?.completedLessonIds ?? [];
          const total = course.lessons.length;
          const done = course.lessons.filter((l) => completedIds.includes(l.id)).length;
          const allDone = total > 0 && done === total;
          return (
            <Card
              key={course.id}
              title={course.title}
              actions={
                progress ? (
                  allDone ? (
                    <Badge tone="green">{t('courseCompleted')}</Badge>
                  ) : (
                    <Badge tone={statusTone(progress.status)}>{progress.status}</Badge>
                  )
                ) : (
                  <Button
                    variant="secondary"
                    onClick={() => handleStart(course.id)}
                    disabled={busy === course.id}
                  >
                    {busy === course.id ? t('starting') : t('start')}
                  </Button>
                )
              }
            >
              {course.description ? (
                <p className="mb-3 text-sm text-slate-500">{course.description}</p>
              ) : null}
              {progress ? (
                <p className="mb-2 text-xs text-slate-500">
                  {t('progress', { completed: done, total })}
                </p>
              ) : (
                <p className="mb-2 text-xs text-slate-500">{t('lessons', { count: total })}</p>
              )}
              <ul className="flex flex-col divide-y divide-slate-100">
                {[...course.lessons]
                  .sort((a, b) => a.order - b.order)
                  .map((lesson) => {
                    const isDone = completedIds.includes(lesson.id);
                    return (
                      <li key={lesson.id} className="py-2 text-sm">
                        <div className="flex items-center justify-between gap-2">
                          <span
                            className={isDone ? 'text-slate-400 line-through' : 'text-slate-800'}
                          >
                            {lesson.order}. {lesson.title}
                          </span>
                          {progress ? (
                            <Button
                              variant={isDone ? 'ghost' : 'secondary'}
                              disabled={isDone || busy === lesson.id}
                              onClick={() => handleCompleteLesson(course.id, lesson.id)}
                            >
                              {isDone ? t('completedLesson') : t('completeLesson')}
                            </Button>
                          ) : null}
                        </div>
                        {/* Most lessons have no body — the seed writes headings and
                            leaves the words to the business. One that does is worth
                            reading without leaving the list. */}
                        {lesson.assets.some((a) => a.kind === 'video') ? (
                          <LessonVideo
                            lessonId={lesson.id}
                            assets={lesson.assets}
                            onProgress={(position, watched) =>
                              reportProgress(lesson.id, position, watched)
                            }
                          />
                        ) : null}
                        {lesson.content ? (
                          <details className="mt-1">
                            <summary className="cursor-pointer text-xs text-slate-500 hover:text-slate-700">
                              {t('readLesson')}
                            </summary>
                            <div className="mt-2 flex flex-col gap-2 border-l-2 border-slate-200 pl-3 text-sm leading-relaxed text-slate-700">
                              {lesson.content
                                .split('\n')
                                .map((para, i) => (para.trim() ? <p key={i}>{para}</p> : null))}
                            </div>
                          </details>
                        ) : null}
                      </li>
                    );
                  })}
              </ul>
            </Card>
          );
        })
      )}
    </div>
  );
}
