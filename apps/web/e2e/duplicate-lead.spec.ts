/**
 * The duplicate-lead choice, in a phone browser (docs/55 §3).
 *
 * The API returning 409 is only half a feature. On a screen, a refusal with no
 * way forward is worse than no check at all — the salesperson standing in front
 * of the customer will retype the address slightly wrong to get past it, and
 * then there are two leads AND the duplicate check believes there is one.
 *
 * So what this asserts is not "the server said no". It is that the person is
 * told WHO holds the contact and can still proceed deliberately.
 */
import { expect, test, type Page } from '@playwright/test';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3021/api/v1';
const RUN = Date.now().toString(36);
const PLATFORM_EMAIL = process.env.AVIORA_SEED_PLATFORM_ADMIN_EMAIL ?? 'admin@aviora.local';
const PLATFORM_PW = process.env.AVIORA_SEED_PLATFORM_ADMIN_PASSWORD ?? 'local-dev-admin-password-1';
const PW = 'e2e-dup-password-1';

const adminEmail = `dup-admin-${RUN}@test.local`;
const contactEmail = `dup-contact-${RUN}@test.local`;

function accessTokenFrom(headers: Array<{ name: string; value: string }>): string {
  const cookie = headers.find((h) => h.name.toLowerCase() === 'set-cookie')?.value ?? '';
  return /aviora_access=([^;]+)/.exec(cookie)?.[1] ?? '';
}

test.beforeAll(async ({ playwright }) => {
  const request = await playwright.request.newContext();
  const platformLogin = await request.post(`${API}/auth/login`, {
    data: { email: PLATFORM_EMAIL, password: PLATFORM_PW },
  });
  const platformToken = accessTokenFrom(await platformLogin.headersArray());
  const tenantRes = await request.post(`${API}/platform/tenants`, {
    headers: { authorization: `Bearer ${platformToken}` },
    data: {
      code: `dup_${RUN}`,
      name: `Dup Co ${RUN}`,
      slug: `dup-${RUN}`,
      defaultLanguage: 'th',
      adminEmail,
      adminDisplayName: 'Dup Admin',
      adminPassword: PW,
    },
  });
  expect(tenantRes.status(), await tenantRes.text()).toBe(201);
  await request.dispose();
});

async function signIn(page: Page) {
  await page.goto('/th/sign-in');
  await page.getByLabel('อีเมล').fill(adminEmail);
  await page.getByLabel('รหัสผ่าน').fill(PW);
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
  await page.waitForURL(/\/th\/(dashboard|admin)/);
}

async function createLead(page: Page, name: string) {
  await page.getByLabel('ชื่อ', { exact: true }).fill(name);
  await page.getByLabel('อีเมล').fill(contactEmail);
  await page.getByRole('button', { name: 'เพิ่มผู้สนใจ' }).click();
}

test.describe('Entering the same contact twice', () => {
  test('warns with the owner, and still lets the person through', async ({ page }) => {
    await signIn(page);
    await page.goto('/th/crm');
    await page.getByRole('button', { name: 'ผู้สนใจ' }).click();

    await createLead(page, `First ${RUN}`);
    await expect(page.getByRole('listitem').filter({ hasText: `First ${RUN}` })).toBeVisible();

    await createLead(page, `Second ${RUN}`);

    // The warning has to name somebody. "This is a duplicate" on its own tells
    // the salesperson nothing they can act on.
    const warning = page.getByText(/มีลีดที่เปิดอยู่สำหรับผู้ติดต่อรายนี้แล้ว/);
    await expect(warning).toBeVisible();
    await expect(page.getByRole('listitem').filter({ hasText: `Second ${RUN}` })).toHaveCount(0);

    // And the way through has to exist, or the check gets defeated by a typo.
    await page.getByRole('button', { name: 'สร้างต่อไป' }).click();
    await expect(page.getByRole('listitem').filter({ hasText: `Second ${RUN}` })).toBeVisible();
    await expect(warning).toBeHidden();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, 'the warning makes the page scroll sideways on a phone').toBeLessThanOrEqual(
      1,
    );
  });
});
