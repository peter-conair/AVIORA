/**
 * Enterprise SSO and the dedicated-database seam (spec §77, docs/31).
 *
 * docs/31 §1 puts the whole feature in one sentence, and it is the sentence
 * this file is built around:
 *
 *     A federated login authenticates. It never authorises.
 *
 * Everything below follows from that. An identity provider is somebody else's
 * server making claims about a person; the tenant's own roles decide what that
 * person may do. So the load-bearing tests here are not the happy path — they
 * are the five refusals in "Verification actually verifies", the single-use
 * callback, and the one where a token arrives carrying `roles: ["admin"]` and
 * `groups: ["owners"]` and the member ends up holding exactly what a member
 * held before: `MEMBER`, and nothing else.
 *
 * A verification test that mints its tokens through the platform's own signer
 * proves only that the platform agrees with itself. So this suite stands up a
 * REAL OpenID provider inside the test process — a `node:https` server with a
 * discovery document, a JWKS endpoint and a token endpoint, signing RS256 with
 * an RSA key generated at setup by `node:crypto`. That makes every refusal
 * honest: the "wrong key" token really is signed by a key the JWKS does not
 * publish, the expired one really has `exp` in the past, and the audience one
 * really carries the OTHER tenant's `client_id`. The suite then asserts on the
 * traffic that provider recorded — that the authorize URL came out of the
 * discovery document, that the code_verifier presented at the token endpoint
 * really does hash to the challenge that was in the redirect, and, for the
 * replay, that the platform did not go back to the token endpoint a second
 * time with a code it had already redeemed.
 *
 * The fake provider is deliberately PERMISSIVE — it will mint a token for any
 * code, twice, with no client authentication at all. A strict provider would
 * do the platform's job for it and every single-use assertion below would pass
 * for the wrong reason.
 *
 * FINDING, recorded rather than worked around (see "Configuration"): the
 * contract stores `client_secret_encrypted`. A hash cannot be presented to a token
 * endpoint, so either the column holds a reversible secret under a misleading
 * name, or the client is public and PKCE is the only proof of possession. The
 * token-exchange test therefore REQUIRES the PKCE verifier to match the
 * challenge, and only checks the client secret IF one is presented — and then
 * insists it is the right one. Whichever way the implementation went, the
 * assertion holds and the ambiguity is written down.
 *
 * The discovery document is served over TLS with a certificate generated at
 * setup and signed by nobody, so this process sets
 * `NODE_TLS_REJECT_UNAUTHORIZED=0` for itself. If the platform pins
 * `rejectUnauthorized: true` of its own accord the configuration test fails
 * with the TLS error the platform reported, which is a readable diagnosis.
 *
 * The owner client does exactly two things that are not reads: it writes the
 * `tenant_databases` row that marks a tenant `migrating` — platform state, and
 * docs/31 §3 is explicit that a tenant cannot move itself, so no app-role
 * route may set it — and it puts that row back afterwards. Everything else it
 * touches, it only looks at.
 *
 * NOTE: stop any locally running API — the outbox relay is cross-tenant.
 */
import { execFileSync } from 'node:child_process';
import {
  createHash,
  createSign,
  generateKeyPairSync,
  randomUUID,
  type KeyObject,
} from 'node:crypto';
import * as https from 'node:https';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/** The provider's certificate is generated for 127.0.0.1 and signed by nobody. */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const RUN = `s${Date.now().toString(36)}`;
const PLATFORM_EMAIL = `e2e-platform-${RUN}@test.local`;
const PW = 'e2e-password-123456';

let app: INestApplication;
let base: string;
let owner: PrismaClient;

/** Atlas federates. Haven exists to be invisible from Atlas, and vice versa. */
let atlas: string;
let haven: string;
const ATLAS_SLUG = `e2e-sso-a-${RUN}`;
const HAVEN_SLUG = `e2e-sso-b-${RUN}`;
const ATLAS_ADMIN = `admin-a-${RUN}@test.local`;
const HAVEN_ADMIN = `admin-b-${RUN}@test.local`;

let atlasPlanId: string;
let miraMemberId: string;

/* ── who the identity provider may speak for ──────────────────────────────── */

/**
 * `allowed_domains` is the whole of docs/31 §1's "a provider that can assert
 * any address can assert the tenant owner's". Atlas's provider is bounded to
 * one domain; every refusal below is measured against it.
 */
const ATLAS_DOMAIN = `atlas-${RUN}.example`;
const HAVEN_DOMAIN = `haven-${RUN}.example`;
const FOREIGN_DOMAIN = `elsewhere-${RUN}.example`;

/** An invited member. SSO must RESOLVE her, not create a second of her. */
const MIRA_EMAIL = `mira@${ATLAS_DOMAIN}`;
const MIRA_SUB = `idp|mira|${RUN}`;
/** Never invited, inside the allowed domain — the JIT fixture. */
const NEWCOMER_EMAIL = `newcomer@${ATLAS_DOMAIN}`;
const NEWCOMER_SUB = `idp|newcomer|${RUN}`;
/** A perfectly valid token for somebody the provider may not speak for. */
const INTRUDER_EMAIL = `intruder@${FOREIGN_DOMAIN}`;
const INTRUDER_SUB = `idp|intruder|${RUN}`;

const ATLAS_CLIENT_ID = `aviora-atlas-${RUN}`;
const ATLAS_CLIENT_SECRET = `atlas-client-secret-${RUN}-never-echo-me`;
const HAVEN_CLIENT_ID = `aviora-haven-${RUN}`;
const HAVEN_CLIENT_SECRET = `haven-client-secret-${RUN}-never-echo-me`;

/** The role every tenant provisions and the only one a federated login may reach. */
const DEFAULT_ROLE = 'MEMBER';

/* ── the identity provider ────────────────────────────────────────────────── */

/**
 * Deliberately NOT the standard spellings. `/op/authorize` and `/op/token` can
 * only be reached by a platform that actually read the discovery document; a
 * platform that guessed `/authorize` would fail, which is the point.
 */
const DISCOVERY_PATH = '/.well-known/openid-configuration';
const AUTHORIZE_PATH = '/op/authorize';
const TOKEN_PATH = '/op/token';
const JWKS_PATH = '/op/keys';
const SIGNING_KID = `aviora-test-${RUN}`;

interface IdpRequest {
  path: string;
  method: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  /** The bytes exactly as they arrived. */
  raw: string;
  /** Form or JSON body, flattened — a token endpoint is posted to either way. */
  form: Record<string, string>;
  at: number;
}

const idpTraffic: IdpRequest[] = [];

interface TokenPlan {
  sub: string;
  email: string;
  nonce: string;
  /** Defaults to Atlas's client id. */
  aud?: string;
  /** Defaults to the provider's own issuer. */
  iss?: string;
  /** Seconds from now; negative mints a token that is already expired. */
  expiresIn?: number;
  /** `unpublished` signs with a key the JWKS does not carry, keeping the kid. */
  key?: 'published' | 'unpublished';
  /** Anything else the IdP feels like asserting — groups, roles, whatever. */
  extra?: Record<string, unknown>;
}

/** What the token endpoint will mint on the next exchange. */
let nextToken: TokenPlan | null = null;
/** The last id_token minted, so a refusal can be checked for echoing it. */
let lastIdToken = '';

let idp: https.Server | null = null;
let idpBase: string | null = null;
let certDir: string | null = null;
let signingKey: KeyObject;
let signingJwk: Record<string, unknown>;
/** Real RSA, real signature, and the JWKS never mentions it. */
let unpublishedKey: KeyObject;

/* ── plumbing ─────────────────────────────────────────────────────────────── */

