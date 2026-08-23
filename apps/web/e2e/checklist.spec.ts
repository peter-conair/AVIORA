/**
 * DAILY CHECK LIST in a phone browser (docs/60 §5).
 *
 * Unlike the follow-up sheets this one stays a real grid, because seeing the
 * whole week at once IS the sheet. So the test checks it fits — seven columns
 * of thumb-sized targets at 360 px is the constraint that decides the design.
 */
import { expect, test, type Page } from '@playwright/test';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3021/api/v1';
const RUN = Date.now().toString(36);
const PLATFORM_EMAIL = process.env.AVIORA_SEED_PLATFORM_ADMIN_EMAIL ?? 'admin@aviora.local';
const PLATFORM_PW = process.env.AVIORA_SEED_PLATFORM_ADMIN_PASSWORD ?? 'local-dev-admin-password-1';
const PW = 'e2e-checklist-password-1';
const adminEmail = `checklist-${RUN}@test.local`;

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
      code: `cl_${RUN}`,
      name: `Checklist Co ${RUN}`,
      slug: `cl-${RUN}`,
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

test.describe('The daily checklist', () => {
  test('ticks a day, ticks the week, and fits on a phone', async ({ page }) => {
    await signIn(page);
    await page.goto('/th/prospecting');
    await page.getByRole('button', { name: 'ทำทุกวัน', exact: true }).click();

    await expect(page.getByRole('cell', { name: 'ใช้สินค้า', exact: true })).toBeVisible();
    await expect(page.getByText('ทำทุกสัปดาห์')).toBeVisible();

    // A daily box, ticked for one day only.
    const box = page.getByRole('button', { name: /^ใช้สินค้า — \d{4}-\d{2}-\d{2}$/ }).first();
    await box.click();
    await expect(box).toHaveAttribute('aria-pressed', 'true');

    // A weekly box is one tick for the whole week, whatever day it is.
    const weekly = page.getByRole('button', { name: 'ทำ List รายชื่อ' });
    await weekly.click();
    await expect(weekly).toHaveAttribute('aria-pressed', 'true');

    // Seven columns of thumb-sized targets at 360 px is the constraint the
    // whole layout is built around; if it scrolls sideways it has failed.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, 'the checklist scrolls sideways on a phone').toBeLessThanOrEqual(1);
  });

  test('moves between weeks', async ({ page }) => {
    await signIn(page);
    await page.goto('/th/prospecting');
    await page.getByRole('button', { name: 'ทำทุกวัน', exact: true }).click();
    const thisWeek = await page.getByText(/^สัปดาห์ \d{4}-\d{2}-\d{2}$/).textContent();
    await page.getByRole('button', { name: 'สัปดาห์ก่อน' }).click();
    await expect(page.getByText(/^สัปดาห์ \d{4}-\d{2}-\d{2}$/)).not.toHaveText(thisWeek ?? '');
  });
});
