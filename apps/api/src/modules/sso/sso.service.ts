import * as crypto from 'node:crypto';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { ERROR_CODES, EVENTS } from '@aviora/shared';
import { appendEvent, withTenant, type PrismaClient, type Tx } from '@aviora/db';
import { AuditService } from '../../common/audit/audit.service';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { PrismaService } from '../../common/db/prisma.service';
import { TenantDb } from '../../common/db/tenant-db.service';
import { TenantDatabaseResolver } from '../../common/db/tenant-database.resolver';
import { AuthService, type SafeUser } from '../identity/auth.service';
import { OidcDiscoveryService } from './oidc-discovery.service';
import {
  assertAllowedEmail,
  codeChallengeFor,
  LOGIN_TTL_MS,
  parseJwt,
  randomToken,
  safeRedirectPath,
  SsoError,
  verifierFor,
  verifyIdTokenClaims,
  verifyIdTokenSignature,
  type IdTokenClaims,
} from './oidc';
import type { SsoProviderView, SsoUpsert } from './sso';

/** The system role a JIT-provisioned person gets, and the only one they get. */
const DEFAULT_ROLE_CODE = 'MEMBER';

const PROVIDER_VIEW_SELECT = {
  kind: true,
  issuer: true,
  discoveryUrl: true,
  clientId: true,
  clientSecretEncrypted: true,
  allowedDomains: true,
  jitProvisioning: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} as const;

export interface SsoStartResult {
  authorizationUrl: string;
}

export interface SsoCallbackResult {
  user: SafeUser;
  tenantId: string;
  redirectTo: string;
  provisioned: boolean;
}

/**
 * Enterprise SSO (docs/31 §1).
 *
 * Two rules shape everything in this file:
 *
 * 1. **A federated login authenticates; it never authorises.** The IdP says
 *    who somebody is. What they may do comes from the tenant's own roles. No
 *    claim is read as a permission, a role or a scope anywhere below — group
 *    and role claims are written to `sso_logins.claims` for an administrator
 *    to look at and are never consulted again. There is no flag that changes
 *    this, because a flag would be an unaudited path to a permission grant.
 * 2. **The flow ends by issuing the platform's OWN session**, through the same
 *    `AuthService.issueTokens` that password login uses. Nothing downstream
 *    trusts the IdP, or knows it was involved.
 */
@Injectable()
export class SsoService {
  private readonly logger = new Logger(SsoService.name);

