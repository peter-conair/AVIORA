export const ANALYTICS_WINDOWS = ['30d', '90d', 'month'] as const;
export type AnalyticsWindow = (typeof ANALYTICS_WINDOWS)[number];

export const DEFAULT_ANALYTICS_WINDOW: AnalyticsWindow = '30d';

export interface ResolvedWindow {
  key: AnalyticsWindow;
  from: Date;
  to: Date;
  days: number;
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

/** `month` is the calendar month to date; the other two are rolling. */
export function resolveWindow(key: AnalyticsWindow, now = new Date()): ResolvedWindow {
  const to = now;
  const from =
    key === 'month'
      ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
      : new Date(to.getTime() - (key === '90d' ? 90 : 30) * DAY_MS);
  const span = to.getTime() - from.getTime();
  return {
    key,
    from,
    to,
    days: Math.round(span / DAY_MS),
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
    comparedWith: { from: window.previousFrom, to: window.previousTo },
  };
}
