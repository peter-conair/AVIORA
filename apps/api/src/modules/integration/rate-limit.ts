import * as crypto from 'node:crypto';
import { Injectable, NestMiddleware, OnModuleDestroy } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { ERROR_CODES } from '@aviora/shared';
import { RedisRateLimitStore } from './redis-rate-limit';

const WINDOW_MS = 60_000;
const DEFAULT_LIMIT = 120;
/** Stop the map growing without bound on a long-lived process. */
const SWEEP_EVERY = 500;

interface Bucket {
  count: number;
  resetAt: number;
}

export interface RateVerdict {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

/**
 * In-memory fixed-window limiter for the public API (docs/30 §4).
 *
 * Still here, and still correct for a single instance — but it counts PER
 * PROCESS, so two API instances allow twice the stated limit. Sprint 19 moved
 * the counter to Redis for exactly that reason (docs/38 §2); this remains the
 * fallback when no Redis is configured, and the honest one to fall back TO
 * when Redis is unreachable.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private sinceSweep = 0;

  constructor(private readonly limit: number = DEFAULT_LIMIT) {}

  take(key: string, now = Date.now()): RateVerdict {
    this.maybeSweep(now);
    const existing = this.buckets.get(key);
    const bucket =
      existing && existing.resetAt > now ? existing : { count: 0, resetAt: now + WINDOW_MS };
    bucket.count += 1;
    this.buckets.set(key, bucket);
    return {
      allowed: bucket.count <= this.limit,
      remaining: Math.max(this.limit - bucket.count, 0),
      resetAt: bucket.resetAt,
    };
  }

  get max(): number {
    return this.limit;
  }

  private maybeSweep(now: number): void {
    if (++this.sinceSweep < SWEEP_EVERY) return;
    this.sinceSweep = 0;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}

/**
 * Attaches `X-RateLimit-Limit`, `-Remaining` and `-Reset` to EVERY public
 * response — a limit a caller cannot see is a limit they will hit blind
 * (docs/30 §4). Written as middleware rather than a guard or an interceptor
 * precisely so the headers survive the 401 from a bad key and the 404 from a
 * bad path, not only the happy one.
 *
 * The bucket key is the presented credential, hashed, so no raw key sits in a
 * long-lived map; callers with no credential at all share a per-IP bucket.
 */
@Injectable()
export class PublicRateLimitMiddleware implements NestMiddleware, OnModuleDestroy {
  private readonly limiter = new RateLimiter(
    Number(process.env.AVIORA_PUBLIC_RATE_LIMIT ?? DEFAULT_LIMIT),
  );
  /**
   * One budget across every instance when Redis is configured (docs/38 §2).
   * Absent it, the in-memory limiter is still correct for a single instance —
   * so this is optional rather than required, and the deployment that needs it
   * is the one that runs more than one process.
   */
  private readonly shared = process.env.AVIORA_REDIS_URL
    ? new RedisRateLimitStore(process.env.AVIORA_REDIS_URL, WINDOW_MS)
    : null;

  constructor(private readonly cls: ClsService) {}

  async onModuleDestroy(): Promise<void> {
    await this.shared?.close();
  }

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    const key = this.bucketKey(req);
    // The in-memory limiter is still consulted when Redis answers, so a Redis
    // that starts failing mid-window falls back to a counter that has been
    // counting all along rather than to an empty one.
    const local = this.limiter.take(key);
    const verdict = (await this.shared?.take(key, this.limiter.max)) ?? local;
    const resetSeconds = Math.ceil(verdict.resetAt / 1000);

    res.setHeader('X-RateLimit-Limit', String(this.limiter.max));
    res.setHeader('X-RateLimit-Remaining', String(verdict.remaining));
    res.setHeader('X-RateLimit-Reset', String(resetSeconds));

    if (verdict.allowed) return next();

    const retryAfter = Math.max(Math.ceil((verdict.resetAt - Date.now()) / 1000), 1);
    res.setHeader('Retry-After', String(retryAfter));
    // Written here rather than thrown: an exception raised in middleware does
    // not reliably reach the global filter, and a rate limit that sometimes
    // answers with an HTML stack trace is worse than no rate limit.
    res.status(429).json({
      error: {
        code: ERROR_CODES.RATE_LIMITED,
        message: 'Rate limit exceeded for this API key',
        details: { retry_after: retryAfter },
        request_id: this.requestId(),
      },
      retry_after: retryAfter,
    });
  }

  private bucketKey(req: Request): string {
    const header = req.header('authorization');
    const raw = header?.startsWith('Bearer ') ? header.slice(7).trim() : null;
    if (raw) return `key:${crypto.createHash('sha256').update(raw).digest('hex')}`;
    return `ip:${req.ip ?? 'unknown'}`;
  }

  private requestId(): string {
    try {
      return this.cls.getId() ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }
}
