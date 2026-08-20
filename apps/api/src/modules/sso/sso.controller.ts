import { Body, Controller, Delete, Get, HttpCode, Put } from '@nestjs/common';
import { z } from 'zod';
import { PERMISSIONS } from '@aviora/shared';
import { RequirePermissions } from '../../common/auth/decorators';
import { ZodPipe } from '../../common/validation/zod.pipe';
import { toHttpException } from './sso-error';
import { ssoUpsertSchema } from './sso';
import { SsoService } from './sso.service';

/**
 * A tenant's identity-provider configuration (docs/31 §4).
 *
 * Held by the owner via `tenant.sso.manage`. Nothing on this controller
 * returns the client secret — `SsoProviderView` has no field for it, so there
 * is no shape a future handler could accidentally serialise one into.
 */
@Controller('tenant/sso')
export class SsoController {
  constructor(private readonly sso: SsoService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.TENANT_SSO_MANAGE)
  async get() {
    return { provider: await this.sso.get() };
  }

  @Put()
  @RequirePermissions(PERMISSIONS.TENANT_SSO_MANAGE)
  async put(@Body(new ZodPipe(ssoUpsertSchema)) body: z.infer<typeof ssoUpsertSchema>) {
    try {
      return {
        provider: await this.sso.upsert(body),
        secretNote:
          'The client secret is stored sealed and is never returned by any endpoint. ' +
          'Send it again to replace it; omit it to keep the stored one.',
      };
    } catch (e) {
      throw toHttpException(e);
    }
  }

  /** Federation off. Local sign-in is unaffected (docs/31 §4). */
  @Delete()
  @HttpCode(204)
  @RequirePermissions(PERMISSIONS.TENANT_SSO_MANAGE)
  async remove(): Promise<void> {
    try {
      await this.sso.remove();
    } catch (e) {
      throw toHttpException(e);
    }
  }
}
