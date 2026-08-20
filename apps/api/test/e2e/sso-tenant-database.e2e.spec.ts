/**
 * Enterprise SSO and the dedicated-database seam (docs/31, runbook docs/32).
 *
 * What this file proves, and what it deliberately does not:
 *
 * The OIDC token checks — signature, `alg`, issuer, audience, expiry, nonce,
 * allowed domain, PKCE — are proved in `src/modules/sso/oidc.spec.ts` against
 * real keys and real forged tokens, with no server involved. Repeating them
 * here would need an https identity provider standing on localhost with a
 * certificate this process trusts, which buys a slower version of the same
 * assertions. So this file takes the other half: the things only a running API
 * can be wrong about.
 *
 * 1. **The client secret is write-only.** It goes in through `PUT /tenant/sso`,
 *    it is unreadable in the database, and it comes back out of nothing.
 * 2. **A failure says which step failed.** An administrator who sees
 *    `step: "configuration"` looks at their setup; one who sees `step: "state"`
 *    looks at their session. "Unauthorized" sends them to a support ticket.
 * 3. **Turning federation off leaves local sign-in alone** (docs/31 §4).
 * 4. **`migrating` means read-only, at the edge.** A mutating verb is refused
 *    with a reason; a read is untouched; and authentication — which writes only
 *    platform-global rows — keeps working, because locking people out of a
 *    product they can still read would achieve nothing for the migration.
 * 5. **A tenant cannot move itself.** Not through a route, and not through the
 *    database: the app role has no INSERT, UPDATE or DELETE on
 *    `tenant_databases` at all, which is asserted here against the live grants
 *    rather than trusted to a migration file nobody re-reads.
 * 6. **The shared path is unchanged.** Every assertion in every other suite is
 *    made with the resolver installed and every tenant `shared`.
 *
 * NOTE: stop any locally running API — the outbox relay is cross-tenant.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import * as argon2 from 'argon2';
import { createAppClient, createOwnerClient, ensureAppRole, type PrismaClient } from '@aviora/db';
import { ENTITLEMENTS, PERMISSIONS } from '@aviora/shared';
import { createApp } from '../../src/app.factory';
import { TenantDatabaseResolver } from '../../src/common/db/tenant-database.resolver';

const RUN = `s${Date.now().toString(36)}`;
const PLATFORM_EMAIL = `e2e-platform-${RUN}@test.local`;
const PW = 'e2e-password-123456';

let app: INestApplication;
let base: string;
let owner: PrismaClient;

/** Acme configures SSO. Borealis exists to not be able to see that it did. */
let acme: string;
let borealis: string;
const ACME_SLUG = `e2e-sso-a-${RUN}`;
const BOREALIS_SLUG = `e2e-sso-b-${RUN}`;
const ACME_ADMIN = `admin-a-${RUN}@test.local`;
const BOREALIS_ADMIN = `admin-b-${RUN}@test.local`;
const ACME_MEMBER = `member-a-${RUN}@test.local`;

let acmeAdmin: string;
let borealisAdmin: string;
let acmeMember: string;
let platformToken: string;
let acmePlanId: string;

/**
 * The one string in this file that must never be readable anywhere. It is
 * distinctive so a substring search over a whole response body is meaningful.
 */
const CLIENT_SECRET = `super-secret-oidc-value-${RUN}`;
const SECOND_SECRET = `rotated-oidc-value-${RUN}`;
const ISSUER = 'https://idp.example.com';
const DISCOVERY = 'https://idp.example.com/.well-known/openid-configuration';
const CLIENT_ID = `aviora-${RUN}`;

async function api(
  path: string,
  init: RequestInit & { token?: string; tenant?: string } = {},
): Promise<{ status: number; text: string; body: any }> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    redirect: 'manual',
    headers: {
      'content-type': 'application/json',
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...(init.tenant ? { 'x-tenant-id': init.tenant } : {}),
    },
  });
  const text = await res.text();
  // A redirect body is empty and a redirect is a legitimate answer here, so a
  // non-JSON body is not a failure — the caller reads `text` in that case.
  let body: any;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: res.status, text, body };
}

