/**
 * Attempt limiting on the doors anybody can knock on (Sprint 29, docs/48).
 *
 * Before this existed, sixty wrong passwords against a real account took two
 * seconds and were all answered — about thirty guesses a second, no delay, no
 * lockout, no record. A ten-thousand-password list took five minutes.
 *
 * The tests below are shaped by the fact that the obvious implementation of a
 * login limiter is itself an attack: a permanent lockout is a denial of service
 * against the victim, counting successes locks people out of their own
 * accounts, and throttling only real accounts answers the enumeration question
 * the identical 401 bodies exist to leave unanswered. There is a test for each.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import * as argon2 from 'argon2';
import { createOwnerClient, ensureAppRole, type PrismaClient } from '@aviora/db';
import { ENTITLEMENTS, PERMISSIONS } from '@aviora/shared';
import { createApp } from '../../src/app.factory';
import { AUTH_LIMITS } from '../../src/common/auth/auth-throttle.service';

const RUN = `t${Date.now().toString(36)}`;
const VICTIM = `throttle-victim-${RUN}@test.local`;
const PW = 'e2e-throttle-password-1';

let app: INestApplication;
let base: string;
let owner: PrismaClient;

async function attempt(
  email: string,
  password: string,
  ip?: string,
): Promise<{ status: number; retryAfter: string | null }> {
  const res = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // Express honours X-Forwarded-For only behind a trusted proxy; where it
      // does not, every request here shares one IP bucket, which is why the
      // per-ACCOUNT assertions below are the load-bearing ones.
      ...(ip ? { 'x-forwarded-for': ip } : {}),
    },
    body: JSON.stringify({ email, password }),
  });
  return { status: res.status, retryAfter: res.headers.get('retry-after') };
}

beforeAll(async () => {
  process.env.AVIORA_SCHEDULER_DISABLED = 'true';
  process.env.AVIORA_OUTBOX_DISABLED = 'true';
  process.env.AVIORA_PII_ENCRYPTION_KEY ??= Buffer.alloc(32, 43).toString('base64');
  // Every request in this file arrives from 127.0.0.1, so one per-IP budget is
  // shared by every test. Held wide open here so the per-ACCOUNT half can be
  // exercised on its own; the per-IP half gets its own test below, which
  // narrows it deliberately.
  process.env.AVIORA_AUTH_LOGIN_IP_LIMIT = '10000';

  owner = createOwnerClient();
  await ensureAppRole(owner);
  for (const key of Object.values(PERMISSIONS)) {
    await owner.permission.upsert({ where: { key }, create: { key }, update: {} });
  }
  for (const key of Object.values(ENTITLEMENTS)) {
    await owner.entitlement.upsert({ where: { key }, create: { key }, update: {} });
  }
  await owner.user.upsert({
    where: { email: VICTIM },
    create: {
      email: VICTIM,
      passwordHash: await argon2.hash(PW, { type: argon2.argon2id }),
      displayName: 'Throttle Victim',
    },
    update: { passwordHash: await argon2.hash(PW, { type: argon2.argon2id }) },
  });

  app = await createApp({ logger: false });
  await app.listen(0);
  base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
}, 180_000);

afterAll(async () => {
  await app?.close();
  await owner?.$disconnect();
});

describe('Guessing a password is no longer free (docs/48 §1)', () => {
  it('refuses the burst that used to be answered sixty times', async () => {
    const results: number[] = [];
    for (let i = 0; i < AUTH_LIMITS.loginPerAccount.limit + 5; i += 1) {
      const { status } = await attempt(VICTIM, `wrong-guess-${i}`);
      results.push(status);
    }
    const refused = results.filter((s) => s === 429).length;
    expect(
      refused,
      `all ${results.length} wrong passwords were answered. Before docs/48 this ` +
        `endpoint took thirty guesses a second, which is a ten-thousand-word list ` +
        `in five minutes.`,
    ).toBeGreaterThan(0);
    // The allowed ones must still be honest 401s, not a silent drop.
    expect(results.filter((s) => s === 401).length).toBeGreaterThan(0);
  }, 120_000);

  it('says when to come back, rather than just refusing', async () => {
    const { status, retryAfter } = await attempt(VICTIM, 'still-wrong');
    expect(status).toBe(429);
    expect(
      retryAfter,
      'a 429 with no Retry-After leaves a caller unable to tell blocked from broken',
    ).toBeTruthy();
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });

  it('does not lock the account permanently — the window is the whole design', async () => {
    // A lock that persists until somebody lifts it hands anyone who knows your
    // address a denial of service against you (docs/48 §3). This asserts the
    // window is bounded and short rather than waiting five minutes for it.
    const { retryAfter } = await attempt(VICTIM, 'wrong-again');
    expect(Number(retryAfter)).toBeLessThanOrEqual(AUTH_LIMITS.loginPerAccount.windowSeconds);
  });
});

describe('Both keys are real, and each is checked on its own (docs/48 §2)', () => {
  it('refuses a source working through many different accounts', async () => {
    // Per-account limiting alone would let one machine spray a thousand
    // addresses at one attempt each and never trip anything.
    process.env.AVIORA_AUTH_LOGIN_IP_LIMIT = '4';
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 8; i += 1) {
        // A DIFFERENT address every time, so no account counter can be what
        // refuses this — only the IP one can.
        const { status } = await attempt(`spray-${RUN}-${i}@test.local`, 'whatever-123456');
        statuses.push(status);
      }
      expect(
        statuses.filter((s) => s === 429).length,
        'a single source sprayed eight different accounts without being refused, ' +
          'so only the per-account key is doing any work',
      ).toBeGreaterThan(0);
    } finally {
      process.env.AVIORA_AUTH_LOGIN_IP_LIMIT = '10000';
    }
  }, 120_000);
});

describe('The limiter does not become the attack (docs/48 §3)', () => {
  it('throttles an address that does not exist, exactly like one that does', async () => {
    // If only real accounts throttled, "this address throttles" would answer
    // the enumeration question the identical 401 bodies leave unanswered.
    const ghost = `ghost-${RUN}@nowhere.local`;
    const statuses: number[] = [];
    for (let i = 0; i < AUTH_LIMITS.loginPerAccount.limit + 3; i += 1) {
      const { status } = await attempt(ghost, `guess-${i}`);
      statuses.push(status);
    }
    expect(
      statuses.filter((s) => s === 429).length,
      'an unknown address was never throttled, so throttling now reveals which ' +
        'addresses are real',
    ).toBeGreaterThan(0);
  }, 120_000);

  it('keeps the two answers indistinguishable while attempts remain', async () => {
    const fresh = `fresh-${RUN}@test.local`;
    const unknown = await fetch(`${base}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: fresh, password: 'whatever-123456' }),
    });
    const body = (await unknown.json()) as { error: { message: string } };
    expect(unknown.status).toBe(401);
    expect(
      body.error.message,
      'the message for an unknown address must not differ from a wrong password',
    ).toMatch(/invalid email or password/i);
  });

  it('clears the counter when the password is finally right', async () => {
    const returning = `returning-${RUN}@test.local`;
    await owner.user.create({
      data: {
        email: returning,
        passwordHash: await argon2.hash(PW, { type: argon2.argon2id }),
        displayName: 'Returning',
      },
    });

    // Fail a few times, short of the limit…
    for (let i = 0; i < AUTH_LIMITS.loginPerAccount.limit - 2; i += 1) {
      const { status } = await attempt(returning, `nope-${i}`);
      expect(status).toBe(401);
    }
    // …then remember it.
    const ok = await attempt(returning, PW);
    expect(ok.status, 'a correct password was refused while attempts remained').toBe(200);

    // The slate is clean: a full run of failures is available again, which is
    // what stops a person's own earlier typos from locking them out later.
    const after: number[] = [];
    for (let i = 0; i < AUTH_LIMITS.loginPerAccount.limit - 1; i += 1) {
      const { status } = await attempt(returning, `nope-again-${i}`);
      after.push(status);
    }
    expect(
      after.every((s) => s === 401),
      'the counter was not cleared by a successful sign-in, so yesterday’s typos ' +
        'still count against you today',
    ).toBe(true);
  }, 120_000);
});
