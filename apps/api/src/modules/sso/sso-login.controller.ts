import { Controller, Get, Param, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { Public } from '../../common/auth/decorators';
import { ZodPipe } from '../../common/validation/zod.pipe';
import { AuthService } from '../identity/auth.service';
import { setSessionCookies } from '../identity/session-cookies';
import { SsoError } from './oidc';
import { toHttpException } from './sso-error';
import { SsoService } from './sso.service';

const startQuery = z.object({ redirectTo: z.string().max(512).optional() }).passthrough();

const callbackQuery = z
  .object({
    code: z.string().min(1).max(4096).optional(),
    state: z.string().min(1).max(512),
    error: z.string().max(200).optional(),
  })
  .passthrough();

const tenantSlugSchema = z.string().regex(/^[a-z0-9-]{3,40}$/);

/**
 * The public half of the OIDC flow (docs/31 §1, §4).
 *
 * Both routes are `@Public()` because neither can require a session: the first
 * is what somebody without one clicks, and the second is where the identity
 * provider — not the browser's cookie jar — sends them back. What the second
 * route produces is the platform's own session, issued by the same
 * `AuthService.issueTokens` password login uses and delivered in the same
 * cookies. Nothing downstream trusts anything the IdP said.
 *
 * Both write their response through `@Res()` because both end in a redirect.
 * Failures still travel through the global exception filter, so an SSO error
 * arrives in the same envelope as every other error in the API — carrying the
 * step that failed, and nothing from the token.
 */
@Controller('auth/sso')
export class SsoLoginController {
  constructor(
    private readonly sso: SsoService,
    private readonly auth: AuthService,
  ) {}

  @Public()
  @Get(':tenantSlug/start')
  async start(
    @Param('tenantSlug', new ZodPipe(tenantSlugSchema)) slug: string,
    @Query(new ZodPipe(startQuery)) query: z.infer<typeof startQuery>,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    try {
      const { authorizationUrl } = await this.sso.start(slug, query.redirectTo, apiOrigin(req));
      // 302: a step in a login, not a permanent fact about the URL.
      res.redirect(302, authorizationUrl);
    } catch (e) {
      throw toHttpException(e);
    }
  }

  @Public()
  @Get('callback')
  async callback(
    @Query(new ZodPipe(callbackQuery)) query: z.infer<typeof callbackQuery>,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    try {
      // The provider can refuse before we ever see a code. Its own error slug
      // is the most useful thing available and is not token material.
      if (query.error || !query.code) {
        throw new SsoError(
          'token_exchange',
          'The identity provider did not return an authorization code ' +
            `(${query.error ?? 'no code in the callback'})`,
        );
      }

      const result = await this.sso.callback(query.state, query.code, apiOrigin(req));
      const tokens = await this.auth.issueTokens(result.user, {
        userAgent: req.header('user-agent') ?? undefined,
        ip: req.ip,
      });
      setSessionCookies(res, tokens);
      // `safeRedirectPath` has already refused anything off-site.
      res.redirect(302, result.redirectTo);
    } catch (e) {
      throw toHttpException(e);
    }
  }
}

/**
 * The base this API is being reached at, used only when no redirect URI is
 * configured (see `redirectUri` in sso.service.ts). Built from the request's
 * own protocol and host — which is why the configured value takes precedence.
 */
function apiOrigin(req: Request): string {
  const host = req.get('host');
  if (!host) return '';
  const proto = req.protocol || 'http';
  return `${proto}://${host}/api/v1`;
}
