/**
 * Schema meta-tests (docs/23 Sprint-0 DoD):
 * 1. zero `timestamp without time zone` columns — timestamptz is mandatory
 * 2. every tenant-owned table has RLS ENABLED + FORCED and a policy attached
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOwnerClient, type PrismaClient } from '@aviora/db';

const TENANT_OWNED_TABLES = [
  'tenant_settings',
  'tenant_memberships',
  'members',
  'roles',
  'role_permissions',
  'member_roles',
  'audit_logs',
  'membership_plans',
  'plan_entitlements',
  'memberships',
  'invitations',
  'teams',
  'team_closure',
  'team_memberships',
  'team_leaderships',
  'goals',
  'courses',
  'lessons',
  'learning_progress',
];

let owner: PrismaClient;

beforeAll(async () => {
  owner = createOwnerClient();
});

afterAll(async () => {
  await owner.$disconnect();
});

describe('schema meta', () => {
  it('has zero timestamp-without-time-zone columns', async () => {
    const rows = await owner.$queryRaw<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND data_type = 'timestamp without time zone'`;
    expect(rows).toEqual([]);
  });

  it('has RLS enabled + forced on every tenant-owned table', async () => {
    const rows = await owner.$queryRaw<
      { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >`
      SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE relname = ANY(${TENANT_OWNED_TABLES}) AND relkind = 'r'`;
    expect(rows.map((r) => r.relname).sort()).toEqual([...TENANT_OWNED_TABLES].sort());
    for (const r of rows) {
      expect(r.relrowsecurity, `${r.relname} must ENABLE RLS`).toBe(true);
      expect(r.relforcerowsecurity, `${r.relname} must FORCE RLS`).toBe(true);
    }
  });

  it('has a tenant_isolation policy on every tenant-owned table', async () => {
    const rows = await owner.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_policies
      WHERE schemaname = 'public' AND policyname = 'tenant_isolation'`;
    expect(rows.map((r) => r.tablename).sort()).toEqual([...TENANT_OWNED_TABLES].sort());
  });

  it('every tenant-owned table has a NOT NULL tenant_id uuid column', async () => {
    // audit_logs.tenant_id is deliberately nullable: platform-scope audit rows
    // carry NULL and are invisible to the app role (owner/platform reads only).
    const mustBeNotNull = TENANT_OWNED_TABLES.filter((t) => t !== 'audit_logs');
    const rows = await owner.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'tenant_id'
        AND is_nullable = 'NO' AND udt_name = 'uuid'`;
    const names = rows.map((r) => r.table_name);
    for (const t of mustBeNotNull) {
      expect(names, `${t}.tenant_id must be NOT NULL uuid`).toContain(t);
    }
  });
});
