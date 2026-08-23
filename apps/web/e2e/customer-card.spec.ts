/**
 * The customer index card in a phone browser (docs/66, docs/65).
 *
 * Sprints 46 and 47 shipped API-only, which meant consent, photographs and the
 * card were built and unreachable — the exact failure docs/63 was written
 * about. This walks the parts that would be easy to get wrong on a screen: the
 * identity number staying hidden, a system-seen month refusing to be clicked,
 * and no photo section existing before consent does.
 */
import { expect, test, type Page } from '@playwright/test';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3021/api/v1';
const RUN = Date.now().toString(36);
const PLATFORM_EMAIL = process.env.AVIORA_SEED_PLATFORM_ADMIN_EMAIL ?? 'admin@aviora.local';
const PLATFORM_PW = process.env.AVIORA_SEED_PLATFORM_ADMIN_PASSWORD ?? 'local-dev-admin-password-1';
const PW = 'e2e-card-password-1';
const adminEmail = `card-${RUN}@test.local`;
const CUSTOMER = `ลูกค้า ${RUN}`;

function accessTokenFrom(headers: Array<{ name: string; value: string }>): string {
  const cookie = headers.find((h) => h.name.toLowerCase() === 'set-cookie')?.value ?? '';
  return /aviora_access=([^;]+)/.exec(cookie)?.[1] ?? '';
}

test.beforeAll(async ({ playwright }) => {
  const request = await playwright.request.newContext();
  const login = await request.post(`${API}/auth/login`, {
    data: { email: PLATFORM_EMAIL, password: PLATFORM_PW },
  });
  const made = await request.post(`${API}/platform/tenants`, {
    headers: { authorization: `Bearer ${accessTokenFrom(await login.headersArray())}` },
    data: {
      code: `cd_${RUN}`,
      name: `Card Co ${RUN}`,
      slug: `cd-${RUN}`,
      defaultLanguage: 'th',
      adminEmail,
      adminDisplayName: 'Coach',
      adminPassword: PW,
    },
  });
  expect(made.status(), await made.text()).toBe(201);
  const tenantId = (await made.json()).tenant.id as string;

  const asAdmin = await request.post(`${API}/auth/login`, {
    data: { email: adminEmail, password: PW },
  });
  const headers = {
    authorization: `Bearer ${accessTokenFrom(await asAdmin.headersArray())}`,
    'x-tenant-id': tenantId,
  };
  const lead = await request.post(`${API}/crm/leads`, {
    headers,
    data: { name: CUSTOMER, email: `c-${RUN}@test.local` },
  });
  const leadId = (await lead.json()).lead.id as string;
  const converted = await request.post(`${API}/crm/leads/${leadId}/convert`, { headers });
  expect(converted.status(), await converted.text()).toBe(201);
  await request.dispose();
});

async function openCard(page: Page) {
  await page.goto('/th/sign-in');
  await page.getByLabel('อีเมล').fill(adminEmail);
  await page.getByLabel('รหัสผ่าน').fill(PW);
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
  await page.waitForURL(/\/th\/(dashboard|admin)/);
  await page.goto('/th/crm');
  await page.getByRole('button', { name: 'ลูกค้า', exact: true }).click();
  await page.getByRole('button', { name: CUSTOMER }).click();
}

test.describe('The customer index card', () => {
  test('hides the identity number, and warns before showing it', async ({ page }) => {
    await openCard(page);

    await page.getByLabel('ABO #').fill('ABO-99120');
    await page.getByLabel('บันทึกเลขใหม่').fill('1103700123456');
    await page.getByRole('button', { name: 'บันทึกทะเบียน' }).click();
    // Asserted first, so a refused save fails here rather than as a missing
    // masked field three lines down that says nothing about why (docs/66 §6).
    await expect(page.getByText('ABO-99120')).toHaveCount(0);
    await expect(page.getByLabel('ABO #')).toHaveValue('ABO-99120');

    // Never on the card. A button reveals it, and says the reveal is recorded
    // BEFORE it is pressed.
    await expect(page.getByText('••••••••••')).toBeVisible();
    await expect(page.getByText('การกดแสดงเลขจะถูกบันทึกไว้ใน audit log')).toBeVisible();
    await expect(page.locator('body')).not.toContainText('1103700123456');

    await page.getByRole('button', { name: 'แสดงเลข' }).click();
    await expect(page.getByText('1103700123456')).toBeVisible();
  });

  test('takes a photo only after consent, and destroys it on withdrawal', async ({ page }) => {
    await openCard(page);

    // No consent, no uploader at all — not a disabled one.
    await expect(page.getByText('ถ่ายรูปไม่ได้จนกว่าลูกค้าจะให้ความยินยอม')).toBeVisible();
    await expect(page.getByLabel('เพิ่มรูป')).toHaveCount(0);

    await page.getByRole('button', { name: 'บันทึกความยินยอม' }).click();
    await expect(page.getByText('มีความยินยอมแล้ว')).toBeVisible();

    await page.getByLabel('เพิ่มรูป').setInputFiles({
      name: 'before.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      ),
    });
    await expect(page.getByRole('button', { name: /ถอนความยินยอม \(1 รูป\)/ })).toBeVisible();
    await expect(page.locator('img[src*="/photos/"]')).toHaveCount(1);

    // The consequence is stated before the button is pressed, not after.
    await expect(page.getByText('การถอนจะลบรูปทั้งหมดถาวร')).toBeVisible();
    await page.getByRole('button', { name: /ถอนความยินยอม/ }).click();

    await expect(page.getByText('ถ่ายรูปไม่ได้จนกว่าลูกค้าจะให้ความยินยอม')).toBeVisible();
    // Scoped to actual photographs: `getByRole('img')` also matches the
    // workspace logo, so it reported one image and proved nothing.
    await expect(page.locator('img[src*="/photos/"]')).toHaveCount(0);
  });

  test('will not let a month the system saw be clicked', async ({ page }) => {
    await openCard(page);
    // Nothing paid in this test's year, so every box is the salesperson's.
    const march = page.getByRole('button', { name: 'เดือน 3' });
    await expect(march).toBeEnabled();
    await march.click();
    await expect(page.getByText('สั่งซื้อ 1 เดือน')).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, 'the card scrolls sideways on a phone').toBeLessThanOrEqual(1);
  });
});
