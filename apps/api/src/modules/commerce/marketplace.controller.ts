import { Controller, Get, Query } from '@nestjs/common';
import { ENTITLEMENTS, PERMISSIONS } from '@aviora/shared';
import { RequireEntitlements, RequirePermissions } from '../../common/auth/decorators';
import { MarketplaceService } from './marketplace.service';

/**
 * Browsing the multi-brand marketplace (docs/44 §3–§4).
 *
 * Gated by `marketplace.access` — the browse SURFACE, not the catalogue. A
 * tenant without the entitlement still has a catalogue and still sells; this
 * route simply answers ENTITLEMENT_REQUIRED. Gating what a tenant configures
 * would lock an owner out of their own shop, which is the mistake docs/24 §2
 * already had to undo once.
 *
 * There is no buy route here. The cart and checkout that exist take these
 * offerings, because a second purchase path would be a second set of pricing
 * and tax rules for the first to disagree with.
 */
@Controller('marketplace')
export class MarketplaceController {
  constructor(private readonly marketplace: MarketplaceService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.COMMERCE_CATALOG_VIEW)
  @RequireEntitlements(ENTITLEMENTS.MARKETPLACE)
  async browse(@Query('brand') brandId?: string, @Query('q') q?: string) {
    return this.marketplace.browse({ brandId, q });
  }

  @Get('brands')
  @RequirePermissions(PERMISSIONS.COMMERCE_CATALOG_VIEW)
  @RequireEntitlements(ENTITLEMENTS.MARKETPLACE)
  async brands() {
    return { brands: await this.marketplace.brands() };
  }
}
