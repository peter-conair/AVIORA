/**
 * The learning path — what to know, and what to do (docs/67).
 *
 * Two questions, asked at every stage of the business, and the product had
 * halves of both lying around without a line joining them:
 *
 *   · what to DO   — the start path (docs/63) covers the first stage and stops
 *   · what to KNOW — `recommendedCourseIds` per rank (docs/62 §4), which is
 *                    empty until an admin fills it, so in practice: nothing
 *
 * This joins them and fills the gap in the middle. It is not a third engine:
 * stages are derived from the same evidence the start path reads, courses are
 * ordinary courses, and progress is ordinary `learning_progress`.
 */
export interface PathCourseSeed {
  code: string;
  title: { en: string; th: string };
  lessons: { en: string; th: string }[];
}

export interface PathActionSeed {
  key: string;
  label: { en: string; th: string };
  /** What proves it. `null` means the member says so. */
  derived: 'dream' | 'goal' | 'names' | 'course' | 'customer' | 'partner' | 'duplicated' | null;
  href: string;
}

export interface PathStageSeed {
  key: string;
  label: { en: string; th: string };
  /**
   * How the system knows this stage is BEHIND the member. Deliberately the
   * same evidence the start path uses — a member should never be told they are
   * at two different places by two screens.
   */
  clearedBy: 'names' | 'customer' | 'partner' | 'duplicated' | 'never';
  courses: readonly PathCourseSeed[];
  actions: readonly PathActionSeed[];
}

const c = (code: string, en: string, th: string, lessons: [string, string][]): PathCourseSeed => ({
  code,
  title: { en, th },
  lessons: lessons.map(([e, t]) => ({ en: e, th: t })),
});

const a = (
  key: string,
  en: string,
  th: string,
  derived: PathActionSeed['derived'],
  href = '/prospecting',
): PathActionSeed => ({ key, label: { en, th }, derived, href });

export const LEARNING_PATH: readonly PathStageSeed[] = [
  {
    key: 'know_the_business',
    label: { en: '1 · Know what you are doing', th: '1 · รู้ว่ากำลังทำอะไร' },
    clearedBy: 'names',
    courses: [
      c('path-basics', 'The business, in one sitting', 'ธุรกิจนี้คืออะไร', [
        ['Where the money comes from', 'รายได้มาจากไหน'],
        ['What a customer is, and what a partner is', 'ลูกค้ากับผู้ร่วมธุรกิจต่างกันอย่างไร'],
        ['The five steps', '5 ขั้นตอน'],
      ]),
      c('path-products', 'The products you will use', 'สินค้าที่คุณจะใช้เอง', [
        ['Use it before you sell it', 'ใช้ก่อนขาย'],
        ['The starter range', 'สินค้ากลุ่มเริ่มต้น'],
      ]),
    ],
    actions: [
      a('dream', 'Write down what you want', 'เขียนความฝันของคุณ', 'dream'),
      a('goal', 'Set this month’s target', 'ตั้งเป้าเดือนนี้', 'goal'),
      a('names', 'Write ten names', 'เขียนรายชื่อ 10 คน', 'names'),
    ],
  },
  {
    key: 'first_customer',
    label: { en: '2 · Your first customer', th: '2 · ลูกค้าคนแรก' },
    clearedBy: 'customer',
    courses: [
      c('path-invite', 'Inviting, without being strange about it', 'การชวนแบบไม่อึดอัด', [
        ['Why scripts exist', 'ทำไมต้องมีสคริปต์'],
        ['The invitation, start to finish', 'ชวนตั้งแต่ต้นจนจบ'],
        ['When they say no', 'เมื่อเขาปฏิเสธ'],
      ]),
      c('path-follow-up', 'Following up so it does not go cold', 'ติดตามไม่ให้เย็น', [
        ['What follow-up actually is', 'ติดตามคืออะไรจริง ๆ'],
        ['Using the follow-up sheet', 'ใช้แผ่นติดตามผล'],
      ]),
    ],
    actions: [
      a('start_course', 'Start your first course', 'เริ่มเรียนคอร์สแรก', 'course', '/learning'),
      a('customer', 'Close your first customer', 'ปิดลูกค้าคนแรก', 'customer', '/crm'),
    ],
  },
  {
    key: 'first_partner',
    label: { en: '3 · Your first partner', th: '3 · ผู้ร่วมธุรกิจคนแรก' },
    clearedBy: 'partner',
    courses: [
      c('path-sponsor', 'Sponsoring somebody properly', 'การสปอนเซอร์ที่ถูกต้อง', [
        ['Who to look for', 'มองหาใคร'],
        ['Showing the plan', 'เปิดแผน'],
        ['The first week after they join', 'สัปดาห์แรกหลังเขาเข้ามา'],
      ]),
    ],
    actions: [a('partner', 'Sponsor your first partner', 'สปอนเซอร์คนแรก', 'partner', '/growth')],
  },
  {
    key: 'duplicate',
    label: { en: '4 · Teach it, do not do it for them', th: '4 · สอนให้ทำ ไม่ใช่ทำให้' },
    // The whole business turns on this stage and nothing before it does.
    clearedBy: 'duplicated',
    courses: [
      c('path-duplicate', 'Duplication', 'การทำซ้ำ (Duplication)', [
        ['Why doing it for them makes it stop', 'ทำให้เขา แล้วทำไมมันหยุด'],
        ['Teaching the name list', 'สอนทำรายชื่อ'],
        ['Running a weekly review with somebody', 'นำ Weekly Update ให้ลูกทีม'],
      ]),
    ],
    actions: [
      a(
        'duplicated',
        'A partner of yours sponsors somebody',
        'ลูกทีมของคุณสปอนเซอร์คนแรกได้',
        'duplicated',
        '/growth',
      ),
    ],
  },
  {
    key: 'build',
    label: { en: '5 · Build the lines', th: '5 · สร้างสาย' },
    // No end: the ladder takes over from here (docs/62).
    clearedBy: 'never',
    courses: [
      c('path-lines', 'Working a line', 'การดูแลสาย', [
        ['Reading the Diamond check list', 'อ่านเช็คลิสต์ไดมอนด์'],
        ['Who has stopped, and what to do', 'ใครหยุดนิ่ง แล้วทำอย่างไร'],
      ]),
    ],
    actions: [],
  },
] as const;

/** Every course the path seeds, flat. */
export function pathCourses(): PathCourseSeed[] {
  return LEARNING_PATH.flatMap((stage) => [...stage.courses]);
}
