/**
 * Public API, webhooks and the white-label manifest (spec §77, §56, docs/30).
 *
 * docs/30 §1 refuses a second event system: "a webhook is one more handler on
 * that relay". Everything here follows from that. If a webhook is a handler,
 * it inherits the outbox's AT LEAST ONCE promise, and the single most
 * important `it` in this file is the one that drains the SAME EVENT TWICE and
 * finds one delivery row and one POST at the receiver. `UNIQUE (endpoint_id,
 * event_id)` is the only thing between a relayed delivery and a second
 * notification — the same defence commission runs, subscription renewals and
 * automation each needed before it, now protecting somebody else's server.
 *
 * A webhook that is only asserted against the database is a webhook nobody has
 * actually tested. So this file stands up a REAL receiver — a `node:https`
 * server inside the test process — and asserts on the traffic it recorded:
 * the four headers §2 names, the signature a receiver would compute, the
 * response code a failing receiver returned and the retry it caused. Signing
 * cannot be checked honestly any other way: a test that recomputes the HMAC
 * from the platform's own stored fields proves only that the platform agrees
 * with itself.
 *
 * FINDING (see the first describe): the migration adds
 * `CHECK (url LIKE 'https://%')`, so a plaintext localhost receiver is
 * impossible by construction. That is the right rule — a secret must never be
 * posted in the clear — and it is asserted here rather than worked around.
 * The receiver is therefore a TLS server with a certificate generated at
 * setup, and the suite sets `NODE_TLS_REJECT_UNAUTHORIZED=0` for its own
 * process so a self-signed certificate on 127.0.0.1 is acceptable to the
 * delivering client. If the delivery client pins `rejectUnauthorized: true`
 * of its own accord, the first delivery test fails with the TLS error the
 * platform recorded in `webhook_deliveries.error` — which is a readable
 * diagnosis and not a mystery.
 *
 * Nothing here asserts an effect the integration layer could have been told
 * about. Events are caused through the modules that own them — a goal is
 * completed through the goals API, a team created through the teams API, a
 * habit logged through the health API — and every effect is read back through
 * the API or through the receiver's own record of what arrived. The owner
 * client reads rows (secret hashes, key hashes, delivery counts, attempts) and
 * does exactly two things that are not reads, both of which move the CLOCK and
 * never an outcome: it replays one delivered event (the redelivery the outbox
 * promises), and it clears the retry backoff on a pending delivery so five
 * attempts do not take five minutes of wall time.
 *
 * NOTE: stop any locally running API — the outbox relay is cross-tenant.
 */
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import * as http from 'node:http';
import * as https from 'node:https';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { ENTITLEMENTS, EVENTS, PERMISSIONS } from '@aviora/shared';
import { createApp } from '../../src/app.factory';
import { OutboxRelayService } from '../../src/common/events/outbox-relay.service';
import { EventBus } from '../../src/common/events/event-bus';

/**
 * The receiver's certificate is generated for 127.0.0.1 and signed by nobody.
 * Set before anything opens a socket, so the delivering client inherits it.
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const RUN = `i${Date.now().toString(36)}`;
const PLATFORM_EMAIL = `e2e-platform-${RUN}@test.local`;
const PW = 'e2e-password-123456';

let app: INestApplication;
let base: string;
let port: string;
let owner: PrismaClient;
let relay: OutboxRelayService;

/** Beacon integrates. Quiet exists to be invisible from Beacon, and vice versa. */
let beacon: string;
let quiet: string;
const BEACON_SLUG = `e2e-int-a-${RUN}`;
const QUIET_SLUG = `e2e-int-b-${RUN}`;
/** The browser-facing host each tenant is painted for (docs/29 §6, docs/30 §5). */
const BEACON_HOST = `${BEACON_SLUG}.localhost`;
const QUIET_HOST = `${QUIET_SLUG}.localhost`;
/** Every tenant this file may drain events for. */
const TENANTS: string[] = [];

const BEACON_APP_NAME = `Beacon Integrations ${RUN}`;
const QUIET_APP_NAME = `Quiet Collective ${RUN}`;
const BEACON_PRIMARY = '#0f766e';
const QUIET_PRIMARY = '#1d4ed8';
const BEACON_BACKGROUND = '#f8fafc';
const QUIET_BACKGROUND = '#0b1120';

let beaconPlanId: string;
let quietPlanId: string;
/** Iris causes Beacon's events. Otto logs Quiet's habits. */
let irisMemberId: string;
let ottoMemberId: string;

/* ── the receiver ─────────────────────────────────────────────────────────── */

const OK_PATH = '/hook/ok';
const BOOM_PATH = '/hook/boom';
const ALL_PATH = '/hook/all';

interface Recorded {
  path: string;
  method: string;
  /** Node lower-cases incoming header names; HTTP header names are case-insensitive. */
  headers: Record<string, string>;
  /** The bytes exactly as they arrived — the signature is over these. */
  raw: string;
  body: unknown;
  at: number;
}

const received: Recorded[] = [];
/** Flipped to 200 only when a test wants a previously failing receiver to recover. */
let boomStatus = 500;
let receiver: https.Server | null = null;
let receiverBase: string | null = null;
let certDir: string | null = null;

/* ── webhook endpoints and keys created by the tests ──────────────────────── */

let okEndpointId: string;
let okSecret: string;
let boomEndpointId: string;
let boomSecret: string;
let allEndpointId: string;
let allEndpointEvents: string[] = [];

let fullKey: string;
let fullKeyId: string;
let narrowKey: string;
let doomedKey: string;
let doomedKeyId: string;

/** Ids kept so a single delivery can be replayed verbatim. */
let goalCompletedEventId: string;
let irisGoalId: string;

/* ── the health fixture the deep scan looks for ───────────────────────────── */

const HABIT_CODE = `dawn-walk-${RUN}`;
const HABIT_NAME = `Dawn walk ${RUN}`;
const LIFESTYLE_NOTE = `Sleeps badly on Tuesdays ${RUN}`;
const HABIT_TARGET = 17;
const HABIT_LOGGED = 13;
const SLEEP_HOURS = 6.13;
const WEIGHT_KG = 71.37;

const FORBIDDEN = {
  strings: [HABIT_CODE, HABIT_NAME, LIFESTYLE_NOTE, 'sleep_hours', 'weight_kg'],
  numbers: [HABIT_TARGET, HABIT_LOGGED, SLEEP_HOURS, WEIGHT_KG],
};

/**
 * INTERPRETATION, copied deliberately from analytics.e2e.spec.ts: the key test
 * is on NAMES, the value test is on the fixture's OWN tokens. A webhook
 * envelope legitimately carries `eventName: "HabitLogged"` and
 * `aggregateType: "habit"` — the FACT that a habit was logged is the event, and
 * docs/30 §2 admits exactly that much ("id, name, tenant, aggregate, payload,
 * occurred-at"). What must never appear is the CONTENT: a habit's code or name,
 * a metric's value, or a key called `sleepAverage` whatever it holds.
 */
const HEALTH_KEY = /habit|sleep|weight|health/i;
/** The envelope's own structural keys, which name the aggregate and the event. */
const STRUCTURAL_KEYS = new Set([
  'eventName',
  'name',
  'event',
  'aggregateType',
  'aggregate',
  'aggregateId',
]);

/* ── plumbing ─────────────────────────────────────────────────────────────── */

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
  return { status: res.status, body: text ? safeJson(text) : null };
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text };
  }
}

/**
 * The same request, but arriving at a HOST — which is the only way a manifest
 * is reached in production (§5: "resolves the tenant by host"). `fetch` drops a
 * `Host` header, so a browser hitting `beacon.example.com` cannot be imitated
 * through it at all; this is a raw request for that one reason, and it sets no
 * `X-Tenant-ID` — with the header there, the header would be doing the
 * resolving and the test would prove nothing.
 */
function rawAtHost(
  host: string,
  path: string,
): Promise<{ status: number; headers: Record<string, string>; text: string; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers: { host: `${host}:${port}` },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers as Record<string, string>,
            text,
            body: text ? safeJson(text) : null,
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
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

/**
 * Scoped to one tenant. The library helper applies the tenant extension as
 * well as the GUC, which matters here: these tests connect as the OWNER role,
 * and the owner BYPASSES row-level security — FORCE RLS binds every role
 * except the table's owner. Without the extension an unfiltered findMany
 * silently reads every tenant's rows.
 */
async function withTenant<T>(tenant: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return dbWithTenant(owner, tenant, fn);
}

/**
 * Webhooks only ever fire on a DRAINED event, so every test that expects a
 * delivery says so out loud by calling this. Nothing in this file is delivered
 * by accident, and nothing is delivered without a test having asked for it.
 */
async function drainOutbox(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const pending = await owner.domainEvent.count({
      where: {
        tenantId: { in: TENANTS },
        processedAt: null,
        attempts: { lt: 5 },
        nextAttemptAt: { lte: new Date() },
      },
    });
    if (pending === 0) return;
    await relay.tick();
  }
  throw new Error('outbox did not drain for these tenants');
}

