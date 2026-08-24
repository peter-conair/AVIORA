import { useTranslations } from 'next-intl';
import type { CourseLock } from '@/lib/types';

/**
 * Why a course is shut, in the member's own words (docs/73 §5).
 *
 * The two reasons read differently on purpose. A rule tells somebody what to go
 * and do; a hold names that a person made a decision. Collapsing them into one
 * grey "locked" would hide which of those is happening, and knowing that is the
 * whole point of showing the lock at all.
 */
export function CourseLockNotice({ lock }: { lock: CourseLock }) {
  const t = useTranslations('learning');
  if (lock.state === 'open') return null;

  const text =
    lock.state === 'awaiting_rule'
      ? t('lockedUntil', { requirement: lock.after })
      : lock.state === 'held'
        ? t('lockedHeld', { reason: lock.reason })
        : t('lockedByLeader');

  return (
    <p className="mt-1 flex items-start gap-2 text-xs text-slate-500">
      <span aria-hidden>🔒</span>
      <span>{text}</span>
    </p>
  );
}
