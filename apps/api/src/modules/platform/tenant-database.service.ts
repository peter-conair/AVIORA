import { Injectable, NotFoundException } from '@nestjs/common';
import { ERROR_CODES } from '@aviora/shared';
import { tenantRowCounts, tenantTablesInDependencyOrder } from '@aviora/db';
import { PrismaService } from '../../common/db/prisma.service';
import {
  TenantDatabaseResolver,
  type TenantDbStatus,
} from '../../common/db/tenant-database.resolver';

export interface TenantPlacementView {
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  status: TenantDbStatus;
  /** The reference, never a DSN — and never the DSN it points at. */
  dsnSecretRef: string | null;
  /** True when the row claims `dedicated` but the reference does not resolve. */
  dsnResolved: boolean;
  migratedAt: string | null;
  notes: string | null;
}

export interface TenantMigrationPlan {
  tenantId: string;
  status: TenantDbStatus;
  generatedAt: string;
  totalRows: number;
  /** Every tenant table, parents first — the order an extract writes them in. */
  tables: Array<{ table: string; rows: number }>;
  /** Things this plan does not and cannot do. Read them before the cutover. */
  caveats: string[];
}

/**
 * Where each tenant's rows live, and what moving one would involve (docs/31 §4).
 *
 * Read-only, deliberately and structurally. Nothing here writes
 * `tenant_databases`: the sprint-15 migration REVOKEs INSERT, UPDATE and
 * DELETE on that table from the app role, so a route that tried would fail at
 * the database. Relocation is an operator action with a runbook (docs/32), not
 * something a request can trigger — including a request from a platform owner.
 */
@Injectable()
export class TenantDatabaseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: TenantDatabaseResolver,
  ) {}

  async map(): Promise<TenantPlacementView[]> {
    const [tenants, rows] = await Promise.all([
      this.prisma.owner.tenant.findMany({
        orderBy: { slug: 'asc' },
        select: { id: true, slug: true, name: true },
      }),
      this.prisma.owner.tenantDatabase.findMany(),
    ]);
    // The resolver's snapshot is what the ROUTER is actually using; re-reading
    // it here keeps the map from showing a state the running process has not
    // picked up yet.
    await this.resolver.refresh().catch(() => undefined);
    const byTenant = new Map(rows.map((r) => [r.tenantId, r]));

    return tenants.map((t) => {
      const row = byTenant.get(t.id);
      const placement = this.resolver.placementFor(t.id);
      return {
        tenantId: t.id,
        tenantSlug: t.slug,
        tenantName: t.name,
        status: placement.status,
        dsnSecretRef: row?.dsnSecretRef ?? null,
        dsnResolved: placement.status === 'dedicated' ? !placement.unresolved : true,
        migratedAt: row?.migratedAt?.toISOString() ?? null,
        notes: row?.notes ?? null,
      };
    });
  }

  /**
   * A DRY RUN. It reads counts and writes nothing — no row moves, no status
   * changes, no connection to a destination is even opened. Its output is the
   * input to the runbook, not a substitute for it.
   */
  async plan(tenantId: string): Promise<TenantMigrationPlan> {
    const tenant = await this.prisma.owner.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true },
    });
    if (!tenant) {
      throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Tenant not found' });
    }

    const tables = await tenantTablesInDependencyOrder(this.prisma.owner);
    const counts = await tenantRowCounts(this.prisma.owner, tenantId, tables);
    const totalRows = counts.reduce((n, c) => n + c.rows, 0);

    return {
      tenantId,
      status: this.resolver.placementFor(tenantId).status,
      generatedAt: new Date().toISOString(),
      totalRows,
      tables: counts.map((c) => ({ table: c.table, rows: c.rows })),
      caveats: PLAN_CAVEATS,
    };
  }
}

/**
 * Written down here rather than left to be discovered during a cutover. Each
 * of these is a thing the plan's row counts do NOT account for.
 */
const PLAN_CAVEATS: string[] = [
  'User accounts are platform-global and are not in these counts: a user may belong to more ' +
    'than one tenant, so the destination needs its own copy rather than a move (docs/32).',
  'Global reference rows — the permission catalog, global knowledge with tenant_id NULL — are ' +
    'not counted and must be seeded into the destination before a restore.',
  'Row counts are a snapshot taken without a lock. They will drift until the tenant is set to ' +
    "'migrating', which is what makes the API refuse writes.",
  'This tooling has never been run at production volume. The roadmap exit criterion — one large ' +
    'tenant migrated with zero data loss and bounded downtime — stays open until it is ' +
    'rehearsed on staging with real data (docs/31 §2).',
];