async function login(email: string): Promise<string> {
  const res = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PW }),
  });
  expect(res.status, `login for ${email}`).toBe(200);
  const access = res.headers.getSetCookie().find((c) => c.startsWith('aviora_access='));
  return decodeURIComponent(access!.split(';')[0]!.split('=')[1]!);
}

/** The resolver re-reads on a TTL; tests force it so they do not sleep. */
async function reroute(): Promise<void> {
  await app.get(TenantDatabaseResolver).refresh();
}

async function setPlacement(tenantId: string, status: string): Promise<void> {
  await owner.tenantDatabase.upsert({
    where: { tenantId },
    create: { tenantId, status, notes: `e2e ${RUN}` },
    update: { status },
  });
  await reroute();
}

function stepOf(body: any): unknown {
  return body?.error?.details?.step;
}

beforeAll(async () => {
  process.env.AVIORA_OUTBOX_DISABLED = 'true';
  process.env.AVIORA_PII_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
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

  platformToken = await login(PLATFORM_EMAIL);
  const mkTenant = async (suffix: string, slug: string, adminEmail: string): Promise<string> => {
    const res = await api('/api/v1/platform/tenants', {
      method: 'POST',
      token: platformToken,
      body: JSON.stringify({
        code: `e2e_sso_${suffix}_${RUN}`,
        name: `SSO ${suffix}`,
        slug,
        adminEmail,
        adminDisplayName: 'Admin',
        adminPassword: PW,
      }),
    });
    expect(res.status).toBe(201);
    return res.body.tenant.id as string;
  };
  acme = await mkTenant('a', ACME_SLUG, ACME_ADMIN);
  borealis = await mkTenant('b', BOREALIS_SLUG, BOREALIS_ADMIN);

  acmeAdmin = await login(ACME_ADMIN);
  borealisAdmin = await login(BOREALIS_ADMIN);

  const plan = await api('/api/v1/membership-plans', {
    method: 'POST',
    token: acmeAdmin,
    tenant: acme,
    body: JSON.stringify({ code: `sso-plan-${RUN}`, name: 'SSO Plan', entitlementKeys: [] }),
  });
  expect(plan.status).toBe(201);
  acmePlanId = plan.body.plan.id;

  const inv = await api('/api/v1/invitations', {
    method: 'POST',
    token: acmeAdmin,
    tenant: acme,
    body: JSON.stringify({ email: ACME_MEMBER, planId: acmePlanId }),
  });
  expect(inv.status).toBe(201);
  const evt = await owner.domainEvent.findFirst({
    where: { eventName: 'MemberInvited', tenantId: acme, aggregateId: inv.body.invitation.id },
  });
  const accepted = await api(
    `/api/v1/invitations/${(evt!.payload as { token: string }).token}/accept`,
    { method: 'POST', body: JSON.stringify({ displayName: 'Acme Member', password: PW }) },
  );
  expect(accepted.status).toBe(201);
  acmeMember = await login(ACME_MEMBER);
}, 240_000);

afterAll(async () => {
  // Leave no routing rows behind: another suite reading a stale `migrating`
  // would fail for a reason that has nothing to do with what it tests.
  await owner?.tenantDatabase
    .deleteMany({ where: { tenantId: { in: [acme, borealis].filter(Boolean) } } })
    .catch(() => undefined);
  await app?.close();
  await owner?.$disconnect();
});

/* ── 1. the client secret is write-only ───────────────────────────────────── */

