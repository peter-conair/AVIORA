/**
 * WEEKLY UPDATE in a phone browser (docs/61 §4).
 *
 * The four boxes are prose and a text area needs little proving. What this
 * walks is the half that is NOT prose: the figures above the boxes are read
 * from the goal and the week's activity, so a member cannot retype a stale one
 * and a coach cannot be shown one.
 */
import { expect, test, type Page } from '@playwright/test';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3021/api/v1';
const RUN = Date.now().toString(36);
const PLATFORM_EMAIL = process.env.AVIORA_SEED_PLATFORM_ADMIN_EMAIL ?? 'admin@aviora.local';
const PLATFORM_PW = process.env.AVIORA_SEED_PLATFORM_ADMIN_PASSWORD ?? 'local-dev-admin-password-1';
const PW = 'e2e-weekly-password-1';
const adminEmail = `weekly-${RUN}@test.local`;

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
      code: `wk_${RUN}`,
      name: `Weekly Co ${RUN}`,
      slug: `wk-${RUN}`,
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

test.describe('The weekly update', () => {
  test('reads the numbers and takes only the words', async ({ page }) => {
    await signIn(page);
    await page.goto('/th/prospecting');

    /* ── with no target, the sheet declines to judge ─────────────────────── */
    await page.getByRole('button', { name: 'รายสัปดาห์', exact: true }).click();
    await expect(
      page.getByText('เดือนนี้ยังไม่ได้ตั้งเป้า จึงยังไม่มีอะไรให้บอกว่าช้าหรือเร็ว'),
    ).toBeVisible();

    /* ── set one, and it starts reporting against it ─────────────────────── */
    await page.getByRole('button', { name: 'เป้าหมาย', exact: true }).click();
    await page.getByLabel('เป้ายอด').fill('1000000');
    await page.getByRole('button', { name: 'บันทึกเป้าหมาย' }).click();
    await page.waitForTimeout(400);

    await page.getByRole('button', { name: 'รายสัปดาห์', exact: true }).click();
    // A million with nothing sold: the pace line must say so rather than stay
    // silent or read as fine.
    await expect(page.getByText(/ของเป้า แต่เดือนผ่านไปแล้ว/)).toBeVisible();
    await expect(page.getByText('ยอดที่ยังต้องหา')).toBeVisible();

    /* ── the words are the only thing it stores ──────────────────────────── */
    await page.getByLabel('Progression Update').fill('ยอดยังไม่ถึง เพราะติดวันหยุด');
    await page.getByRole('button', { name: 'บันทึกสัปดาห์นี้' }).click();
    await expect(page.getByRole('button', { name: 'บันทึกแล้ว' })).toBeVisible();

    await page.reload();
    await page.getByRole('button', { name: 'รายสัปดาห์', exact: true }).click();
    await expect(page.getByLabel('Progression Update')).toHaveValue('ยอดยังไม่ถึง เพราะติดวันหยุด');

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, 'the weekly update scrolls sideways on a phone').toBeLessThanOrEqual(1);
  });
});
