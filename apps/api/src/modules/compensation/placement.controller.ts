import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { PERMISSIONS } from '@aviora/shared';
import {
  CurrentUser,
  RequirePermissions,
  type AuthenticatedUser,
} from '../../common/auth/decorators';
import { ZodPipe } from '../../common/validation/zod.pipe';
import { PlacementService } from './placement.service';

const createSchema = z.object({
  uplineMemberId: z.string().uuid(),
  downlineMemberId: z.string().uuid(),
  metadata: z.record(z.unknown()).optional(),
});

/**
 * The placement graph is administration: it is permission-scoped only, since
 * entitlements come from a member's plan and a tenant owner holds none
 * (docs/24 §2, docs/26 §6).
 */
@Controller('compensation/graph')
export class PlacementController {
  constructor(private readonly placements: PlacementService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.COMPENSATION_MANAGE)
  async list(@Query('includeEnded') includeEnded?: string, @Query('limit') limit?: string) {
    const parsed = Number.parseInt(limit ?? '', 10);
    return {
      placements: await this.placements.list({
        includeEnded: includeEnded === 'true',
        limit: Number.isFinite(parsed) ? parsed : undefined,
      }),
    };
  }

  @Post()
  @RequirePermissions(PERMISSIONS.COMPENSATION_MANAGE)
  async create(
    @Body(new ZodPipe(createSchema)) body: z.infer<typeof createSchema>,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return { placement: await this.placements.create(body, user.userId) };
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.COMPENSATION_MANAGE)
  async end(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return { placement: await this.placements.end(id, user.userId) };
  }
}
