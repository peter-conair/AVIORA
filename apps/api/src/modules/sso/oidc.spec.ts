import * as crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  assertAllowedEmail,
  codeChallengeFor,
  parseJwt,
  safeRedirectPath,
  selectKey,
  SsoError,
  verifierFor,
  verifyIdTokenClaims,
  verifyIdTokenSignature,
  type Jwk,
} from './oidc';

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK = { ...(publicKey.export({ format: 'jwk' }) as Jwk), kid: 'k1', alg: 'RS256' };

function sign(claims: object, header: object = { alg: 'RS256', kid: 'k1' }): string {
  const h = Buffer.from(JSON.stringify(header)).toString('base64url');
  const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const sig = crypto.sign('sha256', Buffer.from(`${h}.${p}`, 'ascii'), privateKey);
  return `${h}.${p}.${sig.toString('base64url')}`;
}

const BASE_CLAIMS = {
  iss: 'https://idp.example.com',
  aud: 'client-abc',
  sub: 'user-1',
  nonce: 'nonce-1',
  email: 'someone@example.com',
  exp: Math.floor(Date.now() / 1000) + 300,
  iat: Math.floor(Date.now() / 1000),
};

const EXPECT = { issuer: 'https://idp.example.com', clientId: 'client-abc', nonce: 'nonce-1' };

describe('id_token signature', () => {
  it('accepts a token signed by the published key', () => {
    expect(() => verifyIdTokenSignature(parseJwt(sign(BASE_CLAIMS)), JWK)).not.toThrow();
  });

  it('refuses a token whose payload was edited after signing', () => {
    const token = sign(BASE_CLAIMS);
    const [h, , s] = token.split('.');
    const tampered = Buffer.from(
      JSON.stringify({ ...BASE_CLAIMS, email: 'owner@example.com' }),
    ).toString('base64url');
    expect(() => verifyIdTokenSignature(parseJwt(`${h}.${tampered}.${s}`), JWK)).toThrow(SsoError);
  });

  it('refuses alg:none, whatever the header claims', () => {
    const h = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
    const p = Buffer.from(JSON.stringify(BASE_CLAIMS)).toString('base64url');
    expect(() => verifyIdTokenSignature(parseJwt(`${h}.${p}.`), JWK)).toThrow(/not accepted/);
  });

  it('refuses HS256 — a symmetric alg verified against a published key', () => {
    const token = sign(BASE_CLAIMS, { alg: 'HS256', kid: 'k1' });
    expect(() => verifyIdTokenSignature(parseJwt(token), JWK)).toThrow(/not accepted/);
  });

  it('refuses a key id the provider does not publish', () => {
    expect(() => selectKey([JWK], { alg: 'RS256', kid: 'rotated-away' })).toThrow(
      /not in its published JWKS/,
    );
  });
});

describe('id_token claims', () => {
  it('accepts the expected issuer, audience, expiry and nonce', () => {
    expect(() => verifyIdTokenClaims(BASE_CLAIMS, EXPECT)).not.toThrow();
  });

  it('refuses a token minted for another client', () => {
    expect(() => verifyIdTokenClaims({ ...BASE_CLAIMS, aud: 'someone-else' }, EXPECT)).toThrow(
      /client id/,
    );
  });

  it('refuses an expired token', () => {
    const exp = Math.floor(Date.now() / 1000) - 3600;
    expect(() => verifyIdTokenClaims({ ...BASE_CLAIMS, exp }, EXPECT)).toThrow(/expired/);
  });

  it('refuses a nonce from a different login, and says the step was the nonce', () => {
    try {
      verifyIdTokenClaims({ ...BASE_CLAIMS, nonce: 'somebody-elses' }, EXPECT);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(SsoError);
      expect((e as SsoError).step).toBe('nonce');
    }
  });
});

describe('allowed domains', () => {
  it('accepts an address in the list', () => {
    expect(assertAllowedEmail(BASE_CLAIMS, ['example.com'])).toBe('someone@example.com');
  });

  it('refuses an address outside it', () => {
    expect(() => assertAllowedEmail(BASE_CLAIMS, ['other.com'])).toThrow(
      /not one of the email domains/,
    );
  });

  it('treats an empty list as "may assert nobody", not as a wildcard', () => {
    try {
      assertAllowedEmail(BASE_CLAIMS, []);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as SsoError).step).toBe('domain');
    }
  });

  it('refuses an address the provider itself says is unverified', () => {
    expect(() =>
      assertAllowedEmail({ ...BASE_CLAIMS, email_verified: false }, ['example.com']),
    ).toThrow(/not verified/);
  });
});

describe('PKCE and redirects', () => {
  it('derives the same verifier for a state and a different one for another', () => {
    expect(verifierFor('state-a', 'key')).toBe(verifierFor('state-a', 'key'));
    expect(verifierFor('state-a', 'key')).not.toBe(verifierFor('state-b', 'key'));
  });

  it('produces an S256 challenge that does not reveal the verifier', () => {
    const verifier = verifierFor('state-a', 'key');
    expect(codeChallengeFor(verifier)).not.toContain(verifier);
    expect(codeChallengeFor(verifier)).toHaveLength(43);
  });

  it('refuses to send a browser off-site after login', () => {
    expect(safeRedirectPath('https://evil.example/steal')).toBe('/');
    expect(safeRedirectPath('//evil.example')).toBe('/');
    expect(safeRedirectPath('/dashboard')).toBe('/dashboard');
  });
});
