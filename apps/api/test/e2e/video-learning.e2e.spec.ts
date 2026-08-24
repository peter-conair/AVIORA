/**
 * Video lessons, and who is allowed to see them yet (docs/73).
 *
 * The headline test in this file is not a playback test — it is
 * **"deleting every assignment row leaves nobody able to see anything new"**.
 * docs/37 §6 refused a per-member grant table because a second permission
 * system is how a codebase ends up with two answers to "may they see this", and
 * the one that disagrees quietly is the one that leaks. docs/73 §1 claims this
 * table is sequencing rather than permission; that claim is only worth making
 * if it is executable, and `the invariant` below is it.
 *
 * The second thing this file holds is Range. iOS Safari will not play a
 * `<video>` from a server that does not answer partial requests, so the byte
 * assertions here are the difference between the feature working on the phone
 * this product is used on (docs/72) and not existing there. The fixture video
 * is a known pattern, so a range is checked by its CONTENT and not only by its
 * headers — an off-by-one in the range maths produces correct-looking headers
 * and a corrupt stream.
 *
 * NOTE: stop any locally running API — the outbox relay is cross-tenant.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import * as argon2 from 'argon2';
import {
  createOwnerClient,
  ensureAppRole,
  withTenant as dbWithTenant,
  type PrismaClient,
  type Tx,
} from '@aviora/db';
import { ENTITLEMENTS, PERMISSIONS, newId } from '@aviora/shared';
import { createApp } from '../../src/app.factory';

const RUN = `v${Date.now().toString(36)}`;
const PLATFORM_EMAIL = `e2e-video-platform-${RUN}@test.local`;
const PW = 'e2e-password-123456';

/** 48,000 bytes where byte i is `i % 251` — every offset is its own fingerprint. */
const VIDEO = Buffer.from(Array.from({ length: 48_000 }, (_, i) => i % 251));

let app: INestApplication;
let base: string;
let owner: PrismaClient;
let tenant: string;
let admin: string;

const m: Record<string, string> = {};
const course: Record<string, string> = {};
const lesson: Record<string, string> = {};

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