describe('provider configuration', () => {
  it('starts with no provider, and says so plainly', async () => {
    const res = await api('/api/v1/tenant/sso', { token: acmeAdmin, tenant: acme });
    expect(res.status).toBe(200);
    expect(res.body.provider).toBeNull();
  });

  it('refuses a discovery URL that is not https', async () => {
    const res = await api('/api/v1/tenant/sso', {
      method: 'PUT',
      token: acmeAdmin,
      tenant: acme,
      body: JSON.stringify({
        issuer: ISSUER,
        discoveryUrl: 'http://idp.example.com/.well-known/openid-configuration',
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        allowedDomains: ['example.com'],
      }),
    });
    expect(res.status).toBe(400);
  });

  it('refuses a wildcard domain — the list is people you can recognise', async () => {
    const res = await api('/api/v1/tenant/sso', {
      method: 'PUT',
      token: acmeAdmin,
      tenant: acme,
      body: JSON.stringify({
        issuer: ISSUER,
        discoveryUrl: DISCOVERY,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        allowedDomains: ['*.example.com'],
      }),
    });
    expect(res.status).toBe(400);
  });

  it('refuses an empty allowed-domains list rather than reading it as "anyone"', async () => {
    const res = await api('/api/v1/tenant/sso', {
      method: 'PUT',
      token: acmeAdmin,
      tenant: acme,
      body: JSON.stringify({
        issuer: ISSUER,
        discoveryUrl: DISCOVERY,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        allowedDomains: [],
      }),
    });
    expect(res.status).toBe(400);
  });

  it('stores a provider and never hands the secret back', async () => {
    const put = await api('/api/v1/tenant/sso', {
      method: 'PUT',
      token: acmeAdmin,
      tenant: acme,
      body: JSON.stringify({
        issuer: ISSUER,
        discoveryUrl: DISCOVERY,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        allowedDomains: ['example.com'],
        jitProvisioning: true,
      }),
    });
    expect(put.status).toBe(200);
    expect(put.body.provider.clientId).toBe(CLIENT_ID);
    expect(put.body.provider.hasClientSecret).toBe(true);
    // The whole response body, not just the fields we thought to name.
    expect(put.text).not.toContain(CLIENT_SECRET);

    const get = await api('/api/v1/tenant/sso', { token: acmeAdmin, tenant: acme });
    expect(get.status).toBe(200);
    expect(get.body.provider.issuer).toBe(ISSUER);
    expect(get.body.provider.jitProvisioning).toBe(true);
    expect(get.text).not.toContain(CLIENT_SECRET);
    expect(get.text).not.toContain('clientSecretEncrypted');
  });

  it('does not store the secret in a form the database can give up', async () => {
    const row = await owner.tenantIdentityProvider.findUniqueOrThrow({
      where: { tenantId: acme },
    });
    expect(row.clientSecretEncrypted).not.toContain(CLIENT_SECRET);
    // Sealed, not hashed: the token exchange needs the value back, and
    // `enc.v1` is the platform's own envelope (docs/31 — reported deviation).
    expect(row.clientSecretEncrypted.startsWith('enc.v1.')).toBe(true);
  });

  it('keeps the stored secret when an update omits it, and replaces it when given', async () => {
    const before = await owner.tenantIdentityProvider.findUniqueOrThrow({
      where: { tenantId: acme },
    });
    const omitted = await api('/api/v1/tenant/sso', {
      method: 'PUT',
      token: acmeAdmin,
      tenant: acme,
      body: JSON.stringify({
        issuer: ISSUER,
        discoveryUrl: DISCOVERY,
        clientId: CLIENT_ID,
        allowedDomains: ['example.com', 'acme.example'],
        jitProvisioning: true,
      }),
    });
    expect(omitted.status).toBe(200);
    const unchanged = await owner.tenantIdentityProvider.findUniqueOrThrow({
      where: { tenantId: acme },
    });
    expect(unchanged.clientSecretEncrypted).toBe(before.clientSecretEncrypted);
    expect(unchanged.allowedDomains).toContain('acme.example');

    const rotated = await api('/api/v1/tenant/sso', {
      method: 'PUT',
      token: acmeAdmin,
      tenant: acme,
      body: JSON.stringify({
        issuer: ISSUER,
        discoveryUrl: DISCOVERY,
        clientId: CLIENT_ID,
        clientSecret: SECOND_SECRET,
        allowedDomains: ['example.com'],
        jitProvisioning: true,
      }),
    });
    expect(rotated.status).toBe(200);
    expect(rotated.text).not.toContain(SECOND_SECRET);
    const after = await owner.tenantIdentityProvider.findUniqueOrThrow({
      where: { tenantId: acme },
    });
    expect(after.clientSecretEncrypted).not.toBe(before.clientSecretEncrypted);
  });

  it('is invisible to another tenant', async () => {
    const res = await api('/api/v1/tenant/sso', { token: borealisAdmin, tenant: borealis });
    expect(res.status).toBe(200);
    expect(res.body.provider).toBeNull();
    expect(res.text).not.toContain(CLIENT_ID);
  });

  it('is not something an ordinary member may read or change', async () => {
    const read = await api('/api/v1/tenant/sso', { token: acmeMember, tenant: acme });
    expect(read.status).toBe(403);
    const write = await api('/api/v1/tenant/sso', {
      method: 'PUT',
      token: acmeMember,
      tenant: acme,
      body: JSON.stringify({
        issuer: ISSUER,
        discoveryUrl: DISCOVERY,
        clientId: 'hijack',
        clientSecret: 'hijack',
        allowedDomains: ['example.com'],
      }),
    });
    expect(write.status).toBe(403);
  });
});

