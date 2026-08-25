import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { ERROR_CODES, PERMISSIONS } from '@aviora/shared';
import { Public } from '../../common/auth/decorators';
import { ZodPipe } from '../../common/validation/zod.pipe';
import type { ApiKeyRequest } from './api-key';
import { ApiKeyGuard, RequirePlatformKey, RequireScopes } from './api-key.guard';
import { ingestRequestSchema, type IngestRequest } from './catalog-ingest';
import { CatalogIngestService } from './catalog-ingest.service';
import { IdempotencyService } from './idempotency.service';
import { PublicApiService, type PageQuery } from './public.service';

/**
 * The public API (docs/30 §3, §6).
 *
 * `@Public()` here means "no session cookie and no JWT" — not "no
 * authentication". Every route below is behind ApiKeyGuard, which
 * authenticates the bearer key, binds the tenant the key belongs to, and
 * checks the scope named on the route against the scopes the key carries.
 *
 * The reads are tenant-scoped: the key names its tenant and sees that tenant
 * only. The one WRITE is the opposite — it edits the global knowledge
 * catalogue, which belongs to no tenant, so it takes a platform key and refuses
 * a tenant one (docs/74). `@RequirePlatformKey` is what enforces that, in both
 * directions: without it a platform key cannot reach a route, and with it a
 * tenant key cannot.
 *
 * That write is the only one, and adding a second is not a small change: a
 * public write needs a retry story before it needs anything else, which is what
 * `IdempotencyService` is and why it is threaded through here rather than left
 * to the service underneath.
 */
@Controller('public')
@Public()
@UseGuards(ApiKeyGuard)
export class PublicApiController {
  constructor(
    private readonly api: PublicApiService,
    private readonly ingest: CatalogIngestService,
    private readonly idempotency: IdempotencyService,
  ) {}

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

  /**
   * Products into the global catalogue (docs/74).
   *
   * Answers 200 with a per-product verdict rather than 201 with a list of ids:
   * a batch in which some rows are refused is neither created nor failed, and
   * the sender's next question is always "which ones" (docs/74 §1).
   */
  @Post('knowledge/products')
  // 200, not the 201 a POST defaults to: a batch that refused every row created
  // nothing, and there is no single resource to point a Location at.
  @HttpCode(200)
  @RequirePlatformKey()
  @RequireScopes(PERMISSIONS.PLATFORM_KNOWLEDGE_CATALOG_MANAGE)
  async ingestProducts(
    @Body(new ZodPipe(ingestRequestSchema)) body: IngestRequest,
    @Req() req: Request & ApiKeyRequest,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    // The guard put it there; if it is missing the guard did not run, and
    // guessing a caller is worse than refusing one.
    const key = req.apiKey;
    if (!key) {
      throw new UnauthorizedException({
        code: ERROR_CODES.UNAUTHENTICATED,
        message: 'A valid API key is required',
      });
    }

    const { response, replayed } = await this.idempotency.run(
      {
        callerId: key.keyId,
        route: 'POST /public/knowledge/products',
        key: idempotencyKey?.trim() || null,
        body,
      },
      () => this.ingest.ingest(body, key.name),
    );
    // Said out loud rather than inferred from the counts: a replay reports the
    // FIRST attempt's verdict, and a caller comparing it against what it just
    // sent needs to know that is what it is reading.
    return { ...response, replayed };
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
