import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { PERMISSIONS } from '@aviora/shared';
import { RequirePermissions } from '../../common/auth/decorators';
import { ZodPipe } from '../../common/validation/zod.pipe';
import { RuleService } from './rule.service';
import { ruleInputSchema } from './rules';

const updateSchema = z.object({
  name: z.string().min(1).max(160).optional(),
  priority: z.number().int().min(0).max(10_000).optional(),
  status: z.enum(['active', 'disabled', 'archived']).optional(),
});

/**
 * Automation is tenant machinery rather than a member capability, so these
 * routes are permission-scoped and no entitlement gates them (docs/27 §4).
 */
@Controller('automation')
export class RuleController {
  constructor(private readonly rules: RuleService) {}

  @Get('rules')
  @RequirePermissions(PERMISSIONS.AUTOMATION_MANAGE)
  async list() {
    return { rules: await this.rules.list() };
  }

  @Post('rules')
  @RequirePermissions(PERMISSIONS.AUTOMATION_MANAGE)
  async create(@Body(new ZodPipe(ruleInputSchema)) body: z.infer<typeof ruleInputSchema>) {
    return { rule: await this.rules.create(body) };
  }

  @Patch('rules/:id')
  @RequirePermissions(PERMISSIONS.AUTOMATION_MANAGE)
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateSchema)) body: z.infer<typeof updateSchema>,
  ) {
    return { rule: await this.rules.update(id, body) };
  }

  @Get('executions')
  @RequirePermissions(PERMISSIONS.AUTOMATION_MANAGE)
  async executions(
    @Query('ruleId') ruleId?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    return {
      executions: await this.rules.executions({
        ruleId,
        status,
        limit: limit ? Number(limit) : undefined,
      }),
    };
  }
}
