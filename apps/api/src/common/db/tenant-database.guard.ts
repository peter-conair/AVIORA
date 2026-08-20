import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { ERROR_CODES } from '@aviora/shared';
import { CLS_TENANT_ID } from '../tenant/tenant-context.middleware';
import { TenantDatabaseResolver } from './tenant-database.resolver';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Routes that keep answering while a tenant is being moved.
 *
 * Authentication is cross-tenant by design and writes only PLATFORM-GLOBAL
 * rows — `users.last_login_at`, `refresh_tokens` — none of which travel with a
 * tenant. Refusing them would lock a tenant's people out of the read-only
 * product they are supposed to still be able to read, and would achieve
 * nothing for the migration: not one row in the extract would change.
 *
 * The platform surface is exempt for the opposite reason: it is the surface an
 * operator uses to run the migration.
 */
const EXEMPT = [/^\/api\/v1\/auth\//, /^\/api\/v1\/platform\//];

/**
 * `status = 'migrating'` makes a tenant read-only AT THE API EDGE (docs/31 §2).
 *
 * The reason it is a guard and not a discipline: a migration that accepts
 * writes it is about to discard is a migration that loses data, and "remember
 * not to write during the cutover" is not a mechanism. Every mutating verb is
 * refused with 503 and a message that says why, so the person who hits it
 * learns the tenant is mid-move rather than that something is broken.
 *
 * When no tenant is migrating — which is every tenant today — this costs one
 * empty-map lookup per mutating request and nothing else.
 */
@Injectable()
export class TenantDatabaseGuard implements CanActivate {
  constructor(
    private readonly cls: ClsService,
    private readonly resolver: TenantDatabaseResolver,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (!MUTATING.has(req.method)) return true;

    const tenantId = this.cls.get(CLS_TENANT_ID) as string | undefined;
    if (!tenantId) return true; // platform / unresolved — nothing tenant-keyed to protect

    const path = req.originalUrl.split('?')[0] ?? '';
    if (EXEMPT.some((re) => re.test(path))) return true;

    // Read, not cached. A tenant goes read-only the moment an operator says so
    // — see TenantDatabaseResolver.isMigrating for why a cache here would be a
    // window in which writes are accepted and then thrown away.
    if (!(await this.resolver.isMigrating(tenantId))) return true;

    const placement = this.resolver.placementFor(tenantId);
    const res = ctx.switchToHttp().getResponse<Response>();
    res.setHeader('Retry-After', '900');
    throw new ServiceUnavailableException({
      code: ERROR_CODES.TENANT_READ_ONLY,
      message:
        'This workspace is temporarily read-only while its data is being moved to a ' +
        'dedicated database. Reading works as normal; changes are refused rather than ' +
        'accepted and then discarded.',
      details: {
        tenantDatabaseStatus: placement.status,
        ...(placement.notes ? { notes: placement.notes } : {}),
      },
    });
  }
}
