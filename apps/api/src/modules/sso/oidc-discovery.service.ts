import * as dns from 'node:dns/promises';
import * as net from 'node:net';
import { Injectable, Logger } from '@nestjs/common';
import {
  discoveryDocumentSchema,
  jwksSchema,
  selectKey,
  SsoError,
  type DiscoveryDocument,
  type Jwk,
  type JwtHeader,
} from './oidc';

const CACHE_TTL_MS = 15 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;
const MAX_BODY_BYTES = 512 * 1024;
/** A JWKS is re-fetched at most this often when a token names an unknown key. */
const JWKS_REFETCH_MIN_INTERVAL_MS = 60 * 1000;

interface CacheEntry<T> {
  value: T;
  fetchedAt: number;
}

/**
 * The discovery document and JWKS of a tenant's identity provider (docs/31 §1).
 *
 * Cached because both are fetched on every single login otherwise, and an IdP
 * that rate-limits its own metadata endpoint would take a tenant's sign-in
 * down with it. Cached with a TTL rather than forever because key rotation is
 * normal and expected: when a token names a key that is not in the cached set,
 * the JWKS is re-fetched once (rate-limited, so an attacker cannot use unknown
 * kids to make this server hammer somebody).
 */
@Injectable()
export class OidcDiscoveryService {
  private readonly logger = new Logger(OidcDiscoveryService.name);
  private readonly documents = new Map<string, CacheEntry<DiscoveryDocument>>();
  private readonly jwks = new Map<string, CacheEntry<Jwk[]>>();

  async document(discoveryUrl: string): Promise<DiscoveryDocument> {
    const cached = this.documents.get(discoveryUrl);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.value;

    const body = await this.getJson(discoveryUrl, 'discovery');
    const parsed = discoveryDocumentSchema.safeParse(body);
    if (!parsed.success) {
      throw new SsoError(
        'discovery',
        'The provider discovery document is missing required endpoints ' +
          '(issuer, authorization_endpoint, token_endpoint, jwks_uri)',
      );
    }
    this.documents.set(discoveryUrl, { value: parsed.data, fetchedAt: Date.now() });
    return parsed.data;
  }

  /** The signing key a token names, re-fetching once if the cache does not have it. */
  async signingKey(jwksUri: string, header: JwtHeader): Promise<Jwk> {
    const cached = this.jwks.get(jwksUri);
    const fresh = cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS;
    if (fresh) {
      try {
        return selectKey(cached.value, header);
      } catch (e) {
        // Only an unknown kid justifies going back to the provider, and only
        // if we have not just done so.
        if (Date.now() - cached.fetchedAt < JWKS_REFETCH_MIN_INTERVAL_MS) throw e;
      }
    }
    const keys = await this.fetchJwks(jwksUri);
    return selectKey(keys, header);
  }

  private async fetchJwks(jwksUri: string): Promise<Jwk[]> {
    const body = await this.getJson(jwksUri, 'discovery');
    const parsed = jwksSchema.safeParse(body);
    if (!parsed.success || parsed.data.keys.length === 0) {
      throw new SsoError('discovery', 'The provider published no usable signing keys');
    }
    const keys = parsed.data.keys as Jwk[];
    this.jwks.set(jwksUri, { value: keys, fetchedAt: Date.now() });
    return keys;
  }

  /** Drops what is cached for one provider — used when its configuration changes. */
  forget(discoveryUrl: string): void {
    const doc = this.documents.get(discoveryUrl);
    if (doc) this.jwks.delete(doc.value.jwks_uri);
    this.documents.delete(discoveryUrl);
  }

  private async getJson(url: string, step: 'discovery'): Promise<unknown> {
    await assertFetchableUrl(url);
    let res: Response;
    try {
      res = await fetch(url, {
        redirect: 'error',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (e) {
      // The reason is safe to surface — it is about OUR request to a URL the
      // tenant's own administrator configured, and carries no token material.
      throw new SsoError(
        step,
        `Could not reach the identity provider at ${url}: ${e instanceof Error ? e.message : 'request failed'}`,
      );
    }
    if (!res.ok) {
      throw new SsoError(step, `The identity provider answered ${res.status} for ${url}`);
    }
    const text = await readCapped(res);
    try {
      return JSON.parse(text);
    } catch {
      throw new SsoError(step, `The identity provider did not return JSON for ${url}`);
    }
  }
}

async function readCapped(res: Response): Promise<string> {
  const text = await res.text();
  if (text.length > MAX_BODY_BYTES) {
    throw new SsoError('discovery', 'The identity provider returned an implausibly large document');
  }
  return text;
}

const PRIVATE_V4 =
  /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

/**
 * Refuses to fetch a URL that resolves inside the network this server sits in.
 *
 * The discovery URL is supplied by a tenant administrator and fetched BY THE
 * SERVER, which is the definition of SSRF: without this, `tenant.sso.manage`
 * is a permission to make the API issue requests to its own cloud metadata
 * service. The https requirement is enforced by a CHECK constraint on the
 * column as well, so it holds even for a row written outside this code.
 *
 * One carve-out, and only one: **loopback outside production**. A test or a
 * development machine runs its fake identity provider on `127.0.0.1`, and
 * loopback is this process's own machine rather than the private network the
 * attack reaches for — RFC-1918 ranges and the link-local metadata address
 * stay refused everywhere, production or not. In production loopback is
 * refused too, because there an admin panel on localhost is exactly the thing
 * somebody would aim this at.
 *
 * `AVIORA_SSO_ALLOW_PRIVATE_ISSUER=true` lifts the check entirely. It exists
 * for a deployment whose IdP genuinely is on a private address, and it must be
 * a deliberate decision rather than a default.
 */
export async function assertFetchableUrl(raw: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsoError('configuration', 'The provider URL is not a URL');
  }
  if (url.protocol !== 'https:') {
    throw new SsoError(
      'configuration',
      'A provider URL must be https — a login flow in the clear is one somebody can stand in the middle of',
    );
  }
  if (process.env.AVIORA_SSO_ALLOW_PRIVATE_ISSUER === 'true') return;

  const loopbackAllowed = process.env.NODE_ENV !== 'production';
  const host = url.hostname;
  const literals = net.isIP(host) ? [host] : await resolveOrThrow(host);
  for (const address of literals) {
    if (loopbackAllowed && isLoopbackAddress(address)) continue;
    if (isPrivateAddress(address)) {
      throw new SsoError(
        'configuration',
        `The provider URL resolves to ${address}, which is inside this server's own network`,
      );
    }
  }
}

function isLoopbackAddress(address: string): boolean {
  if (net.isIPv4(address)) return address.startsWith('127.');
  const v6 = address.toLowerCase();
  if (v6 === '::1') return true;
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? mapped[1]!.startsWith('127.') : false;
}

async function resolveOrThrow(host: string): Promise<string[]> {
  try {
    const records = await dns.lookup(host, { all: true });
    return records.map((r) => r.address);
  } catch {
    throw new SsoError('discovery', `The provider hostname ${host} does not resolve`);
  }
}

function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) return PRIVATE_V4.test(address);
  const v6 = address.toLowerCase();
  if (v6 === '::1' || v6 === '::') return true;
  if (v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80')) return true;
  // IPv4-mapped (::ffff:10.0.0.1) hides a private v4 address inside a v6 one.
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? PRIVATE_V4.test(mapped[1]!) : false;
}
