import * as crypto from 'node:crypto';
import { z } from 'zod';

/**
 * OIDC wire formats and verification (docs/31 §1). Pure functions only:
 * nothing here touches the database, the network or Nest, so every rule below
 * — which algorithms are acceptable, what a nonce mismatch is — can be read
 * and tested without standing anything up.
 *
 * SAML is absent on purpose. It is a second protocol with its own signing,
 * canonicalisation and metadata story, and half of it would be worse than none
 * (docs/31 §5).
 */

/**
 * Which step of the flow failed. A federated login that fails with
 * "unauthorized" tells an administrator nothing; naming the step tells them
 * whether to look at their IdP's metadata, their clock, their allowed domains
 * or their provisioning setting.
 */
export const SSO_STEPS = [
  'configuration',
  'discovery',
  'state',
  'token_exchange',
  'signature',
  'claims',
  'nonce',
  'domain',
  'provisioning',
] as const;
export type SsoStep = (typeof SSO_STEPS)[number];

/**
 * Signature algorithms this platform will accept on an id_token.
 *
 * Asymmetric only. `none` is the classic JWT forgery and HS* is subtler: the
 * verification key for HS256 is the shared secret, and an IdP whose public
 * JWKS is fetchable would hand an attacker the material to sign with. Both are
 * refused by not being on this list rather than by a special case.
 */
export const ACCEPTED_ALGS: ReadonlySet<string> = new Set([
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
]);

/**
 * Tolerance for clock drift between this server and the IdP.
 *
 * Thirty seconds, not two minutes. This is grace on an EXPIRED credential:
 * every second of it is a second a token that the provider has already
 * declared dead is still accepted here. Thirty covers the drift a machine with
 * working NTP actually has; anything larger is covering for a broken clock at
 * the cost of the expiry meaning something.
 */
export const CLOCK_SKEW_SECONDS = 30;

/** How long a started login may sit unfinished. */
export const LOGIN_TTL_MS = 10 * 60 * 1000;

export class SsoError extends Error {
  constructor(
    readonly step: SsoStep,
    message: string,
  ) {
    super(message);
    this.name = 'SsoError';
  }
}

/** The parts of the discovery document this flow actually uses. */
export const discoveryDocumentSchema = z
  .object({
    issuer: z.string().min(1),
    authorization_endpoint: z.string().url(),
    token_endpoint: z.string().url(),
    jwks_uri: z.string().url(),
    id_token_signing_alg_values_supported: z.array(z.string()).optional(),
    code_challenge_methods_supported: z.array(z.string()).optional(),
  })
  .passthrough();

export type DiscoveryDocument = z.infer<typeof discoveryDocumentSchema>;

export interface Jwk {
  kty: string;
  kid?: string;
  alg?: string;
  use?: string;
  [key: string]: unknown;
}

export const jwksSchema = z.object({ keys: z.array(z.record(z.any())) });

export interface JwtHeader {
  alg: string;
  kid?: string;
  typ?: string;
}

export interface IdTokenClaims {
  iss?: string;
  aud?: string | string[];
  sub?: string;
  exp?: number;
  iat?: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  [claim: string]: unknown;
}

export interface ParsedJwt {
  header: JwtHeader;
  claims: IdTokenClaims;
  /** The bytes the signature covers: `header.payload`, ASCII. */
  signingInput: string;
  signature: Buffer;
}

/**
 * Splits and decodes a JWT WITHOUT trusting any of it. Nothing read here may
 * be acted on until `verifyIdTokenSignature` has succeeded — the header's
 * `alg` in particular, which is attacker-controlled until then.
 */
export function parseJwt(token: string): ParsedJwt {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new SsoError('signature', 'The identity provider returned a malformed id_token');
  }
  const [h, p, s] = parts as [string, string, string];
  let header: JwtHeader;
  let claims: IdTokenClaims;
  try {
    header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as JwtHeader;
    claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as IdTokenClaims;
  } catch {
    throw new SsoError('signature', 'The identity provider returned an undecodable id_token');
  }
  return { header, claims, signingInput: `${h}.${p}`, signature: Buffer.from(s, 'base64url') };
}

/** Picks the JWKS entry a token names, by `kid` when it has one. */
export function selectKey(keys: Jwk[], header: JwtHeader): Jwk {
  const usable = keys.filter((k) => k.use === undefined || k.use === 'sig');
  const byKid = header.kid ? usable.find((k) => k.kid === header.kid) : undefined;
  if (byKid) return byKid;
  if (header.kid) {
    throw new SsoError(
      'signature',
      `The identity provider signed with key '${header.kid}', which is not in its published JWKS`,
    );
  }
  if (usable.length === 1) return usable[0]!;
  throw new SsoError(
    'signature',
    'The id_token names no key id and the provider publishes more than one signing key',
  );
}

/**
 * Verifies the signature over `header.payload` with the published key.
 *
 * The algorithm is taken from the TOKEN header but only after being checked
 * against `ACCEPTED_ALGS` and against the key's own `alg` when it declares
 * one, so a forged header cannot talk this function into a weaker primitive.
 */