/** Raw response — media is bytes, and the headers are half of what is asserted. */
async function media(
  path: string,
  token: string,
  range?: string,
): Promise<{ status: number; headers: Headers; bytes: Buffer }> {
  const res = await fetch(`${base}${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      'x-tenant-id': tenant,
      ...(range ? { range } : {}),
    },
  });
  return {
    status: res.status,
    headers: res.headers,
    bytes: Buffer.from(await res.arrayBuffer()),
  };
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

function withTenant<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return dbWithTenant(owner, tenant, fn);
}

function courseOf(body: any, code: string): any {
  return (body.courses as any[]).find((c) => c.code === code);
}

beforeAll(async () => {
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
      displayName: 'E2E Platform Admin',
      platformRole: 'PLATFORM_OWNER',
    },
    update: {},
  });

  app = await createApp({ logger: false });
  await app.listen(0);
  base = (await app.getUrl()).replace('[::1]', '127.0.0.1');

  const platform = await login(PLATFORM_EMAIL);
  const made = await api('/api/v1/platform/tenants', {
    method: 'POST',
    token: platform,
    body: JSON.stringify({
      code: `e2e_vid_${RUN}`,
      name: 'Video',
      slug: `e2e-vid-${RUN}`,
      adminEmail: `admin-${RUN}@test.local`,
      adminDisplayName: 'Admin',
      adminPassword: PW,
    }),
  });
  expect(made.status).toBe(201);
  tenant = made.body.tenant.id;
  admin = await login(`admin-${RUN}@test.local`);

  const plan = await api('/api/v1/membership-plans', {
    method: 'POST',
    token: admin,
    tenant,
    body: JSON.stringify({
      code: 'watch',
      name: 'Watch',
      entitlementKeys: [ENTITLEMENTS.COURSE_ACCESS, ENTITLEMENTS.COMMERCE],
    }),
  });
  expect(plan.status).toBe(201);
  const planId = plan.body.plan.id as string;

  const addMember = async (name: string) => {
    const inv = await api('/api/v1/invitations', {
      method: 'POST',
      token: admin,
      tenant,
      body: JSON.stringify({ email: `${name}-${RUN}@test.local`, planId }),
    });
    expect(inv.status).toBe(201);
    const evt = await owner.domainEvent.findFirst({
      where: { eventName: 'MemberInvited', aggregateId: inv.body.invitation.id },
    });
    const accepted = await api(
      `/api/v1/invitations/${(evt!.payload as { token: string }).token}/accept`,
      { method: 'POST', body: JSON.stringify({ displayName: name, password: PW }) },
    );
    expect(accepted.status).toBe(201);
    return accepted.body.memberId as string;
  };
  for (const name of ['dara', 'ploy', 'kan', 'nok']) m[name] = await addMember(name);

  const mkTeam = async (code: string) => {
    const res = await api('/api/v1/teams', {
      method: 'POST',
      token: admin,
      tenant,
      body: JSON.stringify({ code: `${code}-${RUN}`, name: code }),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.team.id as string;
  };
  const join = async (teamId: string, memberId: string) => {
    const res = await api(`/api/v1/teams/${teamId}/members`, {
      method: 'POST',
      token: admin,
      tenant,
      body: JSON.stringify({ memberId }),
    });
    expect(res.status).toBe(201);
  };

  // dara leads `home`, which holds ploy and kan. nok is in `away` — the same
  // tenant, outside dara's scope, and the reason the scope test can be exact.
  const home = await mkTeam('home');
  const away = await mkTeam('away');
  await join(home, m.dara!);
  await join(home, m.ploy!);
  await join(home, m.kan!);
  await join(away, m.nok!);
  const led = await api(`/api/v1/teams/${home}/leaders`, {
    method: 'POST',
    token: admin,
    tenant,
    body: JSON.stringify({ memberId: m.dara }),
  });
  expect(led.status).toBe(201);

  // No course-authoring API exists yet (docs/10 rows 84–89 are unbuilt), so the
  // library is a fixture. Everything asserted below still goes through the API.
  await withTenant(async (tx) => {
    const mkCourse = async (code: string, policy: string, rule: object | null) => {
      const row = await tx.course.create({
        data: {
          tenantId: tenant,
          code: `${code}-${RUN}`,
          title: code,
          releasePolicy: policy,
          releaseRule: rule ?? undefined,
        },
      });
      const first = await tx.lesson.create({
        data: { tenantId: tenant, courseId: row.id, order: 1, title: `${code} lesson 1` },
      });
      course[code] = row.id;
      lesson[code] = first.id;
    };
    await mkCourse('basics', 'open', null);
    await mkCourse('advanced', 'on_assignment', null);
    await mkCourse('sequel', 'on_assignment', { after: `course:basics-${RUN}` });
  });

  // Upload the fixture video against the OPEN course, so playback can be tested
  // without an assignment confusing the question.
  const uploaded = await fetch(
    `${base}/api/v1/learning/assets?lessonId=${lesson.basics}&kind=video&locale=th&durationSeconds=12`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${admin}`,
        'x-tenant-id': tenant,
        'content-type': 'video/mp4',
      },
      body: VIDEO,
    },
  );
  expect(uploaded.status, await uploaded.text().catch(() => '')).toBe(201);

  await withTenant(async (tx) => {
    const asset = await tx.lessonAsset.findFirst({ where: { lessonId: lesson.advanced } });
    if (!asset) {
      await tx.lessonAsset.create({
        data: {
          id: newId(),
          tenantId: tenant,
          lessonId: lesson.advanced!,
          kind: 'video',
          locale: 'th',
          storageKey: 'missing-on-purpose',
          contentType: 'video/mp4',
          byteSize: 10,
        },
      });
    }
  });
}, 300_000);

afterAll(async () => {
  await app?.close();
  await owner?.$disconnect();
});

