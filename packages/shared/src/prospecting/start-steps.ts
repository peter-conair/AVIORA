/**
 * Starting the business — the first path (docs/63).
 *
 * Spec §25 asks for a configurable onboarding journey. docs/33 recorded it as
 * covered by the learning module, which was wrong in the same way §41 was: a
 * course list is not a journey, and a new member logging in met a dashboard of
 * empty cards with nothing saying which one to touch first.
 *
 * These are the steps in the order the business actually does them, and most of
 * them the system can already SEE — a goal row exists or it does not, a name
 * list has names in it or it does not. Asking somebody to tick a box the system
 * could have read is how a checklist stops being believed.
 */
export interface StartStep {
  key: string;
  label: { en: string; th: string };
  hint: { en: string; th: string };
  /** Where the screen sends them to do it. */
  href: string;
  /**
   * What proves it, when the system can prove it at all. `null` means the
   * member ticks it, and the screen says which kind it is (docs/63 §3).
   */
  derived: 'dream' | 'goal' | 'names' | 'course' | 'checklist' | 'customer' | 'partner' | null;
}

/** The name list is twenty rows on the paper; a start step should not demand all of them. */
export const START_NAMES_TARGET = 10;

export const START_STEPS: readonly StartStep[] = [
  {
    key: 'dream',
    label: { en: 'Write down what you want', th: 'เขียนความฝันของคุณ' },
    hint: { en: 'The life goal on the goal sheet', th: 'เป้าหมายชีวิตในหน้าเป้าหมาย' },
    href: '/prospecting',
    derived: 'dream',
  },
  {
    key: 'goal',
    label: { en: 'Set this month’s target', th: 'ตั้งเป้าเดือนนี้' },
    hint: { en: 'Volume and people', th: 'ยอดและจำนวนคน' },
    href: '/prospecting',
    derived: 'goal',
  },
  {
    key: 'names',
    label: { en: `Write ${START_NAMES_TARGET} names`, th: `เขียนรายชื่อ ${START_NAMES_TARGET} คน` },
    hint: { en: 'Use the Memory Jogger', th: 'ใช้ตัวช่วยจำ' },
    href: '/prospecting',
    derived: 'names',
  },
  {
    key: 'use_products',
    label: { en: 'Use the products yourself', th: 'เริ่มใช้สินค้าเอง' },
    hint: {
      en: 'Tick it on the daily checklist',
      th: 'ติ๊กในเช็คลิสต์ประจำวัน',
    },
    href: '/prospecting',
    derived: 'checklist',
  },
  {
    key: 'course',
    label: { en: 'Start your first course', th: 'เริ่มเรียนคอร์สแรก' },
    hint: { en: 'The learning that gets you there', th: 'ความรู้ที่พาไปถึงเป้า' },
    href: '/learning',
    derived: 'course',
  },
  {
    key: 'meet_coach',
    label: { en: 'Meet your coach', th: 'นัดพบโค้ช' },
    hint: {
      en: 'For the invitation script — the system cannot see this one',
      th: 'ขอสคริปต์ชวน — ข้อนี้ระบบมองไม่เห็น',
    },
    href: '/prospecting',
    // The paper sheet says "Meet Coach for Script" and nothing in the database
    // records a conversation. Better to ask than to guess.
    derived: null,
  },
  {
    key: 'customer',
    label: { en: 'Your first customer', th: 'ลูกค้าคนแรก' },
    hint: { en: 'A lead who bought', th: 'ผู้สนใจที่ปิดได้' },
    href: '/crm',
    derived: 'customer',
  },
  {
    key: 'partner',
    label: { en: 'Your first partner', th: 'ผู้ร่วมธุรกิจคนแรก' },
    hint: { en: 'Somebody you sponsored', th: 'คนที่คุณสปอนเซอร์' },
    href: '/growth',
    derived: 'partner',
  },
] as const;

/** The template code the manual steps are recorded against (docs/63 §4). */
export const START_TEMPLATE_CODE = 'start';
