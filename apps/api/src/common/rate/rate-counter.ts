import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

export interface RateRule {
  limit: number;
  windowSeconds: number;
}
export interface RateResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

/**
 * One fixed-window counter, shared across instances when Redis is configured
 * and per-process when it is not (docs/49 §4).
 *
 * A fixed window rather than a token bucket: a bucket smooths bursts more
 * kindly, and having two algorithms in one codebase is a worse problem than a
 * slightly blunt window. Every limiter here now counts the same way.
 */
@Injectable()
export class RateCounter implements OnModuleDestroy {
  private readonly logger = new Logger(RateCounter.name);
  private readonly redis: Redis | null;
  private readonly local = new Map<string, { count: number; resetAt: number }>();
  private warnedAt = 0;
  private sinceSweep = 0;

  constructor() {
    const url = process.env.AVIORA_REDIS_URL;
    this.redis = url
      ? new Redis(url, {
          connectTimeout: 500,
          commandTimeout: 250,
          maxRetriesPerRequest: 1,
          retryStrategy: (times) => Math.min(times * 200, 5_000),
        })
      : null;
    this.redis?.on('error', (e) => this.warn(e));
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis?.quit().catch(() => this.redis?.disconnect());
  }

  async take(key: string, rule: RateRule): Promise<RateResult> {
    if (this.redis) {
      try {
        const [[, countRaw], [, ttlRaw]] = (await this.redis
          .multi()
          .incr(`rate:${key}`)
          .pttl(`rate:${key}`)
          .exec()) as Array<[Error | null, unknown]> as [
          [Error | null, number],
          [Error | null, number],
        ];
        const count = Number(countRaw);
        let ttl = Number(ttlRaw);
        if (ttl < 0) {
          await this.redis.pexpire(`rate:${key}`, rule.windowSeconds * 1000);
          ttl = rule.windowSeconds * 1000;
        }
        return {
          allowed: count <= rule.limit,
          remaining: Math.max(rule.limit - count, 0),
          resetAt: Date.now() + ttl,
        };
      } catch (e) {
        this.warn(e);
      }
    }
    return this.takeLocal(key, rule);
  }

  private takeLocal(key: string, rule: RateRule): RateResult {
    const now = Date.now();
    if (++this.sinceSweep >= 500) {
      this.sinceSweep = 0;
      for (const [k, b] of this.local) if (b.resetAt <= now) this.local.delete(k);
    }
    const existing = this.local.get(key);
    const bucket =
      existing && existing.resetAt > now
        ? existing
        : { count: 0, resetAt: now + rule.windowSeconds * 1000 };
    bucket.count += 1;
    this.local.set(key, bucket);
    return {
      allowed: bucket.count <= rule.limit,
      remaining: Math.max(rule.limit - bucket.count, 0),
      resetAt: bucket.resetAt,
    };
  }

  /** Falls back, never closed: a cache outage must not log everyone out. */
  private warn(e: unknown): void {
    const now = Date.now();
    if (now - this.warnedAt < 60_000) return;
    this.warnedAt = now;
    this.logger.warn(
      `rate tiers fell back to per-process counting: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
