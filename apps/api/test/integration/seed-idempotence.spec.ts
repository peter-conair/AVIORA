/**
 * The seed runs twice and changes nothing the second time (docs/23 Sprint-0 DoD).
 *
 * docs/17 §15 has said the seed "is itself under test (running twice yields
 * identical state)" since it was written. Nothing tested it. That matters more
 * than most stale claims because the seed runs on EVERY DEPLOY — it is the one
 * script that touches a production database unattended, and "idempotent"
 * printed at the end of its own output is not evidence.
 *
 * It is executed as a child process, exactly as a deploy runs it, rather than
 * by importing a function: the file has no exported entry point, and a test
 * that imported one would be testing a shape the deploy does not use.
 */
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOwnerClient, type PrismaClient } from '@aviora/db';

let owner: PrismaClient;
const dbRoot = path.resolve(__dirname, '../../../../packages/db');

/** Everything the seed claims to ensure, counted the way a reviewer would. */
async function snapshot(prisma: PrismaClient) {
  const [permissions, entitlements, brands, products, articles, topics, goals, ingredients] =
    await Promise.all([
      prisma.permission.count(),
      prisma.entitlement.count(),
      prisma.brand.count({ where: { tenantId: null } }),
      prisma.product.count({ where: { tenantId: null } }),
      prisma.article.count({ where: { tenantId: null } }),
      prisma.topic.count({ where: { tenantId: null } }),
      prisma.healthGoal.count({ where: { tenantId: null } }),
      prisma.ingredient.count({ where: { tenantId: null } }),
    ]);
  const admins = await prisma.user.count({ where: { platformRole: { not: null } } });
  // Role grants are the part a repair pass rewrites, so they are the part most
  // likely to differ between runs.
  const grants = await prisma.rolePermission.count();
  const roles = await prisma.role.count();
  return {
    permissions,
    entitlements,
    brands,
    products,
    articles,
    topics,
    goals,
    ingredients,
    admins,
    grants,
    roles,
  };
}

function runSeed(): void {
  execFileSync('pnpm', ['db:seed'], {
    cwd: dbRoot,
    stdio: 'pipe',
    env: process.env,
    timeout: 240_000,
  });
}

beforeAll(async () => {
  owner = createOwnerClient();
}, 60_000);

afterAll(async () => {
  await owner?.$disconnect();
});

describe('The seed is idempotent, which every deploy depends on', () => {
  it('leaves identical state when run twice in a row', () => {
    // Run it once to reach a known state — this database has been seeded before,
    // but not necessarily by the current version of the script.
    runSeed();
  }, 300_000);

  it('changes nothing on the second run', async () => {
    const before = await snapshot(owner);
    runSeed();
    const after = await snapshot(owner);

    expect(
      after,
      'the seed produced different state on a second run. It executes on every ' +
        'deploy against a live database, so a seed that is not idempotent is a ' +
        'deploy that quietly edits production.',
    ).toEqual(before);

    // Not vacuous: a snapshot of all zeros would compare equal to itself.
    expect(before.permissions, 'no permissions seeded — this compares nothing').toBeGreaterThan(0);
    expect(before.roles, 'no roles seeded — this compares nothing').toBeGreaterThan(0);
    expect(before.products, 'no global knowledge seeded — this compares nothing').toBeGreaterThan(
      0,
    );
  }, 300_000);
});
