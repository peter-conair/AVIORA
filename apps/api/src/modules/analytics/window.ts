import { DEFAULT_TIMEZONE, startOfMonthInZone } from '../../common/time/zone';

export const ANALYTICS_WINDOWS = ['30d', '90d', 'month'] as const;
export type AnalyticsWindow = (typeof ANALYTICS_WINDOWS)[number];

export const DEFAULT_ANALYTICS_WINDOW: AnalyticsWindow = '30d';

export interface ResolvedWindow {
  key: AnalyticsWindow;
  from: Date;
  to: Date;
  days: number;
  /** The IANA zone the boundaries were resolved in. Echoed, never guessed at. */
  timezone: string;
  /**
   * The window of EQUAL length immediately before `from`. Growth (docs/28 §3)
   * is defined as the change between two equal, adjacent windows, so the
   * comparison window is resolved here rather than at each call site — two
   * call sites is two ways to be off by a day.
   */
  previousFrom: Date;
  previousTo: Date;
}

const DAY_MS = 86_400_000;

/**
 * `month` is the calendar month to date; the other two are rolling.
 *
 * The boundary resolves in the TENANT'S zone (docs/29 §2). "This month" for a
 * Bangkok tenant starts at 17:00 UTC on the last day of the previous month, and
 * a UTC-thinking server would hand them a month that begins at 07:00 local on
 * the 1st — seven hours of their own activity filed under last month, every
 * month. Storage stays UTC; the boundaries below are UTC instants. Only the
 * question "when does this tenant's month start?" is asked in their zone.
 */
export function resolveWindow(
  key: AnalyticsWindow,
  timezone: string = DEFAULT_TIMEZONE,
  now = new Date(),
): ResolvedWindow {
  const to = now;
  const from =
    key === 'month'
      ? startOfMonthInZone(timezone, now)
      : new Date(to.getTime() - (key === '90d' ? 90 : 30) * DAY_MS);
  const span = to.getTime() - from.getTime();
  return {
    key,
    from,
    to,
    days: Math.round(span / DAY_MS),
    timezone,
    previousFrom: new Date(from.getTime() - span),
    previousTo: from,
  };
}

/** The window as it is echoed back — every response states the one it used. */
export function windowEcho(window: ResolvedWindow) {
  return {
    key: window.key,
    from: window.from,
    to: window.to,
    days: window.days,
    timezone: window.timezone,
    comparedWith: { from: window.previousFrom, to: window.previousTo },
  };
}