describe('An unreleased course is listed, not hidden (docs/73 §5)', () => {
  it('shows an open course with its lessons', async () => {
    const token = await login(`ploy-${RUN}@test.local`);
    const res = await api('/api/v1/courses', { token, tenant });
    expect(res.status).toBe(200);
    const basics = courseOf(res.body, `basics-${RUN}`);
    expect(basics.visible).toBe(true);
    expect(basics.lock).toEqual({ state: 'open' });
    expect(basics.lessons).toHaveLength(1);
  });

  it('lists a locked course, with the reason, and without its lesson titles', async () => {
    // Listed rather than 404'd: this is the member's own curriculum, and
    // pretending it does not exist is how a leader hides the path from the
    // person walking it. The lesson TITLES are still withheld, because a
    // programme's shape can be read off its headings alone.
    const token = await login(`ploy-${RUN}@test.local`);
    const res = await api('/api/v1/courses', { token, tenant });
    const advanced = courseOf(res.body, `advanced-${RUN}`);
    expect(advanced.visible).toBe(false);
    expect(advanced.lock).toEqual({ state: 'awaiting_leader' });
    expect(advanced.lessons).toEqual([]);
  });

  it('names what a rule is waiting for, so the member knows what to go and do', async () => {
    const token = await login(`ploy-${RUN}@test.local`);
    const res = await api('/api/v1/courses', { token, tenant });
    const sequel = courseOf(res.body, `sequel-${RUN}`);
    expect(sequel.visible).toBe(false);
    expect(sequel.lock).toEqual({ state: 'awaiting_rule', after: `course:basics-${RUN}` });
  });

  it('refuses the bytes of a locked lesson with 403 and the lock, never a silent 404', async () => {
    const token = await login(`ploy-${RUN}@test.local`);
    const res = await api(`/api/v1/learning/lessons/${lesson.advanced}/media?kind=video`, {
      token,
      tenant,
    });
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toMatch(/not opened this lesson yet/i);
  });
});

describe('Range, or it does not play on a phone (docs/73 §7)', () => {
  it('serves the whole file, and advertises that it accepts ranges', async () => {
    const token = await login(`ploy-${RUN}@test.local`);
    const res = await media(`/api/v1/learning/lessons/${lesson.basics}/media?kind=video`, token);
    expect(res.status).toBe(200);
    // Without this header a browser never attempts a partial request, so
    // seeking never happens and iOS never starts.
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-length')).toBe(String(VIDEO.length));
    expect(res.bytes.length).toBe(VIDEO.length);
    expect(res.bytes.equals(VIDEO)).toBe(true);
  });

  it('answers a closed range with 206 and exactly those bytes', async () => {
    const token = await login(`ploy-${RUN}@test.local`);
    const res = await media(
      `/api/v1/learning/lessons/${lesson.basics}/media?kind=video`,
      token,
      'bytes=10-19',
    );
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 10-19/${VIDEO.length}`);
    expect(res.headers.get('content-length')).toBe('10');
    // The content, not just the headers: an off-by-one produces a plausible
    // Content-Range and a stream that is one byte out.
    expect(res.bytes.equals(VIDEO.subarray(10, 20))).toBe(true);
  });

  it('runs an open range to the last byte', async () => {
    // Safari opens a video with exactly this shape.
    const token = await login(`ploy-${RUN}@test.local`);
    const res = await media(
      `/api/v1/learning/lessons/${lesson.basics}/media?kind=video`,
      token,
      'bytes=47990-',
    );
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 47990-47999/${VIDEO.length}`);
    expect(res.bytes.equals(VIDEO.subarray(47_990))).toBe(true);
  });

  it('answers a suffix range with the LAST n bytes', async () => {
    const token = await login(`ploy-${RUN}@test.local`);
    const res = await media(
      `/api/v1/learning/lessons/${lesson.basics}/media?kind=video`,
      token,
      'bytes=-100',
    );
    expect(res.status).toBe(206);
    expect(res.bytes.equals(VIDEO.subarray(VIDEO.length - 100))).toBe(true);
  });

  it('answers an impossible range 416, naming the real length', async () => {
    // Without the length the player has no way to correct itself and simply
    // asks the same impossible thing again.
    const token = await login(`ploy-${RUN}@test.local`);
    const res = await media(
      `/api/v1/learning/lessons/${lesson.basics}/media?kind=video`,
      token,
      'bytes=99999-',
    );
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe(`bytes */${VIDEO.length}`);
  });

  it('serves a lesson video privately and cacheably, unlike a consent photograph', async () => {
    const token = await login(`ploy-${RUN}@test.local`);
    const res = await media(`/api/v1/learning/lessons/${lesson.basics}/media?kind=video`, token);
    const cache = res.headers.get('cache-control') ?? '';
    expect(cache).toMatch(/private/);
    // `no-store` would re-fetch from byte zero on every seek (docs/73 §7).
    expect(cache).not.toMatch(/no-store/);
  });
});

