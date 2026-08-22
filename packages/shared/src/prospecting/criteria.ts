/**
 * The two name lists and what qualifies a name on each (docs/56).
 *
 * Taken from the paper worksheet the business already runs on: a SPONSOR NAME
 * LIST scored on Active / Friendly / Money / Relation / Age, and a CUSTOMER
 * NAME LIST scored on Money / Authority / Relation.
 *
 * `money` and `relation` appear on both, and that is deliberate rather than
 * duplication — one person has one relationship with you and one financial
 * position, whichever list you are looking at them on. Scoring them once and
 * showing them on both lists is what stops the same person carrying two
 * contradictory ratings.
 */
export const PROSPECT_LISTS = ['sponsor', 'customer'] as const;
export type ProspectList = (typeof PROSPECT_LISTS)[number];

export interface ProspectCriterion {
  key: string;
  lists: readonly ProspectList[];
  /** Column heading on the paper sheet, kept so the screen reads like it. */
  label: { en: string; th: string };
  help: { en: string; th: string };
}

export const PROSPECT_CRITERIA: readonly ProspectCriterion[] = [
  {
    key: 'active',
    lists: ['sponsor'],
    label: { en: 'Active', th: 'กระตือรือร้น' },
    help: { en: 'Gets things done, takes initiative', th: 'ลงมือทำ ไม่รอใครสั่ง' },
  },
  {
    key: 'friendly',
    lists: ['sponsor'],
    label: { en: 'Friendly', th: 'เข้ากับคนง่าย' },
    help: { en: 'People warm to them', th: 'ผู้คนชอบและไว้ใจ' },
  },
  {
    key: 'money',
    lists: ['sponsor', 'customer'],
    label: { en: 'Money', th: 'กำลังซื้อ' },
    help: { en: 'Can afford to start or buy', th: 'มีกำลังพอที่จะเริ่มหรือซื้อ' },
  },
  {
    key: 'authority',
    lists: ['customer'],
    label: { en: 'Authority', th: 'ตัดสินใจเองได้' },
    help: { en: 'Decides without asking anyone', th: 'ตัดสินใจซื้อได้ด้วยตัวเอง' },
  },
  {
    key: 'relation',
    lists: ['sponsor', 'customer'],
    label: { en: 'Relation', th: 'ความสนิท' },
    help: { en: 'How close you actually are', th: 'สนิทกันแค่ไหนจริง ๆ' },
  },
  {
    key: 'age',
    lists: ['sponsor'],
    label: { en: 'Age', th: 'ช่วงวัย' },
    help: { en: 'In a season of life that fits', th: 'อยู่ในวัยที่พร้อมเริ่ม' },
  },
] as const;

/** 0 means "not rated yet", which is different from rated low. */
export const PROSPECT_SCORE_MIN = 1;
export const PROSPECT_SCORE_MAX = 5;

/** The sheet has twenty rows. Filling it is the exercise (docs/56 §3). */
export const NAME_LIST_TARGET = 20;

export function criteriaFor(list: ProspectList): readonly ProspectCriterion[] {
  return PROSPECT_CRITERIA.filter((c) => c.lists.includes(list));
}

export type ProspectScores = Record<string, number>;

/**
 * A list's total is the sum of ITS OWN criteria only.
 *
 * Adding every rating together instead would make the sponsor total and the
 * customer total incomparable — a name rated on five criteria would always
 * outrank one rated on three, whatever the ratings said.
 */
export function listScore(list: ProspectList, scores: ProspectScores | null): number {
  if (!scores) return 0;
  return criteriaFor(list).reduce((sum, c) => sum + (Number(scores[c.key]) || 0), 0);
}

/** The most a name can score on this list, so a screen can show "18 / 25". */
export function listScoreMax(list: ProspectList): number {
  return criteriaFor(list).length * PROSPECT_SCORE_MAX;
}
