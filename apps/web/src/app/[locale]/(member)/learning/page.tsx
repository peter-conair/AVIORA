'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { api, ApiError } from '@/lib/api-client';
import type {
  Course,
  CourseProgress,
  CoursesResponse,
  LessonCompleteResponse,
  ProgressResponse,
} from '@/lib/types';
import { Badge, statusTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';

export default function LearningPage() {
  const t = useTranslations('learning');
  const tc = useTranslations('common');

  const [courses, setCourses] = useState<Course[]>([]);
  const [progressMap, setProgressMap] = useState<Record<string, CourseProgress>>({});
  const [loading, setLoading] = useState(true);
  const [notEntitled, setNotEntitled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

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
      <h1 className="text-xl font-bold text-slate-900">{t('title')}</h1>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      {loading ? (
        <p className="py-10 text-center text-sm text-slate-500">{tc('loading')}</p>
      ) : courses.length === 0 ? (
        <Card>
          <p className="text-sm text-slate-500">{t('empty')}</p>
        </Card>
      ) : (
        courses.map((course) => {
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
                      <li
                        key={lesson.id}
                        className="flex items-center justify-between gap-2 py-2 text-sm"
                      >
                        <span className={isDone ? 'text-slate-400 line-through' : 'text-slate-800'}>
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
