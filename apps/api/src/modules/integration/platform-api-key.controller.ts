import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { RequirePlatformRoles } from '../../common/auth/decorators';
import { ZodPipe } from '../../common/validation/zod.pipe';
import { apiKeyCreateSchema, type ApiKeyCreate } from './api-key';
import { ApiKeyService } from './api-key.service';

/**
 * Keys that belong to no tenant (docs/74 §2).
 *
 * A separate controller from `/api-keys`, not a flag on it. That route is
 * reached with `integration.manage`, which every tenant owner holds — and a
 * platform key writes the catalogue every tenant reads. The two are gated on
 * different things and mint from different tables, so they are different
 * routes; giving one route a "platform: true" body field would put the whole
 * distinction inside an `if` that somebody eventually inverts.
 *
 * The scopes such a key may carry are the ordinary vocabulary, so a platform
 * key is not "a key that may do anything" — it is a key that names no tenant.
 * What it may DO is still the list it was minted with.
 */
@RequirePlatformRoles('PLATFORM_OWNER', 'SUPER_ADMIN')
@Controller('platform/api-keys')
export class PlatformApiKeyController {
  constructor(private readonly keys: ApiKeyService) {}

  @Get()
  async list() {
    return { apiKeys: await this.keys.listPlatform() };
  }

  @Post()
  async create(@Body(new ZodPipe(apiKeyCreateSchema)) body: ApiKeyCreate) {
    const { apiKey, key } = await this.keys.createPlatform(body);
    // `key` appears here and nowhere else, ever. Losing it means minting a new
    // one, which is the correct cost of a secret that is never stored in clear.
    return { apiKey, key };
  }

  @Delete(':id')
  async revoke(@Param('id', ParseUUIDPipe) id: string) {
    return { apiKey: await this.keys.revokePlatform(id) };
  }
}
