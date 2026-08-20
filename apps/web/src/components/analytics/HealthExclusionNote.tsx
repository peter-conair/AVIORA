'use client';

import { useTranslations } from 'next-intl';
import { excludesHealthActivity, type AnalyticsDefinitions } from '@/lib/types';

interface HealthExclusionNoteProps {
  definitions: AnalyticsDefinitions | null;
}

/**
 * What "inactive" means on this screen (docs/28 §3).
 *
 * Health activity is deliberately not counted anywhere outside a member's own
 * dashboard, so a member who logs habits every day and does nothing else shows
 * up here as INACTIVE. Being chased for inactivity while diligently using the
 * product is a real harm, so this sits next to every activity number and every
 * inactive-member list — a leader must be able to see it without asking anyone.
 *
 * It renders only when the response's echoed definitions say this scope
 * excludes health activity, which is exactly the scopes where it is true.
 */
export function HealthExclusionNote({ definitions }: HealthExclusionNoteProps) {
  const t = useTranslations('analytics');
  if (!excludesHealthActivity(definitions)) return null;

  return (
    <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
      {t('healthExcluded')}
    </p>
  );
}
