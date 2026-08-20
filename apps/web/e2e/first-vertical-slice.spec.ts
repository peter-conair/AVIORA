/**
 * The spec §72 surfaces, driven through the real UI at a phone viewport.
 *
 * The API-level E2E already proves the journey server-side. This suite exists
 * for the two things only a browser can answer: the screens render and stay
 * operable at a phone width, and the client wiring (cookies, tenant header,
 * locale) works end to end.
 *
 * Invite acceptance is deliberately not repeated here — the raw invitation
 * token lives only in the outbox event, which a browser cannot read, and the
 * API-level E2E covers that path.
 *
 * Requires the API on :3021 and a seeded platform admin (see README).
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3021/api/v1';
const RUN = Date.now().toString(36);
const PLATFORM_EMAIL = process.env.AVIORA_SEED_PLATFORM_ADMIN_EMAIL ?? 'admin@aviora.local';
const PLATFORM_PW = process.env.AVIORA_SEED_PLATFORM_ADMIN_PASSWORD ?? 'local-dev-admin-password-1';
const PW = 'e2e-browser-password-1';

const admin = { email: `pw-admin-${RUN}@test.local`, name: 'PW Admin' };

function accessTokenFrom(headers: Array<{ name: string; value: string }>): string {
  const cookie = headers
    .filter((h) => h.name.toLowerCase() === 'set-cookie')
    .map((h) => h.value)
    .find((v) => v.startsWith('aviora_access='));
  if (!cookie) throw new Error('no access cookie in response');
  return cookie.split(';')[0]!.split('=')[1]!;
}

/** Provisioning happens through the API so the browser test stays about the UI. */
test.beforeAll(async ({ playwright }) => {
  const request: APIRequestContext = await playwright.request.newContext();

  const login = await request.post(`${API}/auth/login`, {
    data: { email: PLATFORM_EMAIL, password: PLATFORM_PW },
  });
  expect(login.ok(), 'platform admin login — is the API running and seeded?').toBeTruthy();
  const platformToken = accessTokenFrom(await login.headersArray());

  const tenantRes = await request.post(`${API}/platform/tenants`, {
    headers: { authorization: `Bearer ${platformToken}` },
    data: {
      code: `pw_${RUN}`,
      name: `Playwright Co ${RUN}`,
      slug: `pw-${RUN}`,
      defaultLanguage: 'th',
      adminEmail: admin.email,
      adminDisplayName: admin.name,
      adminPassword: PW,
    },
  });
  expect(tenantRes.status()).toBe(201);
  const tenantId = (await tenantRes.json()).tenant.id as string;

  const adminLogin = await request.post(`${API}/auth/login`, {
    data: { email: admin.email, password: PW },
  });
  const adminToken = accessTokenFrom(await adminLogin.headersArray());

  await request.post(`${API}/membership-plans`, {
    headers: { authorization: `Bearer ${adminToken}`, 'x-tenant-id': tenantId },
    data: { code: 'starter', name: 'Starter', trialDays: 14, entitlementKeys: ['course.access'] },
  });

  await request.dispose();
});

async function signIn(page: Page) {
  await page.goto('/th/sign-in');
  await page.getByLabel('อีเมล').fill(admin.email);
  await page.getByLabel('รหัสผ่าน').fill(PW);
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
  await page.waitForURL(/\/th\/(dashboard|admin)/);
}

/** The mobile-first claim, asserted rather than eyeballed. */
async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'page scrolls horizontally at a phone width').toBeLessThanOrEqual(1);
}

