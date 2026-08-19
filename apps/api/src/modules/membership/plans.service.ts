import { Injectable, NotFoundException } from '@nestjs/common';
import { ERROR_CODES } from '@aviora/shared';
import { PrismaService } from '../../common/db/prisma.service';
import { TenantDb } from '../../common/db/tenant-db.service';
import { AuditService } from '../../common/audit/audit.service';

export interface UpsertPlanInput {
  code: string;
  name: string;
  description?: string;
  membershipType?: string;
  price?: number;
  currency?: string;
  billingCycle?: string;
  trialDays?: number;
  entitlementKeys?: string[];
}

@Injectable()
export class PlansService {
  constructor(
    private readonly db: TenantDb,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list() {
    return this.db.tx((tx) =>
      tx.membershipPlan.findMany({
        orderBy: { createdAt: 'asc' },
        include: {
          planEntitlements: { select: { entitlement: { select: { key: true } } } },
        },
      }),
    );
  }

  async create(input: UpsertPlanInput) {
    const entitlements = await this.resolveEntitlements(input.entitlementKeys ?? []);
    const plan = await this.db.tx(async (tx) => {
      const created = await tx.membershipPlan.create({
        data: {
          tenantId: this.db.tenantId,
          code: input.code,
          name: input.name,
          description: input.description,
          membershipType: input.membershipType ?? 'standard',
          price: input.price ?? 0,
          currency: input.currency ?? 'THB',
          billingCycle: input.billingCycle ?? 'monthly',
          trialDays: input.trialDays ?? 0,
        },
      });
      if (entitlements.length) {
        await tx.planEntitlement.createMany({
          data: entitlements.map((e) => ({
            tenantId: this.db.tenantId,
            planId: created.id,
            entitlementId: e.id,
          })),
        });
      }
      return created;
    });
    await this.audit.record({
      action: 'membership.plan.create',
      entityType: 'membership_plan',
      entityId: plan.id,
      after: { code: plan.code, name: plan.name, entitlements: input.entitlementKeys ?? [] },
    });
    return plan;
  }

  async update(id: string, input: Partial<UpsertPlanInput>) {
    const entitlements =
      input.entitlementKeys !== undefined
        ? await this.resolveEntitlements(input.entitlementKeys)
        : null;
    const updated = await this.db.tx(async (tx) => {
      const before = await tx.membershipPlan.findFirst({ where: { id } });
      if (!before) {
        throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Plan not found' });
      }
      const plan = await tx.membershipPlan.update({
        where: { id },
        data: {
          name: input.name,
          description: input.description,
          price: input.price,
          billingCycle: input.billingCycle,
          trialDays: input.trialDays,
        },
      });
      if (entitlements) {
        await tx.planEntitlement.deleteMany({ where: { planId: id } });
        if (entitlements.length) {
          await tx.planEntitlement.createMany({
            data: entitlements.map((e) => ({
              tenantId: this.db.tenantId,
              planId: id,
              entitlementId: e.id,
            })),
          });
        }
      }
      return { before, plan };
    });
    await this.audit.record({
      action: 'membership.plan.update',
      entityType: 'membership_plan',
      entityId: id,
      before: { name: updated.before.name, trialDays: updated.before.trialDays },
      after: { name: updated.plan.name, trialDays: updated.plan.trialDays },
    });
    return updated.plan;
  }

  /** Global entitlement catalog (platform reference data — readable by any tenant admin). */
  listEntitlements() {
    return this.prisma.app.entitlement.findMany({
      orderBy: { key: 'asc' },
      select: { key: true, description: true },
    });
  }

  private async resolveEntitlements(keys: string[]) {
    if (!keys.length) return [];
    const rows = await this.prisma.app.entitlement.findMany({
      where: { key: { in: keys } },
      select: { id: true, key: true },
    });
    const found = new Set(rows.map((r) => r.key));
    const missing = keys.filter((k) => !found.has(k));
    if (missing.length) {
      throw new NotFoundException({
        code: ERROR_CODES.NOT_FOUND,
        message: 'Unknown entitlement keys',
        details: { missing },
      });
    }
    return rows;
  }
}
