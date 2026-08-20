import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createClientForDsn, type PrismaClient } from '@aviora/db';
import { PrismaService } from './prisma.service';

/** The three states a tenant's storage can be in (docs/31 §2). */
export const TENANT_DB_STATUSES = ['shared', 'migrating', 'dedicated'] as const;
export type TenantDbStatus = (typeof TENANT_DB_STATUSES)[number];

export interface TenantDatabasePlacement {
  tenantId: string;
  status: TenantDbStatus;
  dsnSecretRef: string | null;
  /** True when the row says `dedicated` but its DSN does not resolve. */
  unresolved: boolean;
  migratedAt: Date | null;
  notes: string | null;
}

/**
 * The one place in the codebase that knows a tenant's rows might not be in the
 * shared database (ADR-002's reserved migration path, docs/31 §2).
 *
 * The shape of this class is dictated by one requirement: when every tenant is
 * `shared` — which is every tenant today — nothing changes. So the resolver
 * holds a SNAPSHOT of the placements that are not `shared`, and that snapshot
 * is normally empty. `clientFor()` is then a size check on an empty map: no
 * query, no await, no second code path. `TenantDb.tx()` calls it on every
 * request and gets `null`, and carries on with exactly the client it used
 * before this class existed.
 *
 * The snapshot is loaded at boot and corrected as a side effect of
 * `isMigrating`, which reads the table directly on every mutating request.
 * That split is deliberate: routing has to be synchronous, so it reads a map;
 * the read-only decision must never be stale, so it reads the database. See
 * `isMigrating` for why staleness there would cost data.
 *
 * Nothing here writes `tenant_databases`. It cannot: the migration REVOKEs
 * INSERT, UPDATE and DELETE on that table from the app role, and this class
 * reads through the app client precisely so that stays true.
 */
