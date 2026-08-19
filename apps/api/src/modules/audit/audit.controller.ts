import { Controller, Get, Query } from '@nestjs/common';
import { PERMISSIONS } from '@aviora/shared';
import { RequirePermissions } from '../../common/auth/decorators';
import { TenantDb } from '../../common/db/tenant-db.service';

const MAX_LIMIT = 100;

/** Audit viewer (docs/13 §audit) — tenant-scoped, newest first, cursor paged. */
@Controller('audit-logs')
export class AuditController {
  constructor(private readonly db: TenantDb) {}

  @Get()
  @RequirePermissions(PERMISSIONS.AUDIT_VIEW)
  async list(
    @Query('action') action?: string,
    @Query('entityType') entityType?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const take = Math.min(Number(limit) || 50, MAX_LIMIT);
    const rows = await this.db.tx((tx) =>
      tx.auditLog.findMany({
        where: {
          ...(action ? { action } : {}),
          ...(entityType ? { entityType } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: take + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: {
          id: true,
          action: true,
          entityType: true,
          entityId: true,
          userId: true,
          memberId: true,
          before: true,
          after: true,
          requestId: true,
          createdAt: true,
        },
      }),
    );
    const hasMore = rows.length > take;
    const items = hasMore ? rows.slice(0, take) : rows;
    return {
      auditLogs: items,
      nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
    };
  }

  @Get('actions')
  @RequirePermissions(PERMISSIONS.AUDIT_VIEW)
  async actions() {
    const rows = await this.db.tx((tx) =>
      tx.auditLog.groupBy({ by: ['action'], _count: true, orderBy: { action: 'asc' } }),
    );
    return { actions: rows.map((r) => ({ action: r.action, count: r._count })) };
  }
}