export function verifyIdTokenSignature(parsed: ParsedJwt, jwk: Jwk): void {
  const alg = parsed.header.alg;
  if (!alg || !ACCEPTED_ALGS.has(alg)) {
    throw new SsoError(
      'signature',
      `id_token algorithm '${alg ?? 'none'}' is not accepted — this platform requires an ` +
        'asymmetric signature (RS*, PS* or ES*)',
    );
  }
  if (typeof jwk.alg === 'string' && jwk.alg !== alg) {
    throw new SsoError(
      'signature',
      `id_token is signed with '${alg}' but the published key is for '${jwk.alg}'`,
    );
  }

  let key: crypto.KeyObject;
  try {
    key = crypto.createPublicKey({ key: jwk as crypto.JsonWebKey, format: 'jwk' });
  } catch {
    throw new SsoError('signature', 'The published signing key could not be read as a public key');
  }

  const digest = `sha${alg.slice(2)}`;
  const options: crypto.VerifyKeyObjectInput = { key };
  if (alg.startsWith('PS')) {
    options.padding = crypto.constants.RSA_PKCS1_PSS_PADDING;
    options.saltLength = crypto.constants.RSA_PSS_SALTLEN_DIGEST;
  }
  if (alg.startsWith('ES')) {
    // JOSE puts ECDSA signatures on the wire as raw r‖s; Node reads DER unless
    // told otherwise, and would reject every valid token without this.
    options.dsaEncoding = 'ieee-p1363';
  }

  const ok = crypto.verify(
    digest,
    Buffer.from(parsed.signingInput, 'ascii'),
    options,
    parsed.signature,
  );
  if (!ok) {
    throw new SsoError(
      'signature',
      'The id_token signature does not verify against the provider JWKS',
    );
  }
}

export interface ClaimExpectations {
  issuer: string;
  clientId: string;
  nonce: string;
  now?: Date;
}

/** Issuer, audience, expiry and nonce — the checks that make a token OURS. */
export function verifyIdTokenClaims(claims: IdTokenClaims, expect: ClaimExpectations): void {
  const nowSeconds = Math.floor((expect.now ?? new Date()).getTime() / 1000);

  if (claims.iss !== expect.issuer) {
    throw new SsoError(
      'claims',
      'The id_token issuer does not match the issuer configured for this tenant',
    );
  }

  const audiences = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
  if (!audiences.includes(expect.clientId)) {
    throw new SsoError('claims', 'The id_token was not issued for this tenant’s client id');
  }

  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SECONDS < nowSeconds) {
    throw new SsoError('claims', 'The id_token has expired');
  }
  if (typeof claims.iat === 'number' && claims.iat - CLOCK_SKEW_SECONDS > nowSeconds) {
    throw new SsoError('claims', 'The id_token is dated in the future — check the clocks');
  }

  // The nonce is what ties this token to the login THIS browser started. A
  // token replayed from another session verifies perfectly and fails here.
  if (typeof claims.nonce !== 'string' || !timingSafeEquals(claims.nonce, expect.nonce)) {
    throw new SsoError('nonce', 'The id_token nonce does not match the login it is answering');
  }
}

/** Constant-time comparison over fixed-width digests. */
export function timingSafeEquals(a: string, b: string): boolean {
  const l = crypto.createHash('sha256').update(a, 'utf8').digest();
  const r = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(l, r);
}

/**
 * The email the token asserts, checked against what this provider is ALLOWED
 * to assert. An IdP that may assert any address may assert the tenant owner's
 * (docs/31 §1), so an empty allow-list is a refusal, not a wildcard.
 */
export function assertAllowedEmail(claims: IdTokenClaims, allowedDomains: string[]): string {
  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
  if (!email || !email.includes('@')) {
    throw new SsoError('claims', 'The id_token carries no email claim, so nobody can be resolved');
  }
  if (claims.email_verified === false) {
    throw new SsoError('claims', 'The identity provider says this email address is not verified');
  }
  const domain = email.slice(email.lastIndexOf('@') + 1);
  const allowed = allowedDomains.map((d) => d.trim().toLowerCase()).filter(Boolean);
  if (allowed.length === 0) {
    throw new SsoError(
      'domain',
      'This provider has no allowed email domains configured, so it may assert nobody',
    );
  }
  if (!allowed.includes(domain)) {
    throw new SsoError(
      'domain',
      `'${domain}' is not one of the email domains this provider is allowed to assert`,
    );
  }
  return email;
}

/** `S256` code challenge for a verifier (RFC 7636). */
export function codeChallengeFor(verifier: string): string {
  return crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/**
 * The PKCE verifier for a login, DERIVED from its state.
 *
 * The schema stores `code_challenge`, and a challenge is one-way — the token
 * exchange needs the verifier back. Rather than storing the verifier in a
 * column named for the challenge (a lie that would outlive this sprint), it is
 * an HMAC of the state under a server key: reproducible at the callback,
 * absent from the database, and useless to anybody who reads the row.
 */
export function verifierFor(state: string, rootKey: string): string {
  return crypto
    .createHmac('sha256', rootKey)
    .update(`aviora.sso.pkce.v1:${state}`)
    .digest('base64url');
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

/**
 * Where the browser may be sent after a successful login. Only a path on this
 * site: an open redirect on the login route is how a phishing page borrows the
 * platform's domain.
 */
export function safeRedirectPath(raw: string | undefined, fallback = '/'): string {
  if (!raw) return fallback;
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return fallback;
  return raw.slice(0, 512);
}