describe('A leader releases to individuals (docs/73 §4, §9)', () => {
  it('releases a course to one member and not the other', async () => {
    const dara = await login(`dara-${RUN}@test.local`);
    const res = await api('/api/v1/learning/assignments', {
      method: 'POST',
      token: dara,
      tenant,
      body: JSON.stringify({ memberIds: [m.ploy], courseId: course.advanced }),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const ploy = await login(`ploy-${RUN}@test.local`);
    expect(
      courseOf((await api('/api/v1/courses', { token: ploy, tenant })).body, `advanced-${RUN}`)
        .visible,
    ).toBe(true);

    const kan = await login(`kan-${RUN}@test.local`);
    expect(
      courseOf((await api('/api/v1/courses', { token: kan, tenant })).body, `advanced-${RUN}`)
        .visible,
    ).toBe(false);
  });

  it('refuses to release to somebody outside the teams they lead', async () => {
    const dara = await login(`dara-${RUN}@test.local`);
    const res = await api('/api/v1/learning/assignments', {
      method: 'POST',
      token: dara,
      tenant,
      body: JSON.stringify({ memberIds: [m.nok], courseId: course.advanced }),
    });
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toMatch(/not in a team you lead/i);
  });

  it('names how many were out of scope rather than silently skipping them', async () => {
    // A bulk assign that quietly dropped the outsiders would look like it
    // worked, and the leader would find out from the people it missed.
    const dara = await login(`dara-${RUN}@test.local`);
    const res = await api('/api/v1/learning/assignments', {
      method: 'POST',
      token: dara,
      tenant,
      body: JSON.stringify({ memberIds: [m.ploy, m.nok], courseId: course.advanced }),
    });
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toMatch(/1 of these members/i);
  });

  it('holds a sequenced course shut, with a reason the member can read', async () => {
    const dara = await login(`dara-${RUN}@test.local`);
    const held = await api('/api/v1/learning/assignments/hold', {
      method: 'POST',
      token: dara,
      tenant,
      body: JSON.stringify({
        memberIds: [m.kan],
        courseId: course.advanced,
        reason: 'finish the basics first',
      }),
    });
    expect(held.status).toBe(201);

    const kan = await login(`kan-${RUN}@test.local`);
    const row = courseOf(
      (await api('/api/v1/courses', { token: kan, tenant })).body,
      `advanced-${RUN}`,
    );
    expect(row.visible).toBe(false);
    expect(row.lock).toEqual({ state: 'held', reason: 'finish the basics first' });
  });

  it('refuses to hold a course the tenant made open to everyone', async () => {
    // The tenant decides which courses are sequenced; the leader sequences
    // within those. A leader who could override an open policy could close the
    // library one course at a time (docs/73 §2).
    const dara = await login(`dara-${RUN}@test.local`);
    const res = await api('/api/v1/learning/assignments/hold', {
      method: 'POST',
      token: dara,
      tenant,
      body: JSON.stringify({
        memberIds: [m.kan],
        courseId: course.basics,
        reason: 'because I say so',
      }),
    });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toMatch(/open to everyone/i);
  });

  it('refuses a hold with no reason at all', async () => {
    const dara = await login(`dara-${RUN}@test.local`);
    const res = await api('/api/v1/learning/assignments/hold', {
      method: 'POST',
      token: dara,
      tenant,
      body: JSON.stringify({ memberIds: [m.kan], courseId: course.advanced, reason: '' }),
    });
    expect(res.status).toBe(400);
  });

  it('gives the leader a board of everyone against everything', async () => {
    const dara = await login(`dara-${RUN}@test.local`);
    const res = await api('/api/v1/learning/assignments/board', { token: dara, tenant });
    expect(res.status).toBe(200);

    const ids = (res.body.members as any[]).map((x) => x.id);
    expect(ids).toContain(m.ploy);
    expect(ids).toContain(m.kan);
    // Scope is the same call knowledge uses; nok is in another team.
    expect(ids).not.toContain(m.nok);

    const cell = (res.body.cells as any[]).find(
      (c) => c.memberId === m.ploy && c.courseId === course.advanced,
    );
    expect(cell.visible).toBe(true);
    expect(cell.status).toBe('not_started');
  });

  it('tells the leader who has finished what, and not when they watched', async () => {
    // docs/73 §8. A completion state supports the conversation a leader should
    // be having; a viewing timestamp supports a different one.
    const dara = await login(`dara-${RUN}@test.local`);
    const res = await api('/api/v1/learning/assignments/board', { token: dara, tenant });
    const cell = (res.body.cells as any[])[0];
    expect(Object.keys(cell).sort()).toEqual(
      [
        'completedLessons',
        'courseId',
        'dueAt',
        'lock',
        'memberId',
        'status',
        'totalLessons',
        'visible',
      ].sort(),
    );
  });
});

describe('A rule opens a course with nobody deciding anything (docs/73 §4)', () => {
  it('opens once the prerequisite course is complete — and no assignment row exists', async () => {
    const kan = await login(`kan-${RUN}@test.local`);
    const before = courseOf(
      (await api('/api/v1/courses', { token: kan, tenant })).body,
      `sequel-${RUN}`,
    );
    expect(before.visible).toBe(false);

    const started = await api(`/api/v1/courses/${course.basics}/start`, {
      method: 'POST',
      token: kan,
      tenant,
    });
    expect(started.status).toBe(201);
    const done = await api(`/api/v1/lessons/${lesson.basics}/complete`, {
      method: 'POST',
      token: kan,
      tenant,
    });
    expect(done.status).toBe(201);

    const after = courseOf(
      (await api('/api/v1/courses', { token: kan, tenant })).body,
      `sequel-${RUN}`,
    );
    expect(after.visible).toBe(true);

    const rows = await withTenant((tx) =>
      tx.learningAssignment.count({ where: { memberId: m.kan!, courseId: course.sequel! } }),
    );
    expect(rows).toBe(0);
  });
});

describe('Watching is recorded, and cannot be faked by seeking (docs/73 §6)', () => {
  it('accumulates watched seconds while position merely moves', async () => {
    const ploy = await login(`ploy-${RUN}@test.local`);
    const post = (positionSeconds: number, watchedDeltaSeconds: number) =>
      api(`/api/v1/learning/lessons/${lesson.basics}/progress`, {
        method: 'POST',
        token: ploy,
        tenant,
        body: JSON.stringify({ positionSeconds, watchedDeltaSeconds }),
      });

    expect((await post(5, 5)).status).toBe(201);
    const second = await post(9, 4);
    expect(second.status).toBe(201);
    expect(second.body.view.positionSeconds).toBe(9);
    expect(second.body.view.watchedSeconds).toBe(9);

    // Dragging the scrubber to the end: the position jumps and nothing was
    // watched, so the watched total does not move.
    const seeked = await post(600, 0);
    expect(seeked.body.view.positionSeconds).toBe(600);
    expect(seeked.body.view.watchedSeconds).toBe(9);
  });
});

describe('the invariant — this is a sequencing table, not a grant table (docs/73 §1)', () => {
  it('leaves nobody able to see anything new when every assignment is deleted', async () => {
    // The single most important test in this file. If a row in
    // `learning_assignments` can be the ONLY reason somebody sees something,
    // that table is a second permission system and docs/37 §6 refused one for
    // reasons that have not changed.
    const visibleFor = async (name: string): Promise<string[]> => {
      const token = await login(`${name}-${RUN}@test.local`);
      const res = await api('/api/v1/courses', { token, tenant });
      return (res.body.courses as any[])
        .filter((c) => c.visible)
        .map((c) => c.code as string)
        .sort();
    };

    const before = {
      ploy: await visibleFor('ploy'),
      kan: await visibleFor('kan'),
    };
    // ploy can see `advanced` only because it was released to her.
    expect(before.ploy).toContain(`advanced-${RUN}`);

    await withTenant((tx) => tx.learningAssignment.deleteMany({}));

    const after = {
      ploy: await visibleFor('ploy'),
      kan: await visibleFor('kan'),
    };

    for (const name of ['ploy', 'kan'] as const) {
      const gained = after[name].filter((code) => !before[name].includes(code));
      expect(gained, `${name} gained access when assignments were deleted`).toEqual([]);
    }
    // And the specific thing an assignment WAS carrying is gone with it.
    expect(after.ploy).not.toContain(`advanced-${RUN}`);
    // A rule-opened course survives, because no row was holding it open.
    expect(after.kan).toContain(`sequel-${RUN}`);
  });
});
