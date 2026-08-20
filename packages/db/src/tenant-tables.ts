import type { PrismaClient } from '@prisma/client';

/**
 * The shape of a tenant's rows in the shared database, derived from the
 * database itself rather than from a hand-kept list (docs/31 §2).
 *
 * A list in TypeScript drifts the moment somebody adds a table and forgets;
 * an extract that silently skips a table is exactly the failure mode a
 * migration cannot afford. So the catalogue is a query: every base table in
 * `public` that carries a `tenant_id uuid` column belongs to some tenant, and
 * the FK graph in `pg_constraint` says what order they may be inserted in.
 */

/** Tables holding a tenant's own row, keyed by `id` rather than `tenant_id`. */
export const TENANT_ROOT_TABLES: Readonly<Record<string, string>> = { tenants: 'id' };

/**
 * Carries `tenant_id` but never moves with the tenant: `tenant_databases`
 * records WHERE a tenant lives, which is the routing table itself — copying it
 * into the destination would tell the new database it points somewhere else.
 */
export const NON_MOVING_TENANT_TABLES: ReadonlySet<string> = new Set(['tenant_databases']);

const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/;

export interface TenantTable {
  table: string;
  /** The column that names the tenant — `tenant_id` everywhere but `tenants`. */
  tenantColumn: string;
}

function assertIdent(name: string): string {
  if (!SAFE_IDENT.test(name)) {
    throw new Error(`Refusing to interpolate an unexpected identifier: ${name}`);
  }
  return name;
}

/** Every table a tenant has rows in, unordered. */
export async function listTenantTables(client: PrismaClient): Promise<TenantTable[]> {
  const rows = await client.$queryRaw<{ table_name: string }[]>`
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public'
      AND t.table_type = 'BASE TABLE'
      AND c.column_name = 'tenant_id'
      AND c.data_type = 'uuid'
    ORDER BY c.table_name`;

  const owned = rows
    .map((r) => r.table_name)
    .filter((name) => !NON_MOVING_TENANT_TABLES.has(name))
    .map((table) => ({ table: assertIdent(table), tenantColumn: 'tenant_id' }));

  const roots = Object.entries(TENANT_ROOT_TABLES).map(([table, tenantColumn]) => ({
    table: assertIdent(table),
    tenantColumn: assertIdent(tenantColumn),
  }));

  return [...roots, ...owned];
}

/**
 * Topological order over the foreign keys BETWEEN the given tables: a parent
 * before every child, so a restore can run with constraints enabled.
 *
 * Self-references (a row pointing at another row of its own table, as
 * `teams.parent_team_id` does) are ignored: they constrain the order of ROWS,
 * not of tables, and the extract emits a table's rows in one statement. The
 * runbook says to defer those constraints rather than pretending otherwise.
 * A cycle between two different tables is reported rather than broken
 * arbitrarily — an arbitrary order there produces a restore that fails
 * halfway, which is worse than a refusal up front.
 */
export async function dependencyOrder(client: PrismaClient, tables: string[]): Promise<string[]> {
  const set = new Set(tables);
  const edges = await client.$queryRaw<{ child: string; parent: string }[]>`
    SELECT child.relname AS child, parent.relname AS parent
    FROM pg_constraint con
    JOIN pg_class child ON child.oid = con.conrelid
    JOIN pg_class parent ON parent.oid = con.confrelid
    JOIN pg_namespace ns ON ns.oid = con.connamespace
    WHERE con.contype = 'f' AND ns.nspname = 'public'`;

  const parents = new Map<string, Set<string>>(tables.map((t) => [t, new Set<string>()]));
  for (const e of edges) {
    if (!set.has(e.child) || !set.has(e.parent) || e.child === e.parent) continue;
    parents.get(e.child)!.add(e.parent);
  }

  const ordered: string[] = [];
  const placed = new Set<string>();
  // Kahn's algorithm, alphabetical within a layer so two runs of the tool
  // against the same schema produce byte-identical output.
  let remaining = [...tables].sort();
  while (remaining.length > 0) {
    const ready = remaining.filter((t) => [...parents.get(t)!].every((p) => placed.has(p)));
    if (ready.length === 0) {
      throw new Error(
        `Foreign-key cycle between tenant tables: ${remaining.join(', ')}. ` +
          'Resolve it by hand — an arbitrary order would fail halfway through a restore.',
      );
    }
    for (const t of ready) {
      ordered.push(t);
      placed.add(t);
    }
    remaining = remaining.filter((t) => !placed.has(t));
  }
  return ordered;
}

