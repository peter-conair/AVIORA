/**
 * The tracking sheets, as data (docs/59).
 *
 * The Follow Up Sheet, the Diamond Check List and the 6WNY protocol are one
 * primitive wearing three sets of column headings — a template of ordered
 * steps, applied to people, producing dated ticks.
 *
 * They live here as SEED, not as code that reads them: the columns name this
 * business's products (`6WNY`, `eSpring`, `GG Pack`, `UNIT12`), and on a
 * multi-tenant system that means another tenant needs its own columns. A tenant
 * may edit, reorder or delete any of these; nothing in the engine knows their
 * names.
 */
export interface TrackerStepSeed {
  key: string;
  label: { en: string; th: string };
  stage?: { en: string; th: string };
  /**
   * A unit turns this column from a tick into a measurement (docs/64 §2).
   * "ชั่งน้ำหนัก (kg.)" ticked is a note that the scales were used; the number
   * they gave is the thing the customer came for.
   */
  captureUnit?: string;
}

export interface TrackerTemplateSeed {
  code: string;
  name: { en: string; th: string };
  description: { en: string; th: string };
  subjectType: 'lead' | 'member' | 'customer';
  order: number;
  steps: readonly TrackerStepSeed[];
}

const s = (key: string, en: string, th: string, stage?: [string, string]): TrackerStepSeed => ({
  key,
  label: { en, th },
  ...(stage ? { stage: { en: stage[0], th: stage[1] } } : {}),
});

/** A column that asks for a number in `unit`. */
const measure = (key: string, en: string, th: string, unit: string): TrackerStepSeed => ({
  key,
  label: { en, th },
  captureUnit: unit,
});

/** FOLLOW UP SHEET — the master grid a prospect is walked through. */
const FOLLOW_UP: TrackerTemplateSeed = {
  code: 'follow_up',
  name: { en: 'Follow Up Sheet', th: 'ติดตามผล' },
  description: {
    en: 'Everything a prospect is walked through, in order',
    th: 'ทุกอย่างที่พาผู้สนใจเดินผ่าน ตามลำดับ',
  },
  subjectType: 'lead',
  order: 1,
  steps: [
    s('6wny_detox', '6WNY / Detox', '6WNY / Detox'),
    s('clean_food', 'Clean Food', 'Clean Food'),
    s('business_model_7_11', 'Business Model 7-11', 'Business Model 7-11'),
    s('business_plan', 'Business Plan', 'แผนธุรกิจ'),
    s('big_picture', 'Big Picture', 'ภาพใหญ่'),
    s('house_brand', 'House Brand', 'House Brand'),
    s('two_years_retired', '2 Years Retired', '2 Years Retired'),
    s('business_uniqueness', 'Business Uniqueness', 'จุดต่างของธุรกิจ'),
    s('artistry', 'Artistry', 'Artistry'),
    s('espring', 'eSpring', 'eSpring'),
    s('atmosphere', 'Atmosphere Sky/Drive', 'Atmosphere Sky/Drive'),
    s('check_in', 'Check-in', 'Check-in'),
    s('five_steps', '5 Steps', '5 ขั้นตอน'),
    s('gg_click_6wny', 'GG Click 6WNY', 'GG Click 6WNY'),
    s('gg_begins', 'GG Begins', 'GG Begins'),
    s('gg_bridge', 'GG Bridge', 'GG Bridge'),
    s('6wny_beginner', '6WNY Beginner', '6WNY Beginner'),
    s('6wny_advance', '6WNY Advance', '6WNY Advance'),
    s('pack_1', 'Pack 1', 'Pack 1'),
    s('pack_2', 'Pack 2', 'Pack 2'),
    s('pack_3', 'Pack 3', 'Pack 3'),
    s('pack_4_7', 'Pack 4-7', 'Pack 4-7'),
    s('pack_8_11', 'Pack 8-11', 'Pack 8-11'),
    s('pack_12_15', 'Pack 12-15', 'Pack 12-15'),
    s('register', 'Register', 'สมัคร'),
    // The sheet draws a "GT Qualification" band over this run of columns; it
    // survives here as a stage so the grid can still show the band.
    s('name_list', 'Name List', 'รายชื่อ', ['GT Qualification', 'คุณสมบัติ GT']),
    s('call_prospects', 'Call prospects', 'โทรเปิดสาย', ['GT Qualification', 'คุณสมบัติ GT']),
    s('three_packs_intro', 'Intro 3 packs', 'เกลี่ยวรับปัง 3 ข้อ', [
      'GT Qualification',
      'คุณสมบัติ GT',
    ]),
    s('product_experience', 'Product experience', 'สินค้า/ตรวจสุขภาพ', [
      'GT Qualification',
      'คุณสมบัติ GT',
    ]),
    s('three_packs', '3 Packs', '3 Packs', ['GT Qualification', 'คุณสมบัติ GT']),
    s('cad_passion', 'CAD Passion', 'CAD Passion', ['GT Qualification', 'คุณสมบัติ GT']),
    s('gg_xtreme', 'GG Xtreme', 'GG Xtreme', ['GT Qualification', 'คุณสมบัติ GT']),
    s('cep', 'CEP', 'CEP', ['GT Qualification', 'คุณสมบัติ GT']),
    s('sop', 'SOP', 'SOP', ['GT Qualification', 'คุณสมบัติ GT']),
    s('abo', 'ABO', 'ABO', ['GT Qualification', 'คุณสมบัติ GT']),
    s('member', 'Member', 'Member', ['GT Qualification', 'คุณสมบัติ GT']),
    s('five_thousand_pv', '5000 PV', '5000 PV', ['GT Qualification', 'คุณสมบัติ GT']),
    s('case', 'Case', 'เคส'),
    s('social_network', 'Social Network', 'Social Network'),
    s('hm_training', 'HM Training', 'HM Training'),
    s('hundred_dream_lists', '100 Dream Lists', '100 Dream Lists'),
    s('workshop', 'Workshop', 'Workshop'),
    s('start_course_6wny', 'Start Course 6WNY', 'เริ่มคอร์ส 6WNY'),
    s('breakfast_set', 'Breakfast Set', 'Breakfast Set'),
  ],
};

