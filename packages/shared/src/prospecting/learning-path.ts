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
/**
 * A lesson heading, and optionally the lesson itself.
 *
 * `body` is almost always absent, and that is the design (docs/67 §2): the
 * seed lays out headings for the business to write under, because putting this
 * codebase's words into a tenant's training is a way of having opinions on
 * their behalf. The exception is material that is true of the plan FAMILY
 * rather than of any one plan — how a differential is computed does not vary
 * by company, and a member who does not know it cannot read their own payout.
 * docs/69 is where that line is argued.
 */
export interface PathLessonSeed {
  en: string;
  th: string;
  body?: { en: string; th: string };
}

export interface PathCourseSeed {
  code: string;
  title: { en: string; th: string };
  lessons: PathLessonSeed[];
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

/** `[heading_en, heading_th]`, or the same plus `[body_en, body_th]`. */
type LessonTuple = [string, string] | [string, string, [string, string]];

const c = (code: string, en: string, th: string, lessons: LessonTuple[]): PathCourseSeed => ({
  code,
  title: { en, th },
  lessons: lessons.map(([e, t, body]) => ({
    en: e,
    th: t,
    ...(body ? { body: { en: body[0], th: body[1] } } : {}),
  })),
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
      // The one seeded course that carries its own words. What a differential
      // is does not vary by company, and a member who cannot read their own
      // payout is not equipped by a heading (docs/69 §3, §5).
      c('path-plan', 'How the plan pays', 'แผนจ่ายเงินอย่างไร', [
        [
          'Retail margin — the part with no downline in it',
          'กำไรขายปลีก — ส่วนที่ไม่เกี่ยวกับสายงานเลย',
          [
            'The gap between what you pay for a product and what a customer pays for it is yours, and it arrives whether or not you ever sponsor anybody.\n\nIt is the first income in the plan and the one most often left out of the explanation — which is unfortunate, because it is also the only one that is entirely within your control. Somebody who sells and never builds a team still has a business. Somebody who builds a team and never sells has a hobby with paperwork.',
            'ส่วนต่างระหว่างราคาที่คุณซื้อกับราคาที่ลูกค้าจ่ายเป็นของคุณ และคุณได้รับไม่ว่าจะเคยสปอนเซอร์ใครหรือไม่\n\nนี่คือรายได้ก้อนแรกของแผน และเป็นก้อนที่ถูกละไว้บ่อยที่สุดเวลาอธิบาย ซึ่งน่าเสียดาย เพราะมันเป็นก้อนเดียวที่อยู่ในการควบคุมของคุณทั้งหมด คนที่ขายอย่างเดียวไม่เคยสร้างทีมก็ยังมีธุรกิจ ส่วนคนที่สร้างทีมแต่ไม่เคยขาย มีแค่งานอดิเรกที่มีเอกสารเยอะ',
          ],
        ],
        [
          'Two figures on every product, and why',
          'สินค้าหนึ่งชิ้นมีสองตัวเลข และทำไมต้องมีสอง',
          [
            'Products carry a point figure and a money figure. The point figure ranks you; the money figure is what your percentage multiplies.\n\nThey are separate on purpose. Prices change and currencies move, and if one number did both jobs, a repricing in a warehouse would push people up and down the ladder without anybody selling anything differently. Two figures keep the ranking stable while the money follows the market.',
            'สินค้าแต่ละชิ้นมีตัวเลขคะแนนและตัวเลขเงิน ตัวเลขคะแนนใช้จัดระดับของคุณ ส่วนตัวเลขเงินคือฐานที่เปอร์เซ็นต์ของคุณไปคูณ\n\nที่แยกกันเพราะตั้งใจ ราคาปรับได้ ค่าเงินขยับได้ ถ้าใช้ตัวเลขเดียวทำสองหน้าที่ การปรับราคาในคลังสินค้าจะดันคนขึ้นลงบนขั้นบันไดทั้งที่ไม่มีใครขายต่างไปจากเดิมเลย การมีสองตัวเลขทำให้การจัดระดับนิ่ง ในขณะที่เงินวิ่งตามตลาด',
          ],
        ],
        [
          'The ladder, and why it resets every month',
          'ขั้นบันได และทำไมต้องรีเซ็ตทุกเดือน',
          [
            'Your group total in a calendar month buys a percentage, on a scale that steps upward — the levels the business talks in when it says "12%" or "21%".\n\nThe month is the whole rule. A level is re-earned, not kept, which is why the tracking sheets matter and why a strong month is not a permanent promotion. Your own plan sets the numbers on each rung; ask for them in writing rather than from memory, including whose volume counts toward yours.',
            'ยอดรวมของกลุ่มคุณในหนึ่งเดือนปฏิทินซื้อเปอร์เซ็นต์ให้คุณ ตามสเกลที่ไล่ขึ้นเป็นขั้น — คือระดับที่ธุรกิจนี้พูดถึงเวลาบอกว่า "12%" หรือ "21%"\n\nคำว่าเดือนคือกฎทั้งหมด ระดับนี้ต้องทำใหม่ ไม่ใช่ได้แล้วได้เลย นั่นคือเหตุผลที่แผ่นติดตามผลสำคัญ และเป็นเหตุผลที่เดือนที่ทำได้ดีไม่ใช่การเลื่อนขั้นถาวร ตัวเลขของแต่ละขั้นเป็นของแผนที่คุณทำอยู่ ขอเป็นลายลักษณ์อักษรดีกว่าจำต่อ ๆ กันมา รวมถึงว่ายอดของใครบ้างที่นับรวมเป็นของคุณ',
          ],
        ],
        [
          'Differential — you are paid for the step, not the pile',
          'ส่วนต่าง — คุณได้ค่าตอบแทนจากขั้น ไม่ใช่จากกอง',
          [
            'You receive your own percentage minus the percentage already paid to the line the volume came through. At 21% with a line running at 15%, the 6% difference on that line is yours.\n\nThis is the single most useful thing to understand about your payout, because it explains something that surprises people: as somebody below you grows, your percentage on them shrinks. That is the plan working, not a mistake. You are paid for the height of the step between you, and the answer to a shrinking step has always been to widen — a new line starts at the bottom of the ladder, which is where the step is tallest.',
            'คุณได้เปอร์เซ็นต์ของตัวเอง ลบด้วยเปอร์เซ็นต์ที่สายนั้นได้ไปแล้ว ถ้าคุณอยู่ที่ 21% และสายหนึ่งทำได้ 15% ส่วนต่าง 6% ของสายนั้นเป็นของคุณ\n\nนี่คือเรื่องที่มีประโยชน์ที่สุดที่ควรเข้าใจเกี่ยวกับรายได้ของคุณ เพราะมันอธิบายสิ่งที่หลายคนแปลกใจ คือยิ่งคนข้างล่างโตขึ้น เปอร์เซ็นต์ที่คุณได้จากเขายิ่งลดลง นั่นคือแผนทำงานถูกต้อง ไม่ใช่ความผิดพลาด คุณได้ค่าตอบแทนตามความสูงของขั้นระหว่างคุณกับเขา และคำตอบของขั้นที่เตี้ยลงคือการขยายออกด้านข้างเสมอ เพราะสายใหม่เริ่มจากล่างสุดของบันได ซึ่งเป็นจุดที่ขั้นสูงที่สุด',
          ],
        ],
        [
          'Breakaway — when a line leaves your group total',
          'การแยกสาย — เมื่อสายหนึ่งออกจากยอดกลุ่มของคุณ',
          [
            'When a line reaches the top rung, it breaks away: its volume stops counting toward your group total, and the differential on it ends. In its place you receive a leadership bonus on that line, and at higher levels bonuses that reach further down.\n\nRead that twice, because it sounds like a loss and is not one. A plan that paid you less for building a strong leader would ensure nobody ever built one. It is also why the levels above the ladder are counted in lines rather than in volume — three qualified lines, six qualified lines, each with its own name. From here the question stops being "how much did I sell" and becomes "how many people did I take all the way", which is a different job and needs different weeks.',
            'เมื่อสายใดขึ้นถึงขั้นสูงสุด สายนั้นจะแยกออก ยอดของเขาหยุดนับรวมเป็นยอดกลุ่มของคุณ และส่วนต่างจากสายนั้นสิ้นสุดลง สิ่งที่เข้ามาแทนคือโบนัสผู้นำจากสายนั้น และเมื่อคุณสูงขึ้นก็จะมีโบนัสที่ลงลึกกว่านั้นอีก\n\nอ่านสองรอบ เพราะฟังดูเหมือนเสียประโยชน์ แต่ไม่ใช่ แผนที่จ่ายคุณน้อยลงเพราะคุณสร้างผู้นำเก่งได้ ย่อมทำให้ไม่มีใครยอมสร้างผู้นำ และนี่คือเหตุผลที่ระดับเหนือขั้นบันไดนับกันเป็นจำนวนสาย ไม่ใช่ยอดขาย เช่น สามสายที่ทำได้ หกสายที่ทำได้ ซึ่งแต่ละระดับมีชื่อเรียกของตัวเอง จากจุดนี้คำถามจะเปลี่ยนจาก "ฉันขายได้เท่าไร" เป็น "ฉันพาคนไปได้สุดทางกี่คน" ซึ่งเป็นงานคนละแบบ และต้องใช้เวลาคนละแบบ',
          ],
        ],
        [
          'What the plan is not',
          'สิ่งที่แผนนี้ไม่ใช่',
          [
            'Every figure in this course is paid on product that somebody bought. Nothing in a lawful plan of this family pays you for a person joining, and that distinction is the line between a compensation plan and a scheme.\n\nIt is worth being able to say plainly, because you will be asked — usually by somebody who is right to ask. If you ever cannot trace a payment back to a sale, that is the question to take to your upline before you take it any further.',
            'ทุกตัวเลขในคอร์สนี้จ่ายจากสินค้าที่มีคนซื้อจริง ไม่มีอะไรในแผนที่ถูกกฎหมายของตระกูลนี้ที่จ่ายให้คุณเพราะมีคนสมัครเข้ามา และความต่างข้อนี้คือเส้นแบ่งระหว่างแผนการตลาดกับแชร์ลูกโซ่\n\nควรพูดให้ชัดได้ เพราะคุณจะถูกถามแน่นอน และมักถูกถามโดยคนที่ถามถูกแล้ว ถ้าเมื่อไรคุณสาวรายการจ่ายกลับไปหาการขายไม่ได้ นั่นคือคำถามที่ต้องถามอัพไลน์ของคุณก่อนจะเดินต่อ',
          ],
        ],
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