/** The outbox row a module wrote when it did the thing we asked it to do. */
async function eventIdFor(tenant: string, eventName: string, aggregateId: string): Promise<string> {
  const row = await owner.domainEvent.findFirst({
    where: { tenantId: tenant, eventName, aggregateId },
    orderBy: { occurredAt: 'desc' },
  });
  expect(row, `no ${eventName} event for ${aggregateId}`).toBeTruthy();
  return row!.id;
}

/**
 * Hands one already-delivered event back to the relay as if the delivery had
 * never happened: the per-handler ledger is cleared and the outbox row is put
 * back on the queue. This is a redelivery, which is the thing the outbox
 * promises AT LEAST ONCE of — and therefore the thing a webhook subscription
 * has to survive without notifying twice.
 */
async function replayEvent(eventId: string): Promise<void> {
  await owner.processedEvent.deleteMany({ where: { eventId } });
  await owner.domainEvent.update({
    where: { id: eventId },
    data: { processedAt: null, attempts: 0, nextAttemptAt: new Date(), lastError: null },
  });
  await drainOutbox();
}

/* ── driving webhook retries ──────────────────────────────────────────────── */

/**
 * A delivery that failed is retried later, and "later" is exponential backoff.
 * A test cannot wait five backoffs, so this moves the CLOCK on pending
 * deliveries for ONE endpoint — never the status, never the attempt count,
 * never the recorded error. Everything the retry assertions read is still
 * produced by the platform.
 */
async function releaseBackoff(tenant: string, endpointId: string): Promise<void> {
  await withTenant(
    tenant,
    (tx) => tx.$executeRaw`
      UPDATE webhook_deliveries SET next_attempt_at = now()
      WHERE tenant_id = ${tenant}::uuid AND endpoint_id = ${endpointId}::uuid
        AND status = 'pending'`,
  );
}

const DRIVER_METHODS = [
  'tick',
  'dispatchDue',
  'deliverDue',
  'retryDue',
  'runDue',
  'flush',
  'drain',
  'poll',
];
let cachedDrivers: Array<{ label: string; run: () => Promise<unknown> }> | null = null;

/**
 * INTERPRETATION: docs/30 §1 says a delivery is retried five times with
 * exponential backoff, but names no scheduler. Whatever the implementation
 * calls it, it is a provider whose class name mentions webhooks/deliveries and
 * which exposes a no-argument "do the due work now" method — the same shape
 * `OutboxRelayService.tick()` has, and the same way this suite drives the
 * outbox rather than waiting for its timer. Discovery is by shape so this file
 * does not import a class the implementer may reasonably have named otherwise.
 */
function webhookDrivers(): Array<{ label: string; run: () => Promise<unknown> }> {
  if (cachedDrivers) return cachedDrivers;
  cachedDrivers = [];
  const container = (
    app as unknown as {
      container?: {
        getModules(): Map<unknown, { providers: Map<unknown, { instance?: unknown }> }>;
      };
    }
  ).container;
  const modules = container?.getModules?.();
  if (!modules) return cachedDrivers;
  const seen = new Set<unknown>();
  for (const mod of modules.values()) {
    for (const wrapper of mod.providers.values()) {
      const instance = wrapper?.instance as Record<string, unknown> | undefined;
      if (!instance || typeof instance !== 'object' || seen.has(instance)) continue;
      seen.add(instance);
      const className = (instance.constructor as { name?: string } | undefined)?.name ?? '';
      if (!/webhook|delivery|deliver/i.test(className)) continue;
      for (const method of DRIVER_METHODS) {
        const fn = instance[method];
        if (typeof fn === 'function' && fn.length === 0) {
          cachedDrivers.push({
            label: `${className}.${method}`,
            run: () => Promise.resolve((fn as () => unknown).call(instance)),
          });
          break; // one entry point per service; never call two on the same instance
        }
      }
    }
  }
  return cachedDrivers;
}

async function pendingCount(tenant: string, endpointId: string): Promise<number> {
  return withTenant(tenant, (tx) =>
    tx.webhookDelivery.count({ where: { endpointId, status: 'pending' } }),
  );
}

/**
 * Drains the outbox (which creates deliveries and makes the first attempt),
 * then keeps handing due work to the retry scheduler until this endpoint has
 * nothing pending or `rounds` is spent. Returns the number of rounds it drove,
 * so a caller can tell "settled immediately" from "took retries".
 */
async function settle(tenant: string, endpointId: string, rounds = 12): Promise<number> {
  await drainOutbox();
  for (let round = 0; round < rounds; round++) {
    if ((await pendingCount(tenant, endpointId)) === 0) return round;
    const drivers = webhookDrivers();
    expect(
      drivers.length,
      'a delivery is pending and nothing in the container looks like a webhook retry ' +
        'scheduler (a provider named /webhook|delivery/ with a no-argument tick). ' +
        'docs/30 §1 promises five attempts, so something has to make them.',
    ).toBeGreaterThan(0);
    await releaseBackoff(tenant, endpointId);
    for (const driver of drivers) await driver.run();
  }
  return rounds;
}

/* ── receiver ─────────────────────────────────────────────────────────────── */

/**
 * A real server, because §2 is a promise made to somebody else's process. It
 * records every request verbatim (raw bytes included — the signature is over
 * those) and answers 200, or 500 on the path a test points at failure.
 */
async function startReceiver(): Promise<boolean> {
  certDir = mkdtempSync(join(tmpdir(), `aviora-hook-${RUN}-`));
  const keyPath = join(certDir, 'key.pem');
  const certPath = join(certDir, 'cert.pem');
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        keyPath,
        '-out',
        certPath,
        '-days',
        '2',
        '-subj',
        '/CN=localhost',
      ],
      { stdio: 'ignore' },
    );
  } catch {
    return false;
  }

  receiver = https.createServer(
    { key: readFileSync(keyPath), cert: readFileSync(certPath) },
    (req, res) => {
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        const path = (req.url ?? '/').split('?')[0]!;
        received.push({
          path,
          method: req.method ?? 'GET',
          headers: req.headers as Record<string, string>,
          raw,
          body: raw ? safeJson(raw) : null,
          at: Date.now(),
        });
        const status = path === BOOM_PATH ? boomStatus : 200;
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(status >= 500 ? { error: 'the receiver is unwell' } : { ok: true }));
      });
    },
  );

  await new Promise<void>((resolve) => receiver!.listen(0, '127.0.0.1', resolve));
  const address = receiver.address();
  const receiverPort = typeof address === 'object' && address ? address.port : 0;
  receiverBase = `https://127.0.0.1:${receiverPort}`;
  return true;
}

function requireReceiver(): string {
  expect(
    receiverBase,
    'no TLS receiver could be started (openssl unavailable?). docs/30 §2 cannot be ' +
      'asserted honestly without one — recomputing the HMAC from the platform’s own ' +
      'fields would only prove the platform agrees with itself.',
  ).toBeTruthy();
  return receiverBase!;
}

function postsTo(path: string): Recorded[] {
  return received.filter((r) => r.path === path);
}

function postsOfEvent(path: string, eventName: string): Recorded[] {
  return postsTo(path).filter((r) => r.headers['x-aviora-event'] === eventName);
}

/**
 * What a receiver does with the request: recompute `sha256=HMAC(timestamp +
 * "." + body)` with the secret it was handed at creation, and compare.
 *
 * INTERPRETATION: the secret is used as the HMAC key exactly as it was handed
 * over — a UTF-8 string. That is what a receiver holding the value in an
 * environment variable would do; if the platform keys the HMAC with decoded
 * bytes instead, this one line is the change and no assertion below moves.
 */
function receiverSignature(rec: Recorded, secret: string, body?: string): string {
  const timestamp = rec.headers['x-aviora-timestamp'] ?? '';
  return `sha256=${createHmac('sha256', secret)
    .update(`${timestamp}.${body ?? rec.raw}`)
    .digest('hex')}`;
}

/* ── the deep scan ────────────────────────────────────────────────────────── */

/**
 * Walks a whole value — objects, arrays, every leaf — and returns one finding
 * per hit, with the JSON path, so a failure says WHERE the leak is. Decimal
 * columns arrive as strings ("6.13"), so numeric leaves are compared
 * numerically whether they arrive as a number or as a string.
 */
function findHealth(value: unknown, path = '$', found: string[] = []): string[] {
  if (value === null || value === undefined) return found;
  if (Array.isArray(value)) {
    value.forEach((v, i) => findHealth(v, `${path}[${i}]`, found));
    return found;
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (!STRUCTURAL_KEYS.has(key) && HEALTH_KEY.test(key)) {
        found.push(`${path}.${key} — key names health data`);
      }
      findHealth(child, `${path}.${key}`, found);
    }
    return found;
  }
  if (typeof value === 'string') {
    const hay = value.toLowerCase();
    for (const token of FORBIDDEN.strings) {
      if (hay.includes(token.toLowerCase())) found.push(`${path} — contains "${token}"`);
    }
    const asNumber = Number(value);
    if (value.trim() !== '' && Number.isFinite(asNumber)) {
      for (const n of FORBIDDEN.numbers) {
        if (asNumber === n) found.push(`${path} — equals health value ${n}`);
      }
    }
    return found;
  }
  if (typeof value === 'number') {
    for (const n of FORBIDDEN.numbers) {
      if (value === n) found.push(`${path} — equals health value ${n}`);
    }
  }
  return found;
}

