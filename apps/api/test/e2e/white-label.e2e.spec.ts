/**
 * White Label and Multi-Country (spec §54–§56, docs/29).
 *
 * docs/29 §1 writes down the mistake this feature invites, so that sentence is
 * what the file opens with:
 *
 *     `hidden_features` hides navigation. It is not access control. A hidden
 *     route still answers, and it must — the permission and entitlement guards
 *     are what refuse.
 *
 * The headline tests therefore do not check that hiding works. They check that
 * hiding did NOTHING: the same request, made by the same caller, before and
 * after the feature was hidden, comes back byte-for-byte identical — a 200 that
 * was a 200, and a 403 that is still a 403 with the same error code. A feature
 * flag that could turn either of those into the other would mean a tenant can
 * "secure" a route by deleting a menu item, and the first person to type the URL
 * finds it.
 *
 * The second promise is that a tenant supplies DATA, never CODE (§1, §7).
 * Colours carrying markup, colours carrying `javascript:`, a font outside the
 * allow-list and landing copy carrying HTML are each refused by error code, and
 * after each refusal the stored branding is compared against the last known-good
 * snapshot in full — a rejection that half-wrote is not a rejection.
 *
 * The third is that a version is a fact. A legal document is published twice,
 * a member accepts the FIRST one, and the acceptance is then checked to still
 * name version 1 after version 2 exists. "The member accepted the terms" is
 * worthless evidence if nobody can say which terms (§3).
 *
 * The fourth is that country, currency and timezone resolve in ONE place (§2).
 * Currency is proved by moving it once and reading it back out of two unrelated
 * modules; timezone is proved on the only measure where a zone is visible from
 * outside — the `month` analytics window, whose start must be local midnight and
 * not 07:00 local because the server thinks in UTC.
 *
 * And tax is a rate that says so (§4). Every amount below is an integer in minor
 * units with its arithmetic written out in a comment above the assertion, the
 * fixture avoids any figure that would need a rounding rule the contract does
 * not state, and the order that was charged is re-read after the rate moves.
 *
 * NOTE: stop any locally running API — the outbox relay is cross-tenant.
 */
import * as http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import * as argon2 from 'argon2';
import {
  createOwnerClient,
  ensureAppRole,
  withTenant as dbWithTenant,
  type PrismaClient,
  type Tx,
} from '@aviora/db';
import { ENTITLEMENTS, PERMISSIONS } from '@aviora/shared';
import { createApp } from '../../src/app.factory';

const RUN = `w${Date.now().toString(36)}`;
const PLATFORM_EMAIL = `e2e-platform-${RUN}@test.local`;
const PW = 'e2e-password-123456';

let app: INestApplication;
let base: string;
let port: string;
let owner: PrismaClient;

/** Acme sells and configures. Borealis exists only to be invisible from Acme. */
let acme: string;
let borealis: string;
const ACME_SLUG = `e2e-wl-a-${RUN}`;
const BOREALIS_SLUG = `e2e-wl-b-${RUN}`;
/** The browser-facing host each tenant is painted for (docs/29 §6, public by host). */
const ACME_HOST = `${ACME_SLUG}.localhost`;
const BOREALIS_HOST = `${BOREALIS_SLUG}.localhost`;

let acmePlanId: string;
let borealisPlanId: string;
let miaMemberId: string;

/* ── the tenant Acme is, in one place ─────────────────────────────────────── */

const ACME_COUNTRY = 'TH';
const ACME_CURRENCY = 'THB';
/**
 * Fixed +07 all year. A zone with DST would make the month-boundary assertion
 * below depend on the date the suite happens to run, which is exactly the kind
 * of test that gets deleted in six months instead of fixed.
 */
const ACME_ZONE = 'Asia/Bangkok';
const ACME_ZONE_OFFSET_MS = 7 * 60 * 60 * 1000;
const ACME_LOCALE = 'th';
const ACME_SUPPORTED = ['th', 'en'];

/** The country Acme does NOT trade in — used for availability and isolation. */
const FOREIGN_COUNTRY = 'SG';

/* ── branding, as data ────────────────────────────────────────────────────── */

const ACME_APP_NAME = `Acme Wellbeing ${RUN}`;
const BOREALIS_APP_NAME = `Borealis Collective ${RUN}`;
const ACME_HEADLINE = `Begin where you are ${RUN}`;
const BOREALIS_HEADLINE = `Northern light ${RUN}`;
const ACME_PRIMARY = '#0f766e';
const BOREALIS_PRIMARY = '#1d4ed8';
/**
 * INTERPRETATION: §1 says fonts come from an allow-list but does not print the
 * list. `Inter` is the one name a web font allow-list is most likely to hold; if
 * the implementation's list differs this constant is the one-line change and no
 * assertion below moves.
 */
/**
 * The allow-list token. It is stored in one case, and the endpoint accepts any
 * — an administrator typing "Inter" is not an attack.
 */
const ALLOWED_FONT = 'inter';
const ALLOWED_FONT_TYPED = 'Inter';

/**
 * INTERPRETATION: §1 gives `hidden_features` as `String[]` without naming the
 * vocabulary. These are the module names the routes below live under. As with
 * the font, only these two constants would move if the vocabulary differs — the
 * point of the tests is that hiding changes no answer, whatever it is called.
 */
const HIDE_COMMERCE = 'commerce';
const HIDE_RANKS = 'ranks';

/* ── legal ────────────────────────────────────────────────────────────────── */

const TERMS_V1_TITLE = `Terms of membership v1 ${RUN}`;
const TERMS_V1_BODY = `First terms. Cancellation within fourteen days. ${RUN}`;
const TERMS_V2_TITLE = `Terms of membership v2 ${RUN}`;
const TERMS_V2_BODY = `Second terms. Cancellation within thirty days. ${RUN}`;
const BOREALIS_TERMS_TITLE = `Borealis terms ${RUN}`;
const BOREALIS_TERMS_BODY = `Nothing in here belongs to Acme. ${RUN}`;

let termsV1Id: string;
let termsV2Id: string;

/* ── commerce fixtures for tax and availability ───────────────────────────── */

/** THB 1,000.00. Chosen so every rate below divides to a whole minor unit. */
const ATLAS_PRICE_MINOR = 100_000;
const TH_RATE_BP = 700; // 7%
const TH_REGION = 'TH-83';
const TH_REGION_RATE_BP = 200; // 2% — deliberately NOT a fraction of the above
const TH_RATE_BP_AFTER = 1_000; // 10%, applied only after the first order exists
const TH_TAX_LABEL = `VAT ${RUN}`;
const TH_REGION_TAX_LABEL = `Island rate ${RUN}`;
const BOREALIS_TAX_LABEL = `Borealis GST ${RUN}`;

let taxedOrderId: string;

/* ── plumbing ─────────────────────────────────────────────────────────────── */

async function api(
  path: string,
  init: RequestInit & { token?: string; tenant?: string } = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...(init.tenant ? { 'x-tenant-id': init.tenant } : {}),
    },
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/**
 * The same request, but arriving at a HOST — which is the only way `GET
 * /tenant/branding` is reached in production (§6: "public (by host)").
 *
 * `fetch` silently drops a `Host` header, so a browser hitting
 * `acme.example.com` cannot be imitated through it at all; this is a raw
 * request for that one reason, and it sets no `X-Tenant-ID` — if the header
 * were there, the header would be doing the resolving and the test would prove
 * nothing.
 */
function apiAtHost(
  host: string,
  path: string,
  init: { method?: string; token?: string; body?: string } = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: init.method ?? 'GET',
        headers: {
          host: `${host}:${port}`,
          'content-type': 'application/json',
          ...(init.body ? { 'content-length': Buffer.byteLength(init.body) } : {}),
          ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null });
          } catch {
            reject(new Error(`${path} at ${host} returned non-JSON: ${text.slice(0, 200)}`));
          }
        });
      },
    );
    req.on('error', reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

async function login(email: string): Promise<string> {
  const res = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PW }),
  });
  expect(res.status).toBe(200);
  const access = res.headers.getSetCookie().find((c) => c.startsWith('aviora_access='));
  return decodeURIComponent(access!.split(';')[0]!.split('=')[1]!);
}

/**
 * Scoped to one tenant. The library helper applies the tenant extension as well
 * as the GUC, which matters here: these tests connect as the OWNER role, and the
 * owner BYPASSES row-level security. Used for row checks ONLY — every claim this
 * file makes about behaviour is made against an API response.
 */