interface Res {
  status: number;
  headers: Record<string, string>;
  setCookies: string[];
  location: string | null;
  body: any;
  text: string;
}

async function api(
  path: string,
  init: RequestInit & { token?: string; tenant?: string; cookie?: string } = {},
): Promise<Res> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    redirect: 'manual',
    headers: {
      'content-type': 'application/json',
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...(init.tenant ? { 'x-tenant-id': init.tenant } : {}),
      ...(init.cookie ? { cookie: init.cookie } : {}),
      ...((init.headers as Record<string, string>) ?? {}),
    },
  });
  const text = await res.text();
  return {
    status: res.status,
    headers: Object.fromEntries(res.headers.entries()),
    setCookies: res.headers.getSetCookie(),
    location: res.headers.get('location'),
    body: text ? safeJson(text) : null,
    text,
  };
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text };
  }
}

async function login(email: string): Promise<string> {
  const res = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PW }),
  });
  expect(res.status, `password login failed for ${email}`).toBe(200);
  const access = res.headers.getSetCookie().find((c) => c.startsWith('aviora_access='));
  return decodeURIComponent(access!.split(';')[0]!.split('=')[1]!);
}

/**
 * Scoped to one tenant. The library helper applies the tenant extension as
 * well as the GUC, which matters here: these tests connect as the OWNER role,
 * and the owner BYPASSES row-level security. Raw statements below carry their
 * own `tenant_id` predicate for the same reason.
 */
async function withTenant<T>(tenant: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return dbWithTenant(owner, tenant, fn);
}

function mentions(value: unknown, token: string): boolean {
  return JSON.stringify(value ?? null)
    .toLowerCase()
    .includes(token.toLowerCase());
}

/* ── rows the new tables hold ─────────────────────────────────────────────
 * Read through raw SQL against the table names docs/31 maps, so this file does
 * not depend on what the generated client happens to call the models while the
 * implementation is still landing. Every statement names its tenant.
 * ------------------------------------------------------------------------ */

interface ProviderRow {
  id: string;
  issuer: string;
  client_id: string;
  client_secret_encrypted: string;
  discovery_url: string;
  allowed_domains: string[];
  jit_provisioning: boolean;
  status: string;
}

async function providerRow(tenant: string): Promise<ProviderRow | null> {
  const rows = await withTenant(tenant, (tx) =>
    tx.$queryRawUnsafe<ProviderRow[]>(
      `SELECT id, issuer, client_id, client_secret_encrypted, discovery_url,
              allowed_domains, jit_provisioning, status
         FROM tenant_identity_providers WHERE tenant_id = $1::uuid`,
      tenant,
    ),
  );
  return rows[0] ?? null;
}

interface LoginRow {
  id: string;
  state: string;
  nonce: string;
  consumed_at: Date | null;
  expires_at: Date;
  claims: unknown;
}

async function loginRow(tenant: string, state: string): Promise<LoginRow | null> {
  const rows = await withTenant(tenant, (tx) =>
    tx.$queryRawUnsafe<LoginRow[]>(
      `SELECT id, state, nonce, consumed_at, expires_at, claims
         FROM sso_logins WHERE tenant_id = $1::uuid AND state = $2`,
      tenant,
      state,
    ),
  );
  return rows[0] ?? null;
}

/**
 * Platform state. docs/31 §3: "a tenant cannot move itself", so there is no
 * app-role route that could write this and the owner client is the only way to
 * put a tenant into the state §2 makes read-only.
 */
async function setDatabaseStatus(tenant: string, status: string): Promise<void> {
  await owner.$executeRawUnsafe(
    `INSERT INTO tenant_databases (id, tenant_id, status, created_at, updated_at)
     VALUES (gen_random_uuid(), $1::uuid, $2, now(), now())
     ON CONFLICT (tenant_id) DO UPDATE SET status = excluded.status, updated_at = now()`,
    tenant,
    status,
  );
}

/* ── the identity provider, for real ──────────────────────────────────────── */

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function signIdToken(plan: TokenPlan): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT', kid: SIGNING_KID };
  const payload = {
    iss: plan.iss ?? idpBase,
    aud: plan.aud ?? ATLAS_CLIENT_ID,
    sub: plan.sub,
    email: plan.email,
    email_verified: true,
    nonce: plan.nonce,
    iat: now - 5,
    exp: now + (plan.expiresIn ?? 300),
    ...(plan.extra ?? {}),
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  // The kid always names the PUBLISHED key. A token signed by a key the JWKS
  // does not carry, but claiming the key it does, is the attack — not a typo.
  const key = plan.key === 'unpublished' ? unpublishedKey : signingKey;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(key);
  return `${signingInput}.${b64url(signature)}`;
}

function discoveryDocument(): Record<string, unknown> {
  return {
    issuer: idpBase,
    authorization_endpoint: `${idpBase}${AUTHORIZE_PATH}`,
    token_endpoint: `${idpBase}${TOKEN_PATH}`,
    jwks_uri: `${idpBase}${JWKS_PATH}`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    scopes_supported: ['openid', 'email', 'profile'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
    claims_supported: ['sub', 'email', 'email_verified', 'nonce', 'aud', 'iss', 'exp'],
  };
}

async function startIdp(): Promise<boolean> {
  certDir = mkdtempSync(join(tmpdir(), `aviora-idp-${RUN}-`));
  const keyPath = join(certDir, 'key.pem');
  const certPath = join(certDir, 'cert.pem');
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        keyPath,
        '-out',
        certPath,
        '-days',
        '2',
        '-subj',
        '/CN=localhost',
      ],
      { stdio: 'ignore' },
    );
  } catch {
    return false;
  }

  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  signingKey = pair.privateKey;
  signingJwk = {
    ...(pair.publicKey.export({ format: 'jwk' }) as Record<string, unknown>),
    kid: SIGNING_KID,
    use: 'sig',
    alg: 'RS256',
  };
  unpublishedKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;

  idp = https.createServer(
    { key: readFileSync(keyPath), cert: readFileSync(certPath) },
    (req, res) => {
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        const url = new URL(req.url ?? '/', 'https://127.0.0.1');
        const form: Record<string, string> = {};
        if (raw.trim().startsWith('{')) {
          const parsed = safeJson(raw);
          for (const [k, v] of Object.entries(parsed ?? {})) form[k] = String(v);
        } else {
          for (const [k, v] of new URLSearchParams(raw)) form[k] = v;
        }
        idpTraffic.push({
          path: url.pathname,
          method: req.method ?? 'GET',
          query: Object.fromEntries(url.searchParams),
          headers: req.headers as Record<string, string>,
          raw,
          form,
          at: Date.now(),
        });

        const send = (status: number, payload: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(payload));
        };

        if (url.pathname === DISCOVERY_PATH) return send(200, discoveryDocument());
        if (url.pathname === JWKS_PATH) return send(200, { keys: [signingJwk] });
        if (url.pathname === TOKEN_PATH) {
          if (!nextToken) return send(400, { error: 'invalid_request' });
          // Permissive on purpose: no client authentication is checked, and the
          // same code mints again. Everything single-use is the PLATFORM's job.
          lastIdToken = signIdToken(nextToken);
          return send(200, {
            access_token: `opaque-access-${randomUUID()}`,
            token_type: 'Bearer',
            expires_in: 3600,
            scope: 'openid email profile',
            id_token: lastIdToken,
          });
        }
        return send(404, { error: 'not_found' });
      });
    },
  );

  await new Promise<void>((resolve) => idp!.listen(0, '127.0.0.1', resolve));
  const address = idp.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  idpBase = `https://127.0.0.1:${port}`;
  return true;
}

