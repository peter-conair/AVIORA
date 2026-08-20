import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { tenantExtension, withTenant, type PrismaClient, type Tx } from '@aviora/db';
import { PrismaService } from './prisma.service';
import { TenantDatabaseResolver } from './tenant-database.resolver';
import { CLS_TENANT_ID } from '../tenant/tenant-context.middleware';

/**
 * Tenant-scoped data access: app role + auto-injected tenant_id (layer 1)
 * inside a SET LOCAL app.tenant_id transaction (layer 2, RLS).
 * All tenant-owned reads/writes in domain services go through `tx()`.
 */
@Injectable()
export class TenantDb {
  private readonly guarded: PrismaClient;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cls: ClsService,
    private readonly router: TenantDatabaseResolver,
  ) {
    this.guarded = this.prisma.app.$extends(
      tenantExtension(() => (this.cls.get(CLS_TENANT_ID) as string | undefined) ?? null),
    ) as unknown as PrismaClient;
  }

  get tenantId(): string {
    const id = this.cls.get(CLS_TENANT_ID) as string | undefined;
    if (!id) throw new Error('TenantContext missing: tenant-scoped operation without tenant');
    return id;
  }

  get tenantIdOrNull(): string | null {
    return (this.cls.get(CLS_TENANT_ID) as string | undefined) ?? null;
  }

  /**
   * The single connection seam ADR-002 reserved. `clientFor` answers `null` for
   * every tenant in the shared database — which is all of them today — so this
   * is the same call it has always been, plus one lookup in an empty map. A
   * tenant that has been moved is the only case that takes a different client,
   * and it takes it here, once, rather than in every service.
   */
  tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const tenantId = this.tenantId;
    return withTenant(this.router.clientFor(tenantId) ?? this.guarded, tenantId, fn);
  }
}