function expectNoHealthAnywhere(label: string, value: unknown): void {
  const found = findHealth(value);
  expect(found, `${label} leaked health data:\n  ${found.join('\n  ')}`).toEqual([]);
}

function mentions(value: unknown, token: string): boolean {
  return JSON.stringify(value ?? null)
    .toLowerCase()
    .includes(token.toLowerCase());
}

/* ── shape tolerance ──────────────────────────────────────────────────────
 * docs/30 §6 fixes the routes and the schema fixes the columns, but not the
 * JSON envelope. The readers below are lenient about WHERE a value sits;
 * every assertion built on them is exact about WHAT it is.
 * ------------------------------------------------------------------------ */

function endpointsOf(body: any): any[] {
  return body?.endpoints ?? body?.webhookEndpoints ?? body?.items ?? [];
}

function deliveriesOf(body: any): any[] {
  return body?.deliveries ?? body?.webhookDeliveries ?? body?.items ?? [];
}

function keysOf(body: any): any[] {
  return body?.keys ?? body?.apiKeys ?? body?.items ?? [];
}

function listOf(body: any): any[] {
  if (Array.isArray(body)) return body;
  return (
    body?.items ?? body?.data ?? body?.members ?? body?.orders ?? body?.ranks ?? body?.results ?? []
  );
}

function nodeOf(body: any, ...keys: string[]): any {
  for (const key of keys) if (body?.[key] && typeof body[key] === 'object') return body[key];
  return body;
}

function secretOf(body: any): string {
  const node = nodeOf(body, 'endpoint', 'webhookEndpoint');
  const secret = body?.secret ?? node?.secret ?? body?.signingSecret ?? node?.signingSecret;
  expect(
    typeof secret,
    `no secret in the creation response — docs/30 §2 hands it over ONCE: ${JSON.stringify(body)?.slice(0, 300)}`,
  ).toBe('string');
  return secret as string;
}

function apiKeyOf(body: any): string {
  const node = nodeOf(body, 'apiKey', 'key');
  const value = body?.key ?? body?.apiKey ?? node?.key ?? node?.secret ?? body?.token;
  expect(
    typeof value,
    `no key in the creation response — docs/30 §3 shows it ONCE: ${JSON.stringify(body)?.slice(0, 300)}`,
  ).toBe('string');
  return value as string;
}

/**
 * The id of the row that was just created, whether it arrived at the top level
 * or inside a wrapper. Deliberately never reads a STRING property: a creation
 * response carries both an id and a one-time secret, and mistaking one for the
 * other would make every later assertion nonsense.
 */
function rowIdOf(body: any, ...wrappers: string[]): string {
  const node = nodeOf(body, ...wrappers);
  const id = node?.id ?? body?.id;
  expect(typeof id, `no id on ${JSON.stringify(body)?.slice(0, 200)}`).toBe('string');
  return id as string;
}

/* ── routes under test ────────────────────────────────────────────────────── */

async function createEndpoint(
  token: string,
  tenant: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  return api('/api/v1/webhooks/endpoints', {
    method: 'POST',
    token,
    tenant,
    body: JSON.stringify(body),
  });
}

async function listEndpoints(token: string, tenant: string) {
  return api('/api/v1/webhooks/endpoints', { token, tenant });
}

async function listDeliveries(token: string, tenant: string) {
  return api('/api/v1/webhooks/deliveries', { token, tenant });
}

async function createKey(
  token: string,
  tenant: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  return api('/api/v1/api-keys', { method: 'POST', token, tenant, body: JSON.stringify(body) });
}

/**
 * INTERPRETATION: docs/30 §3 says authentication is on `/api/public/*`, while
 * the §6 route table lists `/public/members` — and the app mounts everything
 * under the `api/v1` global prefix. Rather than guess, the first public call
 * resolves which of the two answers and every later call uses it.
 */
let PUBLIC_BASE: string | null = null;
async function resolvePublicBase(key: string): Promise<string> {
  if (PUBLIC_BASE) return PUBLIC_BASE;
  const tried: string[] = [];
  for (const candidate of ['/api/v1/public', '/api/public']) {
    const res = await fetch(`${base}${candidate}/members`, {
      headers: { authorization: `Bearer ${key}` },
    });
    await res.text();
    tried.push(`${candidate}/members → ${res.status}`);
    if (res.status !== 404) {
      PUBLIC_BASE = candidate;
      return candidate;
    }
  }
  throw new Error(`no public API surface answered: ${tried.join(', ')}`);
}

async function publicGet(
  path: string,
  key: string | null,
  extra: Record<string, string> = {},
): Promise<{ status: number; headers: Record<string, string>; body: any }> {
  const res = await fetch(`${base}${PUBLIC_BASE ?? '/api/v1/public'}${path}`, {
    headers: {
      'content-type': 'application/json',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...extra,
    },
  });
  const text = await res.text();
  return {
    status: res.status,
    headers: Object.fromEntries(res.headers.entries()),
    body: text ? safeJson(text) : null,
  };
}

/* ── fixture builders ─────────────────────────────────────────────────────── */

async function addMember(
  adminToken: string,
  tenant: string,
  planId: string,
  email: string,
  name: string,
): Promise<string> {
  const inv = await api('/api/v1/invitations', {
    method: 'POST',
    token: adminToken,
    tenant,
    body: JSON.stringify({ email, planId }),
  });
  expect(inv.status).toBe(201);
  const invited = await owner.domainEvent.findFirst({
    where: { eventName: 'MemberInvited', tenantId: tenant, aggregateId: inv.body.invitation.id },
  });
  const accepted = await api(
    `/api/v1/invitations/${(invited!.payload as { token: string }).token}/accept`,
    { method: 'POST', body: JSON.stringify({ displayName: name, password: PW }) },
  );
  expect(accepted.status).toBe(201);
  return accepted.body.memberId;
}

async function createGoal(token: string, tenant: string, title: string): Promise<string> {
  const res = await api('/api/v1/goals', {
    method: 'POST',
    token,
    tenant,
    body: JSON.stringify({ title, category: 'personal' }),
  });
  expect(res.status).toBe(201);
  return res.body.goal.id as string;
}

async function completeGoal(token: string, tenant: string, goalId: string): Promise<void> {
  const res = await api(`/api/v1/goals/${goalId}`, {
    method: 'PATCH',
    token,
    tenant,
    body: JSON.stringify({ status: 'completed' }),
  });
  expect(res.status).toBe(200);
  expect(res.body.goal.status).toBe('completed');
}