/* ── 2. a failure names the step ──────────────────────────────────────────── */

describe('login failures name the step that failed', () => {
  it('a workspace with no provider fails at configuration, not at authentication', async () => {
    const res = await api(`/api/v1/auth/sso/${BOREALIS_SLUG}/start`);
    expect(res.status).toBe(400);
    expect(stepOf(res.body)).toBe('configuration');
  });

  it('an unknown workspace fails at configuration too, without confirming one exists', async () => {
    const res = await api(`/api/v1/auth/sso/no-such-workspace-${RUN}/start`);
    expect(res.status).toBe(400);
    expect(stepOf(res.body)).toBe('configuration');
  });

  it('a callback carrying a state this server never issued fails at the state step', async () => {
    const res = await api('/api/v1/auth/sso/callback?state=not-a-real-state&code=whatever');
    expect(res.status).toBe(401);
    expect(stepOf(res.body)).toBe('state');
  });

  it('a callback with no code fails at the exchange, carrying the provider reason', async () => {
    const res = await api('/api/v1/auth/sso/callback?state=x&error=access_denied');
    expect(stepOf(res.body)).toBe('token_exchange');
    expect(res.text).toContain('access_denied');
  });

  it('never echoes a code or a token back to the caller', async () => {
    const secretish = `code-${RUN}-should-not-be-echoed`;
    const res = await api(`/api/v1/auth/sso/callback?state=nope&code=${secretish}`);
    expect(res.text).not.toContain(secretish);
  });
});

/* ── 3. federation off ≠ locked out ───────────────────────────────────────── */

describe('turning federation off', () => {
  it('removes the provider and leaves local sign-in working', async () => {
    const del = await api('/api/v1/tenant/sso', {
      method: 'DELETE',
      token: acmeAdmin,
      tenant: acme,
    });
    expect(del.status).toBe(204);

    const get = await api('/api/v1/tenant/sso', { token: acmeAdmin, tenant: acme });
    expect(get.body.provider).toBeNull();

    // The thing that must not have broken.
    const token = await login(ACME_MEMBER);
    const me = await api('/api/v1/auth/me', { token });
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(ACME_MEMBER);

    const again = await api('/api/v1/tenant/sso', {
      method: 'DELETE',
      token: acmeAdmin,
      tenant: acme,
    });
    expect(again.status).toBe(404);
  });
});

/* ── 4 & 5. the dedicated-database seam ───────────────────────────────────── */

