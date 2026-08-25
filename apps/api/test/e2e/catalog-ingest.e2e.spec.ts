/**
 * Products from another system (Sprint 49, docs/74).
 *
 * The route is one POST, and almost everything worth testing about it is a
 * REFUSAL. A write into the catalogue every tenant reads has exactly two ways
 * to be wrong: the wrong caller reaches it, or the right caller overwrites
 * something nobody asked them to. So the assertions here are, in order:
 *
 *  1. a tenant key cannot reach it, and a platform key cannot reach the
 *     tenant-scoped routes beside it — the check runs BOTH ways or it is not a
 *     boundary, it is a habit;
 *  2. a product curated in AVIORA is reported back untouched rather than
 *     rewritten, and so is one owned by a different sender;
 *  3. a retry is answered with what the FIRST attempt did.
 *
 * And one assertion that is not about refusing: an ingested product is only
 * worth anything if a member can reach it. That is proved through the member's
 * own API — search, and the ingredient page — never by reading the row back.
 *
 * NOTE: stop any locally running API — the outbox relay is cross-tenant.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import * as argon2 from 'argon2';
import {
  createOwnerClient,
  ensureAppRole,
  seedGlobalKnowledge,
  type PrismaClient,
} from '@aviora/db';
import { ENTITLEMENTS, PERMISSIONS } from '@aviora/shared';
import { createApp } from '../../src/app.factory';

const RUN = `ci${Date.now().toString(36)}`;
const PLATFORM_EMAIL = `e2e-ci-platform-${RUN}@test.local`;
const ADMIN_EMAIL = `e2e-ci-admin-${RUN}@test.local`;
const PW = 'e2e-password-123456';

/** The sender this suite speaks as, and a second one that must not overwrite it. */
const SOURCE = 'e2e-ingest';
const OTHER_SOURCE = 'e2e-other';

const METER = `hanna-hi98103-${RUN}`;
const BUFFER = `hanna-hi7004-${RUN}`;
const METER_NAME = `Pocket pH Meter HI98103 ${RUN}`;

let app: INestApplication;
let base: string;
let owner: PrismaClient;
let tenant: string;
let adminToken: string;
/** The platform key this suite writes with, and a tenant key that must not. */
let platformKey: string;
let scopelessKey: string;
let tenantKey: string;
/** A code the seed curated: the ingest must refuse it. */
let curatedCode: string;

