import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { tenantExtension, withTenant, type PrismaClient, type Tx } from '@aviora/db';
import { PrismaService } from './prisma.service';
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

  tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTenant(this.guarded, this.tenantId, fn);
  }
}
