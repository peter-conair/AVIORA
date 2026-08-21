import { Logger } from '@nestjs/common';
import Redis from 'ioredis';
import type { RateVerdict } from './rate-limit';

/**
 * The shared rate-limit budget (docs/38 §2).
 *
 * `INCR` on the key the limiter already builds, `EXPIRE` set on the first write
 * of a window, and `PTTL` to report when the window ends — the upgrade the
 * in-memory class named for itself. One budget, however many instances.
 *
 * Two behaviours are worth stating out loud because both are choices:
 *
 * **It fails OPEN.** If Redis is unreachable the request is allowed and the
 * failure is logged once per window. A limiter that fails closed converts "the
 * cache is down" into "the public API is down" — it turns a degraded dependency
 * into an outage. What we are exposed to meanwhile is per-process limiting,
 * which is precisely where the platform already was.
 *
 * **It is a fixed window, not a sliding one.** A caller can spend the whole
 * budget at the end of one window and again at the start of the next. That is
 * the same behaviour the in-memory limiter always had, so this change swaps the
 * STORE without quietly changing the LIMIT — one variable at a time.
 */
export class RedisRateLimitStore {
  private readonly logger = new Logger(RedisRateLimitStore.name);
  private readonly redis: Redis;
  private warnedAt = 0;

  constructor(
    url: string,
    private readonly windowMs: number,
  ) {
    this.redis = new Redis(url, {
      // A limiter must not hold a request while a dead Redis times out, so the
      // bound is `commandTimeout`: one quick attempt, then fall back.
      connectTimeout: 1_000,
      commandTimeout: 250,
      maxRetriesPerRequest: 1,
      // The offline queue stays ON, and that is a correction rather than a
      // default. With it off, every command issued before the socket finishes
      // connecting fails instantly with "Stream isn't writeable" — so a fresh
      // process would count per-process for its first requests, which is
      // exactly when a restart storm makes the shared limit matter. With it on,
      // those commands wait for the connection and are still bounded by
      // `commandTimeout`, so a genuinely dead Redis costs 250ms and falls back
      // rather than hanging.
      enableOfflineQueue: true,
      lazyConnect: false,
      retryStrategy: (times) => Math.min(times * 200, 5_000),
    });
    // ioredis emits `error` on every failed reconnect; an unhandled one takes
    // the process down, which would be a rate limiter causing an outage by a
    // different route.
    this.redis.on('error', (e) => this.warn(e));
  }

  private warn(e: unknown): void {
    const now = Date.now();
    if (now - this.warnedAt < this.windowMs) return;
    this.warnedAt = now;
    this.logger.warn(
      `rate limiting is falling back to per-process counting: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }

  async take(key: string, limit: number): Promise<RateVerdict | null> {
    const redisKey = `ratelimit:${key}`;
    try {
      const [[, countRaw], [, ttlRaw]] = (await this.redis
        .multi()
        .incr(redisKey)
        .pttl(redisKey)
        .exec()) as Array<[Error | null, unknown]> as [
        [Error | null, number],
        [Error | null, number],
      ];
      const count = Number(countRaw);
      let ttl = Number(ttlRaw);
      // -1 means the key exists with no expiry: the first INCR of this window.
      if (ttl < 0) {
        await this.redis.pexpire(redisKey, this.windowMs);
        ttl = this.windowMs;
      }
      return {
        allowed: count <= limit,
        remaining: Math.max(limit - count, 0),
        resetAt: Date.now() + ttl,
      };
    } catch (e) {
      this.warn(e);
      // null = "ask the in-memory limiter instead", which is what the caller
      // does. Returning `allowed: true` here would drop the per-process floor
      // as well and let one broken dependency remove limiting entirely.
      return null;
    }
  }

  async close(): Promise<void> {
    await this.redis.quit().catch(() => this.redis.disconnect());
  }
}
