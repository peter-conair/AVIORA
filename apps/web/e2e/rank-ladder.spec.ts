/**
 * The performance ladder in a phone browser (docs/62).
 *
 * Two things worth walking. A brand-new workspace shows 6% · 9% · 12% · 15% ·
 * 18% · 21% — the levels the business actually talks in — and every one of them
 * says it needs a number before it will do anything. Then one gets a number and
 * turns on.
 */
import { expect, test, type Page } from '@playwright/test';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3021/api/v1';
const RUN = Date.now().toString(36);
const PLATFORM_EMAIL = process.env.AVIORA_SEED_PLATFORM_ADMIN_EMAIL ?? 'admin@aviora.local';
const PLATFORM_PW = process.env.AVIORA_SEED_PLATFORM_ADMIN_PASSWORD ?? 'local-dev-admin-password-1';
const PW = 'e2e-ladder-password-1';
const adminEmail = `ladder-web-${RUN}@test.local`;

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
      code: `ldw_${RUN}`,
      name: `Ladder Web ${RUN}`,
      slug: `ldw-${RUN}`,
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

test.describe('The performance ladder', () => {
  test('ships named, switched off, and asks for the business’s own number', async ({ page }) => {
    await signIn(page);
    await page.goto('/th/admin');
    await page
      .getByRole('button', { name: /ระดับ|Growth|แผนการเติบโต/ })
      .first()
      .click();

    // The levels the business talks in, present without anybody building them.
    for (const level of ['6%', '9%', '12%', '21%']) {
      await expect(page.getByText(level, { exact: true }).first()).toBeVisible();
    }
    // And every one says so rather than pretending to be configured.
    await expect(page.getByText('ยังไม่ได้ตั้งเกณฑ์').first()).toBeVisible();

    // Give 6% a number and switch it on.
    await page.getByLabel('ยอดที่ต้องทำสำหรับ 6%').fill('20000');
    await page.getByRole('button', { name: 'เปิดใช้งาน' }).first().click();

    // It stops asking for a number, because it has one.
    await expect(page.getByLabel('ยอดที่ต้องทำสำหรับ 6%')).toHaveCount(0);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, 'the ladder editor scrolls sideways on a phone').toBeLessThanOrEqual(1);
  });
});
