import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';
import { PERMISSIONS } from '@aviora/shared';
import {
  CurrentUser,
  RequirePermissions,
  type AuthenticatedUser,
} from '../../common/auth/decorators';
import { CLS_MEMBER_ID } from '../../common/auth/permissions.guard';
import { ZodPipe } from '../../common/validation/zod.pipe';
import type { TeamActor } from '../team/team-scope.service';
import { CrmService } from './crm.service';

const PLATFORM_BYPASS = new Set(['PLATFORM_OWNER', 'SUPER_ADMIN']);

const leadSchema = z.object({
  name: z.string().min(1).max(160),
  email: z.string().email().optional(),
  phone: z.string().max(40).optional(),
  source: z.string().max(80).optional(),
  notes: z.string().max(4000).optional(),
  stageId: z.string().uuid().optional(),
});

const leadUpdateSchema = z.object({
  name: z.string().min(1).max(160).optional(),
  email: z.string().email().optional(),
  phone: z.string().max(40).optional(),
  notes: z.string().max(4000).optional(),
  stageId: z.string().uuid().optional(),
  status: z.enum(['open', 'lost', 'converted']).optional(),
});

const stageSchema = z.object({
  code: z.string().regex(/^[a-z0-9-]{2,40}$/),
  name: z.string().min(1).max(80),
  order: z.number().int().min(1).max(100),
  isTerminal: z.boolean().optional(),
  isWon: z.boolean().optional(),
});

const followUpSchema = z.object({
  title: z.string().min(1).max(200),
  dueAt: z.coerce.date(),
  notes: z.string().max(2000).optional(),
  leadId: z.string().uuid().optional(),
  customerId: z.string().uuid().optional(),
});

const interactionSchema = z.object({
  summary: z.string().min(1).max(2000),
  channel: z.enum(['note', 'call', 'meeting', 'email', 'line', 'chat']).optional(),
  leadId: z.string().uuid().optional(),
  customerId: z.string().uuid().optional(),
});

@Controller('crm')
export class CrmController {
  constructor(
    private readonly crm: CrmService,
    private readonly cls: ClsService,
  ) {}

  private actor(user: AuthenticatedUser): TeamActor {
    return {
      memberId: (this.cls.get(CLS_MEMBER_ID) as string | undefined) ?? null,
      platformBypass: !!user.platformRole && PLATFORM_BYPASS.has(user.platformRole),
    };
  }

  @Get('stages')
  @RequirePermissions(PERMISSIONS.CRM_LEAD_VIEW)
  async stages() {
    return { stages: await this.crm.stages() };
  }

  @Post('stages')
  @RequirePermissions(PERMISSIONS.CRM_PIPELINE_MANAGE)
  async createStage(@Body(new ZodPipe(stageSchema)) body: z.infer<typeof stageSchema>) {
    return { stage: await this.crm.createStage(body) };
  }

  @Get('pipeline')
  @RequirePermissions(PERMISSIONS.CRM_LEAD_VIEW)
  async pipeline(@CurrentUser() user: AuthenticatedUser) {
    return await this.crm.pipelineSummary(this.actor(user));
  }

  @Get('leads')
  @RequirePermissions(PERMISSIONS.CRM_LEAD_VIEW)
  async listLeads(
    @CurrentUser() user: AuthenticatedUser,
    @Query('status') status?: string,
    @Query('stageId') stageId?: string,
  ) {
    return { leads: await this.crm.listLeads(this.actor(user), { status, stageId }) };
  }

  @Get('leads/:id')
  @RequirePermissions(PERMISSIONS.CRM_LEAD_VIEW)
  async getLead(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return { lead: await this.crm.getLead(id, this.actor(user)) };
  }

  @Post('leads')
  @RequirePermissions(PERMISSIONS.CRM_LEAD_MANAGE)
  async createLead(
    @Body(new ZodPipe(leadSchema)) body: z.infer<typeof leadSchema>,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return { lead: await this.crm.createLead(body, this.actor(user), user.userId) };
  }

  @Patch('leads/:id')
  @RequirePermissions(PERMISSIONS.CRM_LEAD_MANAGE)
  async updateLead(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(leadUpdateSchema)) body: z.infer<typeof leadUpdateSchema>,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return { lead: await this.crm.updateLead(id, body, this.actor(user), user.userId) };
  }

  @Post('leads/:id/convert')
  @RequirePermissions(PERMISSIONS.CRM_LEAD_MANAGE)
  async convertLead(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return { customer: await this.crm.convertLead(id, this.actor(user), user.userId) };
  }

  @Get('customers')
  @RequirePermissions(PERMISSIONS.CRM_CUSTOMER_VIEW)
  async listCustomers(@CurrentUser() user: AuthenticatedUser) {
    return { customers: await this.crm.listCustomers(this.actor(user)) };
  }

  @Get('follow-ups')
  @RequirePermissions(PERMISSIONS.CRM_LEAD_VIEW)
  async listFollowUps(@CurrentUser() user: AuthenticatedUser, @Query('all') all?: string) {
    return { followUps: await this.crm.listFollowUps(this.actor(user), all !== 'true') };
  }

  @Post('follow-ups')
  @RequirePermissions(PERMISSIONS.CRM_LEAD_MANAGE)
  async createFollowUp(
    @Body(new ZodPipe(followUpSchema)) body: z.infer<typeof followUpSchema>,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return { followUp: await this.crm.createFollowUp(body, this.actor(user)) };
  }

  @Patch('follow-ups/:id/complete')
  @RequirePermissions(PERMISSIONS.CRM_LEAD_MANAGE)
  async completeFollowUp(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return { followUp: await this.crm.completeFollowUp(id, this.actor(user)) };
  }

  @Post('interactions')
  @RequirePermissions(PERMISSIONS.CRM_LEAD_MANAGE)
  async logInteraction(
    @Body(new ZodPipe(interactionSchema)) body: z.infer<typeof interactionSchema>,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return { interaction: await this.crm.logInteraction(body, this.actor(user)) };
  }
}
