/**
 * Starting the business, in a phone browser (docs/63 §5).
 *
 * The thing being checked is not that a checklist renders. It is that the path
 * READS itself: set a goal on another screen entirely, come back, and the step
 * is ticked without anybody having ticked it.
 */
import { expect, test, type Page } from '@playwright/test';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3021/api/v1';
const RUN = Date.now().toString(36);
const PLATFORM_EMAIL = process.env.AVIORA_SEED_PLATFORM_ADMIN_EMAIL ?? 'admin@aviora.local';
const PLATFORM_PW = process.env.AVIORA_SEED_PLATFORM_ADMIN_PASSWORD ?? 'local-dev-admin-password-1';
const PW = 'e2e-start-password-1';
const adminEmail = `start-${RUN}@test.local`;

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
      code: `st_${RUN}`,
      name: `Start Co ${RUN}`,
      slug: `st-${RUN}`,
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

test.describe('Starting the business', () => {
  test('tells a new member the one thing to do, then ticks itself', async ({ page }) => {
    await signIn(page);
    await page.goto('/th/dashboard');

    // The card that did not exist: every other card on this screen says empty.
    await expect(page.getByText('เริ่มต้นธุรกิจ')).toBeVisible();
    await expect(page.getByText('ทำข้อนี้ต่อ')).toBeVisible();
    await expect(page.getByText('เขียนความฝันของคุณ').first()).toBeVisible();
    await expect(page.getByText('0 / 8')).toBeVisible();

    // Go and actually do it, on the goal screen.
    await page.getByRole('link', { name: 'ไปทำเลย' }).click();
    await page.waitForURL(/\/th\/prospecting/);
    await page.getByLabel('เป้าหมายชีวิต').fill('เกษียณใน 5 ปี');
    await page.getByLabel('เป้ายอด').fill('30000');
    await page.getByRole('button', { name: 'บันทึกเป้าหมาย' }).click();
    await page.waitForTimeout(500);

    // Nobody ticked anything. Two steps are done because the records say so.
    await page.goto('/th/dashboard');
    await expect(page.getByText('2 / 8')).toBeVisible();
    await expect(page.getByText('เขียนรายชื่อ 10 คน').first()).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, 'the start card scrolls sideways on a phone').toBeLessThanOrEqual(1);
  });
});