/** Every tenant table, parents first. */
export async function tenantTablesInDependencyOrder(client: PrismaClient): Promise<TenantTable[]> {
  const tables = await listTenantTables(client);
  const order = await dependencyOrder(
    client,
    tables.map((t) => t.table),
  );
  const byName = new Map(tables.map((t) => [t.table, t]));
  return order.map((name) => byName.get(name)!);
}

export interface TenantTableCount {
  table: string;
  rows: number;
}

/** Rows this tenant owns, per table, in the order given. */
export async function tenantRowCounts(
  client: PrismaClient,
  tenantId: string,
  tables: TenantTable[],
): Promise<TenantTableCount[]> {
  const counts: TenantTableCount[] = [];
  for (const { table, tenantColumn } of tables) {
    const [row] = await client.$queryRawUnsafe<{ n: string }[]>(
      `SELECT count(*)::text AS n FROM "${assertIdent(table)}" WHERE "${assertIdent(tenantColumn)}" = $1::uuid`,
      tenantId,
    );
    counts.push({ table, rows: Number(row?.n ?? '0') });
  }
  return counts;
}

export interface TenantTableChecksum extends TenantTableCount {
  /** md5 over the tenant's rows, order-independent. Null when there are none. */
  checksum: string | null;
}

/**
 * A per-table fingerprint of the tenant's rows.
 *
 * Each row is hashed from its own `to_jsonb` rendering and the hashes are
 * combined in sorted order, so the result does not depend on physical row
 * order — which differs between a freshly restored table and the one it came
 * from. It DOES depend on column order and on how Postgres renders each type,
 * so source and target must run the same major version and the same migration
 * set; the runbook makes that a precondition rather than a hope.
 */
export async function tenantTableChecksums(
  client: PrismaClient,
  tenantId: string,
  tables: TenantTable[],
): Promise<TenantTableChecksum[]> {
  const out: TenantTableChecksum[] = [];
  for (const { table, tenantColumn } of tables) {
    const [row] = await client.$queryRawUnsafe<{ n: string; checksum: string | null }[]>(
      `SELECT count(*)::text AS n,
              md5(coalesce(string_agg(h, '' ORDER BY h), '')) AS checksum
         FROM (
           SELECT md5(to_jsonb(t)::text) AS h
             FROM "${assertIdent(table)}" t
            WHERE t."${assertIdent(tenantColumn)}" = $1::uuid
         ) s`,
      tenantId,
    );
    out.push({
      table,
      rows: Number(row?.n ?? '0'),
      checksum: Number(row?.n ?? '0') === 0 ? null : (row?.checksum ?? null),
    });
  }
  return out;
}

/**
 * The SQL that produces the INSERT statements for one table's tenant rows.
 *
 * The statement text is built by POSTGRES (`format` + `%L` + `to_jsonb`), not
 * by string concatenation here: every quoting and escaping decision is made by
 * the server that will parse the result. Restoring goes through
 * `jsonb_populate_recordset`, so column order and type parsing are the
 * destination's job too — the dump never encodes a column list that could go
 * stale against a later migration.
 */
export function extractStatementSql(
  table: string,
  tenantColumn: string,
  chunkRows: number,
): string {
  const t = assertIdent(table);
  const col = assertIdent(tenantColumn);
  return `
    WITH src AS (
      SELECT to_jsonb(x) AS j, (row_number() OVER ()) - 1 AS rn
        FROM "${t}" x
       WHERE x."${col}" = $1::uuid
    )
    SELECT format(
             'INSERT INTO %I SELECT * FROM jsonb_populate_recordset(NULL::%I, %L::jsonb);',
             '${t}', '${t}', jsonb_agg(j)
           ) AS stmt
      FROM src
     GROUP BY rn / ${Math.max(1, Math.trunc(chunkRows))}
     ORDER BY min(rn)`;
}
