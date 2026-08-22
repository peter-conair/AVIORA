import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { ERROR_CODES } from '@aviora/shared';
import { CLS_USER_ID } from '../auth/jwt-auth.guard';
import { CLS_TENANT_ID } from '../tenant/tenant-context.middleware';
import { RateCounter } from './rate-counter';

/**
 * The tiers docs/10 §8 specified and nothing enforced (docs/49).
 *
 * An authenticated member was bounded by permissions and entitlements — by WHAT
 * they may do, never by HOW OFTEN. An authorised person, a stolen session or a
 * well-meaning script could call the assistant or a compensation run in a loop,
 * and the only thing that would notice was the bill.
 *
 * Runs as a guard AFTER authentication, which is later than a limiter usually
 * wants to be: the cheapest refusal happens before any work. But these tiers are
 * keyed by tenant and user, and neither exists until the token is verified. What
 * stands in front is the pre-auth layer that already exists — the public API's
 * key limiter and docs/48's attempt limiter — so an unauthenticated flood never
 * reaches here.
 */

export const RATE_TIER = 'rateTier';
export type RateTierName = 'read' | 'write' | 'expensive';

/**
 * Marks a route as expensive. A route is expensive only by SAYING so: a list of
 * expensive paths kept somewhere else drifts from the routes it names, which is
 * the failure this codebase has now met five times.
 */
export const RateTier = (tier: RateTierName) => SetMetadata(RATE_TIER, tier);

/** docs/10 §8's own defaults, read per call so a test can narrow one tier. */
export const RATE_TIERS = {
  get read() {
    return { limit: Number(process.env.AVIORA_RATE_READ ?? 600), windowSeconds: 60 };
  },
  get write() {
    return { limit: Number(process.env.AVIORA_RATE_WRITE ?? 120), windowSeconds: 60 };
  },
  get expensive() {
    return { limit: Number(process.env.AVIORA_RATE_EXPENSIVE ?? 20), windowSeconds: 60 };
  },
  get tenantGlobal() {
    return { limit: Number(process.env.AVIORA_RATE_TENANT ?? 5000), windowSeconds: 60 };
  },
};

@Injectable()
export class RateTierGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly cls: ClsService,
    private readonly counter: RateCounter,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const req = ctx.switchToHttp().getRequest<Request>();
    const res = ctx.switchToHttp().getResponse<Response>();

    const userId = this.cls.get<string | undefined>(CLS_USER_ID);
    const tenantId = this.cls.get<string | undefined>(CLS_TENANT_ID);
    // Anonymous traffic is the pre-auth layer's business (docs/49 §3), and a
    // request with no tenant has no tenant budget to spend.
    if (!userId || !tenantId) return true;

    const declared = this.reflector.getAllAndOverride<RateTierName>(RATE_TIER, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    const tier: RateTierName =
      declared ?? (req.method === 'GET' || req.method === 'HEAD' ? 'read' : 'write');
    const rule = RATE_TIERS[tier];

    const perUser = await this.counter.take(`tier:${tier}:${tenantId}:${userId}`, rule);
    // The tenant ceiling is a ceiling on ITS OWN traffic, not a share of a pool:
    // a shared pool would make one customer's script another customer's outage.
    const perTenant = await this.counter.take(`tier:tenant:${tenantId}`, RATE_TIERS.tenantGlobal);

    // The names docs/10 §8 specifies. They differ from the public API's
    // `X-RateLimit-*`, which shipped first and has callers — renaming a header
    // integrators already read, to satisfy a document, would break somebody's
    // code to make a table tidier (docs/49 §5).
    res.setHeader('RateLimit-Limit', String(rule.limit));
    res.setHeader('RateLimit-Remaining', String(Math.min(perUser.remaining, perTenant.remaining)));
    res.setHeader('RateLimit-Reset', String(Math.ceil(perUser.resetAt / 1000)));

    const refused = !perUser.allowed ? perUser : !perTenant.allowed ? perTenant : null;
    if (!refused) return true;

    const retryAfter = Math.max(Math.ceil((refused.resetAt - Date.now()) / 1000), 1);
    res.setHeader('Retry-After', String(retryAfter));
    // FLAT, not nested under `error`: the global filter reads code/message/
    // details from the top level of an HttpException body and builds the
    // envelope itself. Nesting them produced a 429 whose message was the string
    // "Http Exception" — the standard envelope, saying nothing.
    throw new HttpException(
      {
        code: ERROR_CODES.RATE_LIMITED,
        message: perUser.allowed
          ? 'This organisation has made too many requests. Try again shortly.'
          : `Too many ${tier} requests. Try again shortly.`,
        details: { tier, retry_after: retryAfter },
      },
      429,
    );
  }
}
