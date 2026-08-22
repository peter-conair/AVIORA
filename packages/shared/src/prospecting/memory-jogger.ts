/**
 * The Memory Jogger (docs/56 §4).
 *
 * "Write down twenty names" produces four and a blank stare. The paper sheet
 * solves it by not asking for names at all — it asks who cuts your hair, who
 * sold you your car, who you sat next to in school — and the names arrive as a
 * side effect. This is that sheet as data.
 *
 * Every name added through it keeps the prompt that produced it, so the report
 * can answer which prompts actually work for this person and which are dead
 * weight (docs/56 §6). That is the one thing the paper cannot do.
 */
export interface JoggerPrompt {
  key: string;
  label: { en: string; th: string };
}

export interface JoggerCategory {
  key: string;
  label: { en: string; th: string };
  prompts: readonly JoggerPrompt[];
}

const p = (key: string, en: string, th: string): JoggerPrompt => ({ key, label: { en, th } });

export const MEMORY_JOGGER: readonly JoggerCategory[] = [
  {
    key: 'family',
    label: { en: 'Who are your relatives', th: 'ครอบครัว' },
    prompts: [
      p('parents', 'Parents', 'พ่อแม่'),
      p('grandparents', 'Grandparents', 'ปู่ ย่า ตา ยาย'),
      p('siblings', 'Brothers / Sisters', 'พี่ น้อง'),
      p('aunts_uncles', 'Aunts / Uncles', 'ลุง ป้า น้า อา'),
      p('cousins', 'Cousins', 'ลูกพี่ ลูกน้อง'),
      p('children', 'Children', 'ลูก หลาน'),
    ],
  },
  {
    key: 'friends',
    label: { en: 'Who are your friends', th: 'เพื่อน' },
    prompts: [
      p('close_friends', 'Close friends', 'เพื่อนสนิท'),
      p('classmates', 'Classmates', 'เพื่อนในห้องเรียน'),
      p('faculty_friends', 'Faculty friends', 'เพื่อนในคณะ'),
      p('college_friends', 'College friends', 'เพื่อนต่างคณะ'),
      p('high_school', 'High school', 'เพื่อนมัธยมปลาย'),
      p('tutoring_school', 'Tutoring school', 'เพื่อนเรียนพิเศษ'),
      p('primary_school', 'Primary school', 'เพื่อนประถม'),
      p('secondary_school', 'Secondary school', 'เพื่อนมัธยมต้น'),
      p('club_friends', 'Club friends', 'เพื่อนทำกิจกรรม'),
      p('friends_of_friends', "Friends' friends", 'เพื่อนของเพื่อน'),
      p('co_workers', 'Co-workers', 'เพื่อนร่วมงาน'),
      p('neighbors', 'Neighbors', 'เพื่อนบ้าน'),
    ],
  },
  {
    key: 'regular_shops',
    label: { en: 'Who are our regulars', th: 'ร้านประจำ' },
    prompts: [
      p('beauty_therapist', 'Beauty therapist', 'ช่างทำผม'),
      p('dentist_doctor', 'Dentist / Doctor', 'หมอ หมอฟัน'),
      p('lawyer_accountant', 'Lawyer / Accountant', 'ทนาย นักบัญชี'),
      p('bank_manager', 'Bank manager', 'ผู้จัดการแบงค์'),
      p('veterinarian', 'Veterinarian', 'สัตวแพทย์'),
      p('optometrist', 'Optometrist', 'ร้านขายแว่นตา'),
      p('insurance_broker', 'Insurance broker', 'คนขายประกัน'),
      p('florist', 'Florist', 'ร้านขายดอกไม้'),
      p('restaurant', 'Restaurant', 'ร้านอาหาร'),
      p('teacher_trainer', 'Teacher / Trainer', 'ครู'),
    ],
  },
  {
    key: 'acquaintances',
    label: { en: 'Someone who..', th: 'คนรู้จักที่..' },
    prompts: [
      p('from_temple', 'Friend from church / temple', 'ชอบทำบุญ'),
      p('lives_next_door', 'Lives next door', 'อาศัยอยู่ใกล้บ้าน'),
      p('best_man', 'Best man', 'แขกงานแต่งงาน'),
      p('relative_elders', 'Aunts / Uncles', 'ลุง ป้า น้า อา'),
      p('previous_co_workers', 'Previous co-workers', 'เพื่อนที่ทำงานเก่า'),
      p('owner_of_restaurant', 'Owner of restaurant', 'เจ้าของร้านอาหาร'),
      p('parent_at_kid_school', "Parent at kid's school", 'พ่อแม่เพื่อนลูก'),
    ],
  },
  {
    key: 'who_sold_us',
    label: { en: 'Who sold us our..', th: 'เราเป็นลูกค้า..' },
    prompts: [
      p('house', 'House', 'เซลล์ขายบ้าน'),
      p('car', 'Car', 'เซลล์ขายรถ'),
      p('furniture', 'Furniture / flooring', 'เซลล์เฟอร์นิเจอร์'),
      p('gym_contract', 'Gym contract', 'เซลล์ฟิตเนส'),
      p('car_service', 'Car service', 'อู่ซ่อมรถ ล้างรถ'),
    ],
  },
  {
    key: 'traits',
    label: { en: 'Someone you know who..', th: 'คนที่..' },
    prompts: [
      p('concern_health', 'Cares about health', 'รักสุขภาพ'),
      p('concern_look', 'Cares about their look', 'รักสวยรักงาม'),
      p('loves_shopping', 'Loves shopping', 'ชอบช้อปปิ้ง'),
      p('family_business', 'Has a family business', 'ที่บ้านทำธุรกิจ'),
      p('has_a_ride', 'Has a car', 'มีรถขับ'),
      p('has_babies', 'Has small children', 'มีลูกเล็ก'),
      p('great_job', 'Has a good job', 'มีหน้าที่การงานดี'),
      p('friendly', 'Is easy to get on with', 'เข้ากับคนง่าย'),
      p('lots_of_friends', 'Has lots of friends', 'เพื่อนเยอะ'),
      p('plays_sport', 'Plays sport', 'ชอบออกกำลังกาย'),
      p('more_than_one_job', 'Works more than one job', 'ขยัน'),
      p('international', 'Has connections abroad', 'คนอยู่ต่างประเทศ'),
      p('everyone_else', 'Everyone else', 'ทุกคนที่เหลือ'),
    ],
  },
] as const;

const PROMPTS = new Map(
  MEMORY_JOGGER.flatMap((c) => c.prompts.map((pr) => [pr.key, { category: c.key, prompt: pr }])),
);

export function isJoggerPrompt(key: string): boolean {
  return PROMPTS.has(key);
}

export function joggerCategoryOf(promptKey: string): string | null {
  return PROMPTS.get(promptKey)?.category ?? null;
}

/** Every prompt, flat — the report iterates this so a new prompt shows up with a zero rather than vanishing. */
export function allJoggerPrompts(): { category: string; key: string }[] {
  return [...PROMPTS.entries()].map(([key, v]) => ({ category: v.category, key }));
}
