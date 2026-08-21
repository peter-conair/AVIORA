import { Controller, Get } from '@nestjs/common';
import { Public } from '../../common/auth/decorators';
import { CatalogService } from './catalog.service';

/**
 * `GET /api/v1/public/v1/catalog` — what this API offers, and what it refuses
 * (docs/47).
 *
 * Public on purpose. An integrator deciding whether to build has no key yet,
 * and requiring one to find out what the API does is a door with the
 * instructions on the inside.
 *
 * In its own file, not beside the routes it describes: `CatalogService` reads
 * `PublicApiController`'s metadata, so a controller in that file importing the
 * service would close a cycle — and a cycle here does not fail loudly, it makes
 * the constructor's design-time type `undefined` and Nest reports an
 * unresolvable dependency with no hint of why.
 */
@Controller('public/v1')
export class ApiCatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('catalog')
  @Public()
  describe() {
    return this.catalog.catalog();
  }
}
