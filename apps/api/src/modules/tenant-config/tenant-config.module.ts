import { Module } from '@nestjs/common';
import { BrandingService } from './branding.service';
import { LegalController } from './legal.controller';
import { LegalService } from './legal.service';
import { LocalisationService } from './localisation.service';
import { TenantConfigController } from './tenant-config.controller';

/**
 * White label and multi-country (docs/29). Pure configuration: branding,
 * localisation and legal documents.
 *
 * Nothing here is a permission. `hiddenFeatures` hides navigation and nothing
 * else — the routes of a hidden feature still answer, and the permission and
 * entitlement guards are what refuse. No guard imports anything from this
 * module, and none may.
 */
@Module({
  controllers: [TenantConfigController, LegalController],
  providers: [BrandingService, LocalisationService, LegalService],
  // Branding is exported so the white-label PWA manifest (docs/30 §5) paints
  // itself from the SAME source the login page does, rather than from a second
  // read of the same tables that could drift from it.
  exports: [BrandingService],
})
export class TenantConfigModule {}