beforeAll(async () => {
  process.env.AVIORA_OUTBOX_DISABLED = 'true';
  process.env.AVIORA_PII_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
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

  await startReceiver();

  app = await createApp({ logger: false });
  await app.listen(0);
  base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  port = new URL(base).port;
  relay = app.get(OutboxRelayService);
  // No SMTP here. Handlers are independent by design (docs/11 §idempotency),
  // so dropping the email consumers changes nothing this file asserts — but
  // leaving them in would fail every drain and never let a webhook fire.
  const registry = (app.get(EventBus) as unknown as { handlers: Map<string, { name: string }[]> })
    .handlers;
  registry.forEach((list, key) =>
    registry.set(
      key,
      list.filter((r) => !r.name.startsWith('email.')),
    ),
  );

  const platform = await login(PLATFORM_EMAIL);
  const mkTenant = async (suffix: string, slug: string, name: string, adminEmail: string) => {
    const res = await api('/api/v1/platform/tenants', {
      method: 'POST',
      token: platform,
      body: JSON.stringify({
        code: `e2e_int_${suffix}_${RUN}`,
        name,
        slug,
        adminEmail,
        adminDisplayName: 'Admin',
        adminPassword: PW,
      }),
    });
    expect(res.status).toBe(201);
    return res.body.tenant.id as string;
  };
  beacon = await mkTenant('a', BEACON_SLUG, 'Beacon Integrations', `admin-a-${RUN}@test.local`);
  quiet = await mkTenant('b', QUIET_SLUG, 'Quiet Collective', `admin-b-${RUN}@test.local`);
  TENANTS.push(beacon, quiet);

  const adminA = await login(`admin-a-${RUN}@test.local`);
  const adminB = await login(`admin-b-${RUN}@test.local`);

  const mkPlan = async (token: string, tenant: string, code: string): Promise<string> => {
    const res = await api('/api/v1/membership-plans', {
      method: 'POST',
      token,
      tenant,
      body: JSON.stringify({
        code,
        name: code,
        entitlementKeys: [ENTITLEMENTS.COMMERCE, ENTITLEMENTS.RANKS],
      }),
    });
    expect(res.status).toBe(201);
    return res.body.plan.id as string;
  };
  beaconPlanId = await mkPlan(adminA, beacon, 'signal');
  quietPlanId = await mkPlan(adminB, quiet, 'hush');

  irisMemberId = await addMember(adminA, beacon, beaconPlanId, `iris-${RUN}@test.local`, 'Iris');
  ottoMemberId = await addMember(adminB, quiet, quietPlanId, `otto-${RUN}@test.local`, 'Otto');

  // A rank ladder, so /public/ranks has something to return rather than an
  // empty list that would be equal to itself trivially.
  const rank = await api('/api/v1/ranks', {
    method: 'POST',
    token: adminA,
    tenant: beacon,
    body: JSON.stringify({
      code: 'bronze',
      name: 'Bronze',
      level: 1,
      qualifications: [{ metric: 'personal_volume', comparator: 'gte', threshold: 100_000 }],
    }),
  });
  expect(rank.status).toBe(201);

  // The identity each tenant's manifest must carry (docs/30 §5, docs/29 §1).
  const brand = async (token: string, tenant: string, body: Record<string, unknown>) => {
    const res = await api('/api/v1/tenant/branding', {
      method: 'PUT',
      token,
      tenant,
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
  };
  await brand(adminA, beacon, {
    appName: BEACON_APP_NAME,
    logoUrl: `https://cdn.example.com/${RUN}/beacon.svg`,
    colors: { primary: BEACON_PRIMARY, surface: BEACON_BACKGROUND },
    hiddenFeatures: [],
  });
  await brand(adminB, quiet, {
    appName: QUIET_APP_NAME,
    logoUrl: `https://cdn.example.com/${RUN}/quiet.svg`,
    colors: { primary: QUIET_PRIMARY, surface: QUIET_BACKGROUND },
    hiddenFeatures: [],
  });

  // Everything the fixture caused is delivered before the first endpoint
  // exists, so no endpoint in this file can fire on setup.
  await drainOutbox();
}, 300_000);

afterAll(async () => {
  await app?.close();
  await owner?.$disconnect();
  await new Promise<void>((resolve) => (receiver ? receiver.close(() => resolve()) : resolve()));
  if (certDir) rmSync(certDir, { recursive: true, force: true });
});

describe('An endpoint is a URL the platform will actually reach (docs/30 §1)', () => {
  it('refuses a plaintext receiver, so a secret is never posted in the clear', async () => {
    // FINDING, recorded as a test rather than worked around: the migration
    // carries CHECK (url LIKE 'https://%'), which makes an http://127.0.0.1
    // receiver impossible. That is the right rule — the request carries a
    // signature computed with a shared secret, and TLS is what keeps the body
    // that was signed from being read and replayed. What this asserts is that
    // the REFUSAL happens at the edge with a reason: a 500 here would mean the
    // database constraint is doing the API's validation.
    const admin = await login(`admin-a-${RUN}@test.local`);
    const res = await createEndpoint(admin, beacon, {
      url: `http://127.0.0.1:9/hook/plain-${RUN}`,
      description: 'A receiver that would read the secret off the wire',
      events: [EVENTS.GoalCompleted],
    });
    expect([400, 422]).toContain(res.status);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(await withTenant(beacon, (tx) => tx.webhookEndpoint.count())).toBe(0);
  });

  it('refuses a wildcard subscription — "all events" is not a subscription (§7)', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    for (const events of [['*'], ['all'], []]) {
      const res = await createEndpoint(admin, beacon, {
        url: `${receiverBase ?? 'https://127.0.0.1:9'}${OK_PATH}`,
        events,
      });
      expect([400, 422], `events: ${JSON.stringify(events)}`).toContain(res.status);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    }
    expect(await withTenant(beacon, (tx) => tx.webhookEndpoint.count())).toBe(0);
  });

  it('refuses an event that is not in the catalog, and names it', async () => {
    // INTERPRETATION: §7 states the wildcard refusal outright. This is the
    // same rule read the other way — a subscription to `MemberBecameCurious`
    // can never fire, so it is a typo and not a configuration.
    const admin = await login(`admin-a-${RUN}@test.local`);
    const res = await createEndpoint(admin, beacon, {
      url: `${receiverBase ?? 'https://127.0.0.1:9'}${OK_PATH}`,
      events: ['MemberBecameCurious'],
    });
    expect([400, 422]).toContain(res.status);
    expect(JSON.stringify(res.body.error)).toContain('MemberBecameCurious');
  });

  it('refuses a member who does not hold integration.manage', async () => {
    const iris = await login(`iris-${RUN}@test.local`);
    const listed = await listEndpoints(iris, beacon);
    expect(listed.status).toBe(403);
    expect(listed.body.error.code).toBe('FORBIDDEN');

    const created = await createEndpoint(iris, beacon, {
      url: `${receiverBase ?? 'https://127.0.0.1:9'}${OK_PATH}`,
      events: [EVENTS.GoalCompleted],
    });
    expect(created.status).toBe(403);

    const keys = await api('/api/v1/api-keys', { token: iris, tenant: beacon });
    expect(keys.status).toBe(403);
  });

  it('creates an endpoint and hands over the secret exactly once', async () => {
    const receiverUrl = requireReceiver();
    const admin = await login(`admin-a-${RUN}@test.local`);
    const res = await createEndpoint(admin, beacon, {
      url: `${receiverUrl}${OK_PATH}`,
      description: `Beacon’s own receiver ${RUN}`,
      events: [EVENTS.GoalCompleted],
    });
    expect(res.status).toBe(201);
    okSecret = secretOf(res.body);
    expect(okSecret.length).toBeGreaterThanOrEqual(16);
    okEndpointId = rowIdOf(res.body, 'endpoint', 'webhookEndpoint');

    const endpoint = nodeOf(res.body, 'endpoint', 'webhookEndpoint');
    expect(endpoint.url).toBe(`${receiverUrl}${OK_PATH}`);
    expect(endpoint.events).toEqual([EVENTS.GoalCompleted]);
    expect(endpoint.status ?? 'active').toBe('active');
  });

  it('creates the endpoint that will fail, and the one the other tenant points at everything', async () => {
    const receiverUrl = requireReceiver();
    const adminA = await login(`admin-a-${RUN}@test.local`);
    const adminB = await login(`admin-b-${RUN}@test.local`);

    const boom = await createEndpoint(adminA, beacon, {
      url: `${receiverUrl}${BOOM_PATH}`,
      description: `A receiver that is unwell ${RUN}`,
      events: [EVENTS.TeamCreated],
    });
    expect(boom.status).toBe(201);
    boomEndpointId = rowIdOf(boom.body, 'endpoint', 'webhookEndpoint');
    boomSecret = secretOf(boom.body);

    // Quiet asks for EVERY event the catalog holds. It is the listener the
    // health scan reads, and — until Quiet does anything of its own — the
    // proof that Beacon's events never reach another tenant's receiver.
    const everything = Object.values(EVENTS) as string[];
    let all = await createEndpoint(adminB, quiet, {
      url: `${receiverUrl}${ALL_PATH}`,
      description: `Quiet listens to everything ${RUN}`,
      events: everything,
    });
    if (all.status !== 201) {
      // If the platform refuses to publish a health event at all, that is
      // §7 enforced one layer earlier — and it must say which event it
      // refused rather than dropping it quietly.
      expect([400, 422]).toContain(all.status);
      expect(JSON.stringify(all.body.error)).toContain(EVENTS.HabitLogged);
      const withoutHealth = everything.filter((e) => e !== EVENTS.HabitLogged);
      all = await createEndpoint(adminB, quiet, {
        url: `${receiverUrl}${ALL_PATH}`,
        description: `Quiet listens to everything it is allowed to ${RUN}`,
        events: withoutHealth,
      });
      expect(all.status).toBe(201);
      allEndpointEvents = withoutHealth;
    } else {
      allEndpointEvents = everything;
    }
    allEndpointId = rowIdOf(all.body, 'endpoint', 'webhookEndpoint');
    expect(allEndpointEvents.length).toBeGreaterThan(20);
  });

  it('never returns the secret again, from any route', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const listed = await listEndpoints(admin, beacon);
    expect(listed.status).toBe(200);
    expect(endpointsOf(listed.body)).toHaveLength(2);
    expect(mentions(listed.body, okSecret)).toBe(false);

    // and not on the single-endpoint read either, if the implementation has one
    const single = await api(`/api/v1/webhooks/endpoints/${okEndpointId}`, {
      token: admin,
      tenant: beacon,
    });
    expect([200, 404]).toContain(single.status);
    if (single.status === 200) expect(mentions(single.body, okSecret)).toBe(false);

    // a PATCH is a write and answers with the endpoint; it is not a back door
    const patched = await api(`/api/v1/webhooks/endpoints/${okEndpointId}`, {
      method: 'PATCH',
      token: admin,
      tenant: beacon,
      body: JSON.stringify({ description: `Beacon’s own receiver, renamed ${RUN}` }),
    });
    expect(patched.status).toBe(200);
    expect(mentions(patched.body, okSecret)).toBe(false);
  });

  it('stores a hash and not the secret it handed over', async () => {
    const row = await withTenant(beacon, (tx) =>
      tx.webhookEndpoint.findFirst({ where: { id: okEndpointId } }),
    );
    expect(row).toBeTruthy();
    expect(row!.secretHash).not.toBe(okSecret);
    expect(row!.secretHash).not.toContain(okSecret);
    expect(row!.secretHash.length).toBeGreaterThan(16);
  });
});

