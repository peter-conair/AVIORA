/**
 * The prospecting workbook in a phone browser (docs/56 §5).
 *
 * This exists because the API suite could not have caught what it caught. The
 * name-list endpoint returned each criterion's label as `{en, th}`, the screen
 * rendered the object, React threw, and the whole page went blank — while the
 * integration test went on passing, because it only ever read `criteria[].key`.
 *
 * So this walks the actual work: jog a name loose, put a rating on it, and see
 * it come back in the report.
 */
import { expect, test, type Page } from '@playwright/test';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3021/api/v1';
const RUN = Date.now().toString(36);
const PLATFORM_EMAIL = process.env.AVIORA_SEED_PLATFORM_ADMIN_EMAIL ?? 'admin@aviora.local';
const PLATFORM_PW = process.env.AVIORA_SEED_PLATFORM_ADMIN_PASSWORD ?? 'local-dev-admin-password-1';
const PW = 'e2e-prospecting-password-1';
const adminEmail = `prospecting-${RUN}@test.local`;

function accessTokenFrom(headers: Array<{ name: string; value: string }>): string {
  const cookie = headers.find((h) => h.name.toLowerCase() === 'set-cookie')?.value ?? '';
  return /aviora_access=([^;]+)/.exec(cookie)?.[1] ?? '';
}

test.beforeAll(async ({ playwright }) => {
  const request = await playwright.request.newContext();
  const login = await request.post(`${API}/auth/login`, {
    data: { email: PLATFORM_EMAIL, password: PLATFORM_PW },
  });
  const res = await request.post(`${API}/platform/tenants`, {
    headers: { authorization: `Bearer ${accessTokenFrom(await login.headersArray())}` },
    data: {
      code: `pw_${RUN}`,
      name: `Prospecting Co ${RUN}`,
      slug: `pw-${RUN}`,
      defaultLanguage: 'th',
      adminEmail,
      adminDisplayName: 'Coach',
      adminPassword: PW,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  await request.dispose();
});

async function signIn(page: Page) {
  await page.goto('/th/sign-in');
  await page.getByLabel('อีเมล').fill(adminEmail);
  await page.getByLabel('รหัสผ่าน').fill(PW);
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
  await page.waitForURL(/\/th\/(dashboard|admin)/);
}

test.describe('The prospecting workbook', () => {
  test('jogs a name loose, rates it, and reports it', async ({ page }) => {
    await signIn(page);
    await page.goto('/th/prospecting');

    /* ── the goal comes first: a name list with no number is an address book ── */
    await page.getByLabel('เป้ายอด').fill('30000');
    await page.getByLabel('เป้าจำนวนคน').fill('1');
    await page.getByRole('button', { name: 'บันทึกเป้าหมาย' }).click();
    // Said out loud, because a typed number and a measured one look identical.
    await expect(
      page.getByText('ระบบนับให้จากยอดที่ชำระแล้วและคนที่สปอนเซอร์').first(),
    ).toBeVisible();
    await expect(page.getByText('ช่องนี้คุณกรอกเอง ระบบไม่ได้วัดให้')).toBeVisible();

    /* ── the Memory Jogger produces the name ─────────────────────────────── */
    await page.getByRole('button', { name: 'ช่วยจำ' }).click();
    await page.getByRole('button', { name: 'เพื่อนสนิท' }).click();
    await page.getByLabel('ชื่อ').fill(`สมชาย ${RUN}`);
    await page.getByRole('button', { name: 'เพิ่ม', exact: true }).click();
    // The count next to the prompt is the feedback the paper sheet cannot give.
    await expect(
      page.getByRole('button', { name: /เพื่อนสนิท/ }).getByText('1', { exact: true }),
    ).toBeVisible();

    /* ── the name list shows the gap to twenty ───────────────────────────── */
    await page.getByRole('button', { name: 'รายชื่อผู้ร่วมธุรกิจ' }).first().click();
    // If the criteria arrive unlocalised this line never renders, because the
    // page has already thrown.
    await expect(page.getByText('1 จาก 20 รายชื่อ')).toBeVisible();
    await expect(page.getByText('อีก 19 ชื่อจึงจะเต็มแผ่น')).toBeVisible();
    await expect(page.getByText('ยังไม่ให้คะแนน')).toBeVisible();

    /* ── rating it ───────────────────────────────────────────────────────── */
    for (const [label, value] of [
      ['กระตือรือร้น', '5'],
      ['เข้ากับคนง่าย', '4'],
      ['กำลังซื้อ', '4'],
      ['ความสนิท', '5'],
      ['ช่วงวัย', '3'],
    ] as const) {
      await page.getByLabel(`สมชาย ${RUN} — ${label}`).selectOption(value);
    }
    // 5+4+4+5+3 out of five criteria at five each.
    await expect(page.getByText('21 / 25')).toBeVisible();

    /* ── and the report says who to call ─────────────────────────────────── */
    await page.getByRole('button', { name: 'รายงาน' }).click();
    // Twice, not once: a name jogged loose goes onto BOTH sheets, because
    // deciding which list somebody belongs on is the next exercise and forcing
    // the choice at the moment of remembering is what stops people writing the
    // name down at all.
    await expect(page.getByText(`สมชาย ${RUN}`)).toHaveCount(2);
    await expect(page.getByText('21 / 25')).toBeVisible();
    await expect(page.getByText('รายชื่อมาจากไหนบ้าง')).toBeVisible();

    /* ── the follow-up sheet: put the person on it and tick a column ────── */
    await page.getByRole('button', { name: 'ติดตามผล', exact: true }).click();
    await page.getByRole('button', { name: 'เพิ่มคนเข้าแผ่นนี้' }).click();
    await page.getByRole('button', { name: `สมชาย ${RUN}` }).click();
    // The row shows progress out of the sheet's own column count — the
    // component never names a column, so this works for a tenant's own sheet.
    await expect(page.getByText('0 / 44')).toBeVisible();

    await page.getByRole('button', { name: new RegExp(`สมชาย ${RUN}`) }).click();
    await page.getByRole('button', { name: `สมชาย ${RUN} — แผนธุรกิจ` }).click();
    await expect(page.getByText('1 / 44')).toBeVisible();

    /* ── a name written down but never rated is the coach's real target ─── */
    await page.getByRole('button', { name: 'ช่วยจำ' }).click();
    await page.getByRole('button', { name: 'เพื่อนบ้าน' }).click();
    await page.getByLabel('ชื่อ').fill(`อรทัย ${RUN}`);
    await page.getByRole('button', { name: 'เพิ่ม', exact: true }).click();
    await page.getByRole('button', { name: 'รายงาน' }).click();
    // Names on a list with no rating look like progress and are not, so the
    // report has to say so out loud rather than leaving them sorted last.
    await expect(page.getByText('มี 1 ชื่อในรายชื่อที่ยังไม่ได้ให้คะแนน')).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, 'the workbook scrolls sideways on a phone').toBeLessThanOrEqual(1);
  });
});
