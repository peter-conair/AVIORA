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
  'pipeline_stages',
  'leads',
  'customers',
  'follow_ups',
  'interactions',
  'notifications',
  'notification_preferences',
  'ai_conversations',
  'ai_messages',
  'ai_usage',
  'health_profiles',
  'habits',
  'habit_logs',
  'health_metrics',
  'health_data_grants',
  'communities',
  'posts',
  'comments',
  'reactions',
  'challenges',
  'challenge_participants',
  'gamification_rules',
  'point_entries',
  'member_badges',
];

/**
 * Knowledge tables are LAYERED, not strictly tenant-owned: tenant_id NULL means
 * global knowledge every tenant may read. They carry the same policy name but a
 * different USING clause, and their tenant_id is deliberately nullable.
 */
const LAYERED_KNOWLEDGE_TABLES = [
  'health_goals',
  'topics',
  'ingredients',
  'evidence_references',
  'articles',
  'brands',
  'products',
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
      WHERE relname = ANY(${[...TENANT_OWNED_TABLES, ...LAYERED_KNOWLEDGE_TABLES]}) AND relkind = 'r'`;
    expect(rows.map((r) => r.relname).sort()).toEqual(
      [...TENANT_OWNED_TABLES, ...LAYERED_KNOWLEDGE_TABLES].sort(),
    );
    for (const r of rows) {
      expect(r.relrowsecurity, `${r.relname} must ENABLE RLS`).toBe(true);
      expect(r.relforcerowsecurity, `${r.relname} must FORCE RLS`).toBe(true);
    }
  });

  it('has a tenant_isolation policy on every tenant-owned table', async () => {
    const rows = await owner.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_policies
      WHERE schemaname = 'public' AND policyname = 'tenant_isolation'`;
    expect(rows.map((r) => r.tablename).sort()).toEqual(
      [...TENANT_OWNED_TABLES, ...LAYERED_KNOWLEDGE_TABLES].sort(),
    );
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

describe('layered knowledge policies', () => {
  it('lets every tenant read global rows but never write them', async () => {
    const rows = await owner.$queryRaw<{ tablename: string; qual: string; withcheck: string }[]>`
      SELECT tablename, qual, with_check AS withcheck FROM pg_policies
      WHERE schemaname = 'public' AND policyname = 'tenant_isolation'
        AND tablename = ANY(${LAYERED_KNOWLEDGE_TABLES})`;
    expect(rows).toHaveLength(LAYERED_KNOWLEDGE_TABLES.length);
    for (const r of rows) {
      // readable when global OR owned by the caller's tenant …
      expect(r.qual, `${r.tablename} USING`).toMatch(/tenant_id IS NULL/i);
      // … but writes must always name the caller's tenant
      expect(r.withcheck, `${r.tablename} WITH CHECK`).not.toMatch(/IS NULL/i);
    }
  });
});