  constructor(
    private readonly db: TenantDb,
    private readonly prisma: PrismaService,
    private readonly router: TenantDatabaseResolver,
    private readonly discovery: OidcDiscoveryService,
    private readonly secrets: FieldEncryptionService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------- config

  async get(): Promise<SsoProviderView | null> {
    const row = await this.db.tx((tx) =>
      tx.tenantIdentityProvider.findFirst({ select: PROVIDER_VIEW_SELECT }),
    );
    return row ? view(row) : null;
  }

  /**
   * Upsert. The secret is sealed on the way in and never comes back out: no
   * method on this class returns it and no route exposes one that could.
   */
  async upsert(input: SsoUpsert): Promise<SsoProviderView> {
    const tenantId = this.db.tenantId;
    const sealed = input.clientSecret ? this.secrets.encrypt(input.clientSecret) : null;

    const row = await this.db.tx(async (tx) => {
      const existing = await tx.tenantIdentityProvider.findFirst({ select: { id: true } });
      if (!existing && !sealed) {
        throw new SsoError(
          'configuration',
          'A client secret is required the first time a provider is configured',
        );
      }
      const data = {
        kind: input.kind,
        issuer: input.issuer,
        discoveryUrl: input.discoveryUrl,
        clientId: input.clientId,
        allowedDomains: input.allowedDomains,
        jitProvisioning: input.jitProvisioning,
        status: input.status,
      };
      if (existing) {
        return tx.tenantIdentityProvider.update({
          where: { id: existing.id },
          data: sealed ? { ...data, clientSecretEncrypted: sealed } : data,
          select: PROVIDER_VIEW_SELECT,
        });
      }
      return tx.tenantIdentityProvider.create({
        data: { ...data, tenantId, clientSecretEncrypted: sealed! },
        select: PROVIDER_VIEW_SELECT,
      });
    });

    // Metadata is cached; a changed discovery URL must not keep serving the
    // old provider's endpoints and keys.
    this.discovery.forget(row.discoveryUrl);

    await this.audit.record({
      action: 'tenant.sso.upsert',
      entityType: 'tenant_identity_provider',
      // No secret, sealed or otherwise, in the audit record either.
      after: {
        issuer: row.issuer,
        discoveryUrl: row.discoveryUrl,
        clientId: row.clientId,
        allowedDomains: row.allowedDomains,
        jitProvisioning: row.jitProvisioning,
        status: row.status,
        clientSecretChanged: sealed !== null,
      },
    });
    return view(row);
  }

  /** Federation off. Local sign-in is untouched (docs/31 §4). */
  async remove(): Promise<void> {
    const removed = await this.db.tx(async (tx) => {
      const existing = await tx.tenantIdentityProvider.findFirst({
        select: { id: true, discoveryUrl: true, issuer: true },
      });
      if (!existing) return null;
      // Started logins reference the provider; a half-finished login must not
      // survive its provider being deleted.
      await tx.ssoLogin.deleteMany({ where: { providerId: existing.id } });
      await tx.tenantIdentityProvider.delete({ where: { id: existing.id } });
      return existing;
    });
    if (!removed) {
      throw new NotFoundException({
        code: ERROR_CODES.NOT_FOUND,
        message: 'This workspace has no identity provider configured',
      });
    }
    this.discovery.forget(removed.discoveryUrl);
    await this.audit.record({
      action: 'tenant.sso.delete',
      entityType: 'tenant_identity_provider',
      before: { issuer: removed.issuer },
    });
  }

  // ----------------------------------------------------------------- login

  /**
   * Step 1: mint a single-use state + nonce + PKCE pair and send the browser on.
   *
   * `requestOrigin` is the fallback for `redirect_uri` when nothing is
   * configured — see `redirectUri()`.
   */
  async start(
    tenantSlug: string,
    redirectTo: string | undefined,
    requestOrigin?: string,
  ): Promise<SsoStartResult> {
    const tenant = await this.prisma.owner.tenant.findUnique({
      where: { slug: tenantSlug },
      select: { id: true, status: true },
    });
    if (!tenant || tenant.status !== 'active') {
      throw new SsoError('configuration', 'No active workspace with that address');
    }

    const provider = await this.loadProvider(tenant.id);
    const document = await this.discovery.document(provider.discoveryUrl);

    const state = randomToken(32);
    const nonce = randomToken(32);
    const verifier = verifierFor(state, rootKey());

    await withTenant(this.clientFor(tenant.id), tenant.id, (tx) =>
      tx.ssoLogin.create({
        data: {
          tenantId: tenant.id,
          providerId: provider.id,
          state,
          nonce,
          codeChallenge: codeChallengeFor(verifier),
          redirectTo: safeRedirectPath(redirectTo),
          expiresAt: new Date(Date.now() + LOGIN_TTL_MS),
        },
        select: { id: true },
      }),
    );

    const url = new URL(document.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', provider.clientId);
    url.searchParams.set('redirect_uri', redirectUri(requestOrigin));
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('code_challenge', codeChallengeFor(verifier));
    url.searchParams.set('code_challenge_method', 'S256');
    return { authorizationUrl: url.toString() };
  }

  /**
   * Step 2: verify what came back and turn it into one of our sessions.
   *
   * The state row is consumed with a conditional UPDATE before anything else
   * happens, so two callbacks carrying the same code race for one row and
   * exactly one of them wins. An authorisation code that can be redeemed twice
   * is an account that can be taken over twice (docs/31 §1).
   */
  async callback(state: string, code: string, requestOrigin?: string): Promise<SsoCallbackResult> {
    const login = await this.prisma.owner.ssoLogin.findUnique({ where: { state } });
    if (!login) {
      throw new SsoError('state', 'This sign-in link is not one this server issued');
    }
    if (login.consumedAt) {
      throw new SsoError('state', 'This sign-in has already been completed and cannot be replayed');
    }
    if (login.expiresAt < new Date()) {
      throw new SsoError('state', 'This sign-in took too long and has expired — start again');
    }

    const claimed = await this.prisma.owner.ssoLogin.updateMany({
      where: { id: login.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (claimed.count !== 1) {
      throw new SsoError('state', 'This sign-in has already been completed and cannot be replayed');
    }

    const provider = await this.loadProvider(login.tenantId);
    if (provider.id !== login.providerId) {
      throw new SsoError(
        'configuration',
        'The workspace identity provider changed after this sign-in started — start again',
      );
    }
    const document = await this.discovery.document(provider.discoveryUrl);

    const idToken = await this.exchangeCode(document.token_endpoint, provider, {
      code,
      verifier: verifierFor(state, rootKey()),
      requestOrigin,
    });

    const parsed = parseJwt(idToken);
    const jwk = await this.discovery.signingKey(document.jwks_uri, parsed.header);
    verifyIdTokenSignature(parsed, jwk);
    // The configured issuer and the discovered one must agree BEFORE the token
    // is judged against either: a discovery document served from a compromised
    // host would otherwise be able to nominate its own issuer.
    if (document.issuer !== provider.issuer) {
      throw new SsoError(
        'configuration',
        'The provider discovery document declares an issuer different from the configured one',
      );
    }
    verifyIdTokenClaims(parsed.claims, {
      issuer: provider.issuer,
      clientId: provider.clientId,
      nonce: login.nonce,
    });

    const email = assertAllowedEmail(parsed.claims, provider.allowedDomains);

    // Recorded, surfaced, never applied (docs/31 §5). Nothing reads this back
    // to decide anything.
    await this.prisma.owner.ssoLogin.update({
      where: { id: login.id },
      data: { claims: recordableClaims(parsed.claims) as object },
    });

    const resolved = await this.resolveMember(login.tenantId, provider.jitProvisioning, {
      email,
      displayName: displayNameFrom(parsed.claims, email),
    });

    await this.audit.record({
      action: resolved.provisioned ? 'auth.sso.provision' : 'auth.sso.login',
      entityType: 'member',
      entityId: resolved.memberId,
      tenantId: login.tenantId,
      after: { email, issuer: provider.issuer, jit: resolved.provisioned },
    });

    return {
      user: resolved.user,
      tenantId: login.tenantId,
      redirectTo: safeRedirectPath(login.redirectTo ?? undefined),
      provisioned: resolved.provisioned,
    };
  }

  // -------------------------------------------------------------- internals

  private clientFor(tenantId: string): PrismaClient {
    // The single routing seam again (docs/31 §2). `null` — every tenant today
    // — means the shared database, which is where the owner client points.
    return this.router.clientFor(tenantId) ?? this.prisma.owner;
  }

  private async loadProvider(tenantId: string) {
    const provider = await withTenant(this.clientFor(tenantId), tenantId, (tx) =>
      tx.tenantIdentityProvider.findFirst(),
    );
    if (!provider) {
      throw new SsoError('configuration', 'This workspace has no identity provider configured');
    }
    if (provider.status !== 'active') {
      throw new SsoError('configuration', 'Single sign-on is disabled for this workspace');
    }
    if (provider.kind !== 'oidc') {
      throw new SsoError(
        'configuration',
        `'${provider.kind}' is not a protocol this platform speaks — OIDC only (docs/31 §5)`,
      );
    }
    return provider;
  }

  /** The authorization-code exchange. The response never reaches a log. */
  private async exchangeCode(
    tokenEndpoint: string,
    provider: { clientId: string; clientSecretEncrypted: string },
    input: { code: string; verifier: string; requestOrigin?: string },
  ): Promise<string> {
    const secret = this.secrets.decrypt(provider.clientSecretEncrypted);
    if (!secret) {
      throw new SsoError(
        'configuration',
        'The stored client secret cannot be read — re-enter it in the SSO settings',
      );
    }

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: redirectUri(input.requestOrigin),
      client_id: provider.clientId,
      client_secret: secret,
      code_verifier: input.verifier,
    });

    let res: Response;
    try {
      res = await fetch(tokenEndpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body,
        signal: AbortSignal.timeout(8_000),
      });
    } catch (e) {
      throw new SsoError(
        'token_exchange',
        `Could not reach the identity provider's token endpoint: ${e instanceof Error ? e.message : 'request failed'}`,
      );
    }

    // The status is safe to name; the body is not. An error body from a token
    // endpoint routinely echoes the code, and sometimes more.
    if (!res.ok) {
      this.logger.warn(`SSO token exchange refused with ${res.status}`);
      throw new SsoError(
        'token_exchange',
        `The identity provider refused the authorization code (HTTP ${res.status})`,
      );
    }

    let payload: { id_token?: unknown };
    try {
      payload = (await res.json()) as { id_token?: unknown };
    } catch {
      throw new SsoError('token_exchange', 'The token endpoint did not return JSON');
    }
    if (typeof payload.id_token !== 'string' || payload.id_token.length === 0) {
      throw new SsoError('token_exchange', 'The token response carried no id_token');
    }
    return payload.id_token;
  }

  /**
   * Resolve the person, or provision them if the tenant allows it.
   *
   * JIT creates a MEMBER and nothing more (docs/31 §1). Not a leader, not an
   * administrator, and not whatever an IdP group claim happens to say: a
   * person who has never been invited arriving with a valid token is a member.
   */
  private async resolveMember(
    tenantId: string,
    jitProvisioning: boolean,
    person: { email: string; displayName: string },
  ): Promise<{ user: SafeUser; memberId: string; provisioned: boolean }> {
    const existingUser = await this.prisma.owner.user.findUnique({
      where: { email: person.email },
    });
    if (existingUser && existingUser.status !== 'active') {
      throw new SsoError('provisioning', 'This account is not active on the platform');
    }

    const existingMember = existingUser
      ? await withTenant(this.clientFor(tenantId), tenantId, (tx) =>
          tx.member.findFirst({
            where: { userId: existingUser.id },
            select: { id: true, status: true },
          }),
        )
      : null;

    if (existingMember && existingMember.status === 'active') {
      const user = await this.touchLogin(existingUser!.id);
      return { user, memberId: existingMember.id, provisioned: false };
    }
    if (existingMember) {
      throw new SsoError(
        'provisioning',
        'This person is no longer an active member of this workspace',
      );
    }
    if (!jitProvisioning) {
      throw new SsoError(
        'provisioning',
        'This person has no membership here and just-in-time provisioning is off — ' +
          'invite them first',
      );
    }

    const created = await this.provision(tenantId, person, existingUser?.id ?? null);
    const user = await this.touchLogin(created.userId);
    return { user, memberId: created.memberId, provisioned: true };
  }

  private async provision(
    tenantId: string,
    person: { email: string; displayName: string },
    knownUserId: string | null,
  ): Promise<{ userId: string; memberId: string }> {
    /**
     * A federated account has no password on this platform. Rather than a
     * nullable column or a sentinel string, it gets a hash of random bytes
     * nobody holds: `validateCredentials` then behaves exactly as it does for
     * any wrong password, with no special case to get wrong later.
     */
    const unusablePassword = knownUserId
      ? null
      : await argon2.hash(crypto.randomBytes(48).toString('base64'), { type: argon2.argon2id });

    return withTenant(this.clientFor(tenantId), tenantId, async (tx) => {
      const userId = knownUserId ?? (await createFederatedUser(tx, person, unusablePassword!));

      const existingTenantMembership = await tx.tenantMembership.findFirst({ where: { userId } });
      if (!existingTenantMembership) {
        await tx.tenantMembership.create({ data: { tenantId, userId } });
      }

      const member = await tx.member.create({
        data: { tenantId, userId, displayName: person.displayName },
        select: { id: true },
      });

      const role = await tx.role.findFirst({
        where: { code: DEFAULT_ROLE_CODE },
        select: { id: true },
      });
      if (!role) {
        throw new SsoError(
          'provisioning',
          `This workspace has no '${DEFAULT_ROLE_CODE}' role, so there is no default role to ` +
            'grant. Provisioning refuses rather than inventing one.',
        );
      }
      await tx.memberRole.create({ data: { tenantId, memberId: member.id, roleId: role.id } });

      await appendEvent(tx, {
        eventName: EVENTS.MemberRegistered,
        tenantId,
        aggregateType: 'member',
        aggregateId: member.id,
        actorUserId: userId,
        payload: {
          email: person.email,
          displayName: person.displayName,
          memberId: member.id,
          via: 'sso',
        },
      });

      return { userId, memberId: member.id };
    });
  }

  /** Same bookkeeping password login does, so both look alike in the data. */
  private async touchLogin(userId: string): Promise<SafeUser> {
    const user = await this.prisma.owner.user.update({
      where: { id: userId },
      data: { lastLoginAt: new Date() },
    });
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      locale: user.locale,
      platformRole: user.platformRole,
    };
  }
}

async function createFederatedUser(
  tx: Tx,
  person: { email: string; displayName: string },
  passwordHash: string,
): Promise<string> {
  const user = await tx.user.create({
    data: { email: person.email, passwordHash, displayName: person.displayName },
    select: { id: true },
  });
  return user.id;
}

function view(row: {
  kind: string;
  issuer: string;
  discoveryUrl: string;
  clientId: string;
  clientSecretEncrypted: string;
  allowedDomains: string[];
  jitProvisioning: boolean;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}): SsoProviderView {
  return {
    kind: row.kind,
    issuer: row.issuer,
    discoveryUrl: row.discoveryUrl,
    clientId: row.clientId,
    // The one thing said about the secret is whether there is one.
    hasClientSecret: row.clientSecretEncrypted.length > 0,
    allowedDomains: row.allowedDomains,
    jitProvisioning: row.jitProvisioning,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * What gets written to `sso_logins.claims`.
 *
 * The whole claim set minus the parts that are credentials rather than
 * assertions: `at_hash`/`c_hash` bind to tokens, and nothing about the raw
 * token is stored at all. Group and role claims are kept deliberately — they
 * are the reason the column exists — and are read by nobody.
 */
function recordableClaims(claims: IdTokenClaims): Record<string, unknown> {
  const { at_hash: _a, c_hash: _c, s_hash: _s, ...rest } = claims;
  return rest;
}

function displayNameFrom(claims: IdTokenClaims, email: string): string {
  const name = typeof claims.name === 'string' ? claims.name.trim() : '';
  if (name) return name.slice(0, 120);
  const given = typeof claims.given_name === 'string' ? claims.given_name.trim() : '';
  const family = typeof claims.family_name === 'string' ? claims.family_name.trim() : '';
  const joined = [given, family].filter(Boolean).join(' ');
  return (joined || email.slice(0, email.indexOf('@'))).slice(0, 120);
}

/**
 * Where the IdP sends the browser back.
 *
 * `AVIORA_SSO_REDIRECT_URI` first, then `AVIORA_API_URL`, and only then the
 * origin of the request being served. Configured wins because a redirect_uri
 * read from the request is a redirect_uri whose host an attacker chooses with
 * a `Host` header — the identity provider's own registered-URI check is what
 * stops that becoming an open redirect, and relying on somebody else's check
 * is not a design. The fallback exists so a development or test deployment
 * that has configured nothing still completes a login against a provider on
 * the same host.
 *
 * Start and callback compute this the SAME way and must agree: the token
 * endpoint compares the `redirect_uri` presented at exchange with the one in
 * the authorize request, and a mismatch is refused by the provider.
 */
function redirectUri(requestOrigin?: string): string {
  const explicit = process.env.AVIORA_SSO_REDIRECT_URI;
  if (explicit) return explicit;
  const base = process.env.AVIORA_API_URL ?? requestOrigin;
  if (base) return `${base.replace(/\/$/, '')}/auth/sso/callback`;
  throw new SsoError(
    'configuration',
    'AVIORA_SSO_REDIRECT_URI is not configured and this request carries no origin, so this ' +
      'server cannot tell an identity provider where to send people back to',
  );
}

/** Root key the PKCE verifier is derived from. Never stored, never sent. */
function rootKey(): string {
  const key = process.env.AVIORA_SSO_SIGNING_KEY ?? process.env.AVIORA_JWT_ACCESS_SECRET;
  if (!key) {
    throw new SsoError(
      'configuration',
      'AVIORA_SSO_SIGNING_KEY (or AVIORA_JWT_ACCESS_SECRET) is not configured; refusing to ' +
        'start a login whose PKCE verifier would not be secret',
    );
  }
  return key;
}
