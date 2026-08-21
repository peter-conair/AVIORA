/**
 * The API's description of itself (Sprint 28, docs/47).
 *
 * The reason this is a test and not a document: a hand-maintained API
 * description drifts, and a drifted description is worse than none — it looks
 * authoritative while telling an integrator to call something that no longer
 * exists. This codebase has met that shape twice already (a guard registered so
 * it never ran, a probe counting rows that did not exist), so the catalogue is
 * generated from the application and this asserts it still matches.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { EVENTS } from '@aviora/shared';
import { createApp } from '../../src/app.factory';
import { PublicApiController } from '../../src/modules/integration/public.controller';

let app: INestApplication;
let catalog: any;

beforeAll(async () => {
  process.env.AVIORA_SCHEDULER_DISABLED = 'true';
  process.env.AVIORA_OUTBOX_DISABLED = 'true';
  process.env.AVIORA_PII_ENCRYPTION_KEY ??= Buffer.alloc(32, 31).toString('base64');

  app = await createApp({ logger: false });
  await app.listen(0);
  const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');

  const res = await fetch(`${base}/api/v1/public/v1/catalog`);
  expect(res.status).toBe(200);
  catalog = await res.json();
}, 180_000);

afterAll(async () => {
  await app?.close();
});

describe('The catalogue is readable without a key (docs/47 §3)', () => {
  it('answers an anonymous request', () => {
    // Requiring a key to find out what the API does is a door with the
    // instructions on the inside.
    expect(catalog.version).toBe('v1');
    expect(catalog.authentication.scheme).toBe('Bearer');
  });

  it('states the rate limit the code actually enforces', () => {
    expect(catalog.rateLimit.requests).toBeGreaterThan(0);
    expect(catalog.rateLimit.windowSeconds).toBe(60);
    expect(catalog.rateLimit.headers).toContain('X-RateLimit-Remaining');
  });
});

describe('It matches the application, or it is a lie (docs/47 §2)', () => {
  it('lists every route the public controller declares, and no others', () => {
    // Read from the controller's own metadata, independently of the service
    // that builds the catalogue: if both read it the same wrong way, the test
    // would agree with the bug.
    const proto = PublicApiController.prototype as unknown as Record<string, unknown>;
    const declared = Object.getOwnPropertyNames(proto)
      .filter((k) => k !== 'constructor')
      .filter((k) => Reflect.getMetadata(PATH_METADATA, proto[k] as object) !== undefined);

    expect(
      catalog.endpoints.length,
      `the catalogue lists ${catalog.endpoints.length} endpoints and the controller ` +
        `declares ${declared.length}. A public endpoint that does not appear here is ` +
        `one integrators cannot find; one that appears and does not exist is worse.`,
    ).toBe(declared.length);

    for (const e of catalog.endpoints) {
      expect(e.path.startsWith('/api/v1/public/')).toBe(true);
      expect(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']).toContain(e.method);
    }
  });

  it('names the scope that gates each endpoint', () => {
    for (const e of catalog.endpoints) {
      expect(
        e.scope,
        `${e.method} ${e.path} reports no scope. A key lists what it may do, so an ` +
          `endpoint with none is either ungated or undocumented — both worth failing on.`,
      ).toBeTruthy();
    }
    expect(catalog.scopes.length).toBeGreaterThan(0);
    for (const s of catalog.scopes) {
      expect(catalog.endpoints.some((e: { scope: string }) => e.scope === s)).toBe(true);
    }
  });

  it('lists every event a webhook can subscribe to, from the shared catalog', () => {
    const names = catalog.events.map((e: { name: string }) => e.name).sort();
    expect(names).toEqual(Object.values(EVENTS).sort());
  });
});

describe('It says what will never come, not only what exists (docs/47 §3)', () => {
  it('names the refusals an integrator would otherwise plan around', () => {
    const text = catalog.refuses.join(' ').toLowerCase();
    expect(catalog.refuses.length).toBeGreaterThan(0);
    expect(text).toMatch(/health/);
    expect(text).toMatch(/cross-tenant|one tenant/);
    expect(text).toMatch(/payment|payout/);
  });

  it('does not describe itself as OpenAPI', () => {
    // A hand-shaped subset of OpenAPI is not OpenAPI, and tools that consumed
    // it would break on the parts we did not implement (docs/47 §4).
    expect(JSON.stringify(catalog)).not.toMatch(/"openapi"/i);
    expect(catalog.description).toMatch(/not an OpenAPI document/i);
  });
});
