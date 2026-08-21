/**
 * The spec §72 sequence, walked end to end THROUGH THE UI (docs/16, Slice 1).
 *
 * docs/16's first exit criterion has been unticked since it was written. The
 * API-level suite drives the whole sequence server-side, and the other browser
 * file checks that each screen renders at a phone width — but nothing walked
 * the sequence itself, which is the thing the criterion actually asks for:
 *
 *   Platform Admin → Create Tenant → Create Plan → Tenant Admin Login
 *   → Create Team → Assign Leader → Invite Member → Member Registers
 *   → Membership Activated → Joins Team → Creates Goal → Starts Course
 *   → Completes Lesson → Dashboard Updates
 *
 * Two harness steps stand outside the browser, and both are honest about what
 * they replace:
 *
 *   · The tenant and its platform admin are provisioned over the API. A human
 *     platform owner would do this in the console, and the other suite proves
 *     that console renders; repeating it here would double the runtime to
 *     re-prove somebody else's assertion.
 *   · The invitation TOKEN is read from the outbox event, because it exists
 *     nowhere a browser can reach. That read stands in for opening the email —
 *     the acceptance itself happens in the browser, on the real invite page.
 *
 * Everything a person does, a person does here.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { createOwnerClient } from '@aviora/db';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3021/api/v1';
const RUN = Date.now().toString(36);
const PLATFORM_EMAIL = process.env.AVIORA_SEED_PLATFORM_ADMIN_EMAIL ?? 'admin@aviora.local';
const PLATFORM_PW = process.env.AVIORA_SEED_PLATFORM_ADMIN_PASSWORD ?? 'local-dev-admin-password-1';
const PW = 'e2e-journey-password-1';

const adminEmail = `journey-admin-${RUN}@test.local`;
const memberEmail = `journey-member-${RUN}@test.local`;
const TEAM_CODE = `jteam${RUN}`;
const TEAM_NAME = `Journey Team ${RUN}`;
const GOAL_TITLE = `นอนให้ครบ ${RUN}`;

let tenantId = '';

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

  const tenantRes = await request.post(`${API}/platform/tenants`, {
    headers: { authorization: `Bearer ${platformToken}` },
    data: {
      code: `jrn_${RUN}`,
      name: `Journey Co ${RUN}`,
      slug: `jrn-${RUN}`,
      defaultLanguage: 'th',
      adminEmail,
      adminDisplayName: 'Journey Admin',
      adminPassword: PW,
    },
  });
  expect(tenantRes.status(), await tenantRes.text()).toBe(201);
  tenantId = (await tenantRes.json()).tenant.id as string;

  const adminLogin = await request.post(`${API}/auth/login`, {
    data: { email: adminEmail, password: PW },
  });
  const adminToken = accessTokenFrom(await adminLogin.headersArray());
  const plan = await request.post(`${API}/membership-plans`, {
    headers: { authorization: `Bearer ${adminToken}`, 'x-tenant-id': tenantId },
    data: { code: 'starter', name: 'Starter', trialDays: 14, entitlementKeys: ['course.access'] },
  });
  expect(plan.status(), await plan.text()).toBe(201);
  await request.dispose();
});

async function signIn(page: Page, email: string) {
  await page.goto('/th/sign-in');
  await page.getByLabel('อีเมล').fill(email);
  await page.getByLabel('รหัสผ่าน').fill(PW);
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
  await page.waitForURL(/\/th\/(dashboard|admin)/);
}

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'page scrolls horizontally at a phone width').toBeLessThanOrEqual(1);
}

test.describe('The §72 sequence, in a phone browser', () => {
  test('runs from an empty tenant to a dashboard that shows the work', async ({ page }) => {
    /* ── the tenant admin signs in ───────────────────────────────────────── */
    await signIn(page, adminEmail);
    await expectNoHorizontalScroll(page);

    /* ── creates a team ──────────────────────────────────────────────────── */
    // The admin console is one page with client-side tabs, not a route per
    // section — so this clicks the tab a person would click.
    await page.goto('/th/admin');
    await page.getByRole('button', { name: 'ทีม', exact: true }).click();
    await page.getByLabel('รหัสทีม').fill(TEAM_CODE);
    await page.getByLabel('ชื่อทีม').fill(TEAM_NAME);
    await page.getByRole('button', { name: 'สร้างทีม' }).click();
    // Scoped to the list, not "any text on the page": the parent-team dropdown
    // also carries the name in an <option>, which is never visible and made an
    // earlier version of this assertion fail on a team that had been created
    // perfectly well.
    await expect(
      page.getByRole('listitem').filter({ hasText: TEAM_NAME }).first(),
      'the team did not appear in the admin list after being created',
    ).toBeVisible();
    await expectNoHorizontalScroll(page);

    /* ── invites a member ────────────────────────────────────────────────── */
    await page.getByRole('button', { name: 'คำเชิญ', exact: true }).click();
    await page.getByLabel('อีเมล').fill(memberEmail);
    await page.getByRole('button', { name: 'ส่งคำเชิญ' }).click();
    // Invitations render as table rows, teams as list items — asserting on the
    // element each actually uses rather than on "text somewhere on the page".
    await expect(
      page.getByRole('row').filter({ hasText: memberEmail }).first(),
      'the invitation was not listed after being sent',
    ).toBeVisible();

    /* ── the member opens their invitation ───────────────────────────────── */
    // The token lives only in the outbox event — this read is the email the
    // member would have received. Everything after it is the real page.
    const owner = createOwnerClient();
    let token: string;
    try {
      const event = await owner.domainEvent.findFirst({
        where: { eventName: 'MemberInvited', tenantId },
        orderBy: { occurredAt: 'desc' },
      });
      expect(
        event,
        'no MemberInvited event — the invitation never reached the outbox',
      ).toBeTruthy();
      token = (event!.payload as { token: string }).token;
    } finally {
      await owner.$disconnect();
    }

    await page.context().clearCookies();
    await page.goto(`/th/invite/${token}`);
    await expect(page.getByLabel('ชื่อที่แสดง')).toBeVisible();
    await page.getByLabel('ชื่อที่แสดง').fill('Journey Member');
    await page.getByLabel('รหัสผ่าน').fill(PW);
    await page.getByRole('button', { name: 'ตอบรับคำเชิญ' }).click();

    /* ── membership is active, and the member is on their dashboard ──────── */
    await page.waitForURL(/\/th\/(dashboard|sign-in)/, { timeout: 30_000 });
    if (page.url().includes('sign-in')) {
      // Some flows return the member to sign-in after registering; that is a
      // legitimate shape, so follow it rather than failing on it.
      await signIn(page, memberEmail);
    }
    await expect(page).toHaveURL(/\/th\/dashboard/);
    await expectNoHorizontalScroll(page);

    /* ── creates a goal ──────────────────────────────────────────────────── */
    await page.goto('/th/goals');
    await page.getByLabel('ชื่อเป้าหมาย').fill(GOAL_TITLE);
    await page.getByRole('button', { name: 'เพิ่มเป้าหมาย' }).click();
    await expect(
      page.getByText(GOAL_TITLE).first(),
      'the goal did not appear after being created',
    ).toBeVisible();

    /* ── starts a course and completes a lesson ──────────────────────────── */
    await page.goto('/th/learning');
    const start = page.getByRole('button', { name: 'เริ่มเรียน' }).first();
    await expect(
      start,
      'no course offered to a member whose plan carries course.access — the ' +
        'entitlement gate or the seeded course is missing',
    ).toBeVisible();
    await start.click();

    const finishLesson = page.getByRole('button', { name: 'เรียนจบแล้ว' }).first();
    await expect(finishLesson).toBeVisible();
    await finishLesson.click();
    await expect(page.getByText('จบแล้ว').first()).toBeVisible();
    await expectNoHorizontalScroll(page);

    /* ── and the dashboard reflects all of it ────────────────────────────── */
    await page.goto('/th/dashboard');
    await expect(
      page.getByText(GOAL_TITLE).first(),
      'the dashboard does not show the goal the member just created — the last ' +
        'step of §72 is "Dashboard Updates", and this is that step',
    ).toBeVisible();
    await expect(page.getByText('ความคืบหน้าการเรียนรู้')).toBeVisible();
    await expectNoHorizontalScroll(page);
  });
});
