import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { CurrentUser, Public, type AuthenticatedUser } from '../../common/auth/decorators';
import { ACCESS_COOKIE } from '../../common/auth/jwt-auth.guard';
import { ZodPipe } from '../../common/validation/zod.pipe';
import { AuditService } from '../../common/audit/audit.service';
import { AuthService, type IssuedTokens, type SafeUser } from './auth.service';

export const REFRESH_COOKIE = 'aviora_refresh';

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
    this.setCookies(res, tokens);
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
    this.setCookies(res, tokens);
    return { user };
  }

  @Public()
  @HttpCode(204)
  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const raw = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    if (raw) await this.auth.revoke(raw);
    res.clearCookie(ACCESS_COOKIE, { path: '/' });
    res.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' });
  }

  @Get('me')
  async me(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.me(user.userId);
  }

  private setCookies(res: Response, tokens: IssuedTokens & { user?: SafeUser }) {
    const secure = process.env.NODE_ENV === 'production';
    res.cookie(ACCESS_COOKIE, tokens.accessToken, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: '/',
      maxAge: 15 * 60 * 1000,
    });
    res.cookie(REFRESH_COOKIE, tokens.refreshToken, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: '/api/v1/auth', // only sent to auth endpoints
      expires: tokens.refreshExpiresAt,
    });
  }
}
