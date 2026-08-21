import { Injectable } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { EVENTS } from '@aviora/shared';
import { REQUIRED_SCOPES } from './api-key.guard';
import { PublicApiController } from './public.controller';
import { PUBLIC_RATE_LIMIT_WINDOW_MS, PUBLIC_RATE_LIMIT_DEFAULT } from './rate-limit';

/**
 * The API's description of itself (docs/47).
 *
 * Every part of this is READ FROM THE APPLICATION: the endpoints from the
 * controller's own metadata, the scopes from the decorator that gates each
 * route, the events from the shared catalog. Nothing here is a list somebody
 * has to remember to update.
 *
 * That is not tidiness. A hand-maintained API description drifts, and a drifted
 * description is worse than none — it looks authoritative while telling an
 * integrator to call something that no longer exists.
 */

export interface CatalogEndpoint {
  method: string;
  path: string;
  scope: string | null;
}

/**
 * What this API will never do, named next to what it does (docs/47 §3).
 * An integrator planning around a capability that is never coming has wasted
 * their time, and they cannot tell "not yet" from "never" by reading a list of
 * endpoints.
 */
const REFUSALS = [
  'No health data of any kind, for any member, in any aggregate — it is visible ' +
    'to the member alone unless they grant it to a named person (docs/13).',
  'No cross-tenant reads. A key belongs to one tenant and sees that tenant only.',
  'No payment execution. Orders and commissions are recorded; moving money needs ' +
    'a payout provider this platform does not have (docs/24, docs/26 §9).',
  'No wildcard scopes. A key lists what it may do (docs/30 §7).',
];

@Injectable()
export class CatalogService {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  /** Endpoints of the public API, with the scope each one requires. */
  endpoints(): CatalogEndpoint[] {
    const prefix = Reflect.getMetadata(PATH_METADATA, PublicApiController) as string;
    const instance = new PublicApiController(null as never);
    const proto = Object.getPrototypeOf(instance);

    const found: CatalogEndpoint[] = [];
    for (const key of this.scanner.getAllMethodNames(proto)) {
      const handler = proto[key] as (...args: unknown[]) => unknown;
      const path = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
      if (path === undefined) continue;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod;
      const scopes = this.reflector.get<string[]>(REQUIRED_SCOPES, handler);
      found.push({
        method: RequestMethod[method] ?? 'GET',
        path: `/api/v1/${prefix}/${path}`.replace(/\/+/g, '/').replace(/\/$/, ''),
        // One scope per route today; the array shape is the decorator's, and
        // reporting the first would hide a second if one ever appeared.
        scope: scopes?.length ? scopes.join(' ') : null,
      });
    }
    return found.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  }

  catalog() {
    const endpoints = this.endpoints();
    return {
      version: 'v1',
      description:
        'A description of this API, generated from the running application. It is ' +
        'not an OpenAPI document and does not pretend to be one (docs/47 §4).',
      authentication: {
        scheme: 'Bearer',
        header: 'Authorization',
        keyPrefix: 'ak_',
        note: 'Keys are minted by a tenant and carry explicit scopes.',
      },
      rateLimit: {
        requests: PUBLIC_RATE_LIMIT_DEFAULT,
        windowSeconds: PUBLIC_RATE_LIMIT_WINDOW_MS / 1000,
        headers: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
        note: 'The limit is stated in every response, so a caller never has to guess.',
      },
      endpoints,
      scopes: [
        ...new Set(endpoints.map((e) => e.scope).filter((s): s is string => s !== null)),
      ].sort(),
      events: Object.values(EVENTS)
        .map((name) => ({ name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      webhooks: {
        signature: 'HMAC-SHA256 over the raw body',
        header: 'X-Aviora-Signature',
        note: 'Deliveries retry with backoff; each event reaches an endpoint once.',
      },
      refuses: REFUSALS,
    };
  }
}
