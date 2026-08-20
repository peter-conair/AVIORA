import { Controller, Get, Header } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { Public } from '../../common/auth/decorators';
import { CLS_TENANT_ID } from '../../common/tenant/tenant-context.middleware';
import { ManifestService } from './manifest.service';

/**
 * `GET /manifest.webmanifest`, resolved by host (docs/30 §5).
 *
 * Public and unauthenticated by necessity: a browser asks for the manifest
 * before anybody has signed in, exactly as it asks for the branding the login
 * page is painted with. It is excluded from the `/api/v1` prefix because a PWA
 * manifest is a document of the site, not a call to the API.
 *
 * This is the honest extent of "white-label mobile" this sprint claims: an
 * installable web app carrying the tenant's identity. Native store
 * distribution is a build pipeline and an account per tenant.
 */
@Controller()
export class ManifestController {
  constructor(
    private readonly manifest: ManifestService,
    private readonly cls: ClsService,
  ) {}

  @Get('manifest.webmanifest')
  @Public()
  @Header('content-type', 'application/manifest+json; charset=utf-8')
  @Header('cache-control', 'public, max-age=300')
  async webmanifest() {
    return this.manifest.forHost((this.cls.get(CLS_TENANT_ID) as string | undefined) ?? null);
  }
}
