import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { z } from 'zod';
import { PERMISSIONS } from '@aviora/shared';
import { RequirePermissions } from '../../common/auth/decorators';
import { ZodPipe } from '../../common/validation/zod.pipe';
import { apiKeyCreateSchema } from './api-key';
import { ApiKeyService } from './api-key.service';

/**
 * API key administration (docs/30 §6). Listings carry prefixes, never keys;
 * creation returns the key exactly once and nothing returns it again.
 */
@Controller('api-keys')
export class ApiKeyController {
  constructor(private readonly keys: ApiKeyService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.INTEGRATION_MANAGE)
  async list() {
    return { apiKeys: await this.keys.list() };
  }

  @Post()
  @RequirePermissions(PERMISSIONS.INTEGRATION_MANAGE)
  async create(@Body(new ZodPipe(apiKeyCreateSchema)) body: z.infer<typeof apiKeyCreateSchema>) {
    const { apiKey, key } = await this.keys.create(body);
    return {
      apiKey,
      key,
      keyNote: 'This key is shown once. It is stored only as a hash and cannot be read back.',
    };
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.INTEGRATION_MANAGE)
  async revoke(@Param('id', ParseUUIDPipe) id: string) {
    return { apiKey: await this.keys.revoke(id) };
  }
}
