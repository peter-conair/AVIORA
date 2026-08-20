import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';
import { ENTITLEMENTS, PERMISSIONS } from '@aviora/shared';
import {
  CurrentUser,
  RequireEntitlements,
  RequirePermissions,
  type AuthenticatedUser,
} from '../../common/auth/decorators';
import { CLS_MEMBER_ID } from '../../common/auth/permissions.guard';
import { ZodPipe } from '../../common/validation/zod.pipe';
import { CartService } from './cart.service';

const itemSchema = z.object({
  offeringId: z.string().uuid(),
  quantity: z.number().int().positive().max(1000).default(1),
});

const couponSchema = z.object({
  code: z.string().min(3).max(40),
});

/**
 * The customer's region, which only narrows WHICH single tax rule applies
 * (docs/29 §4). Optional: with no region, the country-wide rule resolves.
 */
const checkoutSchema = z.object({ region: z.string().min(1).max(80).optional() }).default({});

@Controller('cart')
@RequireEntitlements(ENTITLEMENTS.COMMERCE)
export class CartController {
  constructor(
    private readonly cart: CartService,
    private readonly cls: ClsService,
  ) {}

  private memberId(): string | null {
    return (this.cls.get(CLS_MEMBER_ID) as string | undefined) ?? null;
  }

  @Get()
  @RequirePermissions(PERMISSIONS.COMMERCE_CATALOG_VIEW)
  async view() {
    return { cart: await this.cart.view(this.memberId()) };
  }

  @Post('items')
  @RequirePermissions(PERMISSIONS.COMMERCE_CATALOG_VIEW)
  async addItem(@Body(new ZodPipe(itemSchema)) body: z.infer<typeof itemSchema>) {
    return { cart: await this.cart.addItem(this.memberId(), body) };
  }

  @Delete('items/:id')
  @RequirePermissions(PERMISSIONS.COMMERCE_CATALOG_VIEW)
  async removeItem(@Param('id', ParseUUIDPipe) id: string) {
    return { cart: await this.cart.removeItem(this.memberId(), id) };
  }

  @Post('coupon')
  @RequirePermissions(PERMISSIONS.COMMERCE_CATALOG_VIEW)
  async applyCoupon(@Body(new ZodPipe(couponSchema)) body: z.infer<typeof couponSchema>) {
    return { cart: await this.cart.applyCoupon(this.memberId(), body.code) };
  }

  @Delete('coupon')
  @RequirePermissions(PERMISSIONS.COMMERCE_CATALOG_VIEW)
  async removeCoupon() {
    return { cart: await this.cart.removeCoupon(this.memberId()) };
  }

  @Post('checkout')
  @RequirePermissions(PERMISSIONS.COMMERCE_CATALOG_VIEW)
  async checkout(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodPipe(checkoutSchema)) body: z.infer<typeof checkoutSchema>,
  ) {
    return await this.cart.checkout(this.memberId(), user.userId, body);
  }
}
