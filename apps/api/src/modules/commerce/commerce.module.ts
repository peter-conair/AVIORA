import { Module } from '@nestjs/common';
import { CartController } from './cart.controller';
import { CartService } from './cart.service';
import { CommerceScopeService } from './commerce-scope.service';
import { CouponController, OfferingController } from './offering.controller';
import { OfferingService } from './offering.service';
import { OrderController } from './order.controller';
import { OrderService } from './order.service';
import { SubscriptionController } from './subscription.controller';
import { SubscriptionService } from './subscription.service';
import { TaxController } from './tax.controller';
import { TaxService } from './tax.service';

/**
 * Commerce OS (docs/24). Commerce supports the journey and is never the entry
 * point: a tenant that sells nothing simply never receives the
 * `commerce.enabled` entitlement, and every route here answers 403.
 */
@Module({
  controllers: [
    OfferingController,
    CouponController,
    CartController,
    OrderController,
    SubscriptionController,
    TaxController,
  ],
  providers: [
    OfferingService,
    CartService,
    OrderService,
    SubscriptionService,
    CommerceScopeService,
    TaxService,
  ],
})
export class CommerceModule {}
