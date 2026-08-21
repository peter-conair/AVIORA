/**
 * The shared rate-limit budget (docs/38 §2), against a real Redis.
 *
 * The claim being tested is the one a second instance breaks: two limiters —
 * standing in for two API processes — must spend ONE budget, not one each.
 * A mock cannot test that, because the thing under test is whether the counter
 * is genuinely shared.
 *
 * It lives with the integration suites rather than the unit ones because it
 * needs real infrastructure, and `vitest.config.ts` is deliberately kept free
 * of dependencies. It skips when no `AVIORA_REDIS_URL` is configured: the
 * in-memory fallback is correct for a single instance, and a CI without Redis
 * should not fail on a dependency this code is explicitly built to survive.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { RedisRateLimitStore } from '../../src/modules/integration/redis-rate-limit';

const URL = process.env.AVIORA_REDIS_URL;
const run = URL ? describe : describe.skip;

const stores: RedisRateLimitStore[] = [];
const store = (windowMs = 60_000) => {
  const s = new RedisRateLimitStore(URL!, windowMs);
  stores.push(s);
  return s;
};

afterAll(async () => {
  await Promise.allSettled(stores.map((s) => s.close()));
});

run('Two limiters share one budget (docs/38 §2)', () => {
  it('spends a single allowance across two independent instances', async () => {
    const key = `spec-shared-${Date.now().toString(36)}`;
    const a = store();
    const b = store();
    const LIMIT = 4;

    const verdicts = [
      await a.take(key, LIMIT),
      await b.take(key, LIMIT),
      await a.take(key, LIMIT),
      await b.take(key, LIMIT),
    ];
    expect(
      verdicts.every((v) => v?.allowed),
      'the first four requests are within a limit of four',
    ).toBe(true);
    expect(verdicts[3]?.remaining).toBe(0);

    // The fifth is refused whichever instance it lands on — the point of the
    // whole change. Per-process counting would allow four MORE here.
    const fifth = await b.take(key, LIMIT);
    expect(
      fifth?.allowed,
      'a second instance handed out a fresh allowance, which is exactly the bug ' +
        'this replaces: two processes advertising one limit and enforcing two',
    ).toBe(false);
  });

  it('reports a window that ends, rather than one that never does', async () => {
    const key = `spec-window-${Date.now().toString(36)}`;
    const s = store(1_000);
    const first = await s.take(key, 1);
    expect(first?.resetAt).toBeGreaterThan(Date.now());
    expect(
      first!.resetAt - Date.now(),
      'a key with no expiry would hold the budget spent for ever',
    ).toBeLessThanOrEqual(1_000);

    expect((await s.take(key, 1))?.allowed).toBe(false);
    await new Promise((r) => setTimeout(r, 1_200));
    expect((await s.take(key, 1))?.allowed, 'the window never reopened').toBe(true);
  }, 15_000);

  it('falls back rather than refusing when Redis cannot be reached', async () => {
    // docs/38 §2: failing closed would turn "the cache is down" into "the
    // public API is down". Null means "ask the in-memory limiter", which keeps
    // a per-process floor instead of dropping limiting altogether.
    const dead = new RedisRateLimitStore('redis://127.0.0.1:6399', 60_000);
    stores.push(dead);
    expect(await dead.take('spec-unreachable', 10)).toBeNull();
  }, 15_000);
});
