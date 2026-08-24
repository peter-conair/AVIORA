'use client';

import { useEffect, useRef } from 'react';
import { useLocale } from 'next-intl';
import { API_URL } from '@/lib/api-client';
import type { LessonAssetRef } from '@/lib/types';

interface LessonVideoProps {
  lessonId: string;
  assets: LessonAssetRef[];
  /** Fired with seconds actually watched since the last report — never a total. */
  onProgress: (positionSeconds: number, watchedDeltaSeconds: number) => void;
}

/** How often playback is reported. Short enough that a closed tab loses little. */
const HEARTBEAT_MS = 10_000;

/**
 * A lesson video (docs/73 §6–§7).
 *
 * The source is the API's own origin, not this app's — the same shape the
 * customer photograph uses, and for the same reason: the bytes are behind an
 * authenticated route, and a relative path would ask the web server for a file
 * it has never heard of.
 *
 * Watched time is measured by counting the wall clock while the element is
 * actually playing, and reported as a DELTA. Reading `currentTime` instead
 * would let a drag of the scrubber count as having watched everything it
 * skipped, which is exactly what a completion figure must not reward.
 */
export function LessonVideo({ lessonId, assets, onProgress }: LessonVideoProps) {
  const locale = useLocale();
  const ref = useRef<HTMLVideoElement>(null);
  /** Milliseconds of real playback banked since the last report. */
  const watched = useRef(0);
  const playingSince = useRef<number | null>(null);

  const video = assets.find((a) => a.kind === 'video');
  const captions = assets.find((a) => a.kind === 'captions');

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const bank = () => {
      if (playingSince.current === null) return;
      watched.current += Date.now() - playingSince.current;
      playingSince.current = Date.now();
    };
    const onPlay = () => {
      playingSince.current = Date.now();
    };
    const onPause = () => {
      bank();
      playingSince.current = null;
    };

    const report = () => {
      bank();
      const seconds = Math.floor(watched.current / 1000);
      // Nothing to say is worth no request. A paused video reporting zeroes
      // every ten seconds is a heartbeat that only costs battery.
      if (seconds <= 0) return;
      watched.current -= seconds * 1000;
      onProgress(Math.floor(el.currentTime), seconds);
    };

    el.addEventListener('play', onPlay);
    el.addEventListener('pause', onPause);
    el.addEventListener('ended', onPause);
    const timer = window.setInterval(report, HEARTBEAT_MS);

    return () => {
      // One last report on the way out, so closing the tab mid-lesson does not
      // throw away the minutes since the previous heartbeat.
      report();
      window.clearInterval(timer);
      el.removeEventListener('play', onPlay);
      el.removeEventListener('pause', onPause);
      el.removeEventListener('ended', onPause);
    };
  }, [lessonId, onProgress]);

  if (!video) return null;

  const src = `${API_URL}/learning/lessons/${lessonId}/media?kind=video&locale=${locale}`;

  return (
    <video
      ref={ref}
      controls
      preload="metadata"
      playsInline
      // The cookie has to travel to a route that checks who is watching.
      crossOrigin="use-credentials"
      className="mt-2 w-full rounded-lg bg-black"
    >
      <source src={src} />
      {captions ? (
        <track
          kind="captions"
          srcLang={locale}
          default
          src={`${API_URL}/learning/lessons/${lessonId}/media?kind=captions&locale=${locale}`}
        />
      ) : null}
    </video>
  );
}
