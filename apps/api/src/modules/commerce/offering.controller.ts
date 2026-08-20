import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';
import { PERMISSIONS } from '@aviora/shared';
import { RequirePermissions } from '../../common/auth/decorators';
import { CLS_MEMBER_ID } from '../../common/auth/permissions.guard';
import { ZodPipe } from '../../common/validation/zod.pipe';
import { INTERVAL_UNITS } from './billing';
import { COUPON_KINDS, OFFERING_KINDS } from './pricing';
import { OfferingService } from './offering.service';

const createSchema = z.object({
  code: z.string().regex(/^[a-z0-9-]{2,40}$/),
  name: z.string().min(1).max(160),
  description: z.string().max(2000).optional(),
  productId: z.string().uuid().optional(),
  kind: z.enum(OFFERING_KINDS).default('one_time'),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  priceMinor: z.number().int().min(0).max(1_000_000_000),
  intervalUnit: z.enum(INTERVAL_UNITS).optional(),
  intervalCount: z.number().int().positive().max(365).optional(),
});

const updateSchema = z
  .object({
    name: z.string().min(1).max(160).optional(),
    description: z.string().max(2000).optional(),
    priceMinor: z.number().int().min(0).max(1_000_000_000).optional(),
    status: z.enum(['active', 'archived']).optional(),
    intervalUnit: z.enum(INTERVAL_UNITS).optional(),
    intervalCount: z.number().int().positive().max(365).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });

const planPriceSchema = z.object({
  planId: z.string().uuid(),
  priceMinor: z.number().int().min(0).max(1_000_000_000),
});

const couponSchema = z.object({
  code: z.string().regex(/^[A-Za-z0-9-]{3,40}$/),
  kind: z.enum(COUPON_KINDS),
  value: z.number().int().positive().max(1_000_000_000),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  minSubtotalMinor: z.number().int().min(0).max(1_000_000_000).optional(),
  startsAt: z.coerce.date().optional(),
  endsAt: z.coerce.date().optional(),
  maxRedemptions: z.number().int().positive().max(1_000_000).optional(),
});

/**
 * Administration is permission-scoped, NOT entitlement-scoped. Entitlements are
 * resolved from a member's active membership plan, and a tenant owner holds no
 * plan — gating the catalogue on `commerce.enabled` would lock an owner out of
 * their own shop. Browsing is likewise open: the entitlement decides who can
 * BUY, and it is enforced on the cart (docs/24 §2).
 */
@Controller('offerings')
export class OfferingController {
  constructor(
    private readonly offerings: OfferingService,
    private readonly cls: ClsService,
  ) {}

  @Get()
  @RequirePermissions(PERMISSIONS.COMMERCE_CATALOG_VIEW)
  async list() {
    const memberId = (this.cls.get(CLS_MEMBER_ID) as string | undefined) ?? null;
    return { offerings: await this.offerings.list(memberId) };
  }

  @Post()
  @RequirePermissions(PERMISSIONS.COMMERCE_CATALOG_MANAGE)
  async create(@Body(new ZodPipe(createSchema)) body: z.infer<typeof createSchema>) {
    return { offering: await this.offerings.create(body) };
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.COMMERCE_CATALOG_MANAGE)
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateSchema)) body: z.infer<typeof updateSchema>,
  ) {
    return { offering: await this.offerings.update(id, body) };
  }

  @Put(':id/plan-price')
  @RequirePermissions(PERMISSIONS.COMMERCE_CATALOG_MANAGE)
  async setPlanPrice(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(planPriceSchema)) body: z.infer<typeof planPriceSchema>,
  ) {
    return { planPrice: await this.offerings.setPlanPrice(id, body.planId, body.priceMinor) };
  }
}

@Controller('coupons')
export class CouponController {
  constructor(private readonly offerings: OfferingService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.COMMERCE_CATALOG_MANAGE)
  async list() {
    return { coupons: await this.offerings.listCoupons() };
  }

  @Post()
  @RequirePermissions(PERMISSIONS.COMMERCE_CATALOG_MANAGE)
  async create(@Body(new ZodPipe(couponSchema)) body: z.infer<typeof couponSchema>) {
    return { coupon: await this.offerings.createCoupon(body) };
  }
}
