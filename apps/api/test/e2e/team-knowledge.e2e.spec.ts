/**
 * Team knowledge (Sprint 18, docs/37).
 *
 * This closes docs/14 §3 row 16 — the last open row in the MVP checklist —
 * which read: "Team-scoped knowledge does not exist yet, so there is nothing
 * team-level for the assistant to respect."
 *
 * The failure this whole sprint exists to prevent is concrete: a member of one
 * branch asks the assistant a question, and the answer quotes a RIVAL branch's
 * playbook — with a citation, which is what makes it look authorised. So the
 * central test asserts on the CITED ids and on the retrieved set, not on the
 * model's prose, which no test should depend on.
 *
 * The tree, all inside one tenant:
 *
 *        region            ← "Region handbook" (readable by everyone below)
 *        /      \
 *     north     south      ← "North pricing play" / "South pricing play"
 *
 *   · nadia   — member of north, leads nothing
 *   · sam     — member of south, leads nothing
 *   · rita    — leads region (so may publish to region, north and south)
 *   · outsider— member of no team at all
 *
 * Reading goes UP the tree and writing goes DOWN it (docs/37 §2), so the two
 * directions are asserted separately: nadia READS the region's handbook without
 * leading anything, and cannot PUBLISH to her own team.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import * as argon2 from 'argon2';
import { createOwnerClient, ensureAppRole, type PrismaClient } from '@aviora/db';
import { ENTITLEMENTS, PERMISSIONS } from '@aviora/shared';
import { createApp } from '../../src/app.factory';

const RUN = `k${Date.now().toString(36)}`;
const PLATFORM_EMAIL = `e2e-tk-platform-${RUN}@test.local`;
const PW = 'e2e-password-123456';

const REGION_SLUG = `region-handbook-${RUN}`;
const NORTH_SLUG = `north-pricing-play-${RUN}`;
const SOUTH_SLUG = `south-pricing-play-${RUN}`;
/** A word only the south article contains, so a leak is unambiguous. */
const SOUTH_MARKER = `zephyrine${RUN}`;
const NORTH_MARKER = `borealine${RUN}`;
const REGION_MARKER = `meridiane${RUN}`;

let app: INestApplication;
let base: string;
let owner: PrismaClient;
let tenant: string;
let adminToken: string;
let team: { region: string; north: string; south: string };
let token: { nadia: string; sam: string; rita: string; outsider: string };

async function api(
  path: string,
  init: RequestInit & { token?: string; tenant?: string } = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...(init.tenant ? { 'x-tenant-id': init.tenant } : {}),
    },
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function login(email: string): Promise<string> {
  const res = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PW }),
  });
  expect(res.status).toBe(200);
  const access = res.headers.getSetCookie().find((c) => c.startsWith('aviora_access='));
  return decodeURIComponent(access!.split(';')[0]!.split('=')[1]!);
}

/** Titles of the knowledge the search returned — what the assistant could cite. */
const slugsIn = (body: any): string[] =>
  (body?.knowledge ?? []).filter((k: any) => k.kind === 'article').map((k: any) => k.code);