describe('An event is delivered to an endpoint at most once (docs/30 §1)', () => {
  it('delivers one POST for the one event the endpoint asked for', async () => {
    const iris = await login(`iris-${RUN}@test.local`);
    irisGoalId = await createGoal(iris, beacon, `Walk to the lighthouse ${RUN}`);
    await completeGoal(iris, beacon, irisGoalId);
    goalCompletedEventId = await eventIdFor(beacon, EVENTS.GoalCompleted, irisGoalId);

    await settle(beacon, okEndpointId);

    const rows = await withTenant(beacon, (tx) =>
      tx.webhookDelivery.findMany({ where: { endpointId: okEndpointId } }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.eventId).toBe(goalCompletedEventId);
    expect(
      rows[0]!.status,
      `delivery did not succeed — the platform recorded: ${rows[0]!.error ?? '(no error)'}`,
    ).toBe('delivered');
    expect(rows[0]!.responseCode).toBe(200);
    expect(rows[0]!.deliveredAt).toBeTruthy();
    expect(rows[0]!.attempts).toBeGreaterThanOrEqual(1);

    const posts = postsOfEvent(OK_PATH, EVENTS.GoalCompleted);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.method).toBe('POST');
  });

  it('shows the delivery in the log, with the response code that came back', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const res = await listDeliveries(admin, beacon);
    expect(res.status).toBe(200);
    const delivered = deliveriesOf(res.body).filter(
      (d: any) => (d.eventName ?? d.event) === EVENTS.GoalCompleted,
    );
    expect(delivered).toHaveLength(1);
    expect(delivered[0].status).toBe('delivered');
    expect(delivered[0].responseCode ?? delivered[0].response_code).toBe(200);
  });

  it('draining the same event again delivers nothing — no second row, no second POST', async () => {
    // The most important test in this file. The outbox promises AT LEAST ONCE;
    // UNIQUE (endpoint_id, event_id) is what turns that into EXACTLY ONCE for
    // somebody else's server, which may have charged a card on the first one.
    const before = postsTo(OK_PATH).length;
    const attemptsBefore = (
      await withTenant(beacon, (tx) =>
        tx.webhookDelivery.findMany({ where: { endpointId: okEndpointId } }),
      )
    )[0]!.attempts;

    await replayEvent(goalCompletedEventId);
    await settle(beacon, okEndpointId);

    const rows = await withTenant(beacon, (tx) =>
      tx.webhookDelivery.findMany({ where: { endpointId: okEndpointId } }),
    );
    expect(rows).toHaveLength(1);
    // not even a second ATTEMPT on the same row: the event was already handled
    expect(rows[0]!.attempts).toBe(attemptsBefore);
    expect(postsTo(OK_PATH)).toHaveLength(before);
  });

  it('sends nothing for an event the endpoint did not subscribe to', async () => {
    // The same member, the same tenant, a goal CREATED and not completed. The
    // endpoint asked for GoalCompleted, so this is silence by subscription and
    // not by accident.
    const iris = await login(`iris-${RUN}@test.local`);
    const quietGoal = await createGoal(iris, beacon, `Something I only started ${RUN}`);
    await eventIdFor(beacon, EVENTS.GoalCreated, quietGoal);
    await settle(beacon, okEndpointId);

    expect(postsOfEvent(OK_PATH, EVENTS.GoalCreated)).toHaveLength(0);
    expect(postsTo(OK_PATH)).toHaveLength(1);
    const rows = await withTenant(beacon, (tx) =>
      tx.webhookDelivery.count({ where: { endpointId: okEndpointId } }),
    );
    expect(rows).toBe(1);
  });

  it('sends nothing to the other tenant’s endpoint, which subscribed to everything', async () => {
    // Quiet asked for every event in the catalog. Every event so far belongs to
    // Beacon, so Quiet has heard nothing — a subscription is scoped to the
    // tenant that made it, not to the platform.
    expect(await withTenant(quiet, (tx) => tx.webhookDelivery.count())).toBe(0);
    expect(postsTo(ALL_PATH)).toHaveLength(0);
  });
});

describe('A receiver can prove the request came from us (docs/30 §2)', () => {
  it('carries the four headers, named exactly as the contract names them', async () => {
    const post = postsOfEvent(OK_PATH, EVENTS.GoalCompleted)[0];
    expect(post, 'no delivery was recorded to assert headers on').toBeTruthy();

    // Node lower-cases incoming header names; HTTP header names are
    // case-insensitive, so these ARE the names §2 prints.
    expect(post!.headers['x-aviora-event']).toBe(EVENTS.GoalCompleted);
    expect(post!.headers['x-aviora-delivery']).toMatch(/^[0-9a-f-]{36}$/i);
    expect(post!.headers['x-aviora-timestamp']).toMatch(/^\d{10}$/);
    expect(post!.headers['x-aviora-signature']).toMatch(/^sha256=[0-9a-f]{64}$/);

    // and the delivery header names the row an operator would look up
    const row = await withTenant(beacon, (tx) =>
      tx.webhookDelivery.findFirst({ where: { endpointId: okEndpointId } }),
    );
    expect(post!.headers['x-aviora-delivery']).toBe(row!.id);
  });

  it('signs sha256=HMAC(timestamp + "." + body) with the secret handed over at creation', async () => {
    const post = postsOfEvent(OK_PATH, EVENTS.GoalCompleted)[0]!;
    expect(post.headers['x-aviora-signature']).toBe(receiverSignature(post, okSecret));
  });

  it('fails verification when one character of the body changes', async () => {
    // A signature that still verifies after a byte moved is not a signature.
    const post = postsOfEvent(OK_PATH, EVENTS.GoalCompleted)[0]!;
    const tampered = post.raw.replace(/([a-z])/, (c) => (c === 'a' ? 'b' : 'a'));
    expect(tampered).not.toBe(post.raw);
    expect(post.headers['x-aviora-signature']).not.toBe(
      receiverSignature(post, okSecret, tampered),
    );
    // and a different secret does not verify the untouched body either
    expect(post.headers['x-aviora-signature']).not.toBe(receiverSignature(post, `${okSecret}x`));
  });

  it('signs the timestamp it sent, so a captured request cannot be replayed later', async () => {
    const post = postsOfEvent(OK_PATH, EVENTS.GoalCompleted)[0]!;
    const sent = Number(post.headers['x-aviora-timestamp']);
    // it is unix SECONDS, and it is the moment the request was made
    expect(Math.abs(sent * 1000 - post.at)).toBeLessThan(5 * 60_000);
    // moving the timestamp by one second invalidates the signature, which is
    // the whole reason it is inside the signed payload
    const replayed: Recorded = {
      ...post,
      headers: { ...post.headers, 'x-aviora-timestamp': String(sent + 1) },
    };
    expect(post.headers['x-aviora-signature']).not.toBe(receiverSignature(replayed, okSecret));
  });

  it('carries the envelope and nothing more — no health, and no secret', async () => {
    const post = postsOfEvent(OK_PATH, EVENTS.GoalCompleted)[0]!;
    const body = post.body as any;
    // the envelope §2 describes: id, name, tenant, aggregate, payload, occurred-at
    expect(body.eventId ?? body.id).toBeTruthy();
    expect(body.eventName ?? body.name ?? body.event).toBe(EVENTS.GoalCompleted);
    expect(body.tenantId ?? body.tenant).toBe(beacon);
    expect(body.aggregateId ?? body.aggregate?.id).toBe(irisGoalId);
    expect(body.occurredAt ?? body.occurred_at).toBeTruthy();
    // the secret signs the request; it is never IN the request
    expect(mentions(body, okSecret)).toBe(false);
    expectNoHealthAnywhere('the GoalCompleted delivery', body);
  });
});

