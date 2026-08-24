import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ERROR_CODES } from '@aviora/shared';
import { Public } from '../../common/auth/decorators';
import { devLoginEnabled } from '../../common/auth/dev-login';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../common/db/prisma.service';
import { ZodPipe } from '../../common/validation/zod.pipe';
import { AuthService, type SafeUser } from './auth.service';
import { setSessionCookies } from './session-cookies';

/** Enough to choose from; not so many that the picker becomes its own search problem. */
const LIST_LIMIT = 25;

/**
 * The address shapes the e2e suite manufactures — and the reason this list
 * needs an opinion at all. A working database here carries ten thousand of
 * these against seven accounts a person actually signs in as, so showing
 * everything by default shows nothing useful. They are hidden, never dropped:
 * the response says how many, and `all=1` brings them straight back.
 */
const TEST_ACCOUNT_SUFFIXES = ['@test.local', '.example'];

const loginSchema = z.object({ userId: z.string().uuid() });

/**
 * Sign in as anybody, without their password — development only.
 *
 * Local work spends a surprising amount of time proving who you are to your own
 * machine: a member, a team leader, a tenant owner and a platform admin are four
 * different products, and reaching each one through the real form means keeping
 * four passwords for accounts that only exist on one laptop. This is the door
 * that skips that, and it is a complete authentication bypass — which is why it
 * is registered only when {@link devLoginEnabled} agrees, re-checks the same
 * condition on every request, and answers a disabled probe with the 404 a
 * missing route would give rather than a 403 that would confirm it exists.
 *
 * What it does NOT skip: the session it hands back is the ordinary one. Same
 * tokens, same cookies, same rotation, same audit trail — so everything
 * downstream behaves exactly as it will for a real sign-in, which is the whole
 * point of using it to test.
 */
@Controller('dev')
export class DevAuthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The second gate. AppModule already declined to register this controller in
   * production, so reaching here means the flag was on at boot — checking again
   * costs nothing and closes the gap where a future refactor registers the
   * routes unconditionally and nobody notices until it ships.
   */
  private assertEnabled(): void {
    if (!devLoginEnabled()) {
      throw new NotFoundException({
        code: ERROR_CODES.NOT_FOUND,
        message: 'Cannot GET /dev',
      });
    }
  }

  /**
   * The accounts worth offering, newest-and-most-used first.
   *
   * A working database accumulates thousands of throwaway e2e users, so an
   * unfiltered list would bury the three accounts a developer actually signs in
   * as. Ordering puts platform admins at the top, then whoever signed in most
   * recently — which is a good guess at who you want next — and `q` covers the
   * rest.
   */
  @Public()
  @Get('users')
  async users(@Query('q') q?: string, @Query('all') all?: string) {
    this.assertEnabled();
    const search = (q ?? '').trim().slice(0, 120);
    const includeTestAccounts = all === '1' || all === 'true';
    const notATestAccount = {
      AND: TEST_ACCOUNT_SUFFIXES.map((suffix) => ({ email: { not: { endsWith: suffix } } })),
    };
    const where = {
      status: 'active',
      ...(includeTestAccounts ? {} : notATestAccount),
      ...(search
        ? {
            OR: [
              { email: { contains: search, mode: 'insensitive' as const } },
              { displayName: { contains: search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [users, hidden] = await Promise.all([
      this.prisma.app.user.findMany({
        where,
        select: { id: true, email: true, displayName: true, platformRole: true },
        orderBy: [
          { platformRole: { sort: 'asc', nulls: 'last' } },
          { lastLoginAt: { sort: 'desc', nulls: 'last' } },
          { createdAt: 'desc' },
        ],
        take: LIST_LIMIT,
      }),
      // What the filter is keeping back, so the picker can offer it rather than
      // leaving somebody to wonder why the account they just created is missing.
      includeTestAccounts
        ? Promise.resolve(0)
        : this.prisma.app.user.count({
            where: {
              status: 'active',
              NOT: notATestAccount,
              ...(search
                ? {
                    OR: [
                      { email: { contains: search, mode: 'insensitive' as const } },
                      { displayName: { contains: search, mode: 'insensitive' as const } },
                    ],
                  }
                : {}),
            },
          }),
    ]);

    // Which tenants each one lands in, so the picker can say "beta admin —
    // Beta Wellness" instead of making you sign in to find out. Read as owner
    // for the same reason /auth/me does: memberships are RLS-forced and no
    // tenant has been chosen yet.
    const memberships = users.length
      ? await this.prisma.owner.tenantMembership.findMany({
          where: { userId: { in: users.map((u) => u.id) }, status: 'active' },
          select: { userId: true, tenant: { select: { name: true } } },
        })
      : [];
    const byUser = new Map<string, string[]>();
    for (const m of memberships) {
      byUser.set(m.userId, [...(byUser.get(m.userId) ?? []), m.tenant.name]);
    }

    return {
      users: users.map((u) => ({ ...u, tenants: byUser.get(u.id) ?? [] })),
      hiddenTestAccounts: hidden,
    };
  }

  /** Issue a real session for a chosen user id, no password asked. */
  @Public()
  @HttpCode(200)
  @Post('login')
  async login(
    @Body(new ZodPipe(loginSchema)) body: z.infer<typeof loginSchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.assertEnabled();
    const user = await this.prisma.app.user.findUnique({ where: { id: body.userId } });
    // Suspended stays suspended. The point of this door is to skip the
    // password, not to make an account behave differently than it will in
    // production — a status check that only holds on the real form would make
    // dev the one place a disabled account works.
    if (!user || user.status !== 'active') {
      throw new UnauthorizedException({
        code: ERROR_CODES.UNAUTHENTICATED,
        message: 'No such active user',
      });
    }
    await this.prisma.app.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });
    const safe: SafeUser = {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      locale: user.locale,
      platformRole: user.platformRole,
    };
    const tokens = await this.auth.issueTokens(safe, {
      userAgent: req.header('user-agent') ?? undefined,
      ip: req.ip,
    });
    setSessionCookies(res, tokens);
    // Recorded under its own action rather than `auth.login`, so a trail read
    // later never mistakes a bypassed sign-in for a real one.
    await this.audit.record({
      action: 'auth.dev_login',
      entityType: 'user',
      entityId: user.id,
      tenantId: null,
    });
    return { user: safe };
  }
}
