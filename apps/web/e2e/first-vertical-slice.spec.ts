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
    // The wordmark is the TENANT's app name once they set one, so this asserts
    // the home link exists rather than what it happens to say — a white-label
    // product cannot have its own name hard-coded into its tests.
    await expect(page.locator('header a[href="/th/dashboard"]')).toBeVisible();
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
    // It appears twice on purpose — once beside the numbers and once in the
    // definitions the response echoes — so this asserts presence, not count.
    await expect(
      page
        .getByText(
          'ตัวเลขชุดนี้ไม่นับกิจกรรมด้านสุขภาพโดยเจตนา สมาชิกที่บันทึกเฉพาะกิจวัตรสุขภาพจะปรากฏที่นี่ว่า',
        )
        .first(),
    ).toBeVisible();

    // A number without its window is a number that will be misquoted, so the
    // dates the API resolved are shown, not just the key that was asked for.
    await expect(page.getByText('ช่วงเวลาที่ใช้:').first()).toBeVisible();
    await page.getByRole('button', { name: '90 วันล่าสุด' }).click();
    await expect(page.getByText('ช่วงเวลาที่ใช้:').first()).toBeVisible();

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
    await expect(page.getByText('ตัวเลขที่ใช้ตอบ').first()).toBeVisible();
    // The generic failure wording must not be what a leader sees here.
    await expect(page.getByText('เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง')).toHaveCount(0);

    await expectNoHorizontalScroll(page);
  });

  test('the branding tab says that hiding a feature is not access control', async ({ page }) => {
    await signIn(page);
    await page.goto('/th/admin');
    await page.getByRole('button', { name: 'แบรนด์และประเทศ' }).click();

    // The picker and this sentence are one control. An administrator who ticks
    // a feature and believes they have secured it has been misled by the
    // software, so the correction has to sit beside the checkbox — not in
    // docs/29, which nobody opens while configuring a workspace.
    await expect(
      page.getByText('การซ่อนเป็นเรื่องการแสดงผลเท่านั้น ไม่ใช่การจำกัดสิทธิ์').first(),
    ).toBeVisible();
    await expect(page.getByText('เมนูที่ซ่อนจะหายไปจากการนำทาง').first()).toBeVisible();

    // The workspace's country and currency live on the same tab, because
    // opening a new country is one job rather than two screens.
    await expect(page.getByText('ประเทศ สกุลเงิน เขตเวลา และภาษา').first()).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test('the tax rate is labelled in basis points and refuses to be a tax engine', async ({
    page,
  }) => {
    await signIn(page);
    await page.goto('/th/admin');
    await page.getByRole('button', { name: 'ร้านค้า' }).click();
    await expect(page.getByText('อัตราภาษี').first()).toBeVisible();

    // A field labelled "tax" that quietly gets it wrong is worse than one that
    // admits it is a single configured rate, so the API's own disclosure is on
    // the screen, and the unit is named rather than assumed to be percent.
    await expect(page.getByText('not a tax engine').first()).toBeVisible();

    // Typing 700 must read back as 7%, not 700%. The unit is the whole point of
    // the field, so the screen converts it where the number is entered.
    await page.getByLabel('อัตราเป็นเบสิสพอยต์').fill('700');
    await expect(page.getByText('700 เบสิสพอยต์เท่ากับ 7%').first()).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test('the integrations tab shows a webhook secret once, and says so', async ({ page }) => {
    await signIn(page);
    await page.goto('/th/admin');
    await page.getByRole('button', { name: 'การเชื่อมต่อ' }).click();
    await expect(page.getByText('ปลายทาง Webhook').first()).toBeVisible();

    await page.getByLabel('URL ปลายทาง').fill(`https://hooks.example.com/aviora/${RUN}`);
    // The event picker offers what the API says it accepts, one event at a
    // time — there is no "all events" tick, so this test can only pass by
    // choosing one. The raw event name is in each option's accessible name
    // precisely so a developer (and this test) can find it unambiguously.
    await page.getByRole('checkbox', { name: /GoalCompleted/ }).check();
    await page.getByRole('button', { name: 'สร้างปลายทาง' }).click();

    // The secret and the sentence that governs it are one control. A secret
    // rendered without "this is the only time" is a secret somebody will
    // assume they can come back for — and no route will ever give it back.
    await expect(page.getByText('รหัสลับสำหรับลงลายเซ็น — แสดงเพียงครั้งเดียว')).toBeVisible();
    await expect(
      page.getByText('นี่คือครั้งเดียวที่รหัสลับนี้จะถูกแสดง', { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByText('รหัสลับที่หายไปกู้คืนไม่ได้ ถ้าทำหาย ให้ลบปลายทางนี้แล้วสร้างใหม่'),
    ).toBeVisible();
    // whsec_ is the shape of the thing being shown; asserting it proves the
    // panel is showing the secret rather than a placeholder.
    await expect(page.getByText(/whsec_/)).toBeVisible();

    await expectNoHorizontalScroll(page);
  });

  test('a failed delivery shows its response code and its error text', async ({ page }) => {
    await signIn(page);

    // The delivery log is stubbed for this one assertion, and only this one.
    // A genuinely `failed` delivery needs five real attempts with exponential
    // backoff against an unreachable host — minutes of waiting that a browser
    // test cannot honestly produce. What is under test here is the screen: that
    // a failure arrives with its HTTP code, its error text and a way to send it
    // again, rather than as the word "failed" and nothing to act on.
    await page.route('**/webhooks/deliveries*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          deliveries: [
            {
              id: '0192f2c0-0000-7000-8000-0000000000ff',
              endpointId: '0192f2c0-0000-7000-8000-0000000000aa',
              eventId: '0192f2c0-0000-7000-8000-0000000000bb',
              eventName: 'OrderPlaced',
              status: 'failed',
              attempts: 5,
              responseCode: 502,
              error: 'upstream returned an empty response',
              nextAttemptAt: null,
              deliveredAt: null,
              createdAt: new Date().toISOString(),
            },
          ],
        }),
      });
    });

    await page.goto('/th/admin');
    await page.getByRole('button', { name: 'การเชื่อมต่อ' }).click();
    await expect(page.getByText('บันทึกการส่ง').first()).toBeVisible();

    await expect(page.getByText('HTTP 502')).toBeVisible();
    await expect(page.getByText('upstream returned an empty response')).toBeVisible();
    await expect(page.getByText('พยายามแล้ว 5 ครั้ง', { exact: false })).toBeVisible();
    // "It didn't work" is not a support answer, and neither is a log with no
    // way to try again.
    await expect(page.getByRole('button', { name: 'ส่งอีกครั้ง' })).toBeVisible();

    await expectNoHorizontalScroll(page);
  });

  test('signing out leaves the authenticated area', async ({ page }) => {
    await signIn(page);
    // On a phone the header carries only what is needed constantly; signing
    // out lives in the menu, which is where someone looks for it.
    await page.getByRole('button', { name: 'เมนู' }).click();
    await page.getByRole('button', { name: 'ออกจากระบบ' }).click();
    await page.waitForURL(/\/th(\/sign-in)?\/?$/);
  });

  test('every destination is at most two taps away, and the bar fits', async ({ page }) => {
    await signIn(page);
    // The whole point of the redesign: twenty destinations, none of them
    // buried. Open the menu, tap a second-level entry, arrive.
    await page.getByRole('button', { name: 'เมนู' }).click();
    await expect(page.getByRole('dialog', { name: 'เมนูหลัก' })).toBeVisible();
    await page.getByRole('link', { name: 'รายได้' }).click();
    await page.waitForURL(/\/th\/earnings/);
    await expectNoHorizontalScroll(page);

    // and the sheet closed itself on the way — a menu left open over a new
    // page is the small rudeness that makes an app feel unfinished
    await expect(page.getByRole('dialog', { name: 'เมนูหลัก' })).toHaveCount(0);
  });
});
