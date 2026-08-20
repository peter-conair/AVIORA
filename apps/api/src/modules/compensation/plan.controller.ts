import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { z } from 'zod';
import { PERMISSIONS } from '@aviora/shared';
import { RequirePermissions } from '../../common/auth/decorators';
import { ZodPipe } from '../../common/validation/zod.pipe';
import { PlanService } from './plan.service';
import { ruleSchema } from './rules';

const createSchema = z.object({
  code: z.string().regex(/^[a-z0-9-]{2,40}$/),
  name: z.string().min(1).max(160),
  description: z.string().max(2000).optional(),
  /** Defaults to the tenant's currency — a tenant has one, and two modules
   *  resolving it separately is how they end up disagreeing. */
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  status: z.enum(['active', 'archived']).optional(),
  effectiveFrom: z.coerce.date().optional(),
  effectiveTo: z.coerce.date().optional(),
  rules: z.array(ruleSchema).max(100).default([]),
});

/** Plan configuration is permission-scoped only (docs/26 §6). */
@Controller('compensation/plans')
export class PlanController {
  constructor(private readonly plans: PlanService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.COMPENSATION_MANAGE)
  async list() {
    return { plans: await this.plans.list() };
  }

  @Post()
  @RequirePermissions(PERMISSIONS.COMPENSATION_MANAGE)
  async create(@Body(new ZodPipe(createSchema)) body: z.infer<typeof createSchema>) {
    return { plan: await this.plans.create(body) };
  }

  @Post(':id/rules')
  @RequirePermissions(PERMISSIONS.COMPENSATION_MANAGE)
  async addRule(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(ruleSchema)) body: z.infer<typeof ruleSchema>,
  ) {
    return { rule: await this.plans.addRule(id, body) };
  }
}
