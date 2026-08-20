import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { RequirePlatformRoles } from '../../common/auth/decorators';
import { TenantDatabaseService } from './tenant-database.service';

/**
 * The tenant-database map and the migration dry run (docs/31 §4).
 *
 * Platform roles only, because database routing is platform work: "a tenant
 * cannot move itself" (docs/31 §3). There is deliberately no route here that
 * CHANGES a placement — see TenantDatabaseService for why that is a property
 * of the database grants and not merely of this file.
 */
@RequirePlatformRoles('PLATFORM_OWNER', 'SUPER_ADMIN')
@Controller('platform/tenant-databases')
export class TenantDatabaseController {
  constructor(private readonly databases: TenantDatabaseService) {}

  @Get()
  async map() {
    return { tenantDatabases: await this.databases.map() };
  }

  /**
   * `:id` is the TENANT id, not a `tenant_databases` row id: every tenant has
   * a placement, but only a tenant that has been moved (or is being moved) has
   * a row. Keying the dry run on the row would make it impossible to plan the
   * first migration of any tenant.
   *
   * POST rather than GET because it is a computation an operator asks for
   * deliberately — it counts every tenant-owned table — not something a page
   * should fetch on render. It still writes nothing.
   */
  @Post(':id/plan')
  @HttpCode(200)
  async plan(@Param('id', ParseUUIDPipe) tenantId: string) {
    return { plan: await this.databases.plan(tenantId) };
  }
}