/** DIAMOND CHECK LIST — the milestones a line is developed through. */
const DIAMOND: TrackerTemplateSeed = {
  code: 'diamond',
  name: { en: 'Diamond Check List', th: 'เช็คลิสต์ไดมอนด์' },
  description: {
    en: 'Milestones each line is developed through',
    th: 'ขั้นการพัฒนาของแต่ละสาย',
  },
  subjectType: 'member',
  order: 2,
  steps: [
    s('three_packs', 'Uses 3 Packs', 'พลิงชักกระ 3 Packs'),
    s('uses_products', 'Uses the products', 'ใช้สินค้า'),
    s('fifteen_packs', 'Uses 15 Packs', 'พลิงชักกระ 15 Packs'),
    s('attends_center', 'At CENTER every time', 'เข้า CENTER ทุกครั้ง'),
    s('attends_major', 'At the major function', 'เข้างานใหญ่'),
    s('has_case', 'Has a case', 'มีเคส'),
    s('is_gt', 'Is GT', 'เป็น GT'),
    s('teaches_5_3', 'Teaches the 5+3 basics', 'ศึกษาวิธีพื้นฐาน 5+3'),
    s('fifteen_plus', 'Does 15+', 'ทำ 15+'),
    s('twelve_percent', 'Is 12%', 'เป็น 12%'),
    s('unit_12', 'Is UNIT12', 'เป็น UNIT12'),
    s('diamond_club', 'In Diamond Club', 'เข้า Diamond Club'),
    s('turn_pro', 'Is Turn Pro', 'เป็น Turn Pro'),
    s('turn_pro_plus', 'Is Turn Pro+', 'เป็น Turn Pro+'),
  ],
};