async function withTenant<T>(tenant: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return dbWithTenant(owner, tenant, fn);
}

async function addMember(
  adminToken: string,
  tenant: string,
  planId: string,
  email: string,
  name: string,
): Promise<string> {
  const inv = await api('/api/v1/invitations', {
    method: 'POST',
    token: adminToken,
    tenant,
    body: JSON.stringify({ email, planId }),
  });
  expect(inv.status).toBe(201);
  const evt = await owner.domainEvent.findFirst({
    where: { eventName: 'MemberInvited', tenantId: tenant, aggregateId: inv.body.invitation.id },
  });
  const accepted = await api(
    `/api/v1/invitations/${(evt!.payload as { token: string }).token}/accept`,
    { method: 'POST', body: JSON.stringify({ displayName: name, password: PW }) },
  );
  expect(accepted.status).toBe(201);
  return accepted.body.memberId;
}

/* ── shape tolerance ──────────────────────────────────────────────────────
 * docs/29 §6 fixes the routes and the permissions, and §1–§5 fix the fields by
 * NAME — but not the JSON envelope. The readers below are lenient about WHERE a
 * value sits; every assertion built on them is exact about WHAT it is.
 * ------------------------------------------------------------------------ */

function preview(body: unknown): string {
  return JSON.stringify(body ?? null)?.slice(0, 400) ?? '';
}

function brandingOf(body: any): any {
  const branding = body?.branding ?? body?.tenantBranding ?? body;
  expect(branding && typeof branding === 'object', `no branding in ${preview(body)}`).toBe(true);
  return branding;
}

function hiddenOf(body: any): string[] {
  const branding = brandingOf(body);
  const hidden =
    branding.hiddenFeatures ?? branding.hidden_features ?? branding.hidden ?? body?.hiddenFeatures;
  expect(Array.isArray(hidden), `no hiddenFeatures in ${preview(body)}`).toBe(true);
  return hidden as string[];
}

function localisationOf(body: any): any {
  const loc = body?.localisation ?? body?.localization ?? body;
  expect(loc && typeof loc === 'object', `no localisation in ${preview(body)}`).toBe(true);
  return loc;
}

function documentOf(body: any): any {
  const doc = body?.document ?? body?.legalDocument ?? body;
  expect(doc && typeof doc === 'object', `no legal document in ${preview(body)}`).toBe(true);
  return doc;
}

function documentsOf(body: any): any[] {
  const docs = body?.documents ?? body?.legalDocuments ?? body;
  expect(Array.isArray(docs), `no documents array in ${preview(body)}`).toBe(true);
  return docs as any[];
}

function acceptanceOf(body: any): any {
  const acceptance = body?.acceptance ?? body?.legalAcceptance ?? body;
  expect(acceptance && typeof acceptance === 'object', `no acceptance in ${preview(body)}`).toBe(
    true,
  );
  return acceptance;
}

function acceptedDocumentId(body: any): unknown {
  const acceptance = acceptanceOf(body);
  return acceptance.documentId ?? acceptance.document_id ?? acceptance.document?.id;
}

function acceptedVersion(body: any): unknown {
  const acceptance = acceptanceOf(body);
  return acceptance.version ?? acceptance.documentVersion ?? acceptance.document?.version;
}

function taxRulesOf(body: any): any[] {
  const rules = body?.rules ?? body?.taxRules ?? body;
  expect(Array.isArray(rules), `no tax rules array in ${preview(body)}`).toBe(true);
  return rules as any[];
}

function orderOf(body: any): any {
  const order = body?.order ?? body;
  expect(order && typeof order === 'object', `no order in ${preview(body)}`).toBe(true);
  return order;
}

function offeringsOf(body: any): any[] {
  const offerings = body?.offerings ?? body;
  expect(Array.isArray(offerings), `no offerings array in ${preview(body)}`).toBe(true);
  return offerings as any[];
}

function mentions(body: unknown, token: string): boolean {
  return JSON.stringify(body ?? null)
    .toLowerCase()
    .includes(token.toLowerCase());
}

/* ── the tenant's zone, computed here so the API cannot be graded by itself ── */

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zonedParts(zone: string, at: Date): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    expect(part, `${zone} produced no ${type}`).toBeTruthy();
    return Number(part!.value);
  };
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  };
}

/** How far `zone` is ahead of UTC at that instant, in milliseconds. */
function zoneOffsetMs(zone: string, at: Date): number {
  const p = zonedParts(zone, at);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - (at.getTime() - at.getMilliseconds());
}

/** The instant at which the tenant's calendar month began, for that tenant. */
function startOfMonthInZone(zone: string, now = new Date()): Date {
  const p = zonedParts(zone, now);
  const naive = Date.UTC(p.year, p.month - 1, 1, 0, 0, 0);
  const guess = new Date(naive - zoneOffsetMs(zone, now));
  return new Date(naive - zoneOffsetMs(zone, guess));
}

/** Midnight UTC on the first of the month THE TENANT is currently in. */
function utcStartOfSameMonth(zone: string, now = new Date()): Date {
  const p = zonedParts(zone, now);
  return new Date(Date.UTC(p.year, p.month - 1, 1, 0, 0, 0));
}

/* ── request shorthands ───────────────────────────────────────────────────── */

async function putBranding(token: string, tenant: string, body: Record<string, unknown>) {
  return api('/api/v1/tenant/branding', {
    method: 'PUT',
    token,
    tenant,
    body: JSON.stringify(body),
  });
}

async function getBranding(token: string, tenant: string) {
  return api('/api/v1/tenant/branding', { token, tenant });
}

async function putLocalisation(token: string, tenant: string, body: Record<string, unknown>) {
  return api('/api/v1/tenant/localisation', {
    method: 'PUT',
    token,
    tenant,
    body: JSON.stringify(body),
  });
}

async function getLocalisation(token: string, tenant: string) {
  return api('/api/v1/tenant/localisation', { token, tenant });
}

const ACME_LOCALISATION = {
  country: ACME_COUNTRY,
  currency: ACME_CURRENCY,
  timezone: ACME_ZONE,
  defaultLocale: ACME_LOCALE,
  supportedLocales: ACME_SUPPORTED,
};

async function publishLegal(token: string, tenant: string, body: Record<string, unknown>) {
  return api('/api/v1/legal/documents', {
    method: 'POST',
    token,
    tenant,
    body: JSON.stringify(body),
  });
}

async function putTaxRule(token: string, tenant: string, body: Record<string, unknown>) {
  return api('/api/v1/tax/rules', {
    method: 'PUT',
    token,
    tenant,
    body: JSON.stringify(body),
  });
}

async function createOffering(token: string, tenant: string, body: Record<string, unknown>) {
  return api('/api/v1/offerings', {
    method: 'POST',
    token,
    tenant,
    body: JSON.stringify(body),
  });
}

async function addToCart(token: string, tenant: string, offeringId: string) {
  return api('/api/v1/cart/items', {
    method: 'POST',
    token,
    tenant,
    body: JSON.stringify({ offeringId, quantity: 1 }),
  });
}

/**
 * INTERPRETATION: §4 resolves the rule from "the tenant's country and the
 * CUSTOMER'S region", and nothing on the platform holds a customer region — a
 * member has no address. Checkout is the only place the buyer speaks, so this
 * suite passes the region there. If the implementation instead reads it from a
 * profile field, this body is inert (zod strips unknown keys) and one test
 * below — the region-beats-country one — is the only thing that moves.
 */
async function checkout(token: string, tenant: string, region?: string) {
  return api('/api/v1/cart/checkout', {
    method: 'POST',
    token,
    tenant,
    body: JSON.stringify(region ? { region } : {}),
  });
}

async function emptyCart(token: string, tenant: string): Promise<void> {
  const cart = await api('/api/v1/cart', { token, tenant });
  expect(cart.status).toBe(200);
  for (const item of cart.body.cart.items ?? []) {
    await api(`/api/v1/cart/items/${item.id}`, { method: 'DELETE', token, tenant });
  }
}

