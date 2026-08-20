import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { PERMISSIONS } from '@aviora/shared';
import { Public } from '../../common/auth/decorators';
import { ApiKeyGuard, RequireScopes } from './api-key.guard';
import { PublicApiService, type PageQuery } from './public.service';

/**
 * The public API (docs/30 §3, §6).
 *
 * `@Public()` here means "no session cookie and no JWT" — not "no
 * authentication". Every route below is behind ApiKeyGuard, which
 * authenticates the bearer key, binds the tenant the key belongs to, and
 * checks the scope named on the route against the scopes the key carries.
 *
 * There is no POST, PATCH or DELETE in this file. The public surface is
 * read-only this sprint, and a write route would need a whole conversation
 * about idempotency keys and replay that has not happened yet (docs/30 §3).
 */
@Controller('public')
@Public()
@UseGuards(ApiKeyGuard)
export class PublicApiController {
  constructor(private readonly api: PublicApiService) {}

  @Get('members')
  @RequireScopes(PERMISSIONS.MEMBER_VIEW)
  members(@Query('limit') limit?: string, @Query('cursor') cursor?: string) {
    return this.api.members(query(limit, cursor));
  }

  @Get('orders')
  @RequireScopes(PERMISSIONS.COMMERCE_ORDER_VIEW)
  orders(@Query('limit') limit?: string, @Query('cursor') cursor?: string) {
    return this.api.orders(query(limit, cursor));
  }

  @Get('ranks')
  @RequireScopes(PERMISSIONS.RANK_VIEW)
  ranks(@Query('limit') limit?: string, @Query('cursor') cursor?: string) {
    return this.api.ranks(query(limit, cursor));
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function query(limit: string | undefined, cursor: string | undefined): PageQuery {
  return {
    limit: limit ? Number(limit) : undefined,
    // A cursor is an id we handed out. Anything else is dropped rather than
    // passed to Prisma, which would answer with a database error message.
    cursor: cursor && UUID_RE.test(cursor) ? cursor : undefined,
  };
}
