import {
  BadRequestException,
  HttpException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ERROR_CODES } from '@aviora/shared';
import { SsoError, type SsoStep } from './oidc';

/**
 * Which HTTP answer each failed step deserves.
 *
 * `configuration` and `discovery` are 400/502 rather than 401 because nothing
 * is wrong with the person signing in — the workspace's setup or the
 * provider's availability is. Telling somebody "unauthorized" when their
 * administrator typed the wrong discovery URL sends them to the wrong place.
 */
const STATUS_BY_STEP: Record<SsoStep, number> = {
  configuration: 400,
  discovery: 502,
  state: 401,
  token_exchange: 502,
  signature: 401,
  claims: 401,
  nonce: 401,
  domain: 403,
  provisioning: 403,
};

/**
 * Turns an SSO failure into an answer that says WHICH STEP failed (docs/31)
 * and nothing about what was in the token.
 *
 * The step is the whole point: "discovery" sends an administrator to their
 * IdP's metadata URL, "nonce" to their session handling, "domain" to their
 * allowed-domains list, "provisioning" to their invitation process. A single
 * "SSO failed" sends them to a support ticket.
 *
 * What never appears here: an id_token, an access token, an authorization
 * code, a client secret, or a provider's response body. The messages are
 * written by this codebase, not echoed from a wire.
 */
export function toHttpException(e: unknown): HttpException {
  if (!(e instanceof SsoError)) {
    return e instanceof HttpException
      ? e
      : new ServiceUnavailableException({
          code: ERROR_CODES.INTERNAL,
          message: 'Single sign-on could not be completed',
          details: { step: 'unknown' },
        });
  }
  const status = STATUS_BY_STEP[e.step];
  const body = {
    code: status === 403 ? ERROR_CODES.FORBIDDEN : codeFor(status),
    message: e.message,
    details: { step: e.step },
  };
  if (status === 400) return new BadRequestException(body);
  if (status === 401) return new UnauthorizedException(body);
  if (status === 403) return new HttpException(body, 403);
  return new HttpException(body, status);
}

function codeFor(status: number) {
  if (status === 400) return ERROR_CODES.VALIDATION_FAILED;
  if (status === 401) return ERROR_CODES.UNAUTHENTICATED;
  return ERROR_CODES.INTERNAL;
}