beforeAll(async () => {
  process.env.AVIORA_OUTBOX_DISABLED = 'true';
  process.env.AVIORA_PII_ENCRYPTION_KEY ??= Buffer.alloc(32, 9).toString('base64');
  owner = createOwnerClient();
  await ensureAppRole(owner);
  for (const key of Object.values(PERMISSIONS)) {
    await owner.permission.upsert({ where: { key }, create: { key }, update: {} });
  }
  for (const key of Object.values(ENTITLEMENTS)) {
    await owner.entitlement.upsert({ where: { key }, create: { key }, update: {} });
  }
  await owner.user.upsert({
    where: { email: PLATFORM_EMAIL },
    create: {
      email: PLATFORM_EMAIL,
      passwordHash: await argon2.hash(PW, { type: argon2.argon2id }),
      displayName: 'E2E Platform Admin',
      platformRole: 'PLATFORM_OWNER',
    },
    update: {},
  });

  app = await createApp({ logger: false });
  await app.listen(0);
  base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  port = new URL(base).port;

  const platform = await login(PLATFORM_EMAIL);
  const mkTenant = async (
    suffix: string,
    slug: string,
    name: string,
    adminEmail: string,
  ): Promise<string> => {
    const res = await api('/api/v1/platform/tenants', {
      method: 'POST',
      token: platform,
      body: JSON.stringify({
        code: `e2e_wl_${suffix}_${RUN}`,
        name,
        slug,
        adminEmail,
        adminDisplayName: 'Admin',
        adminPassword: PW,
      }),
    });
    expect(res.status).toBe(201);
    return res.body.tenant.id as string;
  };
  acme = await mkTenant('a', ACME_SLUG, 'Acme Wellbeing', `admin-a-${RUN}@test.local`);
  borealis = await mkTenant('b', BOREALIS_SLUG, 'Borealis Collective', `admin-b-${RUN}@test.local`);

  const adminA = await login(`admin-a-${RUN}@test.local`);
  const adminB = await login(`admin-b-${RUN}@test.local`);

  const mkPlan = async (token: string, tenant: string): Promise<string> => {
    const res = await api('/api/v1/membership-plans', {
      method: 'POST',
      token,
      tenant,
      body: JSON.stringify({
        code: 'insider',
        name: 'Insider',
        entitlementKeys: [ENTITLEMENTS.COMMERCE],
      }),
    });
    expect(res.status).toBe(201);
    return res.body.plan.id as string;
  };
  acmePlanId = await mkPlan(adminA, acme);
  borealisPlanId = await mkPlan(adminB, borealis);

  // Mia is a plain member on a plan that may buy: she is both the permitted
  // caller and the unpermitted one, depending on the route.
  miaMemberId = await addMember(adminA, acme, acmePlanId, `mia-${RUN}@test.local`, 'Mia Sorrel');
  await addMember(adminB, borealis, borealisPlanId, `otto-${RUN}@test.local`, 'Otto Lindqvist');

  // Something for the catalogue to hold before anything is hidden.
  const seed = await createOffering(adminA, acme, {
    code: 'field-notes',
    name: 'Field Notes booklet',
    kind: 'one_time',
    currency: ACME_CURRENCY,
    priceMinor: 25_000,
  });
  expect(seed.status).toBe(201);

  // A rank ladder, so the "hidden but permitted" route below has something to
  // return rather than an empty list that would be equal to itself trivially.
  const rank = await api('/api/v1/ranks', {
    method: 'POST',
    token: adminA,
    tenant: acme,
    body: JSON.stringify({
      code: 'bronze',
      name: 'Bronze',
      level: 1,
      qualifications: [{ metric: 'personal_volume', comparator: 'gte', threshold: 100_000 }],
    }),
  });
  expect(rank.status).toBe(201);

  // The branding both tenants start from — every later assertion is a change
  // against a state this suite set itself.
  const acmeBranding = await putBranding(adminA, acme, {
    appName: ACME_APP_NAME,
    logoUrl: `https://cdn.example.com/${RUN}/acme.svg`,
    colors: { primary: ACME_PRIMARY, surface: '#f8fafc' },
    fontFamily: ALLOWED_FONT,
    landing: { headline: ACME_HEADLINE, subheadline: 'A quieter kind of progress.' },
    emailFromName: `Acme ${RUN}`,
    emailFooter: `Acme Wellbeing, Bangkok. ${RUN}`,
    hiddenFeatures: [],
  });
  expect(acmeBranding.status).toBe(200);

  const borealisBranding = await putBranding(adminB, borealis, {
    appName: BOREALIS_APP_NAME,
    logoUrl: `https://cdn.example.com/${RUN}/borealis.svg`,
    colors: { primary: BOREALIS_PRIMARY, surface: '#0b1120' },
    fontFamily: ALLOWED_FONT,
    landing: { headline: BOREALIS_HEADLINE, subheadline: 'Further north.' },
    emailFromName: `Borealis ${RUN}`,
    emailFooter: `Borealis Collective, Tromsø. ${RUN}`,
    hiddenFeatures: [],
  });
  expect(borealisBranding.status).toBe(200);
}, 300_000);

afterAll(async () => {
  await app?.close();
  await owner?.$disconnect();
});

describe('Hiding is presentation and never a permission (docs/29 §1)', () => {
  it('lists a hidden feature as hidden while its own routes answer exactly as before', async () => {
    // This is the test the whole file is built around. It does not check that
    // hiding worked; it checks that hiding did NOTHING to authorization.
    const admin = await login(`admin-a-${RUN}@test.local`);
    const mia = await login(`mia-${RUN}@test.local`);

    const memberBefore = await api('/api/v1/offerings', { token: mia, tenant: acme });
    const adminBefore = await api('/api/v1/coupons', { token: admin, tenant: acme });
    expect(memberBefore.status).toBe(200);
    expect(adminBefore.status).toBe(200);

    const hidden = await putBranding(admin, acme, {
      appName: ACME_APP_NAME,
      hiddenFeatures: [HIDE_COMMERCE],
    });
    expect(hidden.status).toBe(200);
    expect(hiddenOf(hidden.body)).toContain(HIDE_COMMERCE);

    // the browser is told, in the one response that paints navigation
    const painted = await apiAtHost(ACME_HOST, '/api/v1/tenant/branding');
    expect(painted.status).toBe(200);
    expect(hiddenOf(painted.body)).toContain(HIDE_COMMERCE);

    // …and the routes behind it are untouched, byte for byte
    const memberAfter = await api('/api/v1/offerings', { token: mia, tenant: acme });
    const adminAfter = await api('/api/v1/coupons', { token: admin, tenant: acme });
    expect(memberAfter.status).toBe(memberBefore.status);
    expect(memberAfter.body).toEqual(memberBefore.body);
    expect(adminAfter.status).toBe(adminBefore.status);
    expect(adminAfter.body).toEqual(adminBefore.body);

    // not a 404 either — "hidden" must not become "does not exist", or a member
    // who bookmarked the page gets a lie instead of their catalogue
    expect(memberAfter.status).toBe(200);
    expect(offeringsOf(memberAfter.body).map((o: { code: string }) => o.code)).toContain(
      'field-notes',
    );
  });

  it('still refuses the caller who lacks the permission, with the same status and code', async () => {
    // The other direction, and the one that matters for security: hiding must
    // not be mistaken for a guard, so a route that refused before refuses now,
    // for the same stated reason.
    const admin = await login(`admin-a-${RUN}@test.local`);
    const mia = await login(`mia-${RUN}@test.local`);

    // commerce is still hidden from the previous test
    expect(hiddenOf((await getBranding(admin, acme)).body)).toContain(HIDE_COMMERCE);

    const denied = await api('/api/v1/coupons', { token: mia, tenant: acme });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('FORBIDDEN');

    const alsoDenied = await api('/api/v1/offerings', {
      method: 'POST',
      token: mia,
      tenant: acme,
      body: JSON.stringify({
        code: `smuggled-${RUN}`,
        name: 'Something I published myself',
        kind: 'one_time',
        currency: ACME_CURRENCY,
        priceMinor: 1,
      }),
    });
    expect(alsoDenied.status).toBe(403);
    expect(alsoDenied.body.error.code).toBe('FORBIDDEN');

    // and nothing was created by the refused write
    const catalogue = await api('/api/v1/offerings', { token: mia, tenant: acme });
    expect(offeringsOf(catalogue.body).map((o: { code: string }) => o.code)).not.toContain(
      `smuggled-${RUN}`,
    );
  });

  it('hides a second feature without moving the permitted route behind it either', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const before = await api('/api/v1/ranks', { token: admin, tenant: acme });
    expect(before.status).toBe(200);

    const hidden = await putBranding(admin, acme, {
      appName: ACME_APP_NAME,
      hiddenFeatures: [HIDE_COMMERCE, HIDE_RANKS],
    });
    expect(hidden.status).toBe(200);
    expect(hiddenOf(hidden.body)).toEqual(expect.arrayContaining([HIDE_COMMERCE, HIDE_RANKS]));

    const after = await api('/api/v1/ranks', { token: admin, tenant: acme });
    expect(after.status).toBe(before.status);
    expect(after.body).toEqual(before.body);
  });

  it('unhides, and again changes no answer — the two layers never met', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const mia = await login(`mia-${RUN}@test.local`);

    const permittedBefore = await api('/api/v1/offerings', { token: mia, tenant: acme });
    const refusedBefore = await api('/api/v1/coupons', { token: mia, tenant: acme });

    const shown = await putBranding(admin, acme, {
      appName: ACME_APP_NAME,
      hiddenFeatures: [],
    });
    expect(shown.status).toBe(200);
    expect(hiddenOf(shown.body)).toEqual([]);

    const permittedAfter = await api('/api/v1/offerings', { token: mia, tenant: acme });
    const refusedAfter = await api('/api/v1/coupons', { token: mia, tenant: acme });

    expect(permittedAfter.status).toBe(permittedBefore.status);
    expect(permittedAfter.body).toEqual(permittedBefore.body);
    // revealing a feature grants nothing: still 403, still FORBIDDEN
    expect(refusedAfter.status).toBe(refusedBefore.status);
    expect(refusedAfter.status).toBe(403);
    expect(refusedAfter.body.error.code).toBe('FORBIDDEN');
  });

  it('does not let a member edit the branding that decides what they see', async () => {
    const mia = await login(`mia-${RUN}@test.local`);
    const res = await putBranding(mia, acme, { appName: 'Mia Incorporated', hiddenFeatures: [] });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');

    const admin = await login(`admin-a-${RUN}@test.local`);
    expect(brandingOf((await getBranding(admin, acme)).body).appName).toBe(ACME_APP_NAME);
  });
});

