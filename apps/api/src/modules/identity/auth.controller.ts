import { Body, Controller, Get, HttpCode, HttpException, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';
import { ERROR_CODES } from '@aviora/shared';
import { CurrentUser, Public, type AuthenticatedUser } from '../../common/auth/decorators';
import { CLS_PERMISSIONS } from '../../common/auth/permissions.guard';
import { CLS_TENANT_ID } from '../../common/tenant/tenant-context.middleware';
import { ZodPipe } from '../../common/validation/zod.pipe';
import { AUTH_LIMITS, AuthThrottleService } from '../../common/auth/auth-throttle.service';
import { AuditService } from '../../common/audit/audit.service';
import { AuthService } from './auth.service';
import { clearSessionCookies, REFRESH_COOKIE, setSessionCookies } from './session-cookies';

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(10).max(200),
  displayName: z.string().min(1).max(120),
  locale: z.enum(['th', 'en']).optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
});

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly audit: AuditService,
    private readonly cls: ClsService,
    private readonly throttle: AuthThrottleService,
  ) {}

  /**
   * Refuses an attempt that has already spent its budget (docs/48).
   *
   * Shaped like the public API's 429 — code, message, and Retry-After — so a
   * caller never has to guess whether they are blocked or broken.
   */
  private async refuse(
    retryAfterSeconds: number,
    scope: 'ip' | 'account',
    subject: string,
    res?: Response,
  ): Promise<never> {
    // The REFUSAL is audited, not the failure. A wrong password is a Tuesday; a
    // caller crossing the threshold is somebody working through a list, and it
    // is bounded by definition — the limiter that produced it caps how many of
    // these can exist. Neither the address nor the password appears: the
    // subject is the hashed key the limiter itself uses.
    await this.audit.record({
      action: 'auth.throttled',
      entityType: 'auth',
      entityId: subject,
      tenantId: null,
      after: { scope, retryAfterSeconds },
    });
    // The header, not only the body: a 429 without Retry-After leaves a caller
    // unable to tell "blocked" from "broken", which is the same complaint
    // docs/30 §4 fixed for the public API.
    res?.setHeader('Retry-After', String(retryAfterSeconds));
    throw new HttpException(
      {
        error: {
          code: ERROR_CODES.RATE_LIMITED,
          message: 'Too many attempts. Try again shortly.',
          details: { retry_after: retryAfterSeconds },
        },
        retry_after: retryAfterSeconds,
      },
      429,
    );
  }

  @Public()
  @Post('register')
  async register(
    @Body(new ZodPipe(registerSchema)) body: z.infer<typeof registerSchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ipKey = `register:ip:${req.ip ?? 'unknown'}`;
    const verdict = await this.throttle.check(ipKey, AUTH_LIMITS.registerPerIp);
    if (!verdict.allowed) {
      await this.refuse(verdict.retryAfterSeconds, 'ip', req.ip ?? 'unknown', res);
    }

    let user: Awaited<ReturnType<typeof this.auth.register>>;
    try {
      user = await this.auth.register(body);
    } catch (e) {
      // A refused registration spends the attempt: "this address is taken" is
      // the enumeration answer somebody would script for.
      await this.throttle.recordFailure(ipKey, AUTH_LIMITS.registerPerIp);
      throw e;
    }
    await this.audit.record({
      action: 'auth.register',
      entityType: 'user',
      entityId: user.id,
      tenantId: null,
    });
    return { user };
  }

  @Public()
  @HttpCode(200)
  @Post('login')
  async login(
    @Body(new ZodPipe(loginSchema)) body: z.infer<typeof loginSchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    // Two keys, because either alone is bypassable: per-IP stops one source
    // working through a list, per-account stops a thousand IPs working through
    // one victim (docs/48 §2). The account key is the SUBMITTED address,
    // whether or not it exists — otherwise "this address throttles" would
    // answer the question the identical 401 bodies exist to leave unanswered.
    const ipKey = `login:ip:${req.ip ?? 'unknown'}`;
    const accountKey = `login:acct:${AuthThrottleService.accountKey(body.email)}`;
    for (const [key, rule] of [
      [ipKey, AUTH_LIMITS.loginPerIp],
      [accountKey, AUTH_LIMITS.loginPerAccount],
    ] as const) {
      const verdict = await this.throttle.check(key, rule);
      if (!verdict.allowed) {
        await this.refuse(
          verdict.retryAfterSeconds,
          key === ipKey ? 'ip' : 'account',
          key.split(':').pop() ?? 'unknown',
          res,
        );
      }
    }

    let user: Awaited<ReturnType<typeof this.auth.validateCredentials>>;
    try {
      user = await this.auth.validateCredentials(body.email, body.password);
    } catch (e) {
      // Only FAILURES spend an attempt (docs/48 §3).
      await Promise.all([
        this.throttle.recordFailure(ipKey, AUTH_LIMITS.loginPerIp),
        this.throttle.recordFailure(accountKey, AUTH_LIMITS.loginPerAccount),
      ]);
      throw e;
    }
    // …and a success clears the slate, so a person who finally remembers their
    // password is not locked out by the tries that got them there.
    await Promise.all([this.throttle.clear(ipKey), this.throttle.clear(accountKey)]);
    const tokens = await this.auth.issueTokens(user, {
      userAgent: req.header('user-agent') ?? undefined,
      ip: req.ip,
    });
    setSessionCookies(res, tokens);
    return { user };
  }

  @Public()
  @HttpCode(200)
  @Post('refresh')
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const raw = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE] ?? '';
    const { user, tokens } = await this.auth.rotate(raw, {
      userAgent: req.header('user-agent') ?? undefined,
      ip: req.ip,
    });
    setSessionCookies(res, tokens);
    return { user };
  }

  @Public()
  @HttpCode(204)
  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const raw = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    if (raw) await this.auth.revoke(raw);
    clearSessionCookies(res);
  }

  @Get('me')
  async me(@CurrentUser() user: AuthenticatedUser) {
    const me = await this.auth.me(user.userId);
    // What this caller may do IN THE TENANT they are addressing. A screen that
    // offers choices the server will refuse — an API-key scope picker, say —
    // teaches people to expect refusals. Prefer what the guard already loaded;
    // this route carries no permission requirement, so usually it loaded
    // nothing and we read it here instead. It grants nothing either way.
    const cached = this.cls.get(CLS_PERMISSIONS) as Set<string> | undefined;
    const tenantId = this.cls.get(CLS_TENANT_ID) as string | undefined;
    const permissions = cached?.size
      ? [...cached].sort()
      : tenantId
        ? await this.auth.permissionsIn(user.userId, tenantId)
        : [];
    return { ...me, permissions };
  }
}
