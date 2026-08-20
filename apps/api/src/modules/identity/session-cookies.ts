import type { Response } from 'express';
import { ACCESS_COOKIE } from '../../common/auth/jwt-auth.guard';
import type { IssuedTokens } from './auth.service';

export const REFRESH_COOKIE = 'aviora_refresh';

/** Where the refresh cookie is sent — the auth surface and nowhere else. */
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

/**
 * The platform's session, on the wire (ADR-013).
 *
 * Shared rather than duplicated because SSO must end with EXACTLY the session
 * password login produces (docs/31 §1) — same cookies, same flags, same
 * lifetimes. Two copies of this would be two things to keep in step, and the
 * first divergence would be a federated session with weaker cookie flags than
 * a local one.
 */
export function setSessionCookies(res: Response, tokens: IssuedTokens): void {
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
    path: REFRESH_COOKIE_PATH,
    expires: tokens.refreshExpiresAt,
  });
}

export function clearSessionCookies(res: Response): void {
  res.clearCookie(ACCESS_COOKIE, { path: '/' });
  res.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });
}