describe('A receiver that fails is retried, then recorded as failed (docs/30 §1)', () => {
  it('leaves a 500 pending, with the attempt counted, the code kept and the next attempt scheduled', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const team = await api('/api/v1/teams', {
      method: 'POST',
      token: admin,
      tenant: beacon,
      body: JSON.stringify({ code: `ridge-${RUN}`, name: 'Ridge' }),
    });
    expect(team.status).toBe(201);

    // The relay RECORDS the delivery; the dispatcher SENDS it. They are
    // deliberately apart so an unreachable customer server cannot hold a
    // database transaction open, so one attempt is a drain plus one tick.
    await drainOutbox();
    const drivers = webhookDrivers();
    expect(drivers.length, 'nothing in the container sends webhooks').toBeGreaterThan(0);
    for (const driver of drivers) await driver.run();

    const rows = await withTenant(beacon, (tx) =>
      tx.webhookDelivery.findMany({ where: { endpointId: boomEndpointId } }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('pending');
    expect(rows[0]!.attempts).toBe(1);
    expect(rows[0]!.responseCode).toBe(500);
    expect(
      rows[0]!.error,
      'a delivery records the error text — "it didn’t work" is not a support answer',
    ).toBeTruthy();
    expect(rows[0]!.deliveredAt).toBeNull();
    expect(
      rows[0]!.nextAttemptAt,
      'a pending delivery with no next attempt is silence',
    ).toBeTruthy();
    expect(rows[0]!.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());

    expect(postsOfEvent(BOOM_PATH, EVENTS.TeamCreated)).toHaveLength(1);

    // and the failing handler did not break the bus: the event itself drained
    const event = await owner.domainEvent.findFirst({
      where: { id: await eventIdFor(beacon, EVENTS.TeamCreated, team.body.team.id) },
    });
    expect(event!.processedAt).toBeTruthy();
  });

  it('stops after five attempts and keeps the response code and the error', async () => {
    await settle(beacon, boomEndpointId, 12);

    const rows = await withTenant(beacon, (tx) =>
      tx.webhookDelivery.findMany({ where: { endpointId: boomEndpointId } }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('failed');
    expect(rows[0]!.attempts).toBe(5);
    expect(rows[0]!.responseCode).toBe(500);
    expect(rows[0]!.error).toBeTruthy();
    expect(rows[0]!.deliveredAt).toBeNull();

    // five attempts is five requests the receiver actually saw
    expect(postsOfEvent(BOOM_PATH, EVENTS.TeamCreated)).toHaveLength(5);

    // "then failed, and it stays in the log" — the operator can read it
    const admin = await login(`admin-a-${RUN}@test.local`);
    const log = await listDeliveries(admin, beacon);
    const failed = deliveriesOf(log.body).find((d: any) => d.status === 'failed');
    expect(failed).toBeTruthy();
    expect(failed.responseCode ?? failed.response_code).toBe(500);
    expect(failed.error).toBeTruthy();
  }, 120_000);

  it('retries a failed delivery by hand, on the same row', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const before = postsTo(BOOM_PATH).length;
    const deliveryId = (await withTenant(beacon, (tx) =>
      tx.webhookDelivery.findFirst({ where: { endpointId: boomEndpointId } }),
    ))!.id;

    // the receiver recovers, so a manual retry has something to succeed at
    boomStatus = 200;
    const retried = await api(`/api/v1/webhooks/deliveries/${deliveryId}/retry`, {
      method: 'POST',
      token: admin,
      tenant: beacon,
    });
    expect([200, 201, 202]).toContain(retried.status);
    await settle(beacon, boomEndpointId, 6);

    expect(postsTo(BOOM_PATH).length).toBeGreaterThan(before);

    const rows = await withTenant(beacon, (tx) =>
      tx.webhookDelivery.findMany({ where: { endpointId: boomEndpointId } }),
    );
    // one event, one endpoint, one row — a retry is not a new delivery
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(deliveryId);
    expect(rows[0]!.status).toBe('delivered');
    expect(rows[0]!.responseCode).toBe(200);
    expect(rows[0]!.deliveredAt).toBeTruthy();
    expect(rows[0]!.attempts).toBeGreaterThan(5);
  });

  it('signs every retry too, with the same secret and a fresh timestamp', async () => {
    // Two requests for the SAME event, each signed over the timestamp IT sent.
    // Retries driven back to back land inside one second, so the timestamps
    // may legitimately match — what matters is that every attempt carries a
    // signature that verifies against its own header, not that the clock moved.
    const posts = postsOfEvent(BOOM_PATH, EVENTS.TeamCreated);
    expect(posts.length).toBeGreaterThanOrEqual(2);
    for (const post of posts) {
      expect(post.headers['x-aviora-timestamp']).toBeTruthy();
      expect(post.headers['x-aviora-signature']).toBe(receiverSignature(post, boomSecret));
    }
    // …and the same delivery id throughout: the receiver can de-duplicate on it
    const ids = new Set(posts.map((p) => p.headers['x-aviora-delivery']));
    expect(ids.size).toBe(1);
  });
});

describe('A screen can tell what its user may do', () => {
  it('reports the caller’s own permissions, so a scope picker offers only what will be accepted', async () => {
    // A picker that offers scopes the server refuses teaches people to expect
    // refusals. This is what a screen reads to be right the first time — and
    // it decides nothing: the guard still refuses on its own reckoning.
    const admin = await login(`admin-a-${RUN}@test.local`);
    const res = await api('/api/v1/auth/me', { token: admin, tenant: beacon });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.permissions)).toBe(true);
    expect(res.body.permissions).toContain(PERMISSIONS.INTEGRATION_MANAGE);
    // …and never a permission the caller does not hold
    expect(res.body.permissions).not.toContain(PERMISSIONS.PLATFORM_TENANT_MANAGE);
  });
});

describe('A key is shown once, scoped, and bound to one tenant (docs/30 §3)', () => {
  it('refuses a key carrying a scope its creator does not hold, and names the scope', async () => {
    // A tenant owner holds every TENANT-scope permission and no platform one
    // (packages/db system roles). `platform.tenant.manage` is therefore the
    // promotion an admin must not be able to mint for themselves.
    const admin = await login(`admin-a-${RUN}@test.local`);
    const res = await createKey(admin, beacon, {
      name: `A key that promotes me ${RUN}`,
      scopes: [PERMISSIONS.MEMBER_VIEW, PERMISSIONS.PLATFORM_TENANT_MANAGE],
    });
    expect([400, 403, 422]).toContain(res.status);
    expect(JSON.stringify(res.body.error)).toContain(PERMISSIONS.PLATFORM_TENANT_MANAGE);
    expect(await withTenant(beacon, (tx) => tx.apiKey.count())).toBe(0);
  });

  it('refuses a wildcard scope — there is no "*" (§7)', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    for (const scopes of [['*'], ['member.*'], []]) {
      const res = await createKey(admin, beacon, { name: `Wildcard ${RUN}`, scopes });
      expect([400, 403, 422], `scopes: ${JSON.stringify(scopes)}`).toContain(res.status);
    }
    expect(await withTenant(beacon, (tx) => tx.apiKey.count())).toBe(0);
  });

  it('returns the key at creation and never again — a list carries the prefix only', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const res = await createKey(admin, beacon, {
      name: `Beacon integration key ${RUN}`,
      scopes: [PERMISSIONS.MEMBER_VIEW, PERMISSIONS.COMMERCE_ORDER_VIEW, PERMISSIONS.RANK_VIEW],
    });
    expect(res.status).toBe(201);
    fullKey = apiKeyOf(res.body);
    expect(fullKey.length).toBeGreaterThanOrEqual(24);
    fullKeyId = rowIdOf(res.body, 'apiKey', 'key');

    const listed = await api('/api/v1/api-keys', { token: admin, tenant: beacon });
    expect(listed.status).toBe(200);
    expect(keysOf(listed.body)).toHaveLength(1);
    expect(mentions(listed.body, fullKey)).toBe(false);

    // a prefix is kept in the clear so two keys can be told apart in a list
    const prefix = keysOf(listed.body)[0].prefix;
    expect(typeof prefix).toBe('string');
    expect(prefix.length).toBeGreaterThan(3);
    expect(prefix.length).toBeLessThan(fullKey.length);
    expect(fullKey.startsWith(prefix)).toBe(true);
  });

  it('stores a hash, not the key', async () => {
    const row = await withTenant(beacon, (tx) => tx.apiKey.findFirst({ where: { id: fullKeyId } }));
    expect(row).toBeTruthy();
    expect(row!.hash).not.toBe(fullKey);
    expect(row!.hash).not.toContain(fullKey);
    expect(fullKey).not.toContain(row!.hash);
    expect(row!.scopes.sort()).toEqual(
      [PERMISSIONS.MEMBER_VIEW, PERMISSIONS.COMMERCE_ORDER_VIEW, PERMISSIONS.RANK_VIEW].sort(),
    );
    expect(row!.revokedAt).toBeNull();
  });

  it('authenticates the public API, and refuses the caller who brings nothing', async () => {
    await resolvePublicBase(fullKey);

    const members = await publicGet('/members', fullKey);
    expect(members.status).toBe(200);
    const rows = listOf(members.body);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((m: any) => typeof m.id === 'string')).toBe(true);

    const anonymous = await publicGet('/members', null);
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error.code).toBe('UNAUTHENTICATED');

    const nonsense = await publicGet('/members', `${fullKey}-not-really`);
    expect(nonsense.status).toBe(401);
    expect(nonsense.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('answers the rest of the narrow public surface: orders and ranks', async () => {
    const orders = await publicGet('/orders', fullKey);
    expect(orders.status).toBe(200);
    expect(Array.isArray(listOf(orders.body))).toBe(true);

    const ranks = await publicGet('/ranks', fullKey);
    expect(ranks.status).toBe(200);
    expect(listOf(ranks.body).map((r: any) => r.code)).toContain('bronze');
  });

  it('refuses a route the key was not scoped for', async () => {
    // INTERPRETATION: §6 gives the public routes' permission as "key scope"
    // without printing the mapping. The scopes are "permission keys the
    // platform already has" (§3), so /public/members reads member.view. A key
    // holding only rank.view therefore reads ranks and nothing else.
    const admin = await login(`admin-a-${RUN}@test.local`);
    const res = await createKey(admin, beacon, {
      name: `Ranks only ${RUN}`,
      scopes: [PERMISSIONS.RANK_VIEW],
    });
    expect(res.status).toBe(201);
    narrowKey = apiKeyOf(res.body);

    const ranks = await publicGet('/ranks', narrowKey);
    expect(ranks.status).toBe(200);

    const members = await publicGet('/members', narrowKey);
    expect(members.status).toBe(403);
    expect(members.body.error.code).toBe('FORBIDDEN');
    expect(JSON.stringify(members.body.error)).toContain(PERMISSIONS.MEMBER_VIEW);
  });

  it('will not read another tenant’s data, whatever header it is handed', async () => {
    // "A key is bound to one tenant. There is no cross-tenant key, because
    // there is no cross-tenant caller."
    const asQuiet = await publicGet('/members', fullKey, { 'x-tenant-id': quiet });
    expect([200, 400, 403]).toContain(asQuiet.status);
    if (asQuiet.status === 200) {
      const ids = listOf(asQuiet.body).map((m: any) => m.id);
      expect(ids).toContain(irisMemberId);
      expect(ids).not.toContain(ottoMemberId);
    }
    expect(mentions(asQuiet.body, `otto-${RUN}@test.local`)).toBe(false);
    expect(mentions(asQuiet.body, ottoMemberId)).toBe(false);

    // and Quiet's admin cannot see Beacon's key at all
    const adminB = await login(`admin-b-${RUN}@test.local`);
    const theirs = await api('/api/v1/api-keys', { token: adminB, tenant: quiet });
    expect(theirs.status).toBe(200);
    expect(keysOf(theirs.body)).toHaveLength(0);
  });

  it('records last_used_at, so an operator can tell whether a key is still in traffic', async () => {
    const row = await withTenant(beacon, (tx) => tx.apiKey.findFirst({ where: { id: fullKeyId } }));
    expect(row!.lastUsedAt, 'a key that has answered requests has been used').toBeTruthy();
    expect(row!.lastUsedAt!.getTime()).toBeGreaterThan(Date.now() - 10 * 60_000);
  });

  it('refuses a revoked key immediately, and permanently', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const made = await createKey(admin, beacon, {
      name: `A key with a short life ${RUN}`,
      scopes: [PERMISSIONS.RANK_VIEW],
    });
    expect(made.status).toBe(201);
    doomedKey = apiKeyOf(made.body);
    doomedKeyId = rowIdOf(made.body, 'apiKey', 'key');

    const worked = await publicGet('/ranks', doomedKey);
    expect(worked.status).toBe(200);

    const revoked = await api(`/api/v1/api-keys/${doomedKeyId}`, {
      method: 'DELETE',
      token: admin,
      tenant: beacon,
    });
    expect([200, 204]).toContain(revoked.status);

    // immediate: the very next request, with no cache to wait out
    const refused = await publicGet('/ranks', doomedKey);
    expect(refused.status).toBe(401);
    expect(refused.body.error.code).toBe('UNAUTHENTICATED');

    // permanent: the row keeps the revocation and the key never works again
    const row = await withTenant(beacon, (tx) =>
      tx.apiKey.findFirst({ where: { id: doomedKeyId } }),
    );
    expect(row!.revokedAt).toBeTruthy();
    const stillRefused = await publicGet('/ranks', doomedKey);
    expect(stillRefused.status).toBe(401);
  });

  it('keeps the public surface as narrow as it was declared', async () => {
    // §7: "No health endpoints on the public API." Not by omission — by rule.
    for (const path of ['/health', '/habits', '/metrics', '/health/habits']) {
      const res = await publicGet(path, fullKey);
      expect([403, 404], `${path} answered ${res.status}`).toContain(res.status);
    }
  });
});

