import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';
import { CurrentUser, Public, type AuthenticatedUser } from '../../common/auth/decorators';
import { CLS_PERMISSIONS } from '../../common/auth/permissions.guard';
import { CLS_TENANT_ID } from '../../common/tenant/tenant-context.middleware';
import { ZodPipe } from '../../common/validation/zod.pipe';
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
  ) {}

  @Public()
  @Post('register')
  async register(@Body(new ZodPipe(registerSchema)) body: z.infer<typeof registerSchema>) {
    const user = await this.auth.register(body);
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
    const user = await this.auth.validateCredentials(body.email, body.password);
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
