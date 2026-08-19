import { Injectable, Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../db/prisma.service';
import { CLS_TENANT_ID } from '../tenant/tenant-context.middleware';
import { CLS_USER_ID } from '../auth/jwt-auth.guard';
import { CLS_MEMBER_ID } from '../auth/permissions.guard';

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  /** Override CLS tenant (e.g. platform provisioning acting on a new tenant). */
  tenantId?: string | null;
}

/**
 * Audit pipeline (docs/13 §audit). Written via the owner client so
 * platform-scope actions (tenant_id NULL) are recordable; context ids come
 * from CLS. Best-effort: an audit failure is logged, never breaks the action.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cls: ClsService,
  ) {}

  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.owner.auditLog.create({
        data: {
          tenantId:
            entry.tenantId !== undefined
              ? entry.tenantId
              : ((this.cls.get(CLS_TENANT_ID) as string | undefined) ?? null),
          userId: (this.cls.get(CLS_USER_ID) as string | undefined) ?? null,
          memberId: (this.cls.get(CLS_MEMBER_ID) as string | undefined) ?? null,
          action: entry.action,
          entityType: entry.entityType,
          entityId: entry.entityId,
          before: entry.before as object | undefined,
          after: entry.after as object | undefined,
          requestId: this.safeRequestId(),
        },
      });
    } catch (e) {
      this.logger.error(`audit write failed for ${entry.action}`, e as Error);
    }
  }

  private safeRequestId(): string {
    try {
      return this.cls.getId() ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }
}