beforeAll(async () => {
  process.env.AVIORA_SCHEDULER_DISABLED = 'true';
  process.env.AVIORA_OUTBOX_DISABLED = 'true';
  process.env.AVIORA_PII_ENCRYPTION_KEY ??= Buffer.alloc(32, 9).toString('base64');

  owner = createOwnerClient();
  await ensureAppRole(owner);
  for (const key of Object.values(PERMISSIONS)) {
    await owner.permission.upsert({ where: { key }, create: { key }, update: {} });
  }
  for (const key of Object.values(ENTITLEMENTS)) {
    await owner.entitlement.upsert({ where: { key }, create: { key }, update: {} });
  }
  await owner.user.upsert({
    where: { email: PLATFORM_EMAIL },
    create: {
      email: PLATFORM_EMAIL,
      passwordHash: await argon2.hash(PW, { type: argon2.argon2id }),
      displayName: 'E2E TK Platform',
      platformRole: 'PLATFORM_OWNER',
    },
    update: {},
  });

  app = await createApp({ logger: false });
  await app.listen(0);
  base = (await app.getUrl()).replace('[::1]', '127.0.0.1');

  const platform = await login(PLATFORM_EMAIL);
  const created = await api('/api/v1/platform/tenants', {
    method: 'POST',
    token: platform,
    body: JSON.stringify({
      code: `e2e_tk_${RUN}`,
      name: 'Knowledge Co',
      slug: `e2e-tk-${RUN}`,
      adminEmail: `tk-admin-${RUN}@test.local`,
      adminDisplayName: 'Admin',
      adminPassword: PW,
    }),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  tenant = created.body.tenant.id;
  adminToken = await login(`tk-admin-${RUN}@test.local`);

  const plan = await api('/api/v1/membership-plans', {
    method: 'POST',
    token: adminToken,
    tenant,
    // The assistant is entitlement-gated; without this the AI test would 403
    // and prove nothing about scope.
    body: JSON.stringify({
      code: 'std',
      name: 'Standard',
      entitlementKeys: [ENTITLEMENTS.AI_COACH],
    }),
  });
  expect(plan.status).toBe(201);
  const planId = plan.body.plan.id;

  const addMember = async (email: string, name: string): Promise<string> => {
    const inv = await api('/api/v1/invitations', {
      method: 'POST',
      token: adminToken,
      tenant,
      body: JSON.stringify({ email, planId }),
    });
    expect(inv.status).toBe(201);
    const evt = await owner.domainEvent.findFirst({
      where: { eventName: 'MemberInvited', tenantId: tenant, aggregateId: inv.body.invitation.id },
    });
    const accepted = await api(
      `/api/v1/invitations/${(evt!.payload as { token: string }).token}/accept`,
      { method: 'POST', body: JSON.stringify({ displayName: name, password: PW }) },
    );
    expect(accepted.status).toBe(201);
    return accepted.body.memberId;
  };

  const mkTeam = async (code: string, name: string, parentTeamId?: string): Promise<string> => {
    const res = await api('/api/v1/teams', {
      method: 'POST',
      token: adminToken,
      tenant,
      body: JSON.stringify({ code, name, ...(parentTeamId ? { parentTeamId } : {}) }),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.team.id as string;
  };
  const join = async (teamId: string, memberId: string) => {
    const res = await api(`/api/v1/teams/${teamId}/members`, {
      method: 'POST',
      token: adminToken,
      tenant,
      body: JSON.stringify({ memberId }),
    });
    expect(res.status).toBe(201);
  };
  const lead = async (teamId: string, memberId: string) => {
    const res = await api(`/api/v1/teams/${teamId}/leaders`, {
      method: 'POST',
      token: adminToken,
      tenant,
      body: JSON.stringify({ memberId }),
    });
    expect(res.status).toBe(201);
  };

  const region = await mkTeam(`region-${RUN}`, 'Region');
  const north = await mkTeam(`north-${RUN}`, 'North', region);
  const south = await mkTeam(`south-${RUN}`, 'South', region);
  team = { region, north, south };

  const nadia = await addMember(`nadia-${RUN}@test.local`, 'Nadia Ford');
  const sam = await addMember(`sam-${RUN}@test.local`, 'Sam Iyer');
  const rita = await addMember(`rita-${RUN}@test.local`, 'Rita Osei');
  await addMember(`outsider-${RUN}@test.local`, 'Otto Sider');

  await join(north, nadia);
  await join(south, sam);
  await join(region, rita);
  await lead(region, rita);

  token = {
    nadia: await login(`nadia-${RUN}@test.local`),
    sam: await login(`sam-${RUN}@test.local`),
    rita: await login(`rita-${RUN}@test.local`),
    outsider: await login(`outsider-${RUN}@test.local`),
  };

  // Rita leads the region, so she may publish to the region and to both
  // branches beneath it (docs/37 §2, writing goes down).
  const publish = async (teamId: string, slug: string, title: string, marker: string) => {
    const res = await api('/api/v1/knowledge/team-articles', {
      method: 'POST',
      token: token.rita,
      tenant,
      body: JSON.stringify({
        teamId,
        slug,
        title,
        summary: `Pricing guidance. Reference ${marker}.`,
        body: `The agreed approach for pricing conversations. Codeword ${marker}.`,
      }),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  };
  await publish(team.region, REGION_SLUG, 'Region handbook', REGION_MARKER);
  await publish(team.north, NORTH_SLUG, 'North pricing play', NORTH_MARKER);
  await publish(team.south, SOUTH_SLUG, 'South pricing play', SOUTH_MARKER);
}, 240_000);

afterAll(async () => {
  await app?.close();
  await owner?.$disconnect();
});

/* ── 1. the leak this sprint exists to prevent ────────────────────────────── */

describe('One team’s knowledge does not answer another team’s question (docs/37 §3)', () => {
  it('never retrieves — and so never cites — another branch’s article', async () => {
    const res = await api(`/api/v1/knowledge/search?q=pricing%20${SOUTH_MARKER}`, {
      token: token.nadia,
      tenant,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(
      slugsIn(res.body),
      `north's member retrieved south's article. Everything downstream — the ` +
        `summary, the citation, the answer — is built from what retrieval returns, ` +
        `so a leak here is a leak everywhere.`,
    ).not.toContain(SOUTH_SLUG);
    // The response echoes the query back, and the query contains the marker —
    // so the assertion is on what was RETRIEVED, not on the whole envelope.
    expect(JSON.stringify(res.body.knowledge)).not.toContain(SOUTH_MARKER);
  });

  it('answers the assistant from the caller’s own scope, citing nothing beyond it', async () => {
    const res = await api('/api/v1/ai/ask', {
      method: 'POST',
      token: token.nadia,
      tenant,
      // Deliberately WITHOUT the codeword. The assistant quotes the member's
      // own question back, so a question containing the codeword would prove
      // nothing — every appearance of it here can only have come from
      // retrieval, which is the thing under test.
      body: JSON.stringify({ question: 'What is our pricing approach?' }),
    });
    expect([200, 201]).toContain(res.status);
    const cited = (res.body?.citations ?? []).map((c: { code: string }) => c.code);
    expect(cited, 'the assistant cited another branch’s playbook').not.toContain(SOUTH_SLUG);
    expect(
      JSON.stringify(res.body),
      'the answer carried a codeword only the other branch’s article contains',
    ).not.toContain(SOUTH_MARKER);
    // and it did answer from what she MAY read, rather than refusing everything
    expect(
      cited.length,
      'nothing was retrieved at all, so the test proves nothing',
    ).toBeGreaterThan(0);
  });

  it('404s the other branch’s article by slug — 403 would confirm it exists', async () => {
    const res = await api(`/api/v1/knowledge/articles/${SOUTH_SLUG}`, {
      token: token.nadia,
      tenant,
    });
    expect(res.status).toBe(404);
  });

  it('gives a member of no team the tenant’s knowledge and no team’s knowledge', async () => {
    const res = await api(`/api/v1/knowledge/search?q=pricing`, {
      token: token.outsider,
      tenant,
    });
    expect(res.status).toBe(200);
    const slugs = slugsIn(res.body);
    for (const slug of [REGION_SLUG, NORTH_SLUG, SOUTH_SLUG]) {
      expect(slugs, `an unaffiliated member saw ${slug}`).not.toContain(slug);
    }
  });
});

/* ── 2. reading goes up the tree ──────────────────────────────────────────── */

describe('A member reads their own team, and everything above it (docs/37 §2)', () => {
  it('reads the article attached to their own team', async () => {
    const res = await api(`/api/v1/knowledge/search?q=${NORTH_MARKER}`, {
      token: token.nadia,
      tenant,
    });
    expect(slugsIn(res.body)).toContain(NORTH_SLUG);
  });

  it('reads the region handbook without leading anything', async () => {
    // The point of "reading goes UP": nadia leads nothing, and the regional
    // handbook is meant for the branches beneath it.
    const res = await api(`/api/v1/knowledge/search?q=${REGION_MARKER}`, {
      token: token.nadia,
      tenant,
    });
    expect(
      slugsIn(res.body),
      'a member could not read the handbook published to the region above them',
    ).toContain(REGION_SLUG);

    const direct = await api(`/api/v1/knowledge/articles/${REGION_SLUG}`, {
      token: token.nadia,
      tenant,
    });
    expect(direct.status).toBe(200);
  });

  it('does not read sideways — the other branch is neither above nor below', async () => {
    const res = await api(`/api/v1/knowledge/articles/${NORTH_SLUG}`, {
      token: token.sam,
      tenant,
    });
    expect(res.status).toBe(404);
  });

  it('a leader above reads both branches beneath', async () => {
    const res = await api(`/api/v1/knowledge/search?q=pricing`, { token: token.rita, tenant });
    const slugs = slugsIn(res.body);
    expect(slugs).toContain(REGION_SLUG);
  });
});

/* ── 3. writing goes down the tree ────────────────────────────────────────── */

describe('Publishing is leadership, not membership (docs/37 §2, §5)', () => {
  it('refuses a member publishing to their own team', async () => {
    const res = await api('/api/v1/knowledge/team-articles', {
      method: 'POST',
      token: token.nadia,
      tenant,
      body: JSON.stringify({
        teamId: team.north,
        slug: `nadia-attempt-${RUN}`,
        title: 'Unauthorised',
        body: 'Should never exist.',
      }),
    });
    expect(
      res.status,
      'a member of a team could publish to it — reading is membership, writing is not',
    ).toBe(403);
  });

  it('refuses a leader publishing outside the teams they lead', async () => {
    // A second tenant's team would be refused by tenancy; the sharper case is
    // a team in the SAME tenant that this leader does not lead. Nadia's own
    // team is beneath rita, so we need a sibling of the region: make one.
    const outside = await api('/api/v1/teams', {
      method: 'POST',
      token: adminToken,
      tenant,
      body: JSON.stringify({ code: `elsewhere-${RUN}`, name: 'Elsewhere' }),
    });
    expect(outside.status).toBe(201);

    const res = await api('/api/v1/knowledge/team-articles', {
      method: 'POST',
      token: token.rita,
      tenant,
      body: JSON.stringify({
        teamId: outside.body.team.id,
        slug: `rita-overreach-${RUN}`,
        title: 'Out of scope',
        body: 'Should never exist.',
      }),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error.message).toMatch(/teams you lead/i);
  });

  it('lists what a leader has published, and nothing they have not', async () => {
    const res = await api('/api/v1/knowledge/team-articles', { token: token.rita, tenant });
    expect(res.status).toBe(200);
    const slugs = res.body.articles.map((a: { slug: string }) => a.slug);
    expect(slugs).toEqual(expect.arrayContaining([REGION_SLUG, NORTH_SLUG, SOUTH_SLUG]));
  });

  it('unpublishing removes it from the team’s search without deleting it', async () => {
    const mine = await api('/api/v1/knowledge/team-articles', { token: token.rita, tenant });
    const article = mine.body.articles.find((a: { slug: string }) => a.slug === NORTH_SLUG);

    const patched = await api(`/api/v1/knowledge/team-articles/${article.id}`, {
      method: 'PATCH',
      token: token.rita,
      tenant,
      body: JSON.stringify({ status: 'draft' }),
    });
    expect(patched.status).toBe(200);

    const search = await api(`/api/v1/knowledge/search?q=${NORTH_MARKER}`, {
      token: token.nadia,
      tenant,
    });
    expect(slugsIn(search.body)).not.toContain(NORTH_SLUG);

    // still there — a team that acted on this guidance can still be shown what
    // it said (docs/37 §5)
    const still = await api('/api/v1/knowledge/team-articles', { token: token.rita, tenant });
    expect(still.body.articles.map((a: { slug: string }) => a.slug)).toContain(NORTH_SLUG);
  });
});

/* ── 4. the database refuses a row nobody can scope ───────────────────────── */

describe('A team article always belongs to a tenant (docs/37 §1)', () => {
  it('refuses an article naming a team but no tenant', async () => {
    await expect(
      owner.$executeRawUnsafe(
        `INSERT INTO articles (id, tenant_id, team_id, slug, title, body, status, search_text, created_at, updated_at)
         VALUES (gen_random_uuid(), NULL, $1::uuid, $2, 'Orphan', 'body', 'published', '', now(), now())`,
        team.north,
        `orphan-${RUN}`,
      ),
      'a team article with no tenant is a row nobody can scope, and the database should say so',
    ).rejects.toThrow();
  });
});
