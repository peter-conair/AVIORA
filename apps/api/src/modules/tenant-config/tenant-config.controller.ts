import { Body, Controller, Get, Put } from '@nestjs/common';
import { z } from 'zod';
import { PERMISSIONS } from '@aviora/shared';
import { Public, RequirePermissions } from '../../common/auth/decorators';
import { ClsService } from 'nestjs-cls';
import { CLS_TENANT_ID } from '../../common/tenant/tenant-context.middleware';
import { ZodPipe } from '../../common/validation/zod.pipe';
import { brandingUpdateSchema, FONT_FAMILIES } from './branding';
import { BrandingService } from './branding.service';
import { localisationUpdateSchema } from './localisation';
import { LocalisationService } from './localisation.service';

/**
 * White label, as configuration (docs/29 §1, §6).
 *
 * `GET /tenant/branding` is PUBLIC and resolved by host: it is what a browser
 * needs to paint the login page, before anybody has logged in.
 *
 * Note what is NOT here: no guard on this controller reads branding, and no
 * guard anywhere does. `hiddenFeatures` travels to the client as a navigation
 * hint and stops there — the routes of a hidden feature answer normally.
 */
@Controller('tenant')
export class TenantConfigController {
  constructor(
    private readonly branding: BrandingService,
    private readonly localisation: LocalisationService,
    private readonly cls: ClsService,
  ) {}

  /** Resolved from the host by TenantContextMiddleware — public routes have no other source. */
  private tenantId(): string | null {
    return (this.cls.get(CLS_TENANT_ID) as string | undefined) ?? null;
  }

  @Get('branding')
  @Public()
  async getBranding() {
    const tenantId = this.tenantId();
    return {
      branding: await this.branding.publicBranding(tenantId),
      // The choices a tenant may make, so an admin screen never has to hardcode
      // them and can never offer a family the server would refuse.
      fontFamilies: FONT_FAMILIES,
    };
  }

  @Put('branding')
  @RequirePermissions(PERMISSIONS.TENANT_SETTINGS_MANAGE)
  async putBranding(
    @Body(new ZodPipe(brandingUpdateSchema)) body: z.infer<typeof brandingUpdateSchema>,
  ) {
    return { branding: await this.branding.update(body) };
  }

  /**
   * Any member of the tenant — no permission key, because "what currency and
   * language is this place?" is not privileged information about it.
   */
  @Get('localisation')
  async getLocalisation() {
    return { localisation: await this.localisation.get() };
  }

  @Put('localisation')
  @RequirePermissions(PERMISSIONS.TENANT_SETTINGS_MANAGE)
  async putLocalisation(
    @Body(new ZodPipe(localisationUpdateSchema)) body: z.infer<typeof localisationUpdateSchema>,
  ) {
    return { localisation: await this.localisation.update(body) };
  }
}
