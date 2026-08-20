/**
 * Tenant extract / verify — the tooling half of the dedicated-database path
 * (docs/31 §2, runbook docs/32).
 *
 * This is an OPERATOR tool, run by hand from a shell with both DSNs in the
 * environment. It is deliberately not reachable from the API: nothing in the
 * request path may move a tenant, and nothing in the request path may write
 * `tenant_databases` (the migration REVOKEs those grants from the app role).
 *
 *   pnpm --filter @aviora/db tenant:migrate extract --tenant <uuid> --out dump.sql
 *   pnpm --filter @aviora/db tenant:migrate verify  --tenant <uuid> --target <dsn|ENV_NAME>
 *   pnpm --filter @aviora/db tenant:migrate plan    --tenant <uuid>
 *
 * What it does NOT claim: this has never been run against production volume.
 * See docs/32 §7.
 */
import * as fs from 'node:fs';
import { PrismaClient } from '@prisma/client';
import {
  extractStatementSql,
  tenantRowCounts,
  tenantTableChecksums,
  tenantTablesInDependencyOrder,
  type TenantTable,
} from '../src/tenant-tables';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHUNK_ROWS = 500;

interface Args {
  command: string;
  tenant: string;
  out?: string;
  target?: string;
  source?: string;
}

function parseArgs(argv: string[]): Args {
  const [command, ...rest] = argv;
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    if (!key?.startsWith('--')) throw new Error(`Unexpected argument: ${key}`);
    const value = rest[i + 1];
    if (value === undefined) throw new Error(`${key} needs a value`);
    flags.set(key.slice(2), value);
  }
  const tenant = flags.get('tenant') ?? '';
  if (!UUID_RE.test(tenant)) throw new Error('--tenant must be a tenant uuid');
  return {
    command: command ?? '',
    tenant,
    out: flags.get('out'),
    target: flags.get('target'),
    source: flags.get('source'),
  };
}

/** A DSN, or the name of an environment variable holding one. */
function resolveDsn(value: string | undefined, fallbackEnv: string): string {
  const raw = value ?? process.env[fallbackEnv];
  if (!raw) throw new Error(`No DSN: pass one explicitly or set ${fallbackEnv}`);
  if (raw.startsWith('postgres://') || raw.startsWith('postgresql://')) return raw;
  const fromEnv = process.env[raw];
  if (!fromEnv) throw new Error(`${raw} is neither a postgres DSN nor a set environment variable`);
  return fromEnv;
}

function connect(dsn: string): PrismaClient {
  return new PrismaClient({ datasourceUrl: dsn });
}

async function extract(args: Args): Promise<void> {
  const source = connect(resolveDsn(args.source, 'AVIORA_DATABASE_URL'));
  try {
    const tables = await tenantTablesInDependencyOrder(source);
    const counts = await tenantRowCounts(source, args.tenant, tables);
    const total = counts.reduce((n, c) => n + c.rows, 0);
    if (counts[0]?.table === 'tenants' && counts[0].rows === 0) {
      throw new Error(`No tenant ${args.tenant} in this database — nothing to extract`);
    }

    const out = args.out ?? `tenant-${args.tenant}.sql`;
    const fd = fs.openSync(out, 'w');
    const write = (line: string) => fs.writeSync(fd, line);

    write(header(args.tenant, total));
    for (const table of tables) {
      const rows = counts.find((c) => c.table === table.table)?.rows ?? 0;
      write(`\n-- ${table.table} (${rows} rows)\n`);
      if (rows === 0) continue;
      const statements = await source.$queryRawUnsafe<{ stmt: string }[]>(
        extractStatementSql(table.table, table.tenantColumn, CHUNK_ROWS),
        args.tenant,
      );
      for (const s of statements) write(`${s.stmt}\n`);
      process.stderr.write(`  ${table.table}: ${rows}\n`);
    }
    write(footer());
    fs.closeSync(fd);

    process.stderr.write(`\nWrote ${out} — ${total} rows across ${tables.length} tables.\n`);
    process.stderr.write('Restore with: psql "$TARGET_DSN" -v ON_ERROR_STOP=1 -f ' + out + '\n');
  } finally {
    await source.$disconnect();
  }
}

