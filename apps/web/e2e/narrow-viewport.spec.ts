/**
 * 360 px (docs/23 Sprint-1 DoD: "Journey screens usable at 360 px width").
 *
 * The rest of the browser suite runs at a Pixel 7, which is 412 px wide. That
 * is a phone, but it is not the NARROW phone the definition of done names —
 * 360 px is where a Galaxy A-series and most budget Android devices sit, and it
 * is where a layout that merely "works on mobile" starts overflowing.
 *
 * So this file exists to run the layout-critical screens two hundred and fifty
 * pixels narrower than the rest of the suite. It is deliberately small: the
 * point is the WIDTH, not re-proving what the Pixel 7 project already asserts.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3021/api/v1';
const RUN = Date.now().toString(36);
const PLATFORM_EMAIL = process.env.AVIORA_SEED_PLATFORM_ADMIN_EMAIL ?? 'admin@aviora.local';
const PLATFORM_PW = process.env.AVIORA_SEED_PLATFORM_ADMIN_PASSWORD ?? 'local-dev-admin-password-1';
const PW = 'e2e-narrow-password-1';
const adminEmail = `narrow-admin-${RUN}@test.local`;

function accessTokenFrom(headers: Array<{ name: string; value: string }>): string {
  const cookie = headers
    .filter((h) => h.name.toLowerCase() === 'set-cookie')
    .map((h) => h.value)
    .find((v) => v.startsWith('aviora_access='));
  if (!cookie) throw new Error('no access cookie in response');
  return cookie.split(';')[0]!.split('=')[1]!;
}

test.beforeAll(async ({ playwright }) => {
  const request: APIRequestContext = await playwright.request.newContext();
  const login = await request.post(`${API}/auth/login`, {
    data: { email: PLATFORM_EMAIL, password: PLATFORM_PW },
  });
  expect(login.ok(), 'platform admin login — is the API running and seeded?').toBeTruthy();
  const platformToken = accessTokenFrom(await login.headersArray());
  const res = await request.post(`${API}/platform/tenants`, {
    headers: { authorization: `Bearer ${platformToken}` },
    data: {
      code: `nrw_${RUN}`,
      name: `Narrow Co ${RUN}`,
      slug: `nrw-${RUN}`,
      defaultLanguage: 'th',
      adminEmail,
      adminDisplayName: 'Narrow Admin',
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

/**
 * Overflow of a single pixel is rounding; anything more is a layout that will
 * pan sideways under a thumb.
 */
async function expectNoHorizontalScroll(page: Page, where: string) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `${where} scrolls horizontally at 360 px`).toBeLessThanOrEqual(1);
}

test.describe('At 360 px — the narrow phone, not the comfortable one', () => {
  test('the sign-in page fits before anybody has an account', async ({ page }) => {
    await page.goto('/th/sign-in');
    expect(page.viewportSize()?.width, 'this project must run narrower than Pixel 7').toBe(360);
    await expectNoHorizontalScroll(page, 'sign-in');
  });

  test('the journey screens fit', async ({ page }) => {
    await signIn(page);
    for (const [path, name] of [
      ['/th/dashboard', 'dashboard'],
      ['/th/goals', 'goals'],
      ['/th/learning', 'learning'],
      ['/th/knowledge', 'knowledge'],
      ['/th/teams', 'teams'],
    ] as const) {
      await page.goto(path);
      await expectNoHorizontalScroll(page, name);
    }
  });

  test('the admin console fits, tabs and all', async ({ page }) => {
    await signIn(page);
    await page.goto('/th/admin');
    await expectNoHorizontalScroll(page, 'admin');
    for (const tab of ['ทีม', 'คำเชิญ', 'แผนสมาชิก']) {
      await page.getByRole('button', { name: tab, exact: true }).click();
      await expectNoHorizontalScroll(page, `admin → ${tab}`);
    }
  });

  test('the bottom bar still fits its four destinations', async ({ page }) => {
    await signIn(page);
    await page.goto('/th/dashboard');
    const bar = page.locator('nav').last();
    await expect(bar).toBeVisible();
    const box = await bar.boundingBox();
    expect(box, 'no bottom navigation at 360 px').toBeTruthy();
    expect(
      box!.width,
      'the navigation is wider than the screen at 360 px, so a destination is ' +
        'off the edge where a thumb cannot reach it',
    ).toBeLessThanOrEqual(361);
  });
});
