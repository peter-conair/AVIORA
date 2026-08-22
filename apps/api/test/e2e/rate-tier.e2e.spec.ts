/**
 * The rate tiers docs/10 §8 specified and nothing enforced (Sprint 30, docs/49).
 *
 * Before this, an authenticated member was bounded by permissions and
 * entitlements — by WHAT they may do, never by HOW OFTEN. The tests narrow one
 * tier at a time rather than hammering a real limit: at 600 reads a minute a
 * test proving the read tier would take a minute and teach nobody anything.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import * as argon2 from 'argon2';
import { createOwnerClient, ensureAppRole, type PrismaClient } from '@aviora/db';
import { ENTITLEMENTS, PERMISSIONS } from '@aviora/shared';
import { createApp } from '../../src/app.factory';

const RUN = `r${Date.now().toString(36)}`;
const PLATFORM_EMAIL = `e2e-rt-platform-${RUN}@test.local`;
const PW = 'e2e-ratetier-password-1';

let app: INestApplication;
let base: string;
let owner: PrismaClient;
let tenant: string;
let admin: string;

async function api(
  path: string,
  init: RequestInit & { token?: string; tenant?: string } = {},
): Promise<{ status: number; headers: Headers; body: any }> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...(init.tenant ? { 'x-tenant-id': init.tenant } : {}),
    },
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
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

beforeAll(async () => {
  process.env.AVIORA_SCHEDULER_DISABLED = 'true';
  process.env.AVIORA_OUTBOX_DISABLED = 'true';
  process.env.AVIORA_PII_ENCRYPTION_KEY ??= Buffer.alloc(32, 47).toString('base64');
  // Wide open by default so this file's own setup is not throttled; each test
  // narrows the ONE tier it is about.
  process.env.AVIORA_RATE_READ = '100000';
  process.env.AVIORA_RATE_WRITE = '100000';
  process.env.AVIORA_RATE_EXPENSIVE = '100000';
  process.env.AVIORA_RATE_TENANT = '100000';

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
      displayName: 'E2E RT Platform',
      platformRole: 'PLATFORM_OWNER',
    },
    update: {},
  });

  app = await createApp({ logger: false });
  await app.listen(0);
  base = (await app.getUrl()).replace('[::1]', '127.0.0.1');

  const platform = await login(PLATFORM_EMAIL);
  const created = await api('/api/v1/platform/tenants', {
    method: 'POST',
    token: platform,
    body: JSON.stringify({
      code: `e2e_rt_${RUN}`,
      name: 'Tier Co',
      slug: `e2e-rt-${RUN}`,
      adminEmail: `rt-admin-${RUN}@test.local`,
      adminDisplayName: 'Admin',
      adminPassword: PW,
    }),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  tenant = created.body.tenant.id;
  admin = await login(`rt-admin-${RUN}@test.local`);
}, 240_000);

afterAll(async () => {
  await app?.close();
  await owner?.$disconnect();
});

describe('Every answer states the budget (docs/49 §5)', () => {
  it('carries the headers docs/10 §8 names', async () => {
    const res = await api('/api/v1/members', { token: admin, tenant });
    expect(res.status).toBe(200);
    expect(
      res.headers.get('ratelimit-limit'),
      'no RateLimit-Limit on an authenticated read',
    ).toBeTruthy();
    expect(res.headers.get('ratelimit-remaining')).toBeTruthy();
    expect(res.headers.get('ratelimit-reset')).toBeTruthy();
  });

  it('counts down as the budget is spent', async () => {
    const first = await api('/api/v1/members', { token: admin, tenant });
    const second = await api('/api/v1/members', { token: admin, tenant });
    expect(Number(second.headers.get('ratelimit-remaining'))).toBeLessThan(
      Number(first.headers.get('ratelimit-remaining')),
    );
  });
});

describe('A tier refuses when it is spent (docs/49 §2)', () => {
  it('refuses reads past the read limit, and says which tier', async () => {
    process.env.AVIORA_RATE_READ = '3';
    try {
      const statuses: number[] = [];
      let refusal: any = null;
      for (let i = 0; i < 6; i += 1) {
        const res = await api('/api/v1/members', { token: admin, tenant });
        statuses.push(res.status);
        if (res.status === 429) refusal = res;
      }
      expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
      expect(refusal.headers.get('retry-after')).toBeTruthy();
      expect(
        refusal.body.error.details.tier,
        'a refusal that does not name its tier leaves a caller unable to tell ' +
          'which budget they exhausted',
      ).toBe('read');
    } finally {
      process.env.AVIORA_RATE_READ = '100000';
    }
  }, 60_000);

  it('holds the expensive tier separately from ordinary reads', async () => {
    // A compensation run is marked expensive because it traverses the whole
    // tenant; /members is an ordinary read. Spending one budget must not touch
    // the other, or "expensive" is just a second name for "read".
    //
    // The request is deliberately invalid: the GUARD runs before the pipes, so
    // a call that ends in a 400 still spends its slot — which is the property
    // being tested, and it means this needs no compensation plan to exist.
    process.env.AVIORA_RATE_EXPENSIVE = '2';
    try {
      const expensive: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        const res = await api('/api/v1/compensation/runs', {
          method: 'POST',
          token: admin,
          tenant,
          body: JSON.stringify({}),
        });
        expensive.push(res.status);
      }
      expect(
        expensive.filter((s) => s === 429).length,
        `the expensive tier never refused (${expensive.join(', ')}), so the ` +
          'decorator is not being read',
      ).toBeGreaterThan(0);

      const ordinary = await api('/api/v1/members', { token: admin, tenant });
      expect(
        ordinary.status,
        'exhausting the expensive tier also blocked an ordinary read, so the two ' +
          'tiers share one counter',
      ).toBe(200);
    } finally {
      process.env.AVIORA_RATE_EXPENSIVE = '100000';
    }
  }, 60_000);

  it('keeps the tenant ceiling separate from the per-user one', async () => {
    process.env.AVIORA_RATE_TENANT = '3';
    try {
      const statuses: number[] = [];
      let refusal: any = null;
      for (let i = 0; i < 6; i += 1) {
        const res = await api('/api/v1/members', { token: admin, tenant });
        statuses.push(res.status);
        if (res.status === 429) refusal = res;
      }
      expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
      expect(
        refusal.body.error.message,
        'the tenant ceiling refused with a per-user message, so an operator cannot ' +
          'tell one runaway member from a whole organisation',
      ).toMatch(/organisation/i);
    } finally {
      process.env.AVIORA_RATE_TENANT = '100000';
    }
  }, 60_000);
});

describe('It does not limit what it cannot key (docs/49 §3)', () => {
  it('leaves anonymous requests to the pre-auth layer', async () => {
    // No token, no tenant: nothing to key on, and the public limiter and
    // docs/48's attempt limiter are what stand in front.
    process.env.AVIORA_RATE_READ = '1';
    try {
      const first = await fetch(`${base}/healthz`);
      const second = await fetch(`${base}/healthz`);
      expect(first.status).toBe(200);
      expect(second.status, 'an unauthenticated request was charged to a tier').toBe(200);
    } finally {
      process.env.AVIORA_RATE_READ = '100000';
    }
  });
});