describe('Health data does not leave, by rule and not by omission (docs/30 §7)', () => {
  it('proves the scan can catch a leak before trusting it to find none', async () => {
    // A scan that cannot fail is a scan that proves nothing. This is the same
    // guard analytics.e2e.spec.ts puts in front of its dashboard sweep.
    const leaky = {
      eventName: EVENTS.HabitLogged,
      payload: { habitCode: HABIT_CODE, sleepAverage: SLEEP_HOURS, note: LIFESTYLE_NOTE },
    };
    const found = findHealth(leaky);
    expect(found.length).toBeGreaterThanOrEqual(3);
    expect(found.join('\n')).toContain(HABIT_CODE);
    expect(found.join('\n')).toContain('key names health data');
    // and the envelope's own structural fields are NOT a leak
    expect(
      findHealth({ eventName: EVENTS.HabitLogged, aggregateType: 'habit', payload: {} }),
    ).toEqual([]);
  });

  it('causes real health activity in the tenant that subscribed to everything', async () => {
    const otto = await login(`otto-${RUN}@test.local`);

    const profile = await api('/api/v1/health/me', {
      method: 'PUT',
      token: otto,
      tenant: quiet,
      body: JSON.stringify({ lifestyleNotes: LIFESTYLE_NOTE }),
    });
    expect(profile.status).toBe(200);

    const habit = await api('/api/v1/health/habits', {
      method: 'POST',
      token: otto,
      tenant: quiet,
      body: JSON.stringify({
        code: HABIT_CODE,
        name: HABIT_NAME,
        cadence: 'daily',
        targetUnit: 'minutes',
        targetValue: HABIT_TARGET,
      }),
    });
    expect(habit.status).toBe(201);

    const logged = await api(`/api/v1/health/habits/${habit.body.habit.id}/log`, {
      method: 'POST',
      token: otto,
      tenant: quiet,
      body: JSON.stringify({ value: HABIT_LOGGED, completed: true }),
    });
    expect(logged.status).toBe(201);

    for (const [metric, value, unit] of [
      ['sleep_hours', SLEEP_HOURS, 'h'],
      ['weight_kg', WEIGHT_KG, 'kg'],
    ] as const) {
      const res = await api('/api/v1/health/metrics', {
        method: 'POST',
        token: otto,
        tenant: quiet,
        body: JSON.stringify({ metric, value, unit }),
      });
      expect(res.status).toBe(201);
    }

    // …and something non-health in the same tenant, so the endpoint is
    // demonstrably alive and the empty health result below is not just silence.
    const goalId = await createGoal(otto, quiet, `Read more ${RUN}`);
    await completeGoal(otto, quiet, goalId);

    await settle(quiet, allEndpointId);
    expect(postsTo(ALL_PATH).length).toBeGreaterThan(0);
    expect(postsOfEvent(ALL_PATH, EVENTS.GoalCompleted)).toHaveLength(1);
  });

  it('leaves no habit code, metric value or health-shaped key in any delivered body', async () => {
    // Every request this suite's receiver has ever recorded, from every
    // endpoint and every tenant — deep-scanned leaf by leaf.
    expect(received.length).toBeGreaterThan(0);
    for (const rec of received) {
      expectNoHealthAnywhere(`${rec.path} ${rec.headers['x-aviora-event']} body`, rec.body);
      // the raw bytes too, in case a value hid somewhere the parser normalised
      for (const token of FORBIDDEN.strings) {
        expect(
          rec.raw.toLowerCase().includes(token.toLowerCase()),
          `${rec.path} raw body contains "${token}"`,
        ).toBe(false);
      }
    }
  });

  it('delivers the fact of a habit and nothing about it, if it delivers one at all', async () => {
    const habitPosts = postsOfEvent(ALL_PATH, EVENTS.HabitLogged);
    if (!allEndpointEvents.includes(EVENTS.HabitLogged)) {
      // The platform refused the subscription outright — §7 one layer earlier.
      expect(habitPosts).toHaveLength(0);
      return;
    }
    expect(habitPosts.length).toBeGreaterThan(0);
    for (const post of habitPosts) {
      const payload = (post.body as any)?.payload ?? {};
      expect(payload.memberId ?? payload.member_id).toBe(ottoMemberId);
      // no value, no habit name, no code: the event says a habit was logged
      expect(payload.value).toBeUndefined();
      expect(payload.code).toBeUndefined();
      expect(payload.name).toBeUndefined();
      expectNoHealthAnywhere('a HabitLogged delivery', post.body);
    }
  });

  it('keeps health off the public API as well', async () => {
    const members = await publicGet('/members', fullKey);
    expect(members.status).toBe(200);
    expectNoHealthAnywhere('/public/members', members.body);

    const orders = await publicGet('/orders', fullKey);
    expectNoHealthAnywhere('/public/orders', orders.body);
  });
});