describe('A tenant supplies data, never code (docs/29 §1, §7)', () => {
  /** The last state the branding was legitimately in, refreshed after each pass. */
  let good: any;

  it('accepts a colour, a font from the allow-list and plain landing copy', async () => {
    // The refusals below are only worth anything if the endpoint accepts
    // ANYTHING. This is that proof, and it also captures the snapshot the
    // rejected writes are compared against.
    const admin = await login(`admin-a-${RUN}@test.local`);
    const res = await putBranding(admin, acme, {
      appName: ACME_APP_NAME,
      logoUrl: `https://cdn.example.com/${RUN}/acme.svg`,
      colors: { primary: ACME_PRIMARY, surface: '#f8fafc' },
      fontFamily: ALLOWED_FONT,
      landing: { headline: ACME_HEADLINE, subheadline: 'A quieter kind of progress.' },
      emailFromName: `Acme ${RUN}`,
      emailFooter: `Acme Wellbeing, Bangkok. ${RUN}`,
      hiddenFeatures: [],
    });
    expect(res.status).toBe(200);
    const branding = brandingOf(res.body);
    expect(branding.colors.primary).toBe(ACME_PRIMARY);
    expect(branding.fontFamily).toBe(ALLOWED_FONT);

    // …and the same font typed the way a person would type it is the same font
    const typed = await putBranding(admin, acme, { fontFamily: ALLOWED_FONT_TYPED });
    expect(typed.status).toBe(200);
    expect(brandingOf(typed.body).fontFamily).toBe(ALLOWED_FONT);

    good = brandingOf((await getBranding(admin, acme)).body);
  });

  const rejections: Array<{ what: string; token: string; payload: Record<string, unknown> }> = [
    {
      what: 'a colour carrying markup',
      token: '<script>',
      payload: { colors: { primary: `#0f766e"></style><script>alert(1)</script>` } },
    },
    {
      what: 'a colour that is a javascript: URL',
      token: 'javascript:',
      payload: { colors: { primary: 'javascript:alert(document.cookie)' } },
    },
    {
      what: 'a colour smuggling a CSS rule out of its own declaration',
      token: 'display:none',
      payload: { colors: { primary: 'red; } html { display:none } .x{ color:red' } },
    },
    {
      what: 'a font outside the allow-list',
      token: 'Ransom Note Deluxe',
      payload: { fontFamily: 'Ransom Note Deluxe' },
    },
    {
      what: 'a font smuggling a remote stylesheet',
      token: 'evil.example',
      payload: { fontFamily: `Inter'; src: url(https://evil.example/f.woff2); font-family: '` },
    },
    {
      what: 'landing copy carrying HTML tags',
      token: '<h1>',
      payload: { landing: { headline: '<h1>Join now</h1><img src=x onerror=alert(1)>' } },
    },
    {
      what: 'an email footer carrying an anchor',
      token: 'unsubscribe.evil',
      payload: { emailFooter: '<a href="https://unsubscribe.evil/x">Unsubscribe</a>' },
    },
  ];

  for (const { what, token, payload } of rejections) {
    it(`refuses ${what}, and stores nothing`, async () => {
      const admin = await login(`admin-a-${RUN}@test.local`);
      const res = await putBranding(admin, acme, { appName: ACME_APP_NAME, ...payload });

      expect([400, 422], `${what} → ${res.status}: ${preview(res.body)}`).toContain(res.status);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');

      // A rejection that half-wrote is not a rejection: the WHOLE record must
      // be what it was, not merely free of the offending token.
      const after = brandingOf((await getBranding(admin, acme)).body);
      expect(after).toEqual(good);
      expect(mentions(after, token), `${what} left "${token}" behind`).toBe(false);

      // and nothing reached the public page either
      const painted = await apiAtHost(ACME_HOST, '/api/v1/tenant/branding');
      expect(mentions(painted.body, token)).toBe(false);
    });
  }

  it('never emits a style or script element on the public branding response', async () => {
    // The point of refusing tenant CSS is that no member's browser is ever
    // handed a tenant's markup. Checked on the response a browser actually
    // reads, after everything above tried to get some in.
    const painted = await apiAtHost(ACME_HOST, '/api/v1/tenant/branding');
    expect(painted.status).toBe(200);
    const serialised = JSON.stringify(painted.body);
    expect(serialised).not.toMatch(/<script|<style|<\/|javascript:|onerror=/i);
  });
});

describe('Branding is resolved by host (docs/29 §6)', () => {
  it('answers a browser with no session at all', async () => {
    const res = await apiAtHost(ACME_HOST, '/api/v1/tenant/branding');
    expect(res.status).toBe(200);
    const branding = brandingOf(res.body);
    expect(branding.appName).toBe(ACME_APP_NAME);
    expect(branding.colors.primary).toBe(ACME_PRIMARY);
    expect(branding.fontFamily).toBe(ALLOWED_FONT);
    expect(JSON.stringify(branding.landing)).toContain(ACME_HEADLINE);
  });

  it('gives each host its own tenant, and never the other one', async () => {
    const forAcme = await apiAtHost(ACME_HOST, '/api/v1/tenant/branding');
    const forBorealis = await apiAtHost(BOREALIS_HOST, '/api/v1/tenant/branding');
    expect(forAcme.status).toBe(200);
    expect(forBorealis.status).toBe(200);

    expect(brandingOf(forAcme.body).appName).toBe(ACME_APP_NAME);
    expect(brandingOf(forBorealis.body).appName).toBe(BOREALIS_APP_NAME);

    // not by name, colour, headline or id — in either direction
    expect(mentions(forAcme.body, BOREALIS_APP_NAME)).toBe(false);
    expect(mentions(forAcme.body, BOREALIS_HEADLINE)).toBe(false);
    expect(mentions(forAcme.body, BOREALIS_PRIMARY)).toBe(false);
    expect(mentions(forAcme.body, borealis)).toBe(false);

    expect(mentions(forBorealis.body, ACME_APP_NAME)).toBe(false);
    expect(mentions(forBorealis.body, ACME_HEADLINE)).toBe(false);
    expect(mentions(forBorealis.body, ACME_PRIMARY)).toBe(false);
    expect(mentions(forBorealis.body, acme)).toBe(false);
  });

  it('does not put a member list, an email or a secret on the public response', async () => {
    // Public means public. Whatever else this route carries, it must carry
    // nothing a stranger should not have.
    const res = await apiAtHost(ACME_HOST, '/api/v1/tenant/branding');
    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toMatch(/@test\.local/);
    expect(serialised).not.toMatch(/passwordHash|password_hash|secret|token/i);
    expect(mentions(res.body, miaMemberId)).toBe(false);
  });

  it('refuses to guess when no host and no header resolve a tenant', async () => {
    // 127.0.0.1 resolves nothing. A public route that quietly picked "the first
    // tenant" would paint one tenant's brand onto another's domain.
    const res = await api('/api/v1/tenant/branding');
    expect(res.status).not.toBe(200);
    expect([400, 404]).toContain(res.status);
  });
});