describe('the tenant-database map', () => {
  it('is platform work: a tenant owner cannot read it', async () => {
    const res = await api('/api/v1/platform/tenant-databases', {
      token: acmeAdmin,
      tenant: acme,
    });
    expect(res.status).toBe(403);
  });

  it('shows every tenant as shared until one is moved', async () => {
    const res = await api('/api/v1/platform/tenant-databases', { token: platformToken });
    expect(res.status).toBe(200);
    const mine = res.body.tenantDatabases.find((p: any) => p.tenantId === acme);
    expect(mine.status).toBe('shared');
    expect(mine.tenantSlug).toBe(ACME_SLUG);
    // A reference is not a DSN, and no DSN appears anywhere in the response.
    expect(res.text).not.toContain('postgres://');
    expect(res.text).not.toContain('postgresql://');
  });

  it('plans a move as a dry run: counts per table, in dependency order, and caveats', async () => {
    const res = await api(`/api/v1/platform/tenant-databases/${acme}/plan`, {
      method: 'POST',
      token: platformToken,
    });
    expect(res.status).toBe(200);
    const plan = res.body.plan;
    expect(plan.tenantId).toBe(acme);
    expect(plan.totalRows).toBeGreaterThan(0);
    expect(plan.caveats.length).toBeGreaterThan(0);

    const tables = plan.tables.map((t: any) => t.table);
    // The tenant row before the rows that reference it.
    expect(tables.indexOf('tenants')).toBeLessThan(tables.indexOf('members'));
    expect(tables.indexOf('roles')).toBeLessThan(tables.indexOf('member_roles'));
    expect(tables).not.toContain('tenant_databases');
    expect(tables).not.toContain('users');

    const members = plan.tables.find((t: any) => t.table === 'members');
    expect(members.rows).toBeGreaterThan(0);
  });

  it('changed nothing: planning is a read', async () => {
    const after = await owner.tenantDatabase.findUnique({ where: { tenantId: acme } });
    expect(after).toBeNull();
  });

  it('cannot be written by the role the API runs as', async () => {
    const appClient = createAppClient();
    try {
      await expect(
        appClient.$executeRawUnsafe(
          `INSERT INTO tenant_databases (id, tenant_id, status, created_at, updated_at)
           VALUES (gen_random_uuid(), $1::uuid, 'dedicated', now(), now())`,
          acme,
        ),
      ).rejects.toThrow();
      await expect(
        appClient.$executeRawUnsafe(`UPDATE tenant_databases SET status = 'dedicated'`),
      ).rejects.toThrow();
      await expect(appClient.$executeRawUnsafe(`DELETE FROM tenant_databases`)).rejects.toThrow();
      // Reading, however, is exactly what the resolver does.
      await expect(
        appClient.$queryRawUnsafe(`SELECT count(*) FROM tenant_databases`),
      ).resolves.toBeDefined();
    } finally {
      await appClient.$disconnect();
    }
  });
});

describe('a migrating tenant is read-only at the API edge', () => {
  it('refuses a write with a reason, keeps reads, and keeps sign-in working', async () => {
    // Baseline: the write works before anything is migrating.
    const before = await api('/api/v1/goals', {
      method: 'POST',
      token: acmeMember,
      tenant: acme,
      body: JSON.stringify({ title: `Goal before ${RUN}`, category: 'health' }),
    });
    expect(before.status).toBe(201);

    await setPlacement(acme, 'migrating');

    const blocked = await api('/api/v1/goals', {
      method: 'POST',
      token: acmeMember,
      tenant: acme,
      body: JSON.stringify({ title: `Goal during ${RUN}`, category: 'health' }),
    });
    expect(blocked.status).toBe(503);
    expect(blocked.body.error.code).toBe('TENANT_READ_ONLY');
    expect(blocked.body.error.details.tenantDatabaseStatus).toBe('migrating');
    // The refusal explains itself rather than looking like an outage.
    expect(blocked.body.error.message.toLowerCase()).toContain('read-only');

    // Reading is untouched — that is the whole point of read-ONLY.
    const read = await api('/api/v1/goals', { token: acmeMember, tenant: acme });
    expect(read.status).toBe(200);
    expect(read.text).toContain(`Goal before ${RUN}`);

    // Authentication writes only platform-global rows, so it keeps working.
    const token = await login(ACME_MEMBER);
    expect(token.length).toBeGreaterThan(10);

    // And the row the write would have created does not exist.
    expect(read.text).not.toContain(`Goal during ${RUN}`);
  });

  it("leaves every other tenant writable — one tenant's window, not an outage", async () => {
    const res = await api('/api/v1/membership-plans', {
      method: 'POST',
      token: borealisAdmin,
      tenant: borealis,
      body: JSON.stringify({
        code: `while-a-migrates-${RUN}`,
        name: 'Unaffected',
        entitlementKeys: [],
      }),
    });
    expect(res.status).toBe(201);
  });

  it('is still visible as migrating on the platform map', async () => {
    const res = await api('/api/v1/platform/tenant-databases', { token: platformToken });
    const mine = res.body.tenantDatabases.find((p: any) => p.tenantId === acme);
    expect(mine.status).toBe('migrating');
  });

  it('goes back to writable when the placement returns to shared', async () => {
    await setPlacement(acme, 'shared');
    const res = await api('/api/v1/goals', {
      method: 'POST',
      token: acmeMember,
      tenant: acme,
      body: JSON.stringify({ title: `Goal after ${RUN}`, category: 'health' }),
    });
    expect(res.status).toBe(201);
  });
});