/**
 * The dump is one transaction.
 *
 * Two settings earn their place in the preamble:
 *
 * - `session_replication_role = 'replica'` suspends foreign-key triggers for
 *   the restore. It is needed because Prisma's foreign keys are NOT DEFERRABLE,
 *   so `SET CONSTRAINTS ALL DEFERRED` would be a silent no-op, and a table
 *   whose rows reference each other (a team under its parent, a comment under
 *   its parent comment) cannot be inserted in any single statement order. It
 *   requires a superuser connection, and it means the restore does NOT check
 *   referential integrity — docs/32 makes re-checking it a numbered step
 *   rather than an assumption.
 * - `app.tenant_id` is set because RLS is FORCED on these tables: a restore
 *   under a role RLS applies to would otherwise be refused row by row.
 *
 * One transaction also means a single bad row rolls the whole tenant back
 * instead of leaving half of one in the destination.
 */
function header(tenantId: string, totalRows: number): string {
  return [
    `-- AVIORA tenant extract`,
    `-- tenant:    ${tenantId}`,
    `-- generated: ${new Date().toISOString()}`,
    `-- rows:      ${totalRows}`,
    `--`,
    `-- Restore into a database that has ALREADY had migrations applied and the`,
    `-- platform-global reference rows seeded (permissions, global knowledge).`,
    `-- Users are NOT in this file: a user account is platform-global and may`,
    `-- belong to other tenants (docs/32).`,
    `BEGIN;`,
    `SET LOCAL session_replication_role = 'replica';`,
    `SELECT set_config('app.tenant_id', '${tenantId}', true);`,
    '',
  ].join('\n');
}

function footer(): string {
  return ['', `COMMIT;`, ''].join('\n');
}

async function verify(args: Args): Promise<void> {
  const source = connect(resolveDsn(args.source, 'AVIORA_DATABASE_URL'));
  const target = connect(resolveDsn(args.target, 'AVIORA_TENANT_TARGET_DATABASE_URL'));
  try {
    const sourceTables = await tenantTablesInDependencyOrder(source);
    const targetTables = await tenantTablesInDependencyOrder(target);
    const missing = differences(sourceTables, targetTables);
    if (missing.length > 0) {
      throw new Error(
        `Source and target do not have the same tenant tables (${missing.join(', ')}). ` +
          'Apply the same migrations to both before verifying.',
      );
    }

    const [a, b] = await Promise.all([
      tenantTableChecksums(source, args.tenant, sourceTables),
      tenantTableChecksums(target, args.tenant, sourceTables),
    ]);

    let mismatches = 0;
    process.stdout.write(
      `${'table'.padEnd(34)}${'source'.padStart(10)}${'target'.padStart(10)}  result\n`,
    );
    for (let i = 0; i < a.length; i += 1) {
      const s = a[i]!;
      const t = b[i]!;
      const same = s.rows === t.rows && s.checksum === t.checksum;
      if (!same) mismatches += 1;
      const why = same ? 'ok' : s.rows !== t.rows ? 'ROW COUNT DIFFERS' : 'CHECKSUM DIFFERS';
      process.stdout.write(
        `${s.table.padEnd(34)}${String(s.rows).padStart(10)}${String(t.rows).padStart(10)}  ${why}\n`,
      );
    }
    process.stdout.write(
      `\n${a.length - mismatches}/${a.length} tables match. ` +
        `${mismatches === 0 ? 'No difference found.' : `${mismatches} table(s) differ.`}\n`,
    );
    if (mismatches > 0) process.exitCode = 1;
  } finally {
    await Promise.allSettled([source.$disconnect(), target.$disconnect()]);
  }
}

function differences(a: TenantTable[], b: TenantTable[]): string[] {
  const left = new Set(a.map((t) => t.table));
  const right = new Set(b.map((t) => t.table));
  return [
    ...[...left].filter((t) => !right.has(t)).map((t) => `${t} (source only)`),
    ...[...right].filter((t) => !left.has(t)).map((t) => `${t} (target only)`),
  ];
}

/** The same dry run `POST /platform/tenant-databases/:id/plan` returns. */
async function plan(args: Args): Promise<void> {
  const source = connect(resolveDsn(args.source, 'AVIORA_DATABASE_URL'));
  try {
    const tables = await tenantTablesInDependencyOrder(source);
    const counts = await tenantRowCounts(source, args.tenant, tables);
    for (const c of counts) {
      if (c.rows > 0) process.stdout.write(`${c.table.padEnd(34)}${String(c.rows).padStart(10)}\n`);
    }
    process.stdout.write(
      `\n${counts.reduce((n, c) => n + c.rows, 0)} rows would move, ` +
        `across ${counts.filter((c) => c.rows > 0).length} of ${counts.length} tables.\n`,
    );
  } finally {
    await source.$disconnect();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case 'extract':
      return extract(args);
    case 'verify':
      return verify(args);
    case 'plan':
      return plan(args);
    default:
      throw new Error(
        `Unknown command '${args.command}'. Use extract, verify or plan — see docs/32.`,
      );
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
