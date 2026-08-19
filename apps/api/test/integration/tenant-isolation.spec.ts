/**
 * THE tenant-isolation suite (docs/17 — highest-priority tests, CI-blocking).
 * Runs against a real Postgres with migrations applied, as the NON-OWNER
 * `aviora_app` role — Tenant Alpha must never see or write Tenant Beta data.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createAppClient,
  createOwnerClient,
  ensureAppRole,
  tenantExtension,
  withTenant,
  type PrismaClient,
} from '@aviora/db';

const ALPHA = { code: 'test_alpha', slug: 'test-alpha', name: 'Tenant Alpha (test)' };
const BETA = { code: 'test_beta', slug: 'test-beta', name: 'Tenant Beta (test)' };

let owner: PrismaClient;
let app: PrismaClient;
let alphaId: string;
let betaId: string;

async function upsertFixtures() {
  const alpha = await owner.tenant.upsert({
    where: { code: ALPHA.code },
    create: ALPHA,
    update: {},
  });
  const beta = await owner.tenant.upsert({ where: { code: BETA.code }, create: BETA, update: {} });
  alphaId = alpha.id;
  betaId = beta.id;

  for (const [tenantId, email] of [
    [alphaId, 'alpha-member@test.local'],
    [betaId, 'beta-member@test.local'],
  ] as const) {
    const user = await owner.user.upsert({
      where: { email },
      create: { email, passwordHash: 'x', displayName: email },
      update: {},
    });
    await owner.member.upsert({
      where: { tenantId_userId: { tenantId, userId: user.id } },
      create: { tenantId, userId: user.id, displayName: email },
      update: {},
    });
  }
}

beforeAll(async () => {
  owner = createOwnerClient();
  await ensureAppRole(owner);
  await upsertFixtures();
  app = createAppClient();
  await app.$connect();
});

afterAll(async () => {
  await Promise.allSettled([owner.$disconnect(), app.$disconnect()]);
});

describe('RLS tenant isolation (as aviora_app)', () => {
  it('sanity: app role is not the table owner and cannot bypass RLS', async () => {
    const rows = await app.$queryRaw<{ current_user: string; bypass: boolean }[]>`
      SELECT current_user, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`;
    expect(rows[0]?.current_user).toBe('aviora_app');
    expect(rows[0]?.bypass).toBe(false);
  });

  it('alpha context sees only alpha members', async () => {
    const members = await withTenant(app, alphaId, (tx) => tx.member.findMany());
    expect(members.length).toBeGreaterThan(0);
    expect(members.every((m) => m.tenantId === alphaId)).toBe(true);
  });

  it('beta context sees only beta members', async () => {
    const members = await withTenant(app, betaId, (tx) => tx.member.findMany());
    expect(members.length).toBeGreaterThan(0);
    expect(members.every((m) => m.tenantId === betaId)).toBe(true);
  });

  it('no tenant context ⇒ zero rows from tenant-owned tables', async () => {
    const rows = await app.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM members`;
    expect(Number(rows[0]?.n)).toBe(0);
  });

  it('a forged where-clause cannot widen access across tenants', async () => {
    const members = await withTenant(app, alphaId, (tx) =>
      tx.member.findMany({ where: { tenantId: betaId } }),
    );
    expect(members).toHaveLength(0);
  });

  it('cross-tenant WRITE is rejected by RLS WITH CHECK', async () => {
    const alphaUser = await owner.user.findUniqueOrThrow({
      where: { email: 'alpha-member@test.local' },
    });
    await expect(
      withTenant(app, alphaId, (tx) =>
        tx.member.create({
          data: { tenantId: betaId, userId: alphaUser.id, displayName: 'smuggled' },
        }),
      ),
    ).rejects.toThrow(/row-level security|denied/i);
  });

  it('cross-tenant UPDATE affects zero rows', async () => {
    const res = await withTenant(app, alphaId, (tx) =>
      tx.member.updateMany({ where: { tenantId: betaId }, data: { status: 'hacked' } }),
    );
    expect(res.count).toBe(0);
    const betaMembers = await withTenant(app, betaId, (tx) => tx.member.findMany());
    expect(betaMembers.every((m) => m.status !== 'hacked')).toBe(true);
  });
});

describe('app-layer tenant guard (Prisma extension)', () => {
  it('refuses tenant-owned queries when TenantContext is missing', async () => {
    const guarded = app.$extends(tenantExtension(() => null));
    await expect(guarded.member.findMany()).rejects.toThrow(/TenantContext missing/);
  });

  it('auto-injects tenant_id on list queries', async () => {
    const guarded = app.$extends(tenantExtension(() => alphaId));
    const members = await withTenant(guarded as unknown as PrismaClient, alphaId, (tx) =>
      tx.member.findMany(),
    );
    expect(members.every((m) => m.tenantId === alphaId)).toBe(true);
  });
});