function requireIdp(): string {
  expect(
    idpBase,
    'no TLS identity provider could be started (openssl unavailable?). docs/31 §1 ' +
      'cannot be asserted honestly without one — minting id_tokens with the ' +
      'platform’s own signer would only prove the platform agrees with itself.',
  ).toBeTruthy();
  return idpBase!;
}

function trafficTo(path: string): IdpRequest[] {
  return idpTraffic.filter((r) => r.path === path);
}

/** What the platform presented as its client secret, however it presented it. */
function presentedSecret(rec: IdpRequest): string | null {
  if (rec.form.client_secret) return rec.form.client_secret;
  const auth = rec.headers['authorization'] ?? '';
  if (auth.startsWith('Basic ')) {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx >= 0) return decodeURIComponent(decoded.slice(idx + 1));
  }
  return null;
}

/* ── driving a login ──────────────────────────────────────────────────────── */

const SSO_START = (slug: string) => `/api/v1/auth/sso/${slug}/start`;
const SSO_CALLBACK = '/api/v1/auth/sso/callback';
const TENANT_SSO = '/api/v1/tenant/sso';

/**
 * INTERPRETATION: §4 says the start route is a redirect ("Redirect to the
 * IdP"), which is a 3xx with a Location. A JSON body carrying the URL would
 * serve a single-page app just as well, so this reads either and every
 * assertion after it is exact about what the URL must contain.
 */
function authorizeUrlOf(res: Res): URL | null {
  const raw =
    res.location ??
    res.body?.redirectUrl ??
    res.body?.redirect_url ??
    res.body?.authorizationUrl ??
    res.body?.url ??
    null;
  if (typeof raw !== 'string' || !raw.startsWith('http')) return null;
  return new URL(raw);
}

interface Started {
  state: string;
  nonce: string;
  challenge: string;
  authorize: URL;
  tenant: string;
}

async function beginLogin(slug: string, tenant: string): Promise<Started> {
  const res = await api(SSO_START(slug));
  expect([200, 302, 303, 307], `start for ${slug} answered ${res.status}`).toContain(res.status);
  const authorize = authorizeUrlOf(res);
  expect(
    authorize,
    `start for ${slug} produced no authorize URL: ${res.text.slice(0, 300)}`,
  ).toBeTruthy();

  const state = authorize!.searchParams.get('state') ?? '';
  const challenge = authorize!.searchParams.get('code_challenge') ?? '';
  expect(state, 'the redirect carries no state').toBeTruthy();
  expect(challenge, 'the redirect carries no PKCE challenge').toBeTruthy();

  // The nonce the platform issued. The IdP sees it in the authorize request;
  // if this implementation does not put it there, the row it stored is the
  // same value and reading it keeps the test honest rather than lenient.
  const fromUrl = authorize!.searchParams.get('nonce');
  const row = await loginRow(tenant, state);
  const nonce = fromUrl ?? row?.nonce ?? '';
  expect(
    nonce,
    'no nonce anywhere: not in the authorize URL, and no sso_logins row for this state. ' +
      'docs/31 §1 makes the nonce single-use, which means it has to exist first.',
  ).toBeTruthy();

  return { state, nonce, challenge, authorize: authorize!, tenant };
}

async function completeLogin(
  started: Started,
  plan: Partial<TokenPlan> & Pick<TokenPlan, 'sub' | 'email'>,
  opts: { code?: string; state?: string; tenant?: string; query?: Record<string, string> } = {},
): Promise<Res> {
  nextToken = { nonce: started.nonce, ...plan } as TokenPlan;
  const params = new URLSearchParams({
    code: opts.code ?? `authcode-${randomUUID()}`,
    state: opts.state ?? started.state,
    ...(opts.query ?? {}),
  });
  return api(`${SSO_CALLBACK}?${params.toString()}`, {
    ...(opts.tenant ? { tenant: opts.tenant } : {}),
  });
}

function sessionOf(res: Res): string | null {
  const cookie = res.setCookies.find((c) => c.startsWith('aviora_access='));
  if (!cookie) return null;
  const value = decodeURIComponent(cookie.split(';')[0]!.split('=')[1]!);
  return value || null;
}

function requireSession(res: Res): string {
  const session = sessionOf(res);
  expect(
    session,
    `the callback issued no aviora_access cookie (status ${res.status}): ${res.text.slice(0, 300)}. ` +
      'docs/31 §1: "issue the platform’s own session … the only thing the rest of the API trusts."',
  ).toBeTruthy();
  return session!;
}

/**
 * Everything a refusal is allowed to be, and everything it must not contain.
 *
 * INTERPRETATION: "names the failing step without echoing token contents".
 * Named is checked against the reason text; echoed is checked against the
 * things that came out of the token itself — the compact JWT and its segments,
 * the nonce, the subject — and against the client secret, which is not in the
 * token but has no business in an error either. The asserted EMAIL is left out
 * of the forbidden list: an operator answering "why can't I sign in" needs to
 * know which address was refused, and it is the one claim the user already
 * typed.
 */
function expectRefusal(res: Res, step: RegExp, label: string): void {
  const redirectedWithReason =
    res.status >= 300 &&
    res.status < 400 &&
    /error|reason|denied/i.test(res.location ?? '') &&
    !sessionOf(res);
  expect(
    redirectedWithReason || [400, 401, 403, 422].includes(res.status),
    `${label}: expected a refusal, got ${res.status} ${res.text.slice(0, 200)}`,
  ).toBe(true);
  expect(sessionOf(res), `${label}: a refused login must not issue a session`).toBeNull();

  const reason = `${JSON.stringify(res.body ?? null)} ${res.location ?? ''}`;
  expect(reason, `${label}: the refusal does not name the step that failed`).toMatch(step);

  const forbidden: Array<[string, string]> = [
    ['the id_token itself', lastIdToken],
    ['the token payload', lastIdToken.split('.')[1] ?? ''],
    ['the token signature', lastIdToken.split('.')[2] ?? ''],
    ['the nonce', nextToken?.nonce ?? ''],
    ['the subject', nextToken?.sub ?? ''],
    ['the client secret', ATLAS_CLIENT_SECRET],
  ];
  for (const [what, value] of forbidden) {
    if (!value || value.length < 8) continue;
    expect(reason.includes(value), `${label}: the refusal echoes ${what}`).toBe(false);
  }
}

/* ── fixture builders ─────────────────────────────────────────────────────── */

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
  const invited = await owner.domainEvent.findFirst({
    where: { eventName: 'MemberInvited', tenantId: tenant, aggregateId: inv.body.invitation.id },
  });
  const accepted = await api(
    `/api/v1/invitations/${(invited!.payload as { token: string }).token}/accept`,
    { method: 'POST', body: JSON.stringify({ displayName: name, password: PW }) },
  );
  expect(accepted.status).toBe(201);
  return accepted.body.memberId;
}

/** The provider Atlas configures, in one place — every PUT below re-sends it. */
function atlasProviderBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'oidc',
    issuer: idpBase,
    discoveryUrl: `${idpBase}${DISCOVERY_PATH}`,
    clientId: ATLAS_CLIENT_ID,
    clientSecret: ATLAS_CLIENT_SECRET,
    allowedDomains: [ATLAS_DOMAIN],
    ...overrides,
  };
}

async function putProvider(
  token: string,
  tenant: string,
  body: Record<string, unknown>,
): Promise<Res> {
  return api(TENANT_SSO, { method: 'PUT', token, tenant, body: JSON.stringify(body) });
}

