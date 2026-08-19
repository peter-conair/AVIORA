import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ERROR_CODES, EVENTS, PERMISSIONS } from '@aviora/shared';
import { appendEvent, type Tx } from '@aviora/db';
import { TenantDb } from '../../common/db/tenant-db.service';
import { AuditService } from '../../common/audit/audit.service';
import type { TeamActor } from '../team/team-scope.service';
import { CrmScopeService } from './crm-scope.service';

/** Default pipeline created on first use — tenants may rename/reorder freely. */
const DEFAULT_STAGES = [
  { code: 'new', name: 'New', order: 1 },
  { code: 'contacted', name: 'Contacted', order: 2 },
  { code: 'interested', name: 'Interested', order: 3 },
  { code: 'presentation', name: 'Presentation', order: 4 },
  { code: 'follow-up', name: 'Follow-up', order: 5 },
  { code: 'won', name: 'Customer', order: 6, isTerminal: true, isWon: true },
  { code: 'lost', name: 'Lost', order: 7, isTerminal: true },
];

@Injectable()
export class CrmService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly scope: CrmScopeService,
  ) {}

  private requireMember(actor: TeamActor): string {
    if (!actor.memberId) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'You are not a member of this tenant',
      });
    }
    return actor.memberId;
  }

  // ── pipeline ────────────────────────────────────────────────────────────

  /** Stages for the tenant; seeds the default pipeline on first read. */
  async stages() {
    return this.db.tx(async (tx) => {
      const existing = await tx.pipelineStage.findMany({ orderBy: { order: 'asc' } });
      if (existing.length > 0) return existing;
      await tx.pipelineStage.createMany({
        data: DEFAULT_STAGES.map((s) => ({ ...s, tenantId: this.db.tenantId })),
      });
      return tx.pipelineStage.findMany({ orderBy: { order: 'asc' } });
    });
  }

  async createStage(input: {
    code: string;
    name: string;
    order: number;
    isTerminal?: boolean;
    isWon?: boolean;
  }) {
    const stage = await this.db.tx(async (tx) => {
      const dup = await tx.pipelineStage.findFirst({ where: { code: input.code } });
      if (dup) {
        throw new ConflictException({
          code: ERROR_CODES.CONFLICT,
          message: 'Stage code already in use',
        });
      }
      return tx.pipelineStage.create({ data: { ...input, tenantId: this.db.tenantId } });
    });
    await this.audit.record({
      action: 'crm.stage.create',
      entityType: 'pipeline_stage',
      entityId: stage.id,
      after: { code: stage.code, name: stage.name, order: stage.order },
    });
    return stage;
  }

  // ── leads ───────────────────────────────────────────────────────────────

  async listLeads(actor: TeamActor, filter?: { status?: string; stageId?: string }) {
    return this.db.tx(async (tx) => {
      const owners = await this.scope.ownerMemberIds(tx, actor, PERMISSIONS.CRM_LEAD_VIEW);
      return tx.lead.findMany({
        where: {
          ...this.scope.whereOwner(owners),
          ...(filter?.status ? { status: filter.status } : {}),
          ...(filter?.stageId ? { stageId: filter.stageId } : {}),
        },
        orderBy: { createdAt: 'desc' },
        include: { stage: { select: { code: true, name: true, order: true } } },
      });
    });
  }

  async getLead(id: string, actor: TeamActor) {
    return this.db.tx(async (tx) => {
      const lead = await tx.lead.findFirst({
        where: { id },
        include: {
          stage: { select: { code: true, name: true } },
          followUps: { orderBy: { dueAt: 'asc' } },
          interactions: { orderBy: { occurredAt: 'desc' }, take: 50 },
        },
      });
      if (!lead) {
        throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Lead not found' });
      }
      await this.assertLeadAccess(tx, actor, lead.ownerMemberId, PERMISSIONS.CRM_LEAD_VIEW);
      return lead;
    });
  }

  async createLead(
    input: {
      name: string;
      email?: string;
      phone?: string;
      source?: string;
      notes?: string;
      stageId?: string;
    },
    actor: TeamActor,
    actorUserId: string,
  ) {
    const memberId = this.requireMember(actor);
    const lead = await this.db.tx(async (tx) => {
      let stageId = input.stageId ?? null;
      if (!stageId) {
        const first = await tx.pipelineStage.findFirst({ orderBy: { order: 'asc' } });
        stageId = first?.id ?? null;
      }
      const created = await tx.lead.create({
        data: {
          tenantId: this.db.tenantId,
          ownerMemberId: memberId,
          stageId,
          name: input.name,
          email: input.email,
          phone: input.phone,
          source: input.source,
          notes: input.notes,
        },
      });
      await appendEvent(tx, {
        eventName: EVENTS.LeadCreated,
        tenantId: this.db.tenantId,
        aggregateType: 'lead',
        aggregateId: created.id,
        actorUserId,
        payload: { ownerMemberId: memberId, name: created.name, source: created.source },
      });
      return created;
    });
    await this.audit.record({
      action: 'crm.lead.create',
      entityType: 'lead',
      entityId: lead.id,
      after: { name: lead.name, source: lead.source },
    });
    return lead;
  }

  async updateLead(
    id: string,
    input: {
      name?: string;
      email?: string;
      phone?: string;
      notes?: string;
      stageId?: string;
      status?: string;
    },
    actor: TeamActor,
    actorUserId: string,
  ) {
    const result = await this.db.tx(async (tx) => {
      const before = await tx.lead.findFirst({ where: { id } });
      if (!before) {
        throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Lead not found' });
      }
      await this.assertLeadAccess(tx, actor, before.ownerMemberId, PERMISSIONS.CRM_LEAD_MANAGE);
      if (input.stageId) {
        const stage = await tx.pipelineStage.findFirst({ where: { id: input.stageId } });
        if (!stage) {
          throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Stage not found' });
        }
      }
      const lead = await tx.lead.update({ where: { id }, data: input });
      if (input.stageId && input.stageId !== before.stageId) {
        await appendEvent(tx, {
          eventName: EVENTS.LeadStageChanged,
          tenantId: this.db.tenantId,
          aggregateType: 'lead',
          aggregateId: id,
          actorUserId,
          payload: { fromStageId: before.stageId, toStageId: input.stageId },
        });
      }
      return { before, lead };
    });
    await this.audit.record({
      action: 'crm.lead.update',
      entityType: 'lead',
      entityId: id,
      before: { stageId: result.before.stageId, status: result.before.status },
      after: { stageId: result.lead.stageId, status: result.lead.status },
    });
    return result.lead;
  }

  /** Lead → Customer (spec §34 pipeline end): idempotent, emits CustomerConverted. */
  async convertLead(id: string, actor: TeamActor, actorUserId: string) {
    const result = await this.db.tx(async (tx) => {
      const lead = await tx.lead.findFirst({ where: { id } });
      if (!lead) {
        throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Lead not found' });
      }
      await this.assertLeadAccess(tx, actor, lead.ownerMemberId, PERMISSIONS.CRM_LEAD_MANAGE);
      if (lead.convertedCustomerId) {
        const existing = await tx.customer.findFirst({ where: { id: lead.convertedCustomerId } });
        return { customer: existing!, alreadyConverted: true };
      }
      const customer = await tx.customer.create({
        data: {
          tenantId: this.db.tenantId,
          ownerMemberId: lead.ownerMemberId,
          name: lead.name,
          email: lead.email,
          phone: lead.phone,
          convertedFromLeadId: lead.id,
        },
      });
      const wonStage = await tx.pipelineStage.findFirst({ where: { isWon: true } });
      await tx.lead.update({
        where: { id },
        data: {
          status: 'converted',
          convertedCustomerId: customer.id,
          convertedAt: new Date(),
          ...(wonStage ? { stageId: wonStage.id } : {}),
        },
      });
      await appendEvent(tx, {
        eventName: EVENTS.CustomerConverted,
        tenantId: this.db.tenantId,
        aggregateType: 'customer',
        aggregateId: customer.id,
        actorUserId,
        payload: { leadId: id, ownerMemberId: lead.ownerMemberId, name: customer.name },
      });
      return { customer, alreadyConverted: false };
    });
    if (!result.alreadyConverted) {
      await this.audit.record({
        action: 'crm.lead.convert',
        entityType: 'customer',
        entityId: result.customer.id,
        after: { fromLeadId: id, name: result.customer.name },
      });
    }
    return result.customer;
  }

  // ── customers ───────────────────────────────────────────────────────────

  async listCustomers(actor: TeamActor) {
    return this.db.tx(async (tx) => {
      const owners = await this.scope.ownerMemberIds(tx, actor, PERMISSIONS.CRM_CUSTOMER_VIEW);
      return tx.customer.findMany({
        where: this.scope.whereOwner(owners),
        orderBy: { createdAt: 'desc' },
      });
    });
  }

  // ── follow-ups & interactions ───────────────────────────────────────────

  async listFollowUps(actor: TeamActor, onlyOpen = true) {
    return this.db.tx(async (tx) => {
      const owners = await this.scope.ownerMemberIds(tx, actor, PERMISSIONS.CRM_LEAD_VIEW);
      return tx.followUp.findMany({
        where: {
          ...this.scope.whereOwner(owners),
          ...(onlyOpen ? { status: 'open' } : {}),
        },
        orderBy: { dueAt: 'asc' },
        include: {
          lead: { select: { id: true, name: true } },
          customer: { select: { id: true, name: true } },
        },
      });
    });
  }

  async createFollowUp(
    input: { title: string; dueAt: Date; notes?: string; leadId?: string; customerId?: string },
    actor: TeamActor,
  ) {
    const memberId = this.requireMember(actor);
    const followUp = await this.db.tx(async (tx) => {
      if (input.leadId) {
        const lead = await tx.lead.findFirst({ where: { id: input.leadId } });
        if (!lead) {
          throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Lead not found' });
        }
        await this.assertLeadAccess(tx, actor, lead.ownerMemberId, PERMISSIONS.CRM_LEAD_MANAGE);
      }
      return tx.followUp.create({
        data: {
          tenantId: this.db.tenantId,
          ownerMemberId: memberId,
          title: input.title,
          notes: input.notes,
          dueAt: input.dueAt,
          leadId: input.leadId,
          customerId: input.customerId,
        },
      });
    });
    await this.audit.record({
      action: 'crm.followup.create',
      entityType: 'follow_up',
      entityId: followUp.id,
      after: { title: followUp.title, dueAt: followUp.dueAt },
    });
    return followUp;
  }

  async completeFollowUp(id: string, actor: TeamActor) {
    return this.db.tx(async (tx) => {
      const existing = await tx.followUp.findFirst({ where: { id } });
      if (!existing) {
        throw new NotFoundException({
          code: ERROR_CODES.NOT_FOUND,
          message: 'Follow-up not found',
        });
      }
      await this.assertLeadAccess(tx, actor, existing.ownerMemberId, PERMISSIONS.CRM_LEAD_MANAGE);
      return tx.followUp.update({
        where: { id },
        data: { status: 'completed', completedAt: new Date() },
      });
    });
  }

  async logInteraction(
    input: { summary: string; channel?: string; leadId?: string; customerId?: string },
    actor: TeamActor,
  ) {
    const memberId = this.requireMember(actor);
    return this.db.tx(async (tx) => {
      if (input.leadId) {
        const lead = await tx.lead.findFirst({ where: { id: input.leadId } });
        if (!lead) {
          throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Lead not found' });
        }
        await this.assertLeadAccess(tx, actor, lead.ownerMemberId, PERMISSIONS.CRM_LEAD_MANAGE);
        await tx.lead.update({ where: { id: input.leadId }, data: { lastContactAt: new Date() } });
      }
      return tx.interaction.create({
        data: {
          tenantId: this.db.tenantId,
          actorMemberId: memberId,
          summary: input.summary,
          channel: input.channel ?? 'note',
          leadId: input.leadId,
          customerId: input.customerId,
        },
      });
    });
  }

  /** Pipeline summary for the caller's accessible book. */
  async pipelineSummary(actor: TeamActor) {
    return this.db.tx(async (tx) => {
      const owners = await this.scope.ownerMemberIds(tx, actor, PERMISSIONS.CRM_LEAD_VIEW);
      const where = this.scope.whereOwner(owners);
      const [stages, grouped, customers, openFollowUps] = await Promise.all([
        tx.pipelineStage.findMany({ orderBy: { order: 'asc' } }),
        tx.lead.groupBy({ by: ['stageId'], where: { ...where, status: 'open' }, _count: true }),
        tx.customer.count({ where }),
        tx.followUp.count({ where: { ...where, status: 'open' } }),
      ]);
      const countByStage = new Map(grouped.map((g) => [g.stageId, g._count]));
      return {
        stages: stages.map((s) => ({
          id: s.id,
          code: s.code,
          name: s.name,
          order: s.order,
          openLeads: countByStage.get(s.id) ?? 0,
        })),
        customers,
        openFollowUps,
      };
    });
  }

  private async assertLeadAccess(tx: Tx, actor: TeamActor, ownerMemberId: string, permKey: string) {
    const owners = await this.scope.ownerMemberIds(tx, actor, permKey);
    if (!this.scope.canAccess(owners, ownerMemberId)) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'This record belongs to another member',
      });
    }
  }
}
