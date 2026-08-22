import * as crypto from 'node:crypto';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

/**
 * Attempt limiting for the routes anybody can reach without credentials
 * (docs/48).
 *
 * The public API has been rate limited since docs/30; `POST /auth/login` was
 * limited to nothing at all, and answered sixty wrong passwords in two seconds.
 *
 * Three rules shape everything here, and each exists because the obvious
 * implementation of a login limiter is itself an attack:
 *
 *   1. Only FAILURES count, and a success clears the counter — otherwise a
 *      person on a bad connection retrying a form they typed correctly gets
 *      locked out of their own account.
 *   2. There is no permanent lockout. A lock that persists until somebody lifts
 *      it hands anyone who knows your email address a denial of service against
 *      you. Windows expire on their own, always.
 *   3. The per-account key is the SUBMITTED address, whether or not that
 *      account exists. If only real accounts throttled, "this address
 *      throttles" would answer the question the identical 401 bodies exist to
 *      leave unanswered.
 */

export interface ThrottleRule {
  /** How many failures are allowed in the window. */
  limit: number;
  windowSeconds: number;
}

/**
 * docs/48 §5. Generous for a person, useless for a script.
 *
 * Read through getters rather than frozen at import: a limit computed once when
 * the module loads cannot be changed by anything that runs afterwards, which
 * makes the per-IP budget impossible to hold still while testing the per-account
 * one — and a limiter whose two halves cannot be tested apart is a limiter whose
 * halves nobody has tested.
 */
export const AUTH_LIMITS = {
  get loginPerIp(): ThrottleRule {
    return { limit: Number(process.env.AVIORA_AUTH_LOGIN_IP_LIMIT ?? 10), windowSeconds: 300 };
  },
  get loginPerAccount(): ThrottleRule {
    return { limit: Number(process.env.AVIORA_AUTH_LOGIN_ACCOUNT_LIMIT ?? 5), windowSeconds: 300 };
  },
  get registerPerIp(): ThrottleRule {
    return { limit: Number(process.env.AVIORA_AUTH_REGISTER_IP_LIMIT ?? 5), windowSeconds: 3600 };
  },
  get invitePerIp(): ThrottleRule {
    return { limit: Number(process.env.AVIORA_AUTH_INVITE_IP_LIMIT ?? 20), windowSeconds: 3600 };
  },
};

interface Bucket {
  count: number;
  resetAt: number;
}

export interface ThrottleVerdict {
  allowed: boolean;
  retryAfterSeconds: number;
}

@Injectable()
export class AuthThrottleService implements OnModuleDestroy {
  private readonly logger = new Logger(AuthThrottleService.name);
  private readonly redis: Redis | null;
  private readonly local = new Map<string, Bucket>();
  private warnedAt = 0;
  /** Bounds the in-memory map on a long-lived process. */
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
    // An unhandled 'error' from ioredis takes the process down, which would be
    // a login limiter causing an outage by a different route.
    this.redis?.on('error', (e) => this.warn(e));
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis?.quit().catch(() => this.redis?.disconnect());
  }

  /** The address, hashed — a limiter should not keep a list of who tried to sign in. */
  static accountKey(email: string): string {
    return crypto
      .createHash('sha256')
      .update(email.trim().toLowerCase())
      .digest('hex')
      .slice(0, 32);
  }

  /**
   * Is this caller still allowed to TRY? Reads the counter without touching it:
   * an attempt is only spent when it fails (`recordFailure`).
   */
  async check(key: string, rule: ThrottleRule): Promise<ThrottleVerdict> {
    const count = await this.read(key);
    if (count < rule.limit) return { allowed: true, retryAfterSeconds: 0 };
    const ttl = await this.ttl(key, rule);
    return { allowed: false, retryAfterSeconds: Math.max(ttl, 1) };
  }

  /** Spends one attempt. Called only when authentication actually failed. */
  async recordFailure(key: string, rule: ThrottleRule): Promise<void> {
    if (this.redis) {
      try {
        const n = await this.redis.incr(`authfail:${key}`);
        if (n === 1) await this.redis.expire(`authfail:${key}`, rule.windowSeconds);
        return;
      } catch (e) {
        this.warn(e);
      }
    }
    this.bumpLocal(key, rule);
  }

  /** A success clears the slate — rule 1. */
  async clear(key: string): Promise<void> {
    this.local.delete(key);
    if (!this.redis) return;
    await this.redis.del(`authfail:${key}`).catch((e) => this.warn(e));
  }

  private async read(key: string): Promise<number> {
    if (this.redis) {
      try {
        const raw = await this.redis.get(`authfail:${key}`);
        return raw ? Number(raw) : 0;
      } catch (e) {
        this.warn(e);
      }
    }
    const bucket = this.local.get(key);
    return bucket && bucket.resetAt > Date.now() ? bucket.count : 0;
  }

  private async ttl(key: string, rule: ThrottleRule): Promise<number> {
    if (this.redis) {
      try {
        const ms = await this.redis.pttl(`authfail:${key}`);
        if (ms > 0) return Math.ceil(ms / 1000);
      } catch (e) {
        this.warn(e);
      }
    }
    const bucket = this.local.get(key);
    return bucket ? Math.ceil((bucket.resetAt - Date.now()) / 1000) : rule.windowSeconds;
  }

  private bumpLocal(key: string, rule: ThrottleRule): void {
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
  }

  /**
   * Falls back to the in-memory counter, never to nothing (docs/48 §4). A cache
   * outage that locks every user out of the product is a worse day than one
   * that degrades brute-force protection to per-process.
   */
  private warn(e: unknown): void {
    const now = Date.now();
    if (now - this.warnedAt < 60_000) return;
    this.warnedAt = now;
    this.logger.warn(
      `auth throttling fell back to per-process counting: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}
