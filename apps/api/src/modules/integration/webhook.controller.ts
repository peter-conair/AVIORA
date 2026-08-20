import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import { PERMISSIONS } from '@aviora/shared';
import { RequirePermissions } from '../../common/auth/decorators';
import { ZodPipe } from '../../common/validation/zod.pipe';
import { SUBSCRIBABLE_EVENTS, endpointCreateSchema, endpointUpdateSchema } from './webhook';
import { WebhookService } from './webhook.service';

/**
 * Webhook administration (docs/30 §6). Integration machinery, so every route
 * is `integration.manage` and no entitlement gates it.
 *
 * `POST /webhooks/endpoints` is the ONLY route in the codebase that returns an
 * endpoint secret, and it returns it once. There is no route to read one back.
 */
@Controller('webhooks')
export class WebhookController {
  constructor(private readonly webhooks: WebhookService) {}

  @Get('endpoints')
  @RequirePermissions(PERMISSIONS.INTEGRATION_MANAGE)
  async list() {
    return {
      endpoints: await this.webhooks.list(),
      // The events an endpoint may subscribe to, so an admin screen never has
      // to hardcode the catalog and can never offer one the server refuses.
      subscribableEvents: SUBSCRIBABLE_EVENTS,
    };
  }

  @Post('endpoints')
  @RequirePermissions(PERMISSIONS.INTEGRATION_MANAGE)
  async create(
    @Body(new ZodPipe(endpointCreateSchema)) body: z.infer<typeof endpointCreateSchema>,
  ) {
    const { endpoint, secret } = await this.webhooks.create(body);
    return {
      endpoint,
      secret,
      secretNote:
        'This secret is shown once. Store it now — it cannot be read back, and a lost ' +
        'secret means a new endpoint.',
    };
  }

  @Patch('endpoints/:id')
  @RequirePermissions(PERMISSIONS.INTEGRATION_MANAGE)
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(endpointUpdateSchema)) body: z.infer<typeof endpointUpdateSchema>,
  ) {
    return { endpoint: await this.webhooks.update(id, body) };
  }

  @Delete('endpoints/:id')
  @RequirePermissions(PERMISSIONS.INTEGRATION_MANAGE)
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    return { deleted: true, ...(await this.webhooks.remove(id)) };
  }

  @Get('deliveries')
  @RequirePermissions(PERMISSIONS.INTEGRATION_MANAGE)
  async deliveries(
    @Query('endpointId') endpointId?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    return {
      deliveries: await this.webhooks.deliveries({
        endpointId,
        status,
        limit: limit ? Number(limit) : undefined,
      }),
    };
  }

  @Post('deliveries/:id/retry')
  @RequirePermissions(PERMISSIONS.INTEGRATION_MANAGE)
  async retry(@Param('id', ParseUUIDPipe) id: string) {
    return { delivery: await this.webhooks.retry(id) };
  }
}