describe('Legal documents are versioned and acceptance names the version (docs/29 §3)', () => {
  it('publishes version 1', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const res = await publishLegal(admin, acme, {
      kind: 'terms',
      locale: 'en',
      country: ACME_COUNTRY,
      title: TERMS_V1_TITLE,
      body: TERMS_V1_BODY,
    });
    expect(res.status).toBe(201);
    const doc = documentOf(res.body);
    expect(doc.version).toBe(1);
    expect(doc.kind).toBe('terms');
    expect(doc.locale).toBe('en');
    expect(doc.country).toBe(ACME_COUNTRY);
    expect(doc.publishedAt).toBeTruthy();
    termsV1Id = doc.id;
    expect(typeof termsV1Id).toBe('string');
  });

  it('reads back version 1 as the current one, without a session', async () => {
    const res = await apiAtHost(ACME_HOST, `/api/v1/legal/terms?locale=en&country=${ACME_COUNTRY}`);
    expect(res.status).toBe(200);
    const doc = documentOf(res.body);
    expect(doc.id).toBe(termsV1Id);
    expect(doc.version).toBe(1);
    expect(doc.body).toBe(TERMS_V1_BODY);
  });

  it('records an acceptance that names the document id and version, not a boolean', async () => {
    // §3: "the member accepted the terms" is worthless evidence if nobody can
    // say which terms.
    const mia = await login(`mia-${RUN}@test.local`);
    const res = await api(`/api/v1/legal/terms/accept`, {
      method: 'POST',
      token: mia,
      tenant: acme,
      body: JSON.stringify({ documentId: termsV1Id, locale: 'en', country: ACME_COUNTRY }),
    });
    expect([200, 201]).toContain(res.status);

    expect(acceptedDocumentId(res.body)).toBe(termsV1Id);
    expect(acceptedVersion(res.body)).toBe(1);
    expect(acceptanceOf(res.body).acceptedAt).toBeTruthy();

    // it is a record, not a flag: nowhere in the response is the whole answer a
    // bare true
    const acceptance = acceptanceOf(res.body);
    expect(typeof acceptedDocumentId(res.body)).toBe('string');
    expect(acceptance.accepted === true && Object.keys(acceptance).length === 1).toBe(false);
  });

  it('accepts twice without recording it twice', async () => {
    const mia = await login(`mia-${RUN}@test.local`);
    const again = await api(`/api/v1/legal/terms/accept`, {
      method: 'POST',
      token: mia,
      tenant: acme,
      body: JSON.stringify({ documentId: termsV1Id, locale: 'en', country: ACME_COUNTRY }),
    });
    expect([200, 201]).toContain(again.status);
    expect(acceptedDocumentId(again.body)).toBe(termsV1Id);
    expect(acceptedVersion(again.body)).toBe(1);

    // one row, not two — a second click is not a second agreement
    const rows = await withTenant(acme, (tx) =>
      tx.legalAcceptance.count({ where: { memberId: miaMemberId, documentId: termsV1Id } }),
    );
    expect(rows).toBe(1);
  });

  it('publishes a second version rather than editing the first', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const res = await publishLegal(admin, acme, {
      kind: 'terms',
      locale: 'en',
      country: ACME_COUNTRY,
      title: TERMS_V2_TITLE,
      body: TERMS_V2_BODY,
    });
    expect(res.status).toBe(201);
    const doc = documentOf(res.body);
    expect(doc.version).toBe(2);
    expect(doc.id).not.toBe(termsV1Id);
    termsV2Id = doc.id;
  });

  it('serves the latest version from the current endpoint', async () => {
    const res = await apiAtHost(ACME_HOST, `/api/v1/legal/terms?locale=en&country=${ACME_COUNTRY}`);
    expect(res.status).toBe(200);
    const doc = documentOf(res.body);
    expect(doc.id).toBe(termsV2Id);
    expect(doc.version).toBe(2);
    expect(doc.body).toBe(TERMS_V2_BODY);
    expect(doc.body).not.toBe(TERMS_V1_BODY);
  });

  it('refuses to modify a published document', async () => {
    // §3: "Rewriting what somebody agreed to, after they agreed to it, is not
    // an edit." There is no update route in §6; whichever way one is reached
    // for, the answer must not be success.
    const admin = await login(`admin-a-${RUN}@test.local`);
    const attempts = [
      await api(`/api/v1/legal/documents/${termsV1Id}`, {
        method: 'PATCH',
        token: admin,
        tenant: acme,
        body: JSON.stringify({ body: `Rewritten after the fact ${RUN}` }),
      }),
      await api(`/api/v1/legal/documents/${termsV1Id}`, {
        method: 'PUT',
        token: admin,
        tenant: acme,
        body: JSON.stringify({
          kind: 'terms',
          locale: 'en',
          country: ACME_COUNTRY,
          title: TERMS_V1_TITLE,
          body: `Rewritten after the fact ${RUN}`,
        }),
      }),
      await api(`/api/v1/legal/documents/${termsV1Id}`, {
        method: 'DELETE',
        token: admin,
        tenant: acme,
      }),
    ];
    for (const attempt of attempts) {
      expect([400, 403, 404, 405, 409, 422], preview(attempt.body)).toContain(attempt.status);
    }

    // and version 1 still says what it said
    const all = await api('/api/v1/legal/documents', { token: admin, tenant: acme });
    expect(all.status).toBe(200);
    const v1 = documentsOf(all.body).find((d: { id: string }) => d.id === termsV1Id);
    expect(v1, 'version 1 disappeared').toBeTruthy();
    expect(v1.body).toBe(TERMS_V1_BODY);
  });

  it('keeps the superseded version readable, and the old acceptance pointing at it', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const all = await api('/api/v1/legal/documents', { token: admin, tenant: acme });
    expect(all.status).toBe(200);

    const versions = documentsOf(all.body)
      .filter((d: { kind: string; locale: string }) => d.kind === 'terms' && d.locale === 'en')
      .map((d: { version: number }) => d.version)
      .sort();
    expect(versions).toEqual(expect.arrayContaining([1, 2]));

    const v1 = documentsOf(all.body).find((d: { id: string }) => d.id === termsV1Id);
    expect(v1.body).toBe(TERMS_V1_BODY);
    expect(v1.title).toBe(TERMS_V1_TITLE);

    // Mia agreed to the FIRST terms. Publishing the second cannot move what she
    // agreed to — there is no read route for one acceptance in §6, so this is a
    // direct row check, and the only one this section makes.
    const acceptance = await withTenant(acme, (tx) =>
      tx.legalAcceptance.findFirst({ where: { memberId: miaMemberId, documentId: termsV1Id } }),
    );
    expect(acceptance, "Mia's acceptance of version 1 is gone").toBeTruthy();
    expect(acceptance!.documentId).toBe(termsV1Id);
    expect(acceptance!.documentId).not.toBe(termsV2Id);
  });

  it('lets the same member accept the new version as a separate record', async () => {
    const mia = await login(`mia-${RUN}@test.local`);
    const res = await api(`/api/v1/legal/terms/accept`, {
      method: 'POST',
      token: mia,
      tenant: acme,
      body: JSON.stringify({ documentId: termsV2Id, locale: 'en', country: ACME_COUNTRY }),
    });
    expect([200, 201]).toContain(res.status);
    expect(acceptedDocumentId(res.body)).toBe(termsV2Id);
    expect(acceptedVersion(res.body)).toBe(2);

    // two agreements, to two different documents — not one row overwritten
    const rows = await withTenant(acme, (tx) =>
      tx.legalAcceptance.findMany({ where: { memberId: miaMemberId } }),
    );
    expect(rows.map((r) => r.documentId).sort()).toEqual([termsV1Id, termsV2Id].sort());
  });

  it('keeps the whole version list to administrators', async () => {
    const mia = await login(`mia-${RUN}@test.local`);
    const res = await api('/api/v1/legal/documents', { token: mia, tenant: acme });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('does not invent a document for a kind nobody published', async () => {
    const res = await apiAtHost(
      ACME_HOST,
      `/api/v1/legal/refund?locale=en&country=${ACME_COUNTRY}`,
    );
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('Country and currency resolve in one place (docs/29 §2)', () => {
  it('stores the tenant’s country, currency, timezone and locales', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const res = await putLocalisation(admin, acme, ACME_LOCALISATION);
    expect(res.status).toBe(200);

    const loc = localisationOf(res.body);
    expect(loc.country).toBe(ACME_COUNTRY);
    expect(loc.currency).toBe(ACME_CURRENCY);
    expect(loc.timezone).toBe(ACME_ZONE);
    expect(loc.defaultLocale).toBe(ACME_LOCALE);
    expect(loc.supportedLocales).toEqual(expect.arrayContaining(ACME_SUPPORTED));

    // any member may read what country and currency they are in
    const mia = await login(`mia-${RUN}@test.local`);
    const mine = await getLocalisation(mia, acme);
    expect(mine.status).toBe(200);
    expect(localisationOf(mine.body).currency).toBe(ACME_CURRENCY);
    expect(localisationOf(mine.body).timezone).toBe(ACME_ZONE);
  });

  it('quotes that currency from every endpoint that quotes money', async () => {
    // §2: "One tenant, one currency, resolved in one place." Ranks and
    // automation rules are two modules that never speak to each other; if they
    // agree, there is one resolver.
    const admin = await login(`admin-a-${RUN}@test.local`);
    const ranks = await api('/api/v1/ranks', { token: admin, tenant: acme });
    const rules = await api('/api/v1/automation/rules', { token: admin, tenant: acme });
    expect(ranks.status).toBe(200);
    expect(rules.status).toBe(200);
    expect(ranks.body.currency).toBe(ACME_CURRENCY);
    expect(rules.body.currency).toBe(ACME_CURRENCY);
  });

  it('moves both of them when the tenant’s currency moves — one setting, one answer', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const moved = await putLocalisation(admin, acme, { ...ACME_LOCALISATION, currency: 'SGD' });
    expect(moved.status).toBe(200);
    expect(localisationOf(moved.body).currency).toBe('SGD');

    const ranks = await api('/api/v1/ranks', { token: admin, tenant: acme });
    const rules = await api('/api/v1/automation/rules', { token: admin, tenant: acme });
    expect(ranks.body.currency).toBe('SGD');
    expect(rules.body.currency).toBe('SGD');
    // and neither is still answering with the old one from its own copy
    expect(ranks.body.currency).not.toBe(ACME_CURRENCY);
    expect(rules.body.currency).not.toBe(ACME_CURRENCY);

    // put it back; everything after this reads THB again
    const back = await putLocalisation(admin, acme, ACME_LOCALISATION);
    expect(back.status).toBe(200);
    expect((await api('/api/v1/ranks', { token: admin, tenant: acme })).body.currency).toBe(
      ACME_CURRENCY,
    );
  });

  it('keeps the commerce.currency setting working, wherever its home now is', async () => {
    // §2: currency "moves here as its home, with the setting kept working."
    // Read through the setting the rest of the platform already resolves.
    const setting = await withTenant(acme, (tx) =>
      tx.tenantSetting.findFirst({ where: { key: 'commerce.currency' } }),
    );
    expect(setting?.value ?? null).toBe(ACME_CURRENCY);
  });

  const badLocalisations: Array<{ what: string; payload: Record<string, unknown> }> = [
    // INTERPRETATION: each of these is WELL FORMED but not a real value — an
    // unassigned ISO-3166 code, an unassigned ISO-4217 code, an IANA zone that
    // does not exist and a language subtag that is not a language. Rejecting a
    // malformed string is easy; rejecting an unknown one is the promise.
    { what: 'an unknown country', payload: { ...ACME_LOCALISATION, country: 'ZZ' } },
    { what: 'an unknown currency', payload: { ...ACME_LOCALISATION, currency: 'QQQ' } },
    { what: 'an unknown timezone', payload: { ...ACME_LOCALISATION, timezone: 'Mars/Olympus' } },
    {
      what: 'an unknown default locale',
      payload: { ...ACME_LOCALISATION, defaultLocale: 'zz', supportedLocales: ['zz'] },
    },
  ];

  for (const { what, payload } of badLocalisations) {
    it(`refuses ${what}, and stores nothing`, async () => {
      const admin = await login(`admin-a-${RUN}@test.local`);
      const res = await putLocalisation(admin, acme, payload);
      expect([400, 422], `${what} → ${res.status}: ${preview(res.body)}`).toContain(res.status);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');

      const after = localisationOf((await getLocalisation(admin, acme)).body);
      expect(after.country).toBe(ACME_COUNTRY);
      expect(after.currency).toBe(ACME_CURRENCY);
      expect(after.timezone).toBe(ACME_ZONE);
      expect(after.defaultLocale).toBe(ACME_LOCALE);
    });
  }

  it('does not let a member change the country the tenant trades in', async () => {
    const mia = await login(`mia-${RUN}@test.local`);
    const res = await putLocalisation(mia, acme, {
      ...ACME_LOCALISATION,
      country: FOREIGN_COUNTRY,
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');

    const admin = await login(`admin-a-${RUN}@test.local`);
    expect(localisationOf((await getLocalisation(admin, acme)).body).country).toBe(ACME_COUNTRY);
  });
});

describe('Timezone is what a day means here (docs/29 §2)', () => {
  it('starts the month window at local midnight, not at UTC midnight', async () => {
    // This is the whole reason a timezone is stored. Asia/Bangkok is UTC+07 all
    // year, so the tenant's month began SEVEN HOURS BEFORE midnight UTC on the
    // first — i.e. at 17:00Z on the last day of the previous month. A server
    // thinking in UTC would report a window that starts at 07:00 Bangkok time
    // and quietly drops everything the tenant did that morning.
    const admin = await login(`admin-a-${RUN}@test.local`);
    expect(localisationOf((await getLocalisation(admin, acme)).body).timezone).toBe(ACME_ZONE);

    const res = await api('/api/v1/analytics/tenant?window=month', { token: admin, tenant: acme });
    expect(res.status).toBe(200);

    const echoed = res.body?.window ?? res.body?.resolvedWindow;
    const rawFrom = echoed?.from ?? echoed?.start ?? res.body?.from;
    expect(typeof rawFrom, `month window states no start in ${preview(res.body)}`).toBe('string');
    const from = new Date(rawFrom as string);

    const now = new Date();
    const expected = startOfMonthInZone(ACME_ZONE, now);
    const utcMidnight = utcStartOfSameMonth(ACME_ZONE, now);

    expect(from.toISOString()).toBe(expected.toISOString());
    // stated the other way round, so a failure says by how much and which way
    expect(utcMidnight.getTime() - from.getTime()).toBe(ACME_ZONE_OFFSET_MS);
    expect(from.getTime()).toBeLessThan(utcMidnight.getTime());
    expect(from.getTime()).not.toBe(utcMidnight.getTime());

    // and read as a clock, it is midnight FOR THIS TENANT
    const local = zonedParts(ACME_ZONE, from);
    expect(local.day).toBe(1);
    expect(local.hour).toBe(0);
    expect(local.minute).toBe(0);
  });

  it('moves the boundary when the zone moves', async () => {
    // Same tenant, same data, different zone: the only thing that may change
    // the answer is the setting, which is the claim being made.
    const admin = await login(`admin-a-${RUN}@test.local`);
    const utcTenant = await putLocalisation(admin, acme, {
      ...ACME_LOCALISATION,
      timezone: 'UTC',
    });
    expect(utcTenant.status).toBe(200);

    const res = await api('/api/v1/analytics/tenant?window=month', { token: admin, tenant: acme });
    expect(res.status).toBe(200);
    const echoed = res.body?.window ?? res.body?.resolvedWindow;
    const from = new Date((echoed?.from ?? echoed?.start ?? res.body?.from) as string);
    expect(from.toISOString()).toBe(utcStartOfSameMonth('UTC').toISOString());

    // back to Bangkok for everything that follows
    expect((await putLocalisation(admin, acme, ACME_LOCALISATION)).status).toBe(200);
  });
});

describe('Tax is a single configured rate, and says so (docs/29 §4)', () => {
  let atlasId: string;

  it('publishes something to be taxed', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const res = await createOffering(admin, acme, {
      code: 'atlas',
      name: 'Atlas of small habits',
      kind: 'one_time',
      currency: ACME_CURRENCY,
      priceMinor: ATLAS_PRICE_MINOR,
      availableCountries: [],
    });
    expect(res.status).toBe(201);
    atlasId = res.body.offering.id;
  });

  it('charges no tax, and invents no tax fields, when no rule exists', async () => {
    // §4: a field labelled "tax" that quietly gets it wrong is worse than one
    // that says "single configured rate". No rule means no charge and no story.
    const admin = await login(`admin-a-${RUN}@test.local`);
    const rules = await api('/api/v1/tax/rules', { token: admin, tenant: acme });
    expect(rules.status).toBe(200);
    expect(taxRulesOf(rules.body)).toEqual([]);

    const mia = await login(`mia-${RUN}@test.local`);
    await emptyCart(mia, acme);
    expect((await addToCart(mia, acme, atlasId)).status).toBe(201);

    const res = await checkout(mia, acme);
    expect(res.status).toBe(201);
    const order = orderOf(res.body);

    // subtotal 100_000 · discount 0 · tax 0 → total 100_000
    expect(order.subtotalMinor).toBe(ATLAS_PRICE_MINOR);
    expect(order.discountMinor).toBe(0);
    expect(order.taxMinor ?? 0).toBe(0);
    expect(order.totalMinor).toBe(ATLAS_PRICE_MINOR);
    expect(order.taxLabel ?? null).toBeNull();
    expect(order.taxRateBasisPoints ?? null).toBeNull();
  });

  it('applies the rule for the tenant’s country at checkout', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const rule = await putTaxRule(admin, acme, {
      country: ACME_COUNTRY,
      rateBasisPoints: TH_RATE_BP,
      inclusive: false,
      label: TH_TAX_LABEL,
    });
    expect([200, 201]).toContain(rule.status);

    const mia = await login(`mia-${RUN}@test.local`);
    await emptyCart(mia, acme);
    expect((await addToCart(mia, acme, atlasId)).status).toBe(201);

    const res = await checkout(mia, acme);
    expect(res.status).toBe(201);
    const order = orderOf(res.body);
    taxedOrderId = order.id;

    // 100_000 minor × 700 basis points ÷ 10_000 = 7_000 minor
    // total = 100_000 subtotal − 0 discount + 7_000 tax = 107_000 minor
    expect(order.subtotalMinor).toBe(100_000);
    expect(order.discountMinor).toBe(0);
    expect(order.taxMinor).toBe(7_000);
    expect(order.totalMinor).toBe(107_000);
    expect(order.taxRateBasisPoints).toBe(TH_RATE_BP);
    expect(order.taxLabel).toBe(TH_TAX_LABEL);

    // integers, like every other amount on the platform
    for (const key of ['subtotalMinor', 'discountMinor', 'taxMinor', 'totalMinor'] as const) {
      expect(Number.isInteger(order[key]), key).toBe(true);
    }
  });

  it('lets the more specific region rule win over the country rule', async () => {
    // §4: "the most specific match for the tenant's country and the customer's
    // region". Two rules exist; exactly one may be charged.
    const admin = await login(`admin-a-${RUN}@test.local`);
    const rule = await putTaxRule(admin, acme, {
      country: ACME_COUNTRY,
      region: TH_REGION,
      rateBasisPoints: TH_REGION_RATE_BP,
      inclusive: false,
      label: TH_REGION_TAX_LABEL,
    });
    expect([200, 201]).toContain(rule.status);

    const mia = await login(`mia-${RUN}@test.local`);
    await emptyCart(mia, acme);
    expect((await addToCart(mia, acme, atlasId)).status).toBe(201);

    const res = await checkout(mia, acme, TH_REGION);
    expect(res.status).toBe(201);
    const order = orderOf(res.body);

    // 100_000 minor × 200 basis points ÷ 10_000 = 2_000 minor
    // total = 100_000 − 0 + 2_000 = 102_000 minor
    expect(order.taxMinor).toBe(2_000);
    expect(order.totalMinor).toBe(102_000);
    expect(order.taxRateBasisPoints).toBe(TH_REGION_RATE_BP);
    expect(order.taxLabel).toBe(TH_REGION_TAX_LABEL);
    // ONE rule was resolved, not two summed: 7_000 + 2_000 = 9_000 is the wrong
    // answer this assertion exists to catch
    expect(order.taxMinor).not.toBe(9_000);
  });

  it('does not touch an order that has already been charged when the rate changes', async () => {
    // §4: "an order carries what it was charged." Nothing is recomputed later.
    const admin = await login(`admin-a-${RUN}@test.local`);
    const raised = await putTaxRule(admin, acme, {
      country: ACME_COUNTRY,
      rateBasisPoints: TH_RATE_BP_AFTER,
      inclusive: false,
      label: `${TH_TAX_LABEL} (raised)`,
    });
    expect([200, 201]).toContain(raised.status);

    const res = await api(`/api/v1/orders/${taxedOrderId}`, { token: admin, tenant: acme });
    expect(res.status).toBe(200);
    const order = orderOf(res.body);

    // still the 7% it was charged, not the 10% the rule now says
    expect(order.taxMinor).toBe(7_000);
    expect(order.taxRateBasisPoints).toBe(TH_RATE_BP);
    expect(order.taxLabel).toBe(TH_TAX_LABEL);
    expect(order.totalMinor).toBe(107_000);
  });

  it('upserts by country and region rather than piling up rules', async () => {
    // §6: "Upsert by (country, region)."
    const admin = await login(`admin-a-${RUN}@test.local`);
    const res = await api('/api/v1/tax/rules', { token: admin, tenant: acme });
    expect(res.status).toBe(200);
    const rules = taxRulesOf(res.body);
    expect(rules).toHaveLength(2);

    const country = rules.find((r: { region: string | null }) => !r.region);
    const region = rules.find((r: { region: string | null }) => r.region === TH_REGION);
    expect(country.rateBasisPoints).toBe(TH_RATE_BP_AFTER);
    expect(region.rateBasisPoints).toBe(TH_REGION_RATE_BP);
  });

  it('says plainly that it is one configured rate and not a tax engine', async () => {
    // §4: the response and the admin screen both say so. A reader who takes
    // this for a tax engine will file wrongly and blame the platform.
    const admin = await login(`admin-a-${RUN}@test.local`);
    const res = await api('/api/v1/tax/rules', { token: admin, tenant: acme });
    expect(res.status).toBe(200);

    const serialised = JSON.stringify(res.body);
    expect(serialised).toMatch(/single[- ]?(configured[- ]?)?rate/i);
    expect(serialised).toMatch(/not a tax engine/i);
    // The disclaimer is deliberately NOT asserted to be free of the words
    // "nexus" or "exemption": naming what this is not is exactly how §4 says to
    // say it, and a test that forbade those words would punish the honest
    // implementation.
  });

  it('keeps tax rules to whoever manages the catalogue', async () => {
    const mia = await login(`mia-${RUN}@test.local`);
    const read = await api('/api/v1/tax/rules', { token: mia, tenant: acme });
    expect(read.status).toBe(403);
    expect(read.body.error.code).toBe('FORBIDDEN');

    const write = await putTaxRule(mia, acme, {
      country: ACME_COUNTRY,
      rateBasisPoints: 0,
      inclusive: false,
      label: 'No tax, please',
    });
    expect(write.status).toBe(403);
  });
});

describe('Product availability by country (docs/29 §5)', () => {
  let foreignOnlyId: string;
  let everywhereId: string;
  let withdrawnId: string;

  it('publishes offerings limited to another country, limited to this one, and to none', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);

    const foreign = await createOffering(admin, acme, {
      code: 'harbour-tour',
      name: 'Harbour tour',
      kind: 'one_time',
      currency: ACME_CURRENCY,
      priceMinor: 50_000,
      availableCountries: [FOREIGN_COUNTRY],
    });
    expect(foreign.status).toBe(201);
    foreignOnlyId = foreign.body.offering.id;
    expect(foreign.body.offering.availableCountries).toEqual([FOREIGN_COUNTRY]);

    const everywhere = await createOffering(admin, acme, {
      code: 'pocket-guide',
      name: 'Pocket guide',
      kind: 'one_time',
      currency: ACME_CURRENCY,
      priceMinor: 30_000,
      availableCountries: [],
    });
    expect(everywhere.status).toBe(201);
    everywhereId = everywhere.body.offering.id;

    const withdrawn = await createOffering(admin, acme, {
      code: 'river-walk',
      name: 'River walk',
      kind: 'one_time',
      currency: ACME_CURRENCY,
      priceMinor: 20_000,
      availableCountries: [ACME_COUNTRY],
    });
    expect(withdrawn.status).toBe(201);
    withdrawnId = withdrawn.body.offering.id;
  });

  it('treats an empty list as available everywhere', async () => {
    const mia = await login(`mia-${RUN}@test.local`);
    const catalogue = await api('/api/v1/offerings', { token: mia, tenant: acme });
    expect(catalogue.status).toBe(200);
    expect(offeringsOf(catalogue.body).map((o: { id: string }) => o.id)).toContain(everywhereId);

    await emptyCart(mia, acme);
    expect((await addToCart(mia, acme, everywhereId)).status).toBe(201);
    const res = await checkout(mia, acme);
    expect(res.status).toBe(201);
    expect(orderOf(res.body).subtotalMinor).toBe(30_000);
  });

  it('keeps the unbuyable out of the catalogue', async () => {
    // CHOICE: §5 says "a catalogue that shows something unbuyable is a
    // catalogue that wastes people's time", so this suite asserts the offering
    // is ABSENT for a member of a tenant it is not available in. The refusal at
    // checkout is the second guard, tested below — an item can already be in a
    // cart when availability changes underneath it.
    const mia = await login(`mia-${RUN}@test.local`);
    const catalogue = await api('/api/v1/offerings', { token: mia, tenant: acme });
    expect(catalogue.status).toBe(200);
    const ids = offeringsOf(catalogue.body).map((o: { id: string }) => o.id);
    expect(ids).not.toContain(foreignOnlyId);
    expect(ids).toContain(everywhereId);
    expect(ids).toContain(withdrawnId);
  });

  it('refuses it at checkout, with a reason that names the offering and the country', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const mia = await login(`mia-${RUN}@test.local`);

    // in the cart while it was still available here …
    await emptyCart(mia, acme);
    expect((await addToCart(mia, acme, withdrawnId)).status).toBe(201);
    const ordersBefore = (await api('/api/v1/orders', { token: mia, tenant: acme })).body.orders
      .length;

    // … and withdrawn from this country before they got to the till
    const patched = await api(`/api/v1/offerings/${withdrawnId}`, {
      method: 'PATCH',
      token: admin,
      tenant: acme,
      body: JSON.stringify({ availableCountries: [FOREIGN_COUNTRY] }),
    });
    expect(patched.status).toBe(200);

    const res = await checkout(mia, acme);
    expect([400, 409, 422], preview(res.body)).toContain(res.status);
    expect(['VALIDATION_FAILED', 'CONFLICT']).toContain(res.body.error.code);

    const message =
      String(res.body.error.message ?? '') + JSON.stringify(res.body.error.details ?? '');
    expect(message).toMatch(/available|country/i);
    // it names WHICH offering — "something in your cart is unavailable" is not
    // a reason a member can act on
    expect(message.includes('River walk') || message.includes('river-walk')).toBe(true);
    // and WHICH country is in question
    expect(message.includes(ACME_COUNTRY) || message.includes(FOREIGN_COUNTRY)).toBe(true);

    // the refusal did not half-buy it
    const ordersAfter = (await api('/api/v1/orders', { token: mia, tenant: acme })).body.orders
      .length;
    expect(ordersAfter).toBe(ordersBefore);
    await emptyCart(mia, acme);
  });

  it('does not let the availability list be used as a way past permission either', async () => {
    // Availability is a commerce rule, not an access rule: a member still may
    // not edit it.
    const mia = await login(`mia-${RUN}@test.local`);
    const res = await api(`/api/v1/offerings/${foreignOnlyId}`, {
      method: 'PATCH',
      token: mia,
      tenant: acme,
      body: JSON.stringify({ availableCountries: [] }),
    });
    expect(res.status).toBe(403);
  });
});

