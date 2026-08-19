import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { PERMISSIONS } from '@aviora/shared';
import { RequirePermissions } from '../../common/auth/decorators';
import { ZodPipe } from '../../common/validation/zod.pipe';
import { PlansService } from './plans.service';

const upsertSchema = z.object({
  code: z.string().regex(/^[a-z0-9-]{2,40}$/),
  name: z.string().min(1).max(160),
  description: z.string().max(2000).optional(),
  membershipType: z.string().max(60).optional(),
  price: z.number().min(0).optional(),
  currency: z.string().length(3).optional(),
  billingCycle: z.enum(['monthly', 'quarterly', 'yearly', 'lifetime']).optional(),
  trialDays: z.number().int().min(0).max(365).optional(),
  entitlementKeys: z.array(z.string()).max(50).optional(),
});

const updateSchema = upsertSchema.partial();

@Controller('membership-plans')
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.MEMBERSHIP_PLAN_VIEW)
  async list() {
    return { plans: await this.plans.list() };
  }

  @Get('entitlements/catalog')
  @RequirePermissions(PERMISSIONS.MEMBERSHIP_PLAN_VIEW)
  async catalog() {
    return { entitlements: await this.plans.listEntitlements() };
  }

  @Post()
  @RequirePermissions(PERMISSIONS.MEMBERSHIP_PLAN_MANAGE)
  async create(@Body(new ZodPipe(upsertSchema)) body: z.infer<typeof upsertSchema>) {
    return { plan: await this.plans.create(body) };
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.MEMBERSHIP_PLAN_MANAGE)
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateSchema)) body: z.infer<typeof updateSchema>,
  ) {
    return { plan: await this.plans.update(id, body) };
  }
}