@Injectable()
export class TenantDatabaseResolver implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TenantDatabaseResolver.name);

  /** Only tenants that are NOT `shared`. Empty in every deployment today. */
  private placements = new Map<string, TenantDatabasePlacement>();
  private loading: Promise<void> | null = null;

  /** One client per resolved DSN — a second client would be a second pool. */
  private readonly dedicated = new Map<string, PrismaClient>();

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.refresh().catch((e: unknown) => {
      // A resolver that cannot read its own table must not stop the API from
      // booting: an empty snapshot means "everybody is shared", which is both
      // the truth today and the safe answer.
      this.logger.warn(`tenant placement snapshot unavailable at boot: ${message(e)}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([...this.dedicated.values()].map((c) => c.$disconnect()));
    this.dedicated.clear();
  }

  /**
   * The connection this tenant's rows live on, or `null` for the shared
   * database — which is the answer for every tenant until one is moved.
   */
  clientFor(tenantId: string): PrismaClient | null {
    if (this.placements.size === 0) return null;
    const placement = this.placements.get(tenantId);
    if (!placement || placement.status === 'shared') return null;
    if (placement.status === 'migrating') return null; // still the shared rows, read-only
    return this.dedicatedClient(placement);
  }

  /** What the routing table says about this tenant. */
  placementFor(tenantId: string): TenantDatabasePlacement {
    return (
      this.placements.get(tenantId) ?? {
        tenantId,
        status: 'shared',
        dsnSecretRef: null,
        unresolved: false,
        migratedAt: null,
        notes: null,
      }
    );
  }

  /**
   * Whether this tenant is mid-migration, read from the table rather than from
   * the snapshot.
   *
   * The snapshot exists so ROUTING can be a synchronous map lookup. This
   * question cannot be answered from it: an operator flips the status with
   * psql, and a cached "no" would keep accepting writes the migration is about
   * to discard for as long as the cache lived. A window of even a few seconds
   * there is a window in which data is lost silently — so this is a primary-key
   * lookup on a table that has one row per moved tenant (today: none), paid
   * once per mutating request, and the snapshot is corrected as a side effect.
   *
   * Fails OPEN, deliberately. If the routing table cannot be read, refusing
   * every write on the platform would turn a lookup failure into an outage;
   * the migration's own procedure (docs/32 §4.1) checks the refusal is live
   * before it extracts anything.
   */
  async isMigrating(tenantId: string): Promise<boolean> {
    try {
      const row = await this.prisma.app.tenantDatabase.findUnique({
        where: { tenantId },
        select: { status: true, dsnSecretRef: true, migratedAt: true, notes: true },
      });
      const status = (row?.status ?? 'shared') as TenantDbStatus;
      if (status === 'shared') {
        if (this.placements.delete(tenantId)) this.logger.log(`tenant ${tenantId} is shared again`);
        return false;
      }
      this.placements.set(tenantId, {
        tenantId,
        status,
        dsnSecretRef: row?.dsnSecretRef ?? null,
        unresolved: status === 'dedicated' && !resolveDsn(row?.dsnSecretRef ?? null),
        migratedAt: row?.migratedAt ?? null,
        notes: row?.notes ?? null,
      });
      return status === 'migrating';
    } catch (e) {
      this.logger.warn(`could not read tenant placement for ${tenantId}: ${message(e)}`);
      return false;
    }
  }

  /** Re-read the routing table. Concurrent callers share one query. */
  async refresh(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = this.load().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async load(): Promise<void> {
    // `tenant_databases` has no RLS policy (it is platform scope, not
    // tenant-owned), and the app role holds SELECT and nothing else on it.
    const rows = await this.prisma.app.tenantDatabase.findMany({
      where: { status: { not: 'shared' } },
      select: {
        tenantId: true,
        status: true,
        dsnSecretRef: true,
        migratedAt: true,
        notes: true,
      },
    });

    const next = new Map<string, TenantDatabasePlacement>();
    for (const row of rows) {
      const status = (TENANT_DB_STATUSES as readonly string[]).includes(row.status)
        ? (row.status as TenantDbStatus)
        : 'shared';
      if (status === 'shared') {
        this.logger.warn(
          `tenant_databases row for ${row.tenantId} has unknown status '${row.status}' — ` +
            'treating it as shared',
        );
        continue;
      }
      const dsn = status === 'dedicated' ? resolveDsn(row.dsnSecretRef) : null;
      if (status === 'dedicated' && !dsn) {
        this.logger.error(
          `tenant ${row.tenantId} is marked dedicated but ${row.dsnSecretRef ?? '(no secret ref)'} ` +
            'does not resolve in this environment — its requests will be refused, not silently ' +
            'served from the shared database',
        );
      }
      next.set(row.tenantId, {
        tenantId: row.tenantId,
        status,
        dsnSecretRef: row.dsnSecretRef,
        unresolved: status === 'dedicated' && !dsn,
        migratedAt: row.migratedAt,
        notes: row.notes,
      });
    }
    this.placements = next;
  }

  /**
   * Fails closed. A tenant whose DSN cannot be resolved is served an error, not
   * the shared database: falling back would hand somebody the rows their
   * tenant used to have, quietly, which is the worst outcome available.
   */
  private dedicatedClient(placement: TenantDatabasePlacement): PrismaClient {
    const dsn = resolveDsn(placement.dsnSecretRef);
    if (!dsn) {
      throw new Error(
        `Tenant ${placement.tenantId} is on a dedicated database but its DSN reference ` +
          `(${placement.dsnSecretRef ?? 'none'}) does not resolve in this environment`,
      );
    }
    const existing = this.dedicated.get(dsn);
    if (existing) return existing;
    const client = createClientForDsn(dsn);
    this.dedicated.set(dsn, client);
    return client;
  }
}

/**
 * A `dsn_secret_ref` is a REFERENCE, never a DSN: the schema comment says so
 * and the column is read by anybody who can read the routing table. Supported
 * form today is `env:NAME`, resolved from the process environment, which is
 * where a secret manager delivers its values in this deployment. A bare name
 * is accepted as `env:` for convenience.
 */
function resolveDsn(ref: string | null): string | null {
  if (!ref) return null;
  const name = ref.startsWith('env:') ? ref.slice(4) : ref;
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) return null;
  const value = process.env[name];
  if (!value?.startsWith('postgres')) return null;
  return value;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