describe('Isolation — another tenant’s configuration is invisible', () => {
  it('gives Borealis its own branding, legal documents and tax rules', async () => {
    const adminB = await login(`admin-b-${RUN}@test.local`);

    const loc = await putLocalisation(adminB, borealis, {
      country: FOREIGN_COUNTRY,
      currency: 'SGD',
      timezone: 'Asia/Singapore',
      defaultLocale: 'en',
      supportedLocales: ['en'],
    });
    expect(loc.status).toBe(200);

    const doc = await publishLegal(adminB, borealis, {
      kind: 'terms',
      locale: 'en',
      country: FOREIGN_COUNTRY,
      title: BOREALIS_TERMS_TITLE,
      body: BOREALIS_TERMS_BODY,
    });
    expect(doc.status).toBe(201);

    const rule = await putTaxRule(adminB, borealis, {
      country: FOREIGN_COUNTRY,
      rateBasisPoints: 900,
      inclusive: false,
      label: BOREALIS_TAX_LABEL,
    });
    expect([200, 201]).toContain(rule.status);
  });

  it('keeps Borealis’s branding out of every Acme response', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const mine = await getBranding(admin, acme);
    expect(mine.status).toBe(200);
    expect(brandingOf(mine.body).appName).toBe(ACME_APP_NAME);
    expect(mentions(mine.body, BOREALIS_APP_NAME)).toBe(false);
    expect(mentions(mine.body, BOREALIS_HEADLINE)).toBe(false);
    expect(mentions(mine.body, borealis)).toBe(false);
  });

  it('keeps Borealis’s legal documents out of Acme’s list and off Acme’s host', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const all = await api('/api/v1/legal/documents', { token: admin, tenant: acme });
    expect(all.status).toBe(200);
    expect(mentions(all.body, BOREALIS_TERMS_TITLE)).toBe(false);
    expect(mentions(all.body, BOREALIS_TERMS_BODY)).toBe(false);

    // Acme's host serves Acme's terms even for a country Borealis published in
    const painted = await apiAtHost(
      ACME_HOST,
      `/api/v1/legal/terms?locale=en&country=${FOREIGN_COUNTRY}`,
    );
    expect(mentions(painted.body, BOREALIS_TERMS_BODY)).toBe(false);
    expect(mentions(painted.body, BOREALIS_TERMS_TITLE)).toBe(false);
    // Acme published terms for TH, not for SG, so either Acme's own document
    // comes back or nothing does — never the neighbour's.
    if (painted.status === 200) {
      expect([termsV1Id, termsV2Id]).toContain(documentOf(painted.body).id);
    } else {
      expect(painted.status).toBe(404);
    }
  });

  it('keeps Borealis’s tax rules out of Acme’s rules, and out of Acme’s prices', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const res = await api('/api/v1/tax/rules', { token: admin, tenant: acme });
    expect(res.status).toBe(200);
    expect(mentions(res.body, BOREALIS_TAX_LABEL)).toBe(false);
    expect(taxRulesOf(res.body).every((r: { country: string }) => r.country === ACME_COUNTRY)).toBe(
      true,
    );

    // and the order Acme charged still carries Acme's label
    const order = await api(`/api/v1/orders/${taxedOrderId}`, { token: admin, tenant: acme });
    expect(orderOf(order.body).taxLabel).toBe(TH_TAX_LABEL);
  });

  it('refuses Borealis’s administrator at Acme’s tenant boundary', async () => {
    const adminB = await login(`admin-b-${RUN}@test.local`);
    // `/tenant/branding` is deliberately absent: it is PUBLIC by design — a
    // browser has to paint the tenant before anybody has logged in — so what
    // it returns is already visible to the world by host. The boundary that
    // matters is the configuration nobody outside the tenant should read.
    for (const path of [
      '/api/v1/tenant/localisation',
      '/api/v1/legal/documents',
      '/api/v1/tax/rules',
    ]) {
      const res = await api(path, { token: adminB, tenant: acme });
      expect([403, 404], `${path} → ${res.status}`).toContain(res.status);
      expect(res.status).not.toBe(200);
    }
  });

  it('does not let Borealis’s host paint Acme, or the reverse', async () => {
    const forBorealis = await apiAtHost(BOREALIS_HOST, '/api/v1/tenant/branding');
    expect(forBorealis.status).toBe(200);
    expect(brandingOf(forBorealis.body).appName).toBe(BOREALIS_APP_NAME);
    expect(mentions(forBorealis.body, ACME_APP_NAME)).toBe(false);
    expect(mentions(forBorealis.body, ACME_HEADLINE)).toBe(false);

    // Borealis's own terms are on Borealis's host, and only there
    const terms = await apiAtHost(
      BOREALIS_HOST,
      `/api/v1/legal/terms?locale=en&country=${FOREIGN_COUNTRY}`,
    );
    expect(terms.status).toBe(200);
    expect(documentOf(terms.body).body).toBe(BOREALIS_TERMS_BODY);
    expect(mentions(terms.body, TERMS_V1_BODY)).toBe(false);
    expect(mentions(terms.body, TERMS_V2_BODY)).toBe(false);
  });
});
