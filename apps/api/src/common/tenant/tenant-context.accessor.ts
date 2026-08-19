import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { TenantContext } from '@aviora/shared';
import { CLS_TENANT_ID, CLS_TENANT_SOURCE } from './tenant-context.middleware';

/** Read-only accessor for the current request's TenantContext (CLS-backed). */
@Injectable()
export class TenantContextAccessor {
  constructor(private readonly cls: ClsService) {}

  current(): TenantContext {
    return {
      tenantId: this.cls.get(CLS_TENANT_ID) ?? null,
      source: this.cls.get(CLS_TENANT_SOURCE) ?? 'platform',
      userId: this.cls.get('userId') ?? null,
      memberId: this.cls.get('memberId') ?? null,
      requestId: this.cls.getId(),
    };
  }

  /** Throws unless a tenant is resolved — use in tenant-scoped services. */
  requireTenantId(): string {
    const id = this.cls.get(CLS_TENANT_ID);
    if (!id) throw new Error('TenantContext missing: tenant-scoped operation without tenant');
    return id as string;
  }
}