async function api(
  path: string,
  init: RequestInit & { token?: string; tenant?: string; key?: string; idempotency?: string } = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...(init.key ? { authorization: `Bearer ${init.key}` } : {}),
      ...(init.tenant ? { 'x-tenant-id': init.tenant } : {}),
      ...(init.idempotency ? { 'idempotency-key': init.idempotency } : {}),
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

/** The meter, as the sender would send it. */
function meter(over: Record<string, unknown> = {}) {
  return {
    code: METER,
    name: METER_NAME,
    brand: { code: `hanna-${RUN}`, name: 'HANNA' },
    description: 'A pocket pH meter.',
    sourceUrl: 'https://example.com/hi98103',
    ...over,
  };
}

function ingest(
  products: Array<Record<string, unknown>>,
  opts: { key?: string; source?: string; idempotency?: string } = {},
) {
  return api('/api/v1/public/knowledge/products', {
    method: 'POST',
    key: opts.key ?? platformKey,
    idempotency: opts.idempotency,
    body: JSON.stringify({ source: opts.source ?? SOURCE, products }),
  });
}

beforeAll(async () => {
  process.env.AVIORA_SCHEDULER_DISABLED = 'true';
  process.env.AVIORA_OUTBOX_DISABLED = 'true';
  process.env.AVIORA_PII_ENCRYPTION_KEY ??= Buffer.alloc(32, 23).toString('base64');

  owner = createOwnerClient();
  await ensureAppRole(owner);
  for (const key of Object.values(PERMISSIONS)) {
    await owner.permission.upsert({ where: { key }, create: { key }, update: {} });
  }
  for (const key of Object.values(ENTITLEMENTS)) {
    await owner.entitlement.upsert({ where: { key }, create: { key }, update: {} });
  }
  // The curated catalogue this ingest must not touch, and the ingredient it
  // may link to. Both come from the seed rather than being written here: a
  // fixture the test controls could be shaped to make the test pass.
  await seedGlobalKnowledge(owner);
  const curated = await owner.product.findFirst({
    where: { tenantId: null, source: null },
    select: { code: true },
  });
  expect(curated, 'the knowledge seed has no curated product to defend').toBeTruthy();
  curatedCode = curated!.code;

  await owner.user.upsert({
    where: { email: PLATFORM_EMAIL },
    create: {
      email: PLATFORM_EMAIL,
      passwordHash: await argon2.hash(PW, { type: argon2.argon2id }),
      displayName: 'E2E Ingest Platform',
      platformRole: 'PLATFORM_OWNER',
    },
    update: {},
  });

  app = await createApp({ logger: false });
  await app.listen(0);
  base = (await app.getUrl()).replace('[::1]', '127.0.0.1');

  const platformToken = await login(PLATFORM_EMAIL);
  const made = await api('/api/v1/platform/tenants', {
    method: 'POST',
    token: platformToken,
    body: JSON.stringify({
      code: `e2e_ci_${RUN}`,
      name: 'Ingest Co',
      slug: `e2e-ci-${RUN}`,
      adminEmail: ADMIN_EMAIL,
      adminDisplayName: 'Admin',
      adminPassword: PW,
    }),
  });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  tenant = made.body.tenant.id;
  adminToken = await login(ADMIN_EMAIL);

  const mkPlatformKey = async (name: string, scopes: string[]): Promise<string> => {
    const res = await api('/api/v1/platform/api-keys', {
      method: 'POST',
      token: platformToken,
      body: JSON.stringify({ name, scopes }),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.key;
  };
  platformKey = await mkPlatformKey('ingest', [PERMISSIONS.PLATFORM_KNOWLEDGE_CATALOG_MANAGE]);
  scopelessKey = await mkPlatformKey('reader', [PERMISSIONS.MEMBER_VIEW]);

  const tenantKeyRes = await api('/api/v1/api-keys', {
    method: 'POST',
    token: adminToken,
    tenant,
    body: JSON.stringify({ name: 'tenant', scopes: [PERMISSIONS.MEMBER_VIEW] }),
  });
  expect(tenantKeyRes.status, JSON.stringify(tenantKeyRes.body)).toBe(201);
  tenantKey = tenantKeyRes.body.key;
}, 300_000);

afterAll(async () => {
  await app?.close();
  await owner?.$disconnect();
});

describe('A key that belongs to no tenant (docs/74 §2)', () => {
  it('is told apart from a tenant key by looking at it', () => {
    expect(platformKey.startsWith('avpk_')).toBe(true);
    expect(tenantKey.startsWith('avk_')).toBe(true);
  });

  it('is not something a tenant owner can mint for themselves', async () => {
    // The tenant admin holds every tenant-scope permission, including
    // integration.manage. That must not be a route to a key that writes the
    // catalogue every other tenant reads.
    const res = await api('/api/v1/platform/api-keys', {
      method: 'POST',
      token: adminToken,
      tenant,
      body: JSON.stringify({ name: 'sneaky', scopes: [PERMISSIONS.MEMBER_VIEW] }),
    });
    expect(res.status).toBe(403);
  });

  it('is refused on the routes that serve one tenant', async () => {
    // The other direction, and the one that is easy to forget: a key naming no
    // tenant must never be handed whichever tenant the host resolved.
    const res = await api('/api/v1/public/members', { key: platformKey, tenant });
    expect(res.status).toBe(403);
    expect(res.body.error.details.required).toBe('tenant');
  });

  it('never returns the key again after minting it', async () => {
    const res = await api('/api/v1/platform/api-keys', {
      token: await login(PLATFORM_EMAIL),
    });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(platformKey);
    for (const k of res.body.apiKeys) expect(k.hash).toBeUndefined();
  });
});

describe('Reaching the ingest at all', () => {
  it('refuses a tenant key', async () => {
    const res = await ingest([meter()], { key: tenantKey });
    expect(res.status).toBe(403);
    expect(res.body.error.details.required).toBe('platform');
  });

  it('refuses a platform key that does not carry the scope', async () => {
    const res = await ingest([meter()], { key: scopelessKey });
    expect(res.status).toBe(403);
    expect(res.body.error.details.required).toContain(
      PERMISSIONS.PLATFORM_KNOWLEDGE_CATALOG_MANAGE,
    );
  });

  it('refuses no key at all', async () => {
    const res = await api('/api/v1/public/knowledge/products', {
      method: 'POST',
      body: JSON.stringify({ source: SOURCE, products: [meter()] }),
    });
    expect(res.status).toBe(401);
  });

  it('refuses the same code twice in one request', async () => {
    // Letting the last one win hides the sender's mistake until the two rows
    // disagree about something that matters.
    const res = await ingest([meter(), meter({ name: 'Different' })]);
    expect(res.status).toBe(400);
  });
});

describe('Writing products (docs/74 §1)', () => {
  it('creates a product and the brand it names', async () => {
    const res = await ingest([meter({ ingredients: ['magnesium'] })]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.created).toBe(1);
    expect(res.body.results[0]).toMatchObject({ code: METER, outcome: 'created' });
    expect(res.body.results[0].ingredientsLinked).toBe(1);
  });

  it('reports the same payload as unchanged rather than updated', async () => {
    // A sync that reports a hundred updates every hour tells its operator
    // nothing. `unchanged` is the number that makes the others worth reading.
    const res = await ingest([meter({ ingredients: ['magnesium'] })]);
    expect(res.status).toBe(200);
    expect(res.body.unchanged).toBe(1);
    expect(res.body.results[0].outcome).toBe('unchanged');
  });

  it('updates what actually changed', async () => {
    const res = await ingest([
      meter({ description: 'A pocket pH meter, now with a case.', ingredients: ['magnesium'] }),
    ]);
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(1);
  });

  it('reports ingredient codes it does not know, and writes the product anyway', async () => {
    const res = await ingest([
      { ...meter({ code: BUFFER, name: `pH 4.01 Buffer ${RUN}` }), ingredients: ['no-such-thing'] },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.results[0].outcome).toBe('created');
    expect(res.body.results[0].unknownIngredients).toEqual(['no-such-thing']);
  });
});

describe('Who owns a row (docs/74 §3)', () => {
  it('refuses a product curated in AVIORA', async () => {
    const res = await ingest([meter({ code: curatedCode, name: 'Hijacked' })]);
    expect(res.status).toBe(200);
    expect(res.body.refused).toBe(1);
    expect(res.body.results[0].reason).toMatch(/curated/i);

    const row = await owner.product.findFirst({ where: { tenantId: null, code: curatedCode } });
    expect(row?.name, 'a curated product was rewritten by an ingest').not.toBe('Hijacked');
  });

  it('refuses a product another sender owns, and names the owner', async () => {
    const res = await ingest([meter({ name: 'Taken over' })], { source: OTHER_SOURCE });
    expect(res.status).toBe(200);
    expect(res.body.refused).toBe(1);
    expect(res.body.results[0].reason).toContain(SOURCE);
  });

  it('writes the rest of a batch when one row is refused', async () => {
    const third = `hanna-third-${RUN}`;
    const res = await ingest([
      meter({ code: curatedCode }),
      meter({ code: third, name: `Third ${RUN}` }),
    ]);
    expect(res.status).toBe(200);
    expect(res.body.refused).toBe(1);
    expect(res.body.created).toBe(1);
  });
});

describe('A member can actually reach what was written (docs/74 §5)', () => {
  it('finds the product through search', async () => {
    // Searched by this RUN's own token, not by the model number. Products come
    // LAST in search and the query takes ten of them (spec §33) — so once a
    // real catalogue is loaded, a term as common as a model number is a term
    // this run's product is legitimately crowded out of. That is the ranking
    // working, not a defect, and the test must not depend on being alone.
    const res = await api(`/api/v1/knowledge/search?q=${encodeURIComponent(RUN)}`, {
      token: adminToken,
      tenant,
    });
    expect(res.status).toBe(200);
    expect(res.body.products.map((p: { code: string }) => p.code)).toContain(METER);
  });

  it('shows it on the page for the ingredient it links to', async () => {
    // The link is the whole point: a product with none appears on no journey
    // and no ingredient page, however many of them were written.
    const res = await api('/api/v1/knowledge/ingredients/magnesium', {
      token: adminToken,
      tenant,
    });
    expect(res.status).toBe(200);
    expect(res.body.ingredient.products.map((p: { code: string }) => p.code)).toContain(METER);
  });

  it('removes a link the sender no longer sends', async () => {
    // A present `ingredients` is the whole truth. Without this a sender could
    // only ever add, and could never correct a mistake.
    const res = await ingest([meter({ ingredients: [] })]);
    expect(res.status).toBe(200);
    expect(res.body.results[0].ingredientsLinked).toBe(0);

    const page = await api('/api/v1/knowledge/ingredients/magnesium', {
      token: adminToken,
      tenant,
    });
    expect(page.body.ingredient.products.map((p: { code: string }) => p.code)).not.toContain(METER);
  });

  it('leaves links alone when the sender says nothing about ingredients', async () => {
    await ingest([meter({ ingredients: ['magnesium'] })]);
    const res = await ingest([meter({ description: 'Quiet about ingredients.' })]);
    expect(res.status).toBe(200);

    const page = await api('/api/v1/knowledge/ingredients/magnesium', {
      token: adminToken,
      tenant,
    });
    expect(page.body.ingredient.products.map((p: { code: string }) => p.code)).toContain(METER);
  });
});

describe('Retrying a write (docs/74 §4)', () => {
  const KEY = `idem-${RUN}`;

  it('answers a repeat with what the first attempt did', async () => {
    const product = meter({ code: `idem-${RUN}`, name: `Idempotent ${RUN}` });
    const first = await ingest([product], { idempotency: KEY });
    expect(first.status).toBe(200);
    expect(first.body.created).toBe(1);
    expect(first.body.replayed).toBe(false);

    // Without the record this would answer `unchanged` — indistinguishable,
    // from the sender's side, from the first write having been lost.
    const second = await ingest([product], { idempotency: KEY });
    expect(second.status).toBe(200);
    expect(second.body.created).toBe(1);
    expect(second.body.replayed).toBe(true);
  });

  it('refuses the same key with a different body', async () => {
    const res = await ingest([meter({ code: `idem-${RUN}`, name: 'Something else' })], {
      idempotency: KEY,
    });
    expect(res.status).toBe(409);
  });

  it('does the work again when no key is sent', async () => {
    // A scheduled hourly sync is two deliberate identical requests, and
    // collapsing them by hashing the body would be wrong.
    const res = await ingest([meter({ code: `idem-${RUN}`, name: `Idempotent ${RUN}` })]);
    expect(res.status).toBe(200);
    expect(res.body.replayed).toBe(false);
  });
});

describe('Products that contain nothing (docs/74 §6)', () => {
  const FILTER = `espring-${RUN}`;

  it('reaches a product through a TOPIC when it has no ingredient', async () => {
    // A water filter contains no ingredient and belonged to no goal until this
    // path existed — the whole point of the extension.
    const res = await ingest([
      {
        code: FILTER,
        name: `Water filter ${RUN}`,
        brand: { code: `espring-${RUN}`, name: 'ESPRING' },
        topics: ['water-at-home'],
      },
    ]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.results[0]).toMatchObject({ outcome: 'created', topicsLinked: 1 });
    expect(res.body.results[0].ingredientsLinked).toBe(0);

    const journey = await api('/api/v1/knowledge/journey/clean-water', {
      token: adminToken,
      tenant,
    });
    expect(journey.status).toBe(200);
    expect(journey.body.products.map((p: { code: string }) => p.code)).toContain(FILTER);
    // and the topic says which products it reached, so the UI can show the path
    const topic = journey.body.topics.find((t: { code: string }) => t.code === 'water-at-home');
    expect(topic.productIds.length).toBeGreaterThan(0);
  });

  it('reports a topic it does not know, and writes the product anyway', async () => {
    const res = await ingest([
      { ...meter({ code: `unknown-topic-${RUN}` }), topics: ['no-such-topic'] },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.results[0].outcome).toBe('created');
    expect(res.body.results[0].unknownTopics).toEqual(['no-such-topic']);
  });

  it('removes a topic link the sender no longer sends', async () => {
    // Same rule as ingredients: a PRESENT list is the whole truth.
    const res = await ingest([
      {
        code: FILTER,
        name: `Water filter ${RUN}`,
        brand: { code: `espring-${RUN}`, name: 'ESPRING' },
        topics: [],
      },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.results[0].topicsLinked).toBe(0);

    const journey = await api('/api/v1/knowledge/journey/clean-water', {
      token: adminToken,
      tenant,
    });
    expect(journey.body.products.map((p: { code: string }) => p.code)).not.toContain(FILTER);
  });

  it('creates no topic of its own', async () => {
    // A topic is a heading a member navigates by. A catalogue that could invent
    // headings could reorganise somebody else's knowledge from outside.
    const before = await owner.topic.count();
    await ingest([{ ...meter({ code: `inv-topic-${RUN}` }), topics: ['invented-heading'] }]);
    expect(await owner.topic.count()).toBe(before);
  });
});

describe('Pictures of the product (docs/74 §7)', () => {
  const SHOT = 'https://cdn.example.test/a.jpg';
  const SHOT2 = 'https://cdn.example.test/b.jpg';

  it('keeps the sender order, and shows the first on the card', async () => {
    const res = await ingest([meter({ images: [{ url: SHOT2 }, { url: SHOT, alt: 'front' }] })]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.results[0].imagesLinked).toBe(2);

    const page = await api('/api/v1/knowledge/ingredients/magnesium', {
      token: adminToken,
      tenant,
    });
    const shown = page.body.ingredient.products.find((p: { code: string }) => p.code === METER);
    // ONE image reaches the client, and it is the sender's first.
    expect(shown.images).toHaveLength(1);
    expect(shown.images[0].url).toBe(SHOT2);
  });

  it('never clears a mirrored copy on re-sync', async () => {
    // Somebody paid to fetch those bytes. A catalogue re-send must not throw
    // the copy away because the sender does not know it exists.
    const row = await owner.productImage.findFirst({ where: { url: SHOT } });
    await owner.productImage.update({
      where: { id: row!.id },
      data: { storedPath: 'mirror/a.jpg' },
    });

    await ingest([meter({ images: [{ url: SHOT2 }, { url: SHOT, alt: 'front' }] })]);

    const after = await owner.productImage.findFirst({ where: { url: SHOT } });
    expect(after?.storedPath).toBe('mirror/a.jpg');
  });

  it('removes a picture the sender no longer sends', async () => {
    const res = await ingest([meter({ images: [{ url: SHOT2 }] })]);
    expect(res.status).toBe(200);
    expect(res.body.results[0].imagesLinked).toBe(1);
    expect(await owner.productImage.count({ where: { url: SHOT } })).toBe(0);
  });

  it('serves our own copy when one exists, and 404s when it does not', async () => {
    const row = await owner.productImage.findFirst({ where: { url: SHOT2 } });
    // No copy yet: the route refuses rather than proxying somebody else's CDN.
    const before = await api(`/api/v1/knowledge/product-images/${row!.id}/content`, {
      token: adminToken,
      tenant,
    });
    expect(before.status).toBe(404);
  });

  it('refuses anything that is not a URL', async () => {
    // Bytes are not what this endpoint takes, and a path with no origin is a
    // picture nobody else can fetch.
    const res = await ingest([meter({ images: [{ url: '/local/a.jpg' }] })]);
    expect(res.status).toBe(400);
  });
});

describe('A batch the endpoint will not take (docs/74 §1)', () => {
  it('refuses an oversized body as a refusal, not as a server error', async () => {
    // Express defaults to 100 KB and body-parser throws an `http-errors` object,
    // not an HttpException — so this used to answer "Internal server error" and
    // tell a caller their own mistake was ours.
    const fat = 'ก'.repeat(1900);
    const many = Array.from({ length: 100 }, (_, i) =>
      meter({ code: `fat-${RUN}-${i}`, description: fat }),
    );
    const res = await ingest(many);
    // The limit is raised for this route, so a hundred products is ACCEPTED —
    // the endpoint must take the batch size it advertises.
    expect(res.status, JSON.stringify(res.body).slice(0, 200)).toBe(200);
    expect(res.body.results.length).toBe(100);
  });
});

describe('What the ingest will not do (docs/74 §8)', () => {
  it('creates no ingredient of its own', async () => {
    // An ingredient carries claims about what it does to a body. A sender that
    // could invent one could invent those.
    const before = await owner.ingredient.count();
    await ingest([meter({ code: `inv-${RUN}`, ingredients: ['invented-thing'] })]);
    expect(await owner.ingredient.count()).toBe(before);
  });

  it('takes no price, and refuses a payload that carries one', async () => {
    const res = await ingest([{ ...meter({ code: `priced-${RUN}` }), priceMinor: 450000 }]);
    expect(res.status).toBe(400);
  });
});