function providerOf(body: any): any {
  return body?.provider ?? body?.sso ?? body?.identityProvider ?? body;
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

  await startIdp();

  app = await createApp({ logger: false });
  await app.listen(0);
  base = (await app.getUrl()).replace('[::1]', '127.0.0.1');

  const platform = await login(PLATFORM_EMAIL);
  const mkTenant = async (suffix: string, slug: string, name: string, adminEmail: string) => {
    const res = await api('/api/v1/platform/tenants', {
      method: 'POST',
      token: platform,
      body: JSON.stringify({
        code: `e2e_sso_${suffix}_${RUN}`,
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
  atlas = await mkTenant('a', ATLAS_SLUG, 'Atlas Federated', ATLAS_ADMIN);
  haven = await mkTenant('b', HAVEN_SLUG, 'Haven Collective', HAVEN_ADMIN);

  const adminA = await login(ATLAS_ADMIN);
  const plan = await api('/api/v1/membership-plans', {
    method: 'POST',
    token: adminA,
    tenant: atlas,
    body: JSON.stringify({ code: 'atlas', name: 'Atlas', entitlementKeys: [] }),
  });
  expect(plan.status).toBe(201);
  atlasPlanId = plan.body.plan.id as string;

  miraMemberId = await addMember(adminA, atlas, atlasPlanId, MIRA_EMAIL, 'Mira');
}, 300_000);

afterAll(async () => {
  await app?.close();
  await owner?.$disconnect();
  await new Promise<void>((resolve) => (idp ? idp.close(() => resolve()) : resolve()));
  if (certDir) rmSync(certDir, { recursive: true, force: true });
});

/* ══ 1. configuration ══════════════════════════════════════════════════════ */

describe('A provider is configuration, and the secret is not part of it (docs/31 §1, §4)', () => {
  it('refuses a discovery URL that is not https', async () => {
    // The discovery document names the JWKS the platform will trust and the
    // token endpoint it will post a secret to. Fetched over plaintext, both
    // belong to whoever is on the wire.
    const admin = await login(ATLAS_ADMIN);
    const res = await putProvider(
      admin,
      atlas,
      atlasProviderBody({
        issuer: `http://127.0.0.1:9`,
        discoveryUrl: `http://127.0.0.1:9${DISCOVERY_PATH}`,
      }),
    );
    expect([400, 422]).toContain(res.status);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(await providerRow(atlas), 'a refused configuration was stored anyway').toBeNull();
  });

  it('refuses SAML by name, rather than accepting it and doing nothing (§5)', async () => {
    // "No SAML. Named, not silently missing." A provider stored with kind
    // 'saml' would be a configuration screen that federates nothing.
    const admin = await login(ATLAS_ADMIN);
    const res = await putProvider(admin, atlas, atlasProviderBody({ kind: 'saml' }));
    expect([400, 422]).toContain(res.status);
    expect(JSON.stringify(res.body.error).toLowerCase()).toContain('saml');
    expect(await providerRow(atlas)).toBeNull();
  });

  it('accepts the provider, and JIT provisioning is off because nobody turned it on', async () => {
    requireIdp();
    const admin = await login(ATLAS_ADMIN);
    const res = await putProvider(admin, atlas, atlasProviderBody());
    expect([200, 201]).toContain(res.status);

    const provider = providerOf(res.body);
    expect(provider.issuer).toBe(idpBase);
    expect(provider.clientId ?? provider.client_id).toBe(ATLAS_CLIENT_ID);
    expect(provider.allowedDomains ?? provider.allowed_domains).toEqual([ATLAS_DOMAIN]);
    // docs/31 §1: a person who has never been invited is not a member by
    // default. Off unless a tenant said otherwise, in writing.
    expect(provider.jitProvisioning ?? provider.jit_provisioning ?? false).toBe(false);
    expect(provider.status ?? 'active').toBe('active');

    // and Haven configures its own, so every isolation assertion below is a
    // comparison between two real providers rather than one and a hole
    const adminB = await login(HAVEN_ADMIN);
    const havens = await putProvider(adminB, haven, {
      kind: 'oidc',
      issuer: idpBase,
      discoveryUrl: `${idpBase}${DISCOVERY_PATH}`,
      clientId: HAVEN_CLIENT_ID,
      clientSecret: HAVEN_CLIENT_SECRET,
      allowedDomains: [HAVEN_DOMAIN],
    });
    expect([200, 201]).toContain(havens.status);
  });

  it('never returns the client secret, from any route', async () => {
    const admin = await login(ATLAS_ADMIN);

    const read = await api(TENANT_SSO, { token: admin, tenant: atlas });
    expect(read.status).toBe(200);
    expect(mentions(read.body, ATLAS_CLIENT_SECRET), 'GET /tenant/sso returned the secret').toBe(
      false,
    );

    // an upsert answers with the provider; a write is not a back door to a read
    const written = await putProvider(admin, atlas, atlasProviderBody());
    expect([200, 201]).toContain(written.status);
    expect(mentions(written.body, ATLAS_CLIENT_SECRET), 'PUT /tenant/sso echoed the secret').toBe(
      false,
    );

    // nor the platform's own view of where tenants live
    const platform = await login(PLATFORM_EMAIL);
    const databases = await api('/api/v1/platform/tenant-databases', { token: platform });
    expect([200, 404]).toContain(databases.status);
    if (databases.status === 200) expect(mentions(databases.body, ATLAS_CLIENT_SECRET)).toBe(false);
  });

  it('stores something other than the secret it was handed', async () => {
    // FINDING, written down rather than worked around: the column is called
    // `client_secret_encrypted`, but a hash cannot be presented to a token endpoint.
    // Either the value is reversible (encrypted, and the name is misleading) or
    // the client is public and PKCE is the only proof of possession. What is
    // NOT acceptable either way is the plaintext sitting in the column, which
    // is all this asserts.
    const row = await providerRow(atlas);
    expect(row, 'no provider row after a successful upsert').toBeTruthy();
    expect(row!.client_secret_encrypted).not.toBe(ATLAS_CLIENT_SECRET);
    expect(row!.client_secret_encrypted).not.toContain(ATLAS_CLIENT_SECRET);
    expect(row!.client_secret_encrypted.length).toBeGreaterThan(16);
  });

  it('refuses a member who does not hold tenant.sso.manage, and changes nothing', async () => {
    // Federation decides who may sign in. A member who can configure it can
    // point the tenant at a provider they control.
    const before = await providerRow(atlas);
    const mira = await login(MIRA_EMAIL);

    const read = await api(TENANT_SSO, { token: mira, tenant: atlas });
    expect(read.status).toBe(403);
    expect(read.body.error.code).toBe('FORBIDDEN');

    const written = await putProvider(
      mira,
      atlas,
      atlasProviderBody({ clientId: 'a-client-mira-controls', allowedDomains: [FOREIGN_DOMAIN] }),
    );
    expect(written.status).toBe(403);

    const removed = await api(TENANT_SSO, { method: 'DELETE', token: mira, tenant: atlas });
    expect(removed.status).toBe(403);

    const after = await providerRow(atlas);
    expect(after).toEqual(before);
  });
});

/* ══ 2. the redirect ═══════════════════════════════════════════════════════ */

describe('The redirect a browser follows carries state and a challenge (docs/31 §1)', () => {
  it('sends the browser to the endpoint the discovery document named', async () => {
    requireIdp();
    const started = await beginLogin(ATLAS_SLUG, atlas);

    // `/op/authorize` is not a spelling anyone would guess — reaching it means
    // the platform actually read the discovery document it was configured with.
    expect(trafficTo(DISCOVERY_PATH).length).toBeGreaterThan(0);
    expect(started.authorize.origin).toBe(idpBase);
    expect(started.authorize.pathname).toBe(AUTHORIZE_PATH);

    const q = started.authorize.searchParams;
    expect(q.get('client_id')).toBe(ATLAS_CLIENT_ID);
    expect(q.get('response_type')).toBe('code');
    expect((q.get('scope') ?? '').split(/\s+/)).toContain('openid');
    expect(q.get('redirect_uri') ?? '', 'no redirect_uri for the IdP to come back to').toContain(
      '/auth/sso/callback',
    );

    // PKCE: S256, and a challenge long enough to be one
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(started.challenge.length).toBeGreaterThanOrEqual(43);
    expect(started.challenge).toMatch(/^[A-Za-z0-9_-]+$/);

    // and the secret is never in a URL a browser will hold in its history
    expect(started.authorize.toString()).not.toContain(ATLAS_CLIENT_SECRET);
  });

  it('issues a state that is single-use and expiring, and never the same twice', async () => {
    const first = await beginLogin(ATLAS_SLUG, atlas);
    const second = await beginLogin(ATLAS_SLUG, atlas);
    expect(first.state).not.toBe(second.state);
    expect(first.challenge).not.toBe(second.challenge);
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.state.length).toBeGreaterThanOrEqual(16);

    const row = await loginRow(atlas, first.state);
    expect(row, 'the state the browser was handed was never recorded').toBeTruthy();
    expect(row!.consumed_at, 'a state is unconsumed until a callback uses it').toBeNull();
    expect(
      new Date(row!.expires_at).getTime(),
      'docs/31 §1: state and nonce EXPIRE — a row with no future expiry never does',
    ).toBeGreaterThan(Date.now());
  });

  it('refuses to start for a tenant that has no provider, and for one that does not exist', async () => {
    const platform = await login(PLATFORM_EMAIL);
    const bare = await api('/api/v1/platform/tenants', {
      method: 'POST',
      token: platform,
      body: JSON.stringify({
        code: `e2e_sso_c_${RUN}`,
        name: 'No Federation',
        slug: `e2e-sso-c-${RUN}`,
        adminEmail: `admin-c-${RUN}@test.local`,
        adminDisplayName: 'Admin',
        adminPassword: PW,
      }),
    });
    expect(bare.status).toBe(201);

    const unconfigured = await api(SSO_START(`e2e-sso-c-${RUN}`));
    expect([400, 404]).toContain(unconfigured.status);
    expect(authorizeUrlOf(unconfigured)).toBeNull();

    const nobody = await api(SSO_START(`e2e-sso-nobody-${RUN}`));
    expect([400, 404]).toContain(nobody.status);
    expect(authorizeUrlOf(nobody)).toBeNull();
  });
});

/* ══ 3. the happy path ═════════════════════════════════════════════════════ */

describe('The callback issues the PLATFORM’s session, never the IdP’s (docs/31 §1)', () => {
  let session = '';
  let started: Started;

  it('exchanges the code with PKCE and issues a session that works on a normal route', async () => {
    requireIdp();
    started = await beginLogin(ATLAS_SLUG, atlas);
    const before = trafficTo(TOKEN_PATH).length;

    const res = await completeLogin(started, { sub: MIRA_SUB, email: MIRA_EMAIL });
    session = requireSession(res);

    // the exchange happened, once, and it was an authorization_code grant
    const exchanges = trafficTo(TOKEN_PATH).slice(before);
    expect(exchanges).toHaveLength(1);
    const exchange = exchanges[0]!;
    expect(exchange.method).toBe('POST');
    expect(exchange.form.grant_type).toBe('authorization_code');
    expect(exchange.form.client_id ?? presentedSecret(exchange)).toBeTruthy();

    // PKCE is proved at the provider, not asserted from our own fields: the
    // verifier presented here must hash to the challenge that was in the URL
    const verifier = exchange.form.code_verifier;
    expect(verifier, 'no code_verifier — the PKCE challenge was decoration').toBeTruthy();
    expect(createHash('sha256').update(verifier!).digest('base64url')).toBe(started.challenge);

    // and IF a client secret is presented, it is the configured one and not a
    // hash of it (see the FINDING in "Configuration")
    const secret = presentedSecret(exchange);
    if (secret !== null) expect(secret).toBe(ATLAS_CLIENT_SECRET);

    // the session is OURS: a JWT the API accepts, and not the IdP's id_token
    expect(session).not.toBe(lastIdToken);
    expect(session.split('.')).toHaveLength(3);
    const me = await api('/api/v1/auth/me', { cookie: `aviora_access=${session}` });
    expect(me.status, 'the cookie the callback set does not authenticate anything').toBe(200);
    expect(me.body.user.email).toBe(MIRA_EMAIL);
  });

  it('resolves the person to the member they already were, in the right tenant', async () => {
    const me = await api('/api/v1/members/me', {
      cookie: `aviora_access=${session}`,
      tenant: atlas,
    });
    expect(me.status).toBe(200);
    // the SAME member, not a second Mira alongside the invited one
    expect(me.body.member.id).toBe(miraMemberId);
    expect(await withTenant(atlas, (tx) => tx.member.count({ where: { id: miraMemberId } }))).toBe(
      1,
    );
    expect(
      await owner.user.count({ where: { email: MIRA_EMAIL } }),
      'a federated login created a second user for an address that already had one',
    ).toBe(1);

    const account = await api('/api/v1/auth/me', { cookie: `aviora_access=${session}` });
    const slugs = (account.body.tenants ?? []).map((t: any) => t.slug);
    expect(slugs).toContain(ATLAS_SLUG);
    expect(slugs).not.toContain(HAVEN_SLUG);
  });

  it('marks the state consumed and records what the IdP asserted', async () => {
    const row = await loginRow(atlas, started.state);
    expect(row, 'the state row disappeared instead of being consumed').toBeTruthy();
    expect(
      row!.consumed_at,
      'docs/31 §1: state and nonce are SINGLE-USE. A row still open after a ' +
        'successful login is a code that can be redeemed again.',
    ).toBeTruthy();
  });

  it('gives the session no reach into the other tenant', async () => {
    const trespass = await api('/api/v1/members/me', {
      cookie: `aviora_access=${session}`,
      tenant: haven,
    });
    expect(trespass.status).toBe(403);
    expect(trespass.body.error.code).toBe('FORBIDDEN');
  });
});

/* ══ 4. verification ═══════════════════════════════════════════════════════ */

describe('Verification actually verifies (docs/31 §1)', () => {
  /**
   * Each of these is a token that is perfect in every respect but one. If any
   * of them logs somebody in, the platform is trusting an assertion it has not
   * checked — and every one of them is somebody else's account.
   */
  it('refuses a token signed by a key the JWKS does not publish', async () => {
    const started = await beginLogin(ATLAS_SLUG, atlas);
    const res = await completeLogin(started, {
      sub: MIRA_SUB,
      email: MIRA_EMAIL,
      key: 'unpublished',
    });
    expectRefusal(res, /signature|verif|jwks|key|invalid[_ ]token/i, 'wrong signing key');
    expect(trafficTo(JWKS_PATH).length, 'the JWKS was never fetched at all').toBeGreaterThan(0);
  });

  it('refuses a token that has expired', async () => {
    const started = await beginLogin(ATLAS_SLUG, atlas);
    const res = await completeLogin(started, {
      sub: MIRA_SUB,
      email: MIRA_EMAIL,
      expiresIn: -60,
    });
    expectRefusal(res, /expir|\bexp\b|stale|not valid|invalid[_ ]token/i, 'expired token');
  });

  it('refuses a token whose nonce is not the one that was issued', async () => {
    // The nonce binds this token to THIS login. Without the check, a token
    // captured from any other session of the same user replays into a new one.
    const started = await beginLogin(ATLAS_SLUG, atlas);
    const res = await completeLogin(started, {
      sub: MIRA_SUB,
      email: MIRA_EMAIL,
      nonce: `nonce-from-some-other-login-${randomUUID()}`,
    });
    expectRefusal(res, /nonce|replay|invalid[_ ]token/i, 'mismatched nonce');
  });

  it('refuses a token minted for another client', async () => {
    // Literally the other tenant's client id. An audience check that passes
    // here means one tenant's IdP token signs you into another tenant's app.
    const started = await beginLogin(ATLAS_SLUG, atlas);
    const res = await completeLogin(started, {
      sub: MIRA_SUB,
      email: MIRA_EMAIL,
      aud: HAVEN_CLIENT_ID,
    });
    expectRefusal(res, /aud|audience|client|invalid[_ ]token/i, 'wrong audience');
  });

  it('refuses a token from another issuer', async () => {
    const started = await beginLogin(ATLAS_SLUG, atlas);
    const res = await completeLogin(started, {
      sub: MIRA_SUB,
      email: MIRA_EMAIL,
      iss: `https://an-issuer-nobody-configured-${RUN}.example`,
    });
    expectRefusal(res, /iss\b|issuer|invalid[_ ]token/i, 'wrong issuer');
  });

  it('left no session, no member and no user behind for any of them', async () => {
    // Five refusals, five separate states. If any of them half-succeeded, the
    // tenant grew a member out of a token that failed verification.
    expect(await withTenant(atlas, (tx) => tx.member.count())).toBe(2); // admin + Mira
    expect(await owner.user.count({ where: { email: MIRA_EMAIL } })).toBe(1);
  });
});

/* ══ 5. replay ═════════════════════════════════════════════════════════════ */

describe('A callback is single-use, because a code that redeems twice is an account taken twice (docs/31 §1)', () => {
  it('refuses the second use of the same state and code', async () => {
    // The most important test in this file. The identity provider here will
    // happily mint a second token for the same code — real ones sometimes do,
    // and an attacker who captures a callback URL replays it verbatim. The only
    // thing standing between that and a duplicate session is the platform's own
    // single-use check.
    const started = await beginLogin(ATLAS_SLUG, atlas);
    const code = `authcode-replayed-${randomUUID()}`;

    const first = await completeLogin(started, { sub: MIRA_SUB, email: MIRA_EMAIL }, { code });
    requireSession(first);
    const exchangesAfterFirst = trafficTo(TOKEN_PATH).length;

    const second = await completeLogin(started, { sub: MIRA_SUB, email: MIRA_EMAIL }, { code });
    expectRefusal(second, /state|consum|used|replay|expir|invalid/i, 'replayed callback');

    expect(
      trafficTo(TOKEN_PATH).length,
      'the platform went back to the token endpoint with a code it had already redeemed. ' +
        'The refusal came too late: by then the IdP had minted a second token.',
    ).toBe(exchangesAfterFirst);
  });

  it('refuses a state nobody issued', async () => {
    const res = await api(
      `${SSO_CALLBACK}?code=authcode-${randomUUID()}&state=state-nobody-issued-${randomUUID()}`,
    );
    expect(sessionOf(res)).toBeNull();
    expect([400, 401, 403, 404]).toContain(res.status);
  });

  it('refuses a callback with no state at all', async () => {
    const res = await api(`${SSO_CALLBACK}?code=authcode-${randomUUID()}`);
    expect(sessionOf(res)).toBeNull();
    expect([400, 401, 403, 404]).toContain(res.status);
  });
});

/* ══ 6. domains ════════════════════════════════════════════════════════════ */

describe('A provider may assert only its own domains (docs/31 §1)', () => {
  it('refuses an address outside allowed_domains, however good the token is', async () => {
    // Correct signature, live expiry, right audience, right issuer, matching
    // nonce. The only thing wrong with it is the address, and that is enough —
    // "a provider that can assert any address can assert the tenant owner's".
    const started = await beginLogin(ATLAS_SLUG, atlas);
    const res = await completeLogin(started, { sub: INTRUDER_SUB, email: INTRUDER_EMAIL });
    expectRefusal(res, /domain|allowed|email|not permitted|forbidden/i, 'foreign email domain');

    expect(await owner.user.count({ where: { email: INTRUDER_EMAIL } })).toBe(0);
    expect(await withTenant(atlas, (tx) => tx.member.count())).toBe(2);
  });

  it('refuses an address that merely ends with the allowed domain', async () => {
    // `atlas-run.example.attacker.test` and `notatlas-run.example` both contain
    // the allowed domain as a substring. A suffix match on the whole address,
    // or a `contains`, lets either of them in.
    const started = await beginLogin(ATLAS_SLUG, atlas);
    const res = await completeLogin(started, {
      sub: `idp|lookalike|${RUN}`,
      email: `someone@${ATLAS_DOMAIN}.attacker-${RUN}.test`,
    });
    expectRefusal(res, /domain|allowed|email|not permitted|forbidden/i, 'lookalike domain');

    const other = await beginLogin(ATLAS_SLUG, atlas);
    const res2 = await completeLogin(other, {
      sub: `idp|lookalike2|${RUN}`,
      email: `someone@not${ATLAS_DOMAIN}`,
    });
    expectRefusal(res2, /domain|allowed|email|not permitted|forbidden/i, 'prefixed domain');

    expect(await withTenant(atlas, (tx) => tx.member.count())).toBe(2);
  });
});

/* ══ 7. authentication is not authorisation ════════════════════════════════ */

describe('A federated login authenticates; it never authorises (docs/31 §1, §5)', () => {
  /** What the IdP claims Mira is. None of it is true here, and none of it matters. */
  const CLAIMED = {
    roles: ['admin', 'tenant_owner'],
    groups: ['owners', 'billing'],
    permissions: ['tenant.sso.manage', 'platform.tenant.manage'],
    is_admin: true,
  };

  let session = '';
  let state = '';
  let rolesBefore: string[] = [];
  let roleCodesBefore: string[] = [];
  let grantsBefore = 0;

  it('signs the person in, carrying every claim an IdP could think of', async () => {
    const admin = await login(ATLAS_ADMIN);
    const listed = await api('/api/v1/members', { token: admin, tenant: atlas });
    expect(listed.status).toBe(200);
    rolesBefore = listed.body.members.find((m: any) => m.id === miraMemberId).roles;
    expect(rolesBefore).toEqual([DEFAULT_ROLE]);

    roleCodesBefore = (
      await withTenant(atlas, (tx) => tx.role.findMany({ select: { code: true } }))
    )
      .map((r) => r.code)
      .sort();
    grantsBefore = await withTenant(atlas, (tx) => tx.rolePermission.count());

    const started = await beginLogin(ATLAS_SLUG, atlas);
    state = started.state;
    const res = await completeLogin(started, {
      sub: MIRA_SUB,
      email: MIRA_EMAIL,
      extra: CLAIMED,
    });
    session = requireSession(res);
  });

  it('leaves the member holding the tenant’s default role and nothing else', async () => {
    const me = await api('/api/v1/members/me', {
      cookie: `aviora_access=${session}`,
      tenant: atlas,
    });
    expect(me.status).toBe(200);
    expect(me.body.member.id).toBe(miraMemberId);
    expect(me.body.member.memberRoles.map((r: any) => r.role.code)).toEqual([DEFAULT_ROLE]);
  });

  it('refuses her the admin routes the claims said she owned', async () => {
    const cookie = `aviora_access=${session}`;
    // `permissions: ["tenant.sso.manage"]` — the route that permission gates
    const sso = await api(TENANT_SSO, { cookie, tenant: atlas });
    expect(sso.status).toBe(403);
    expect(sso.body.error.code).toBe('FORBIDDEN');

    // `roles: ["admin"]` — the member roster
    const members = await api('/api/v1/members', { cookie, tenant: atlas });
    expect(members.status).toBe(403);

    // `permissions: ["platform.tenant.manage"]` — platform scope, which no
    // tenant role holds at all, let alone one an IdP asked for
    const platform = await api('/api/v1/platform/tenants', { cookie });
    expect(platform.status).toBe(403);
  });

  it('did not move a single permission anywhere in the tenant', async () => {
    const admin = await login(ATLAS_ADMIN);
    const listed = await api('/api/v1/members', { token: admin, tenant: atlas });
    expect(listed.body.members.find((m: any) => m.id === miraMemberId).roles).toEqual(rolesBefore);

    // no role called `owners` appeared to hold the claim, and no existing role
    // quietly grew a grant to satisfy one
    const roleCodesAfter = (
      await withTenant(atlas, (tx) => tx.role.findMany({ select: { code: true } }))
    )
      .map((r) => r.code)
      .sort();
    expect(roleCodesAfter).toEqual(roleCodesBefore);
    expect(await withTenant(atlas, (tx) => tx.rolePermission.count())).toBe(grantsBefore);
    expect(
      await withTenant(atlas, (tx) => tx.memberRole.count({ where: { memberId: miraMemberId } })),
    ).toBe(1);
  });

  it('keeps the claims where an administrator can read them', async () => {
    // docs/31 §1: group and role claims "are recorded on the membership for an
    // administrator to look at". Recorded, surfaced, never applied — the first
    // two are this test, the third is the three above it.
    const admin = await login(ATLAS_ADMIN);
    const candidates = [TENANT_SSO, `${TENANT_SSO}/logins`, `${TENANT_SSO}/activity`];
    const tried: string[] = [];
    let surfaced: string | null = null;
    for (const path of candidates) {
      const res = await api(path, { token: admin, tenant: atlas });
      tried.push(`${path} → ${res.status}`);
      if (res.status === 200 && mentions(res.body, 'owners')) {
        surfaced = JSON.stringify(res.body);
        break;
      }
    }

    const row = await loginRow(atlas, state);
    const recorded = surfaced ?? JSON.stringify(row?.claims ?? null);
    expect(
      recorded,
      `the claims the IdP asserted were dropped: no route surfaced them (${tried.join(', ')}) ` +
        'and sso_logins.claims did not keep them. An unrecorded claim is one nobody can audit.',
    ).toContain('owners');
    expect(recorded).toContain('admin');
  });
});

/* ══ 8. JIT provisioning ═══════════════════════════════════════════════════ */

describe('JIT provisioning is off until a tenant turns it on, and creates a member only (docs/31 §1)', () => {
  it('refuses somebody nobody invited while it is off', async () => {
    const started = await beginLogin(ATLAS_SLUG, atlas);
    const res = await completeLogin(started, { sub: NEWCOMER_SUB, email: NEWCOMER_EMAIL });
    expectRefusal(res, /member|invit|unknown|not found|provision|forbidden/i, 'unknown member');

    expect(
      await owner.user.count({ where: { email: NEWCOMER_EMAIL } }),
      'a refused login created the user anyway',
    ).toBe(0);
    expect(await withTenant(atlas, (tx) => tx.member.count())).toBe(2);
  });

  it('creates a member — and only a member — once the tenant turns it on', async () => {
    const admin = await login(ATLAS_ADMIN);
    const enabled = await putProvider(admin, atlas, atlasProviderBody({ jitProvisioning: true }));
    expect([200, 201]).toContain(enabled.status);

    const started = await beginLogin(ATLAS_SLUG, atlas);
    const res = await completeLogin(started, { sub: NEWCOMER_SUB, email: NEWCOMER_EMAIL });
    const session = requireSession(res);

    const me = await api('/api/v1/members/me', {
      cookie: `aviora_access=${session}`,
      tenant: atlas,
    });
    expect(me.status).toBe(200);
    expect(me.body.member.id).not.toBe(miraMemberId);
    // "never a role beyond the tenant's default. A person who has never been
    // invited arriving with a valid token is a member, not an administrator."
    expect(me.body.member.memberRoles.map((r: any) => r.role.code)).toEqual([DEFAULT_ROLE]);

    const roster = await api('/api/v1/members', { token: admin, tenant: atlas });
    const created = roster.body.members.find((m: any) => m.email === NEWCOMER_EMAIL);
    expect(created, 'the JIT member is not on the roster an administrator reads').toBeTruthy();
    expect(created.roles).toEqual([DEFAULT_ROLE]);

    // and the admin routes are shut to them exactly as they are to Mira
    const sso = await api(TENANT_SSO, {
      cookie: `aviora_access=${session}`,
      tenant: atlas,
    });
    expect(sso.status).toBe(403);
  });

  it('still refuses a foreign domain with provisioning on', async () => {
    // JIT widens WHO may be created, never WHICH addresses the provider may
    // assert. Turning it on must not quietly disable the domain bound.
    const started = await beginLogin(ATLAS_SLUG, atlas);
    const res = await completeLogin(started, { sub: INTRUDER_SUB, email: INTRUDER_EMAIL });
    expectRefusal(res, /domain|allowed|email|not permitted|forbidden/i, 'foreign domain with JIT');
    expect(await owner.user.count({ where: { email: INTRUDER_EMAIL } })).toBe(0);
  });
});

/* ══ 9. isolation ══════════════════════════════════════════════════════════ */

describe('One tenant’s federation is invisible to another (docs/31 §1)', () => {
  it('shows Haven its own provider and nothing of Atlas’s', async () => {
    const adminB = await login(HAVEN_ADMIN);
    const res = await api(TENANT_SSO, { token: adminB, tenant: haven });
    expect(res.status).toBe(200);

    const provider = providerOf(res.body);
    expect(provider.clientId ?? provider.client_id).toBe(HAVEN_CLIENT_ID);
    expect(provider.allowedDomains ?? provider.allowed_domains).toEqual([HAVEN_DOMAIN]);

    expect(mentions(res.body, ATLAS_CLIENT_ID), 'Haven can see Atlas’s client id').toBe(false);
    expect(mentions(res.body, ATLAS_DOMAIN), 'Haven can see Atlas’s allowed domain').toBe(false);
    expect(mentions(res.body, ATLAS_CLIENT_SECRET)).toBe(false);
    expect(mentions(res.body, HAVEN_CLIENT_SECRET)).toBe(false);
  });

  it('refuses Atlas’s administrator at Haven’s configuration', async () => {
    const adminA = await login(ATLAS_ADMIN);
    const read = await api(TENANT_SSO, { token: adminA, tenant: haven });
    expect(read.status).toBe(403);

    const written = await putProvider(
      adminA,
      haven,
      atlasProviderBody({ allowedDomains: [ATLAS_DOMAIN] }),
    );
    expect(written.status).toBe(403);

    const row = await providerRow(haven);
    expect(row!.client_id, 'Atlas rewrote Haven’s provider').toBe(HAVEN_CLIENT_ID);
    expect(row!.allowed_domains).toEqual([HAVEN_DOMAIN]);
  });

  it('cannot be aimed at another tenant on the way back', async () => {
    // The state is the only thing that says which tenant this login belongs
    // to. A caller who adds a header naming a different one must not move it:
    // Atlas's provider asserting an address into Haven would be one tenant
    // minting members inside another.
    const havenMembersBefore = await withTenant(haven, (tx) => tx.member.count());
    const started = await beginLogin(ATLAS_SLUG, atlas);

    const res = await completeLogin(
      started,
      { sub: MIRA_SUB, email: MIRA_EMAIL },
      { tenant: haven, query: { tenantSlug: HAVEN_SLUG } },
    );

    const session = sessionOf(res);
    if (session) {
      // A session was still issued — acceptable only if the state decided the
      // tenant and the header was ignored entirely.
      const account = await api('/api/v1/auth/me', { cookie: `aviora_access=${session}` });
      const slugs = (account.body.tenants ?? []).map((t: any) => t.slug);
      expect(slugs, 'the callback moved the login into another tenant').not.toContain(HAVEN_SLUG);
      expect(slugs).toContain(ATLAS_SLUG);

      const trespass = await api('/api/v1/members/me', {
        cookie: `aviora_access=${session}`,
        tenant: haven,
      });
      expect(trespass.status).toBe(403);
    } else {
      expect([400, 401, 403, 404]).toContain(res.status);
    }

    expect(
      await withTenant(haven, (tx) => tx.member.count()),
      'Atlas’s federated login created a member inside Haven',
    ).toBe(havenMembersBefore);
    expect(await loginRow(haven, started.state)).toBeNull();
  });
});

/* ══ 10. the migration seam ════════════════════════════════════════════════ */

describe('A migrating tenant is read-only, because a migration that accepts writes loses them (docs/31 §2)', () => {
  it('reports where each tenant lives, to the platform and to nobody else', async () => {
    const platform = await login(PLATFORM_EMAIL);
    const res = await api('/api/v1/platform/tenant-databases', { token: platform });
    expect(res.status).toBe(200);
    const rows: any[] = res.body.databases ?? res.body.items ?? res.body.tenantDatabases ?? [];
    expect(Array.isArray(rows)).toBe(true);

    // and a tenant owner cannot read it: "Database routing is platform work,
    // not tenant work: a tenant cannot move itself." (§3)
    const adminA = await login(ATLAS_ADMIN);
    const forbidden = await api('/api/v1/platform/tenant-databases', {
      token: adminA,
      tenant: atlas,
    });
    expect(forbidden.status).toBe(403);
  });

  it('answers a GET and refuses a write, with a reason, while the status says migrating', async () => {
    const mira = await login(MIRA_EMAIL);
    const before = await api('/api/v1/goals', { token: mira, tenant: atlas });
    expect(before.status).toBe(200);

    await setDatabaseStatus(atlas, 'migrating');
    try {
      // reads still work — a read-only tenant is still a working tenant
      const read = await api('/api/v1/goals', { token: mira, tenant: atlas });
      expect(read.status, 'a migrating tenant went dark instead of going read-only').toBe(200);

      const write = await api('/api/v1/goals', {
        method: 'POST',
        token: mira,
        tenant: atlas,
        body: JSON.stringify({
          title: `A goal written mid-migration ${RUN}`,
          category: 'personal',
        }),
      });
      expect(
        [409, 423, 451, 503],
        `a write during migration answered ${write.status}: ${write.text.slice(0, 200)}`,
      ).toContain(write.status);
      expect(
        JSON.stringify(write.body ?? null),
        'the refusal does not say why — "it didn’t work" is not something support can relay',
      ).toMatch(/read[-_ ]?only|migrat|maintenance/i);

      // and the write really did not happen
      expect(
        await withTenant(atlas, (tx) =>
          tx.goal.count({ where: { title: `A goal written mid-migration ${RUN}` } }),
        ),
      ).toBe(0);

      // the platform can still see where the tenant is, and says so
      const platform = await login(PLATFORM_EMAIL);
      const listed = await api('/api/v1/platform/tenant-databases', { token: platform });
      expect(listed.status).toBe(200);
      const rows: any[] =
        listed.body.databases ?? listed.body.items ?? listed.body.tenantDatabases ?? [];
      const mine = rows.find((r: any) => (r.tenantId ?? r.tenant_id ?? r.tenant?.id) === atlas);
      expect(
        mine,
        'the platform view does not include a tenant that is mid-migration',
      ).toBeTruthy();
      expect(mine.status).toBe('migrating');
    } finally {
      await setDatabaseStatus(atlas, 'shared');
    }
  });

  it('takes writes again once the tenant is back on the shared database', async () => {
    const mira = await login(MIRA_EMAIL);
    const write = await api('/api/v1/goals', {
      method: 'POST',
      token: mira,
      tenant: atlas,
      body: JSON.stringify({ title: `A goal written after ${RUN}`, category: 'personal' }),
    });
    expect(write.status).toBe(201);
  });

  it('plans a move without making one (§2: the seam and the rehearsal, not a migration)', async () => {
    /**
     * INTERPRETATION: §4 writes `POST /platform/tenant-databases/:id/plan`
     * without saying whether `:id` is the tenant or the routing row. Both are
     * tried; whichever answers is the one asserted on, and if neither does the
     * failure prints what it tried.
     */
    const platform = await login(PLATFORM_EMAIL);
    const listed = await api('/api/v1/platform/tenant-databases', { token: platform });
    const rows: any[] =
      listed.body.databases ?? listed.body.items ?? listed.body.tenantDatabases ?? [];
    const mine = rows.find((r: any) => (r.tenantId ?? r.tenant_id ?? r.tenant?.id) === atlas);

    const tried: string[] = [];
    let plan: Res | null = null;
    for (const id of [mine?.id, atlas].filter(Boolean) as string[]) {
      const res = await api(`/api/v1/platform/tenant-databases/${id}/plan`, {
        method: 'POST',
        token: platform,
        body: JSON.stringify({}),
      });
      tried.push(`${id} → ${res.status}`);
      if (res.status === 200 || res.status === 201) {
        plan = res;
        break;
      }
    }
    expect(plan, `no dry run answered: ${tried.join(', ')}`).toBeTruthy();

    // A dry run says what WOULD move. It must name tables and counts, and it
    // must not have moved anything: the status is still shared.
    expect(JSON.stringify(plan!.body)).toMatch(/table|rows|count/i);
    const after = await owner.$queryRawUnsafe<Array<{ status: string }>>(
      `SELECT status FROM tenant_databases WHERE tenant_id = $1::uuid`,
      atlas,
    );
    expect(after[0]?.status).toBe('shared');
  });
});

/* ══ 11. turning it off ════════════════════════════════════════════════════ */

describe('Federation can be switched off, and local sign-in is unaffected (docs/31 §4)', () => {
  it('removes the provider and stops starting logins', async () => {
    const admin = await login(ATLAS_ADMIN);
    const removed = await api(TENANT_SSO, { method: 'DELETE', token: admin, tenant: atlas });
    expect([200, 204]).toContain(removed.status);

    const started = await api(SSO_START(ATLAS_SLUG));
    expect([400, 404]).toContain(started.status);
    expect(authorizeUrlOf(started)).toBeNull();
  });

  it('leaves the members it federated able to sign in with a password', async () => {
    // Turning federation off must not lock out the people it let in — least of
    // all the ones JIT created, who never chose a password. Mira had one before
    // SSO existed, and it still works.
    const token = await login(MIRA_EMAIL);
    const me = await api('/api/v1/members/me', { token, tenant: atlas });
    expect(me.status).toBe(200);
    expect(me.body.member.id).toBe(miraMemberId);
  });

  it('leaves Haven’s federation alone', async () => {
    const adminB = await login(HAVEN_ADMIN);
    const res = await api(TENANT_SSO, { token: adminB, tenant: haven });
    expect(res.status).toBe(200);
    expect(providerOf(res.body).clientId ?? providerOf(res.body).client_id).toBe(HAVEN_CLIENT_ID);
  });
});
