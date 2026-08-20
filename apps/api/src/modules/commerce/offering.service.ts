import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ERROR_CODES } from '@aviora/shared';
import { TenantDb } from '../../common/db/tenant-db.service';
import { AuditService } from '../../common/audit/audit.service';
import { priceResolver, tenantCurrency } from './pricing';

export interface CreateOfferingInput {
  code: string;
  name: string;
  description?: string;
  productId?: string;
  kind: 'one_time' | 'subscription';
  currency?: string;
  priceMinor: number;
  intervalUnit?: string;
  intervalCount?: number;
}

export interface UpdateOfferingInput {
  name?: string;
  description?: string;
  priceMinor?: number;
  status?: 'active' | 'archived';
  intervalUnit?: string;
  intervalCount?: number;
}

/**
 * The catalogue a tenant sells (docs/24 §1). An offering may point at a
 * knowledge Product, which stays brand-neutral and possibly global — the
 * price, the name and the billing interval belong to the tenant, not the
 * product.
 */
@Injectable()
export class OfferingService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
  ) {}

  /** Active catalogue with the price THIS caller would actually pay. */
  list(memberId: string | null) {
    return this.db.tx(async (tx) => {
      const offerings = await tx.offering.findMany({
        where: { status: 'active' },
        orderBy: { name: 'asc' },
      });
      const priceOf = await priceResolver(tx, memberId);
      return Promise.all(
        offerings.map(async (o) => ({
          id: o.id,
          code: o.code,
          name: o.name,
          description: o.description,
          productId: o.productId,
          kind: o.kind,
          currency: o.currency,
          listPriceMinor: o.priceMinor,
          priceMinor: await priceOf(o),
          intervalUnit: o.intervalUnit,
          intervalCount: o.intervalCount,
        })),
      );
    });
  }

  async create(input: CreateOfferingInput) {
    const offering = await this.db.tx(async (tx) => {
      const dup = await tx.offering.findFirst({ where: { code: input.code } });
      if (dup) {
        throw new ConflictException({
          code: ERROR_CODES.CONFLICT,
          message: 'Offering code already in use',
        });
      }
      assertInterval(input.kind, input.intervalUnit, input.intervalCount);
      return tx.offering.create({
        data: {
          tenantId: this.db.tenantId,
          code: input.code,
          name: input.name,
          description: input.description,
          productId: input.productId,
          kind: input.kind,
          currency: input.currency ?? (await tenantCurrency(tx)),
          priceMinor: input.priceMinor,
          intervalUnit: input.intervalUnit,
          intervalCount: input.intervalCount,
        },
      });
    });
    await this.audit.record({
      action: 'commerce.offering.create',
      entityType: 'offering',
      entityId: offering.id,
      after: { code: offering.code, kind: offering.kind, priceMinor: offering.priceMinor },
    });
    return offering;
  }

  async update(id: string, input: UpdateOfferingInput) {
    const { before, after } = await this.db.tx(async (tx) => {
      const existing = await tx.offering.findFirst({ where: { id } });
      if (!existing) {
        throw new NotFoundException({
          code: ERROR_CODES.NOT_FOUND,
          message: 'Offering not found',
        });
      }
      assertInterval(
        existing.kind,
        input.intervalUnit ?? existing.intervalUnit ?? undefined,
        input.intervalCount ?? existing.intervalCount ?? undefined,
      );
      const updated = await tx.offering.update({ where: { id: existing.id }, data: input });
      return { before: existing, after: updated };
    });
    await this.audit.record({
      action: 'commerce.offering.update',
      entityType: 'offering',
      entityId: after.id,
      before: { name: before.name, priceMinor: before.priceMinor, status: before.status },
      after: { name: after.name, priceMinor: after.priceMinor, status: after.status },
    });
    return after;
  }

  /** Membership pricing as data — one row per plan that pays a different price. */
  async setPlanPrice(offeringId: string, planId: string, priceMinor: number) {
    const planPrice = await this.db.tx(async (tx) => {
      const offering = await tx.offering.findFirst({ where: { id: offeringId } });
      if (!offering) {
        throw new NotFoundException({
          code: ERROR_CODES.NOT_FOUND,
          message: 'Offering not found',
        });
      }
      const plan = await tx.membershipPlan.findFirst({ where: { id: planId } });
      if (!plan) {
        throw new NotFoundException({
          code: ERROR_CODES.NOT_FOUND,
          message: 'Membership plan not found',
        });
      }
      const existing = await tx.offeringPlanPrice.findFirst({ where: { offeringId, planId } });
      return existing
        ? tx.offeringPlanPrice.update({ where: { id: existing.id }, data: { priceMinor } })
        : tx.offeringPlanPrice.create({
            data: { tenantId: this.db.tenantId, offeringId, planId, priceMinor },
          });
    });
    await this.audit.record({
      action: 'commerce.offering.planPrice',
      entityType: 'offering_plan_price',
      entityId: planPrice.id,
      after: { offeringId, planId, priceMinor },
    });
    return planPrice;
  }

  listCoupons() {
    return this.db.tx((tx) => tx.coupon.findMany({ orderBy: { createdAt: 'desc' }, take: 200 }));
  }

  async createCoupon(input: {
    code: string;
    kind: 'percent' | 'fixed';
    value: number;
    currency?: string;
    minSubtotalMinor?: number;
    startsAt?: Date;
    endsAt?: Date;
    maxRedemptions?: number;
  }) {
    // Coupon codes are typed by hand, on a phone, by people who do not think
    // about case. One stored form, one lookup form.
    const code = input.code.toUpperCase();
    const coupon = await this.db.tx(async (tx) => {
      const dup = await tx.coupon.findFirst({ where: { code } });
      if (dup) {
        throw new ConflictException({
          code: ERROR_CODES.CONFLICT,
          message: 'Coupon code already in use',
        });
      }
      if (input.kind === 'percent' && (input.value < 1 || input.value > 100)) {
        throw new ConflictException({
          code: ERROR_CODES.VALIDATION_FAILED,
          message: 'A percent coupon must discount between 1 and 100 percent',
        });
      }
      if (input.startsAt && input.endsAt && input.endsAt < input.startsAt) {
        throw new ConflictException({
          code: ERROR_CODES.VALIDATION_FAILED,
          message: 'A coupon cannot end before it starts',
        });
      }
      return tx.coupon.create({
        data: {
          tenantId: this.db.tenantId,
          code,
          kind: input.kind,
          value: input.value,
          currency: input.kind === 'fixed' ? (input.currency ?? (await tenantCurrency(tx))) : null,
          minSubtotalMinor: input.minSubtotalMinor,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          maxRedemptions: input.maxRedemptions,
        },
      });
    });
    await this.audit.record({
      action: 'commerce.coupon.create',
      entityType: 'coupon',
      entityId: coupon.id,
      after: { code: coupon.code, kind: coupon.kind, value: coupon.value },
    });
    return coupon;
  }
}

function assertInterval(kind: string, unit?: string, count?: number): void {
  if (kind !== 'subscription') return;
  if (!unit || !count) {
    throw new ConflictException({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'A subscription offering needs an interval unit and count',
    });
  }
}