/** FOLLOW UP 6WNY — a staged protocol, timed from the start of the course. */
const SIX_WNY: TrackerTemplateSeed = {
  code: 'follow_up_6wny',
  name: { en: '6WNY Follow-up', th: 'ติดตามผล 6WNY' },
  description: {
    en: 'The 6WNY protocol, day by day',
    th: 'ขั้นตอนติดตามคอร์ส 6WNY ตามวัน',
  },
  subjectType: 'customer',
  order: 3,
  steps: [
    ...[
      measure('before_weight', 'Weight (kg)', 'ชั่งน้ำหนัก', 'kg'),
      measure('before_measure', 'Waist (cm)', 'วัดรอบเอว', 'cm'),
      s('before_photo', 'Photo before', 'ถ่ายรูป Before'),
      s('before_member_pack', '6WNY Member Pack', '6WNY Member Pack'),
      s('before_how_to_eat', 'Taught how to eat', 'สอนวิธีการกิน'),
      s('before_order', 'Ordered', 'สั่งวิธีการแนะนำในนิจ'),
    ].map((step) => ({ ...step, stage: { en: 'Before the course', th: 'ก่อนเริ่มคอร์ส' } })),
    ...[
      measure('d4_weight', 'Weight (kg)', 'ชั่งน้ำหนัก', 'kg'),
      measure('d4_measure', 'Waist (cm)', 'วัดรอบเอว', 'cm'),
      s('d4_encourage', 'Encouraged', 'ทำแคปชั่นให้คำชมเชย'),
      s('d4_share', 'Shared their result', 'เชียร์รังจังโซด โิตากนพร้'),
      s('d4_invite_buzz', 'Invited to Buzz Click 6WNY', 'ชวนเข้า Buzz Click 6WNY ช่วงเทรก'),
    ].map((step) => ({ ...step, stage: { en: 'Day 4', th: '4 วัน' } })),
    ...[
      measure('d7_weight', 'Weight (kg)', 'ชั่งน้ำหนัก', 'kg'),
      measure('d7_measure', 'Waist (cm)', 'วัดรอบเอว', 'cm'),
      s('d7_encourage', 'Encouraged', 'ทำแคปชั่นให้คำชมเชย'),
      s('d7_wording', 'Taught the wording', 'สอน wording การชวนคนมาต่อเนื่อง'),
      s('d7_share', 'Shared their result', 'เชียร์รังจังโซด โิตากนพร้'),
      s('d7_clean_food', 'Clean Food', 'Clean Food'),
      s('d7_beginner', '6WNY Beginner', '6WNY Beginner'),
    ].map((step) => ({ ...step, stage: { en: 'Day 7', th: '7 วัน' } })),
    ...[
      measure('d14_weight', 'Weight (kg)', 'ชั่งน้ำหนัก', 'kg'),
      measure('d14_measure', 'Waist (cm)', 'วัดรอบเอว', 'cm'),
      s('d14_photo_after', 'Photo before/after', 'ถ่ายรูป Before After'),
      s('d14_model_7_11', 'Model 7-11', 'Model 7-11'),
      s('d14_business_plan', 'Business Plan', 'Business Plan'),
      s('d14_gg_pack_1', 'GG Pack 1', 'GG Pack 1'),
    ].map((step) => ({ ...step, stage: { en: 'Day 14', th: '14 วัน' } })),
    ...[
      measure('w3_weight', 'Weight (kg)', 'ชั่งน้ำหนัก', 'kg'),
      measure('w3_measure', 'Waist (cm)', 'วัดรอบเอว', 'cm'),
      s('w3_two_years', '2 Years retire', '2 Years retire'),
      s('w3_gg_pack_2', 'GG Pack 2', 'GG Pack 2'),
      s('w3_6wny_advance', '6WNY Advance', '6WNY Advance'),
      s('w3_breakfast_set', 'Breakfast Set', 'Breakfast Set'),
      s('w3_detox', 'Detox', 'Detox'),
      s('w3_register', 'Register', 'Register'),
      s('w3_online', 'Taught online', 'สอนสั่ง Online'),
      s('w3_follow_up_hm', 'Follow up HM + into the system', 'Follow up HM + เกาเข้าระบบ'),
    ].map((step) => ({ ...step, stage: { en: 'Week 3 onward', th: 'สัปดาห์ที่ 3 เป็นต้นไป' } })),
  ],
};

export const TRACKER_TEMPLATE_SEEDS: readonly TrackerTemplateSeed[] = [FOLLOW_UP, DIAMOND, SIX_WNY];
