/**
 * DAILY CHECK LIST (docs/60).
 *
 * Eight things done every day and eight done once a week — the sheet a member
 * ticks without thinking about it, which is exactly why it belongs to the
 * habits engine that already exists rather than to a new grid.
 *
 * These are BUSINESS habits. The habits module was built for health data and
 * carries docs/13's privacy promise: nobody sees a member's logs without a
 * grant, not even their leader. That promise is right for a weight and wrong
 * for "did you make your calls" — a coach seeing the latter is the entire point
 * of the sheet. They are separated by `category`, never by a query that hopes.
 */
export interface ChecklistItemSeed {
  code: string;
  cadence: 'daily' | 'weekly';
  label: { en: string; th: string };
}

const daily = (code: string, en: string, th: string): ChecklistItemSeed => ({
  code: `biz_${code}`,
  cadence: 'daily',
  label: { en, th },
});
const weekly = (code: string, en: string, th: string): ChecklistItemSeed => ({
  code: `bizw_${code}`,
  cadence: 'weekly',
  label: { en, th },
});

export const DAILY_CHECKLIST: readonly ChecklistItemSeed[] = [
  daily('use_products', 'Use the products', 'ใช้สินค้า'),
  daily('call_appointments', 'Call for appointments', 'โทรนัดหมาย'),
  daily('meet_someone_new', 'Meet someone new', 'รู้จักคนเพิ่ม'),
  daily('sponsor', 'Sponsor', 'Sponsor'),
  daily('follow_up_hm', 'Follow up HM', 'มี Follow up HM'),
  daily('listen_link', 'Listen to the Link', 'ฟัง Link'),
  daily('review_work', 'Review the work', 'วิเคราะห์งาน'),
  daily('read_15_pages', 'Read 15 pages', 'อ่านหนังสือ 15 หน้า'),
];

export const WEEKLY_CHECKLIST: readonly ChecklistItemSeed[] = [
  weekly('name_list', 'Work the name list', 'ทำ List รายชื่อ'),
  weekly('product_case', 'Build a product case', 'ทำเคสสินค้า'),
  weekly('repeat_customers', 'Look after repeat customers', 'ดูแลลูกค้าซื้อซ้ำ'),
  weekly('invite_to_system', 'Invite people into the system', 'โทรนัดมาเข้าระบบ'),
  weekly('hm_practice', 'Practise HM', 'ทำ HM ฝึก'),
  weekly('talk_to_upline', 'Talk to the upline', 'คุยกับ UPLINE'),
  weekly('book_major', 'Book the major function', 'นัดงานใหญ่'),
  weekly('review_and_plan', 'Review volume, people and plan', 'ประเมินผล ยอด คน และวางแผน'),
];

export const CHECKLIST_SEEDS: readonly ChecklistItemSeed[] = [
  ...DAILY_CHECKLIST,
  ...WEEKLY_CHECKLIST,
];

/**
 * The Sunday that starts the week containing `date`, in UTC.
 *
 * Sunday because the sheet's first column is SUNDAY. Getting this wrong does
 * not look like a bug — it looks like a member who ticked Monday and found
 * their week empty.
 */
export function startOfWeekUtc(date: Date): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d;
}