describe('The manifest carries the tenant’s identity, not ours (docs/30 §5)', () => {
  /**
   * INTERPRETATION: §5 writes the route as `GET /manifest.webmanifest (web)`,
   * and the app mounts everything else under `api/v1`. Rather than assume one
   * spelling, this asks for each candidate and asserts on whichever answers —
   * and if none does, the failure prints what it tried, because "(web)" may
   * mean the Next app serves it from the branding this API already exposes by
   * host, in which case this suite is the wrong place for the assertion.
   */
  const CANDIDATES = [
    '/manifest.webmanifest',
    '/api/v1/manifest.webmanifest',
    '/api/v1/tenant/manifest.webmanifest',
    '/api/v1/tenant/manifest',
  ];
  let manifestPath: string | null = null;

  async function manifestFor(host: string) {
    if (manifestPath) return rawAtHost(host, manifestPath);
    const tried: string[] = [];
    for (const candidate of CANDIDATES) {
      const res = await rawAtHost(host, candidate);
      tried.push(`${candidate} → ${res.status}`);
      if (res.status === 200) {
        manifestPath = candidate;
        return res;
      }
    }
    expect(manifestPath, `no manifest answered by host: ${tried.join(', ')}`).toBeTruthy();
    throw new Error('unreachable');
  }

  it('resolves by host and carries the tenant’s name and colours', async () => {
    const res = await manifestFor(BEACON_HOST);
    expect(res.status).toBe(200);
    const manifest = res.body;
    expect(manifest.name ?? manifest.short_name).toContain(BEACON_APP_NAME);
    expect(
      [manifest.theme_color, manifest.background_color].map((c: string) => (c ?? '').toLowerCase()),
    ).toContain(BEACON_PRIMARY);
    // a manifest is installable or it is a JSON file nobody uses
    expect(manifest.start_url).toBeTruthy();
    expect(manifest.display).toBeTruthy();
  });

  it('never paints one tenant with another’s identity', async () => {
    const forBeacon = await manifestFor(BEACON_HOST);
    const forQuiet = await manifestFor(QUIET_HOST);

    expect(mentions(forQuiet.body, QUIET_APP_NAME)).toBe(true);
    expect(mentions(forQuiet.body, BEACON_APP_NAME)).toBe(false);
    expect(mentions(forBeacon.body, QUIET_APP_NAME)).toBe(false);
    expect(JSON.stringify(forQuiet.body)).not.toBe(JSON.stringify(forBeacon.body));

    expect(
      [forQuiet.body.theme_color, forQuiet.body.background_color].map((c: string) =>
        (c ?? '').toLowerCase(),
      ),
    ).toContain(QUIET_PRIMARY);
  });

  it('does not guess a tenant when the host names none', async () => {
    // The platform's own host is not a tenant. Painting a browser with SOME
    // tenant's identity because one had to be picked is worse than saying no.
    const res = await rawAtHost('127.0.0.1', manifestPath ?? CANDIDATES[0]!);
    expect([200, 400, 404]).toContain(res.status);
    if (res.status === 200) {
      expect(mentions(res.body, BEACON_APP_NAME)).toBe(false);
      expect(mentions(res.body, QUIET_APP_NAME)).toBe(false);
    }
  });

  it('is public — a manifest a browser cannot fetch is not a manifest', async () => {
    // No token, no X-Tenant-ID, nothing but a host. That is all a browser
    // sends when it decides whether an app is installable.
    const res = await manifestFor(BEACON_HOST);
    expect(res.status).toBe(200);
    expect(res.headers['content-type'] ?? '').toMatch(/json|manifest/i);
  });
});

describe('An endpoint can be paused and removed, and stops receiving (docs/30 §6)', () => {
  it('stops delivering to a paused endpoint, without deleting what it already received', async () => {
    const admin = await login(`admin-a-${RUN}@test.local`);
    const paused = await api(`/api/v1/webhooks/endpoints/${okEndpointId}`, {
      method: 'PATCH',
      token: admin,
      tenant: beacon,
      body: JSON.stringify({ status: 'paused' }),
    });
    expect(paused.status).toBe(200);

    const before = postsTo(OK_PATH).length;
    const iris = await login(`iris-${RUN}@test.local`);
    const goalId = await createGoal(iris, beacon, `A goal nobody hears about ${RUN}`);
    await completeGoal(iris, beacon, goalId);
    await settle(beacon, okEndpointId);

    expect(postsTo(OK_PATH)).toHaveLength(before);
    // the log of what DID happen is untouched
    const rows = await withTenant(beacon, (tx) =>
      tx.webhookDelivery.count({ where: { endpointId: okEndpointId, status: 'delivered' } }),
    );
    expect(rows).toBe(1);
  });

  it('removes an endpoint on request, and the tenant’s list says so', async () => {
    // webhook_deliveries references the endpoint ON DELETE RESTRICT, so a
    // removal either takes the log with it or marks the endpoint gone. Which
    // one is an implementation choice; that the tenant stops seeing it, and
    // stops being delivered to, is not.
    const admin = await login(`admin-a-${RUN}@test.local`);
    const removed = await api(`/api/v1/webhooks/endpoints/${okEndpointId}`, {
      method: 'DELETE',
      token: admin,
      tenant: beacon,
    });
    expect([200, 204]).toContain(removed.status);

    const listed = await listEndpoints(admin, beacon);
    expect(listed.status).toBe(200);
    expect(endpointsOf(listed.body).map((e: any) => e.id)).not.toContain(okEndpointId);

    // and a foreign tenant could never have removed it in the first place
    const adminB = await login(`admin-b-${RUN}@test.local`);
    const trespass = await api(`/api/v1/webhooks/endpoints/${boomEndpointId}`, {
      method: 'DELETE',
      token: adminB,
      tenant: quiet,
    });
    expect([403, 404]).toContain(trespass.status);
    expect(
      await withTenant(beacon, (tx) => tx.webhookEndpoint.count({ where: { id: boomEndpointId } })),
    ).toBe(1);
  });
});

/**
 * Last on purpose. Exhausting the window is the only honest way to prove the
 * 429, and every earlier test that calls the public API would then be answered
 * by a limit this suite spent itself.
 */
describe('A limit a caller cannot see is a limit they hit blind (docs/30 §4)', () => {
  it('states the limit, what is left and when it resets, on every public response', async () => {
    const res = await publicGet('/ranks', fullKey);
    expect(res.status).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toMatch(/^\d+$/);
    expect(res.headers['x-ratelimit-remaining']).toMatch(/^\d+$/);
    expect(res.headers['x-ratelimit-reset']).toMatch(/^\d+$/);
    expect(Number(res.headers['x-ratelimit-remaining'])).toBeLessThanOrEqual(
      Number(res.headers['x-ratelimit-limit']),
    );
  });

  it('counts down as the caller spends it', async () => {
    const first = await publicGet('/ranks', fullKey);
    const second = await publicGet('/ranks', fullKey);
    expect(Number(second.headers['x-ratelimit-remaining'])).toBeLessThan(
      Number(first.headers['x-ratelimit-remaining']) + 1,
    );
    expect(Number(second.headers['x-ratelimit-limit'])).toBe(
      Number(first.headers['x-ratelimit-limit']),
    );
  });

  it('answers 429 with retry_after when the limit is gone, never a silent drop', async () => {
    const probe = await publicGet('/ranks', fullKey);
    const limit = Number(probe.headers['x-ratelimit-limit']);
    const remaining = Number(probe.headers['x-ratelimit-remaining']);
    expect(
      limit,
      'a limit this large cannot be exercised inside a test; state a smaller default ' +
        'or make it configurable, or nobody will ever prove the 429 works',
    ).toBeLessThanOrEqual(600);

    let limited: { status: number; headers: Record<string, string>; body: any } | null = null;
    // The bound is fixed BEFORE the loop: `remaining` falls as the loop runs,
    // so re-reading it in the condition makes i and remaining meet halfway and
    // the loop gives up before it ever reaches the limit.
    const attempts = remaining + 2;
    for (let i = 0; i <= attempts; i++) {
      const res = await publicGet('/ranks', fullKey);
      if (res.status === 429) {
        limited = res;
        break;
      }
      expect(res.status).toBe(200);
      // the counter must fall as it is spent, or the headers are decoration
      expect(Number(res.headers['x-ratelimit-remaining'])).toBeLessThan(remaining + 1);
    }

    expect(limited, `never refused after ${limit} requests inside one window`).toBeTruthy();
    expect(limited!.body.error.code).toBe('RATE_LIMITED');
    // "429 with retry_after in the body, never a silent drop"
    const retryAfter =
      limited!.body.error.retry_after ??
      limited!.body.error.details?.retry_after ??
      limited!.body.retry_after;
    expect(typeof retryAfter, `no retry_after: ${JSON.stringify(limited!.body)}`).toBe('number');
    expect(retryAfter).toBeGreaterThan(0);
    // the headers are on the refusal too — a caller learns when to come back
    expect(limited!.headers['x-ratelimit-limit']).toMatch(/^\d+$/);
    expect(limited!.headers['x-ratelimit-remaining']).toBe('0');
    expect(limited!.headers['x-ratelimit-reset']).toMatch(/^\d+$/);
  }, 120_000);
});