test.describe('AVIORA in a phone browser', () => {
  test('signs in and lands on the dashboard without horizontal scrolling', async ({ page }) => {
    await signIn(page);
    await expect(page.getByRole('link', { name: 'AVIORA' })).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test("the phone keyboard's Go key signs in, not just the button", async ({ page }) => {
    // On a phone most people submit with the keyboard, never touching the
    // button. If implicit submission ever breaks, sign-in breaks for them and
    // for nobody testing with a mouse.
    await page.goto('/th/sign-in');
    await page.getByLabel('อีเมล').fill(admin.email);
    await page.getByLabel('รหัสผ่าน').fill(PW);
    await page.getByLabel('รหัสผ่าน').press('Enter');
    await page.waitForURL(/\/th\/(dashboard|admin)/);
  });

  test('the admin console and its tabs are reachable on a phone', async ({ page }) => {
    await signIn(page);
    await page.goto('/th/admin');
    await expect(page.getByRole('button', { name: 'ทีม' })).toBeVisible();
    await page.getByRole('button', { name: 'ทีม' }).click();
    await expect(page.getByText('สร้างทีม').first()).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test('global knowledge reaches a brand-new workspace, in Thai', async ({ page }) => {
    await signIn(page);
    await page.goto('/th/knowledge');
    // knowledge with tenant_id NULL is shared, so an empty tenant is not an
    // empty screen — and the API localises it for a /th client
    await expect(page.getByText('นอนหลับดีขึ้น')).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test('the journey shows products only after the knowledge', async ({ page }) => {
    await signIn(page);
    await page.goto('/th/knowledge/journey/better-sleep');
    await expect(page.getByText('สุขอนามัยการนอน').first()).toBeVisible();

    const body = await page.locator('main').innerText();
    const ingredientAt = body.indexOf('แมกนีเซียม');
    const productAt = body.indexOf('Magnesium Glycinate');
    expect(ingredientAt, 'ingredient missing from the journey').toBeGreaterThan(-1);
    expect(productAt, 'product missing from the journey').toBeGreaterThan(-1);
    expect(productAt, 'products must come after the knowledge').toBeGreaterThan(ingredientAt);
    await expectNoHorizontalScroll(page);
  });

  test('healthy living leads with its privacy promise on a phone', async ({ page }) => {
    await signIn(page);
    await page.goto('/th/health');
    await expect(page.getByRole('button', { name: 'วันนี้' })).toBeVisible();
    // the promise members are asked to trust has to be on the screen, not in a doc
    await page.getByRole('button', { name: 'ความเป็นส่วนตัว' }).click();
    await expect(page.getByText('ข้อมูลสุขภาพของคุณเป็นส่วนตัวโดยค่าเริ่มต้น')).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test('community, challenges and rewards render on a phone', async ({ page }) => {
    await signIn(page);

    // Each screen keeps its heading whether or not the data behind it is in
    // scope, so a workspace without communities or points is still a page.
    for (const [path, heading] of [
      ['/th/community', 'คอมมูนิตี้'],
      ['/th/challenges', 'ชาเลนจ์'],
      ['/th/rewards', 'แต้มและตรา'],
    ] as const) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: heading })).toBeVisible();
      await expectNoHorizontalScroll(page);
    }
  });

  test('the shop and orders pages render on a phone', async ({ page }) => {
    await signIn(page);
    for (const [path, heading] of [
      ['/th/shop', 'ร้านค้า'],
      ['/th/orders', 'คำสั่งซื้อและการสมัครสมาชิกต่อเนื่อง'],
    ] as const) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: heading })).toBeVisible();
      await expectNoHorizontalScroll(page);
    }
  });

  test('the commerce tab is where a tenant decides what it sells', async ({ page }) => {
    await signIn(page);
    await page.goto('/th/admin');
    await page.getByRole('button', { name: 'ร้านค้า' }).click();
    await expect(page.getByText('สินค้าและบริการ').first()).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test('the growth page tells a member what is still missing', async ({ page }) => {
    await signIn(page);
    await page.goto('/th/growth');
    await expect(page.getByRole('heading', { name: 'เส้นทางการเติบโต' })).toBeVisible();
    // The referral graph is not the team graph, and a member is told so on the
    // screen rather than in a document nobody opens.
    await expect(
      page.getByText('สายการแนะนำเป็นคนละเรื่องกับทีมที่คุณสังกัด ย้ายทีมแล้วผู้แนะนำไม่เปลี่ยน'),
    ).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test('the ranks tab is where a tenant defines its ladder', async ({ page }) => {
    await signIn(page);
    await page.goto('/th/admin');
    await page.getByRole('button', { name: 'ระดับและการแนะนำ' }).click();
    await expect(page.getByText('ลำดับระดับ').first()).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test('the earnings page says what it is not showing', async ({ page }) => {
    await signIn(page);
    await page.goto('/th/earnings');
    await expect(page.getByRole('heading', { name: 'รายได้จากแผนตอบแทน' })).toBeVisible();
    // Only approved entries reach a member, so the reason something is absent
    // has to be on the screen — otherwise an empty page reads as a lost payout.
    await expect(
      page.getByText(
        'แสดงเฉพาะรายการที่อนุมัติแล้วเท่านั้น รายการที่ยังไม่อนุมัติจะยังไม่ปรากฏที่นี่',
      ),
    ).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test('the compensation tab is where a tenant configures what it pays', async ({ page }) => {
    await signIn(page);
    await page.goto('/th/admin');
    await page.getByRole('button', { name: 'แผนตอบแทน' }).click();
    await expect(page.getByText('รอบคำนวณค่าตอบแทน').first()).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test('my rewards renders on a phone, cash note and all', async ({ page }) => {
    await signIn(page);
    await page.goto('/th/my-rewards');
    // The page is the member's own grants, so an account holding none still has
    // to be a page — the heading is what says the screen loaded rather than
    // failed.
    await expect(page.getByRole('heading', { name: 'รางวัลของฉัน' })).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test('the automation tab is where a tenant writes its rules', async ({ page }) => {
    await signIn(page);
    await page.goto('/th/admin');
    await page.getByRole('button', { name: 'อัตโนมัติและรางวัล' }).click();
    await expect(page.getByText('กติกาอัตโนมัติ').first()).toBeVisible();
    // Rules that fire rules are the loop nobody can trace, and the screen says
    // so rather than leaving it to a document.
    await expect(
      page.getByText(
        'เหตุการณ์ที่เกิดจากการทำงานอัตโนมัติจะไม่ไปกระตุ้นกติกาข้ออื่นอีก กติกาจึงต่อกันเป็นลูกโซ่ไม่ได้',
      ),
    ).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test('the gamification tab explains that points are configuration', async ({ page }) => {
    await signIn(page);
    await page.goto('/th/admin');
    await page.getByRole('button', { name: 'แต้มและชาเลนจ์' }).click();
    await expect(page.getByText('กติกาการให้แต้ม').first()).toBeVisible();
    await expect(page.getByText('เหตุการณ์ที่ไม่ได้ตั้งกติกาไว้จะไม่ได้แต้มเลย')).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test('leader analytics name their window and what "inactive" means', async ({ page }) => {
    await signIn(page);
    await page.goto('/th/leader');
    await expect(page.getByRole('heading', { name: 'วิเคราะห์ข้อมูลทีม' })).toBeVisible();

    // A member who only logs health habits is reported here as inactive. That
    // costs someone something real, so the sentence explaining it has to be on
    // the screen next to the numbers — not in a document nobody opens.
    await expect(
      page.getByText(
        'ตัวเลขชุดนี้ไม่นับกิจกรรมด้านสุขภาพโดยเจตนา สมาชิกที่บันทึกเฉพาะกิจวัตรสุขภาพจะปรากฏที่นี่ว่า',
      ),
    ).toBeVisible();

    // A number without its window is a number that will be misquoted, so the
    // dates the API resolved are shown, not just the key that was asked for.
    await expect(page.getByText('ช่วงเวลาที่ใช้:')).toBeVisible();
    await page.getByRole('button', { name: '90 วันล่าสุด' }).click();
    await expect(page.getByText('ช่วงเวลาที่ใช้:')).toBeVisible();

    await expectNoHorizontalScroll(page);
  });

  test('the coach renders its correlation refusal as an answer, not an error', async ({ page }) => {
    await signIn(page);
    await page.goto('/th/leader');
    await expect(page.getByRole('heading', { name: 'โค้ชทีม AI' })).toBeVisible();

    // The one question the platform declines. It never reaches a model, so this
    // asserts the refusal itself — and that it is presented as a considered
    // answer with its figures, rather than as something that went wrong.
    await page.getByRole('button', { name: 'กิจกรรมใดสัมพันธ์กับการเติบโต' }).click();
    await expect(page.getByText('ตอบโดยนโยบายของแพลตฟอร์ม')).toBeVisible();
    await expect(
      page.getByText('นี่คือคำตอบที่ตั้งใจให้เป็นเช่นนี้ ไม่ใช่ความผิดพลาด'),
    ).toBeVisible();
    await expect(page.getByText('ตัวเลขที่ใช้ตอบ')).toBeVisible();
    // The generic failure wording must not be what a leader sees here.
    await expect(page.getByText('เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง')).toHaveCount(0);

    await expectNoHorizontalScroll(page);
  });

  test('signing out leaves the authenticated area', async ({ page }) => {
    await signIn(page);
    await page.getByRole('button', { name: 'ออกจากระบบ' }).click();
    await page.waitForURL(/\/th(\/sign-in)?\/?$/);
  });
});
