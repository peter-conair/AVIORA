/**
 * 6WNY as a programme, not just a follow-up sheet (docs/64).
 *
 * Sprint 40 seeded the tracking sheet — 34 checkpoints across five stages — and
 * that was all "6WNY" meant anywhere in the system: no course, no product, no
 * measurements. A programme you cannot learn, cannot buy and whose results are
 * not recorded is a checklist wearing a programme's name.
 *
 * The course below is a spine, not content: six weeks with a title each, so the
 * learning module has something real to attach to and a coach has somewhere to
 * put the material. The words that go inside are the business's.
 */
export interface SixWnyLessonSeed {
  order: number;
  title: { en: string; th: string };
}

export const SIX_WNY_COURSE_CODE = '6wny';

export const SIX_WNY_LESSONS: readonly SixWnyLessonSeed[] = [
  {
    order: 1,
    title: { en: 'Week 1 — starting, and the measurements', th: 'สัปดาห์ 1 — เริ่มต้นและการวัดผล' },
  },
  {
    order: 2,
    title: { en: 'Week 2 — eating through the week', th: 'สัปดาห์ 2 — การกินตลอดสัปดาห์' },
  },
  {
    order: 3,
    title: { en: 'Week 3 — what to do when it stalls', th: 'สัปดาห์ 3 — ทำอย่างไรเมื่อผลนิ่ง' },
  },
  { order: 4, title: { en: 'Week 4 — clean food', th: 'สัปดาห์ 4 — Clean Food' } },
  { order: 5, title: { en: 'Week 5 — keeping it', th: 'สัปดาห์ 5 — รักษาผลที่ได้' } },
  {
    order: 6,
    title: {
      en: 'Week 6 — before and after, and what next',
      th: 'สัปดาห์ 6 — เปรียบเทียบผลและก้าวต่อไป',
    },
  },
] as const;

/**
 * The pack, seeded WITHOUT a price.
 *
 * What 6WNY costs is the business's number — the same rule as the ladder's
 * thresholds (docs/62 §2) and "5+3" (docs/58 §3.2). It seeds `status: 'draft'`
 * at zero so it cannot be sold by accident, and the shop refuses to list a
 * draft offering.
 */
export const SIX_WNY_OFFERING_CODE = '6wny-pack';
export const SIX_WNY_OFFERING = {
  code: SIX_WNY_OFFERING_CODE,
  name: { en: '6WNY Pack', th: 'แพ็ก 6WNY' },
  description: {
    en: 'The six-week programme pack. Set your own price before selling it.',
    th: 'แพ็กโปรแกรม 6 สัปดาห์ — ตั้งราคาของคุณเองก่อนเปิดขาย',
  },
} as const;
