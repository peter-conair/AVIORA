/**
 * The performance ladder — 6% · 9% · 12% · 15% · 18% · 21% (docs/62).
 *
 * These are the levels the business actually talks in, and the Diamond Check
 * List already names three of them (`เป็น 12%`, `ทำ 15+`, `เป็น UNIT12`). They
 * map onto the rank engine exactly: a level is the highest rank whose rules all
 * pass, recomputed monthly, which is what a performance bonus level IS.
 *
 * ## The thresholds are deliberately not here
 *
 * What group volume earns 12% is the business's own number — set by the
 * compensation plan it operates under, revised by that plan, and different for
 * another tenant. Writing one here would produce a figure that looks
 * authoritative because it is in the code, which is the exact failure this
 * codebase keeps finding.
 *
 * So the ladder seeds with the right SHAPE — six levels, correctly named, each
 * qualified on group volume in a calendar month — and a threshold of zero, as
 * `draft`. Draft ranks are never evaluated, and `activate` refuses a rank whose
 * thresholds are still zero (docs/62 §3). The tenant supplies its numbers; the
 * system supplies the structure.
 */
export interface RankLadderSeed {
  code: string;
  name: { en: string; th: string };
  level: number;
  percent: number;
}

export const RANK_LADDER: readonly RankLadderSeed[] = [
  { code: 'pct_6', name: { en: '6%', th: '6%' }, level: 1, percent: 6 },
  { code: 'pct_9', name: { en: '9%', th: '9%' }, level: 2, percent: 9 },
  { code: 'pct_12', name: { en: '12%', th: '12%' }, level: 3, percent: 12 },
  { code: 'pct_15', name: { en: '15%', th: '15%' }, level: 4, percent: 15 },
  { code: 'pct_18', name: { en: '18%', th: '18%' }, level: 5, percent: 18 },
  { code: 'pct_21', name: { en: '21%', th: '21%' }, level: 6, percent: 21 },
] as const;

/**
 * Group volume in the calendar month — the metric a performance level is
 * actually earned on, and a `calendar_month` window because the level is
 * re-earned every month rather than kept.
 */
export const LADDER_METRIC = 'downline_volume';
export const LADDER_WINDOW = 'calendar_month';

/** A ladder rank still carrying this threshold has not been configured. */
export const LADDER_UNSET_THRESHOLD = 0;
