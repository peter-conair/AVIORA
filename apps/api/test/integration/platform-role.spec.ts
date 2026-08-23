/**
 * The platform role is bound by the database, not exempt from it (docs/53).
 *
 * docs/03 §4.1 recorded the gap this closes: platform paths ran as the table
 * OWNER, and Postgres exempts an owner from its own tables' policies even under
 * FORCE ROW LEVEL SECURITY — so on those paths there was no second layer at all.
 *
 * The property worth testing is not "platform can read across tenants". It is
 * that the exemption has to be ASKED FOR: a platform connection that does not
 * declare itself sees nothing. That is what makes it an explicit entry point
 * rather than an inherited privilege, and it is the assertion that would fail
 * if somebody later replaced the policy with `USING (true)`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createOwnerClient,
  createPlatformClient,
  withPlatform,
  type PrismaClient,
} from '@aviora/db';

let owner: PrismaClient;
let platform: PrismaClient;
let tenantCount = 0;

beforeAll(async () => {
  owner = createOwnerClient();
  platform = createPlatformClient();
  tenantCount = await owner.tenant.count();
  expect(tenantCount, 'no tenants — this file would compare nothing').toBeGreaterThan(1);
}, 60_000);

afterAll(async () => {
  await owner?.$disconnect();
  await platform?.$disconnect();
});

describe('It must declare itself (docs/53 §2)', () => {
  it('reads NOTHING from a tenant-owned table without the flag', async () => {
    // No withPlatform, no app.tenant_id: the policies see a connection claiming
    // nothing, and both refuse.
    const members = await platform.member.count();
    expect(
      members,
      'the platform role read tenant-owned rows without declaring itself. Either ' +
        'the policy is USING (true), or the role is BYPASSRLS — in both cases it ' +
        'is the owner again with a different name.',
    ).toBe(0);
  });

  it('reads across tenants once it does declare itself', async () => {
    const seen = await withPlatform(platform, (tx) => tx.member.count());
    expect(
      seen,
      'the platform role saw nothing even inside withPlatform, so the policy ' +
        'admits no one and every platform view is broken',
    ).toBeGreaterThan(0);
  });

  it('sees more than one tenant, which is the whole point', async () => {
    const tenants = await withPlatform(platform, (tx) =>
      tx.member.findMany({ select: { tenantId: true }, distinct: ['tenantId'], take: 5 }),
    );
    expect(
      new Set(tenants.map((t) => t.tenantId)).size,
      'a declared platform read still saw one tenant, so it is not crossing at all',
    ).toBeGreaterThan(1);
  });
});

describe('It is not the owner (docs/53 §2)', () => {
  it('has neither superuser nor BYPASSRLS', async () => {
    const rows = await owner.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'aviora_platform'`;
    expect(rows[0], 'aviora_platform does not exist').toBeTruthy();
    expect(rows[0]!.rolsuper, 'the platform role is a superuser').toBe(false);
    expect(
      rows[0]!.rolbypassrls,
      'the platform role can bypass RLS, which makes its policy decorative',
    ).toBe(false);
  });

  it('cannot change the schema', async () => {
    // A role that can ALTER TABLE can drop its own policy, which would make
    // everything above ceremony.
    await expect(
      platform.$executeRawUnsafe('CREATE TABLE platform_role_probe (id int)'),
    ).rejects.toThrow();
  });

  /**
   * Tables the platform role must NOT be able to read, with the reason.
   *
   * The same shape as `UNAUDITED` in audit-coverage: the invariant holds
   * everywhere else, and an exception is a decision somebody made out loud
   * rather than a gap nobody noticed.
   */
  const NO_PLATFORM_READ: Array<{ table: string; why: string }> = [
    {
      table: 'customer_consents',
      why: 'Consent is between a customer and the member who took it (docs/65 §3). The platform operator reading it is not what the customer agreed to.',
    },
    {
      table: 'progress_photos',
      why: 'A customer consented to their salesperson holding their photograph, not to the platform operator being able to look at it (docs/65 §3). Cross-tenant support access to before/after pictures of people is not a trade worth making for easier debugging.',
    },
  ];

  it('carries a policy on every table that has tenant_isolation', async () => {
    // If a table gained tenant_isolation later without platform_access, a
    // platform view over it would silently return nothing — the quiet
    // half-failure this whole design is arranged to avoid.
    const gaps = await owner.$queryRaw<Array<{ relname: string }>>`
      SELECT c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation')
         AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'platform_access')`;
    const excluded = new Set(NO_PLATFORM_READ.map((e) => e.table));
    expect(
      gaps.map((g) => g.relname).filter((name) => !excluded.has(name)),
      'these tables are tenant-isolated but have no platform policy, so a ' +
        'platform read over them returns nothing rather than failing loudly. ' +
        'If that is deliberate, add it to NO_PLATFORM_READ with the reason.',
    ).toEqual([]);

    // And the exclusions must still be real: an entry left behind after its
    // table gained a policy would quietly stop protecting anything.
    const stillExcluded = gaps.map((g) => g.relname);
    for (const entry of NO_PLATFORM_READ) {
      expect(
        stillExcluded,
        `${entry.table} now has a platform policy — remove it from NO_PLATFORM_READ`,
      ).toContain(entry.table);
    }
  });
});
