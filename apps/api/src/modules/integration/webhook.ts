import * as crypto from 'node:crypto';
import { z } from 'zod';
import { EVENTS, type DomainEventEnvelope, type EventName } from '@aviora/shared';

/**
 * Webhook wire format and signing (docs/30 §2). Pure functions only — nothing
 * here touches the database or the network, so the signature is testable
 * without a server and the deny-list is readable without a schema.
 */

export const WEBHOOK_HEADERS = {
  event: 'X-Aviora-Event',
  delivery: 'X-Aviora-Delivery',
  timestamp: 'X-Aviora-Timestamp',
  signature: 'X-Aviora-Signature',
} as const;

/** 5 attempts, then `failed` and it stays in the log (docs/30 §1). */
export const MAX_DELIVERY_ATTEMPTS = 5;

/**
 * Events that must NEVER be forwarded to a tenant's server (docs/30 §7).
 *
 * The catalog is already health-free by design — `HabitLogged` carries the
 * habit and the day, never a value — but "by design" is a property of today's
 * payloads, and a payload is one commit away from growing a field. This list
 * is the structural assertion: a denied event is dropped with a logged reason
 * at record time AND again at send time, and an endpoint cannot even subscribe
 * to one. A subscription is not a consent, and the tenant's own server is
 * still another person (docs/28 §2).
 */
export const HEALTH_DENIED_EVENTS: ReadonlySet<string> = new Set<string>([EVENTS.HabitLogged]);

export const KNOWN_EVENTS: ReadonlySet<string> = new Set<string>(Object.values(EVENTS));

/** Event names an endpoint may legally subscribe to. */
export const SUBSCRIBABLE_EVENTS: readonly string[] = Object.values(EVENTS)
  .filter((name) => !HEALTH_DENIED_EVENTS.has(name))
  .sort();

/**
 * The body of a webhook: the event envelope and nothing more (docs/30 §2).
 * Snake_case on the wire because this is somebody else's integration, not our
 * internal object.
 */
export interface WebhookBody {
  id: string;
  name: string;
  tenant: string | null;
  aggregate: { type: string; id: string };
  payload: unknown;
  occurred_at: string;
}

export function webhookBody(event: DomainEventEnvelope): WebhookBody {
  return {
    id: event.eventId,
    name: event.eventName,
    tenant: event.tenantId,
    aggregate: { type: event.aggregateType, id: event.aggregateId },
    payload: event.payload,
    occurred_at: event.occurredAt,
  };
}

/**
 * `sha256=<hex HMAC of "timestamp.body" with the endpoint secret>` (docs/30 §2).
 *
 * The timestamp is INSIDE the signed string, so a request captured today
 * cannot be replayed tomorrow against a receiver that checks how old it is.
 * A signature over the body alone would be a signature that never expires.
 */
export function signWebhook(secret: string, timestampSeconds: number, body: string): string {
  const mac = crypto
    .createHmac('sha256', secret)
    .update(`${timestampSeconds}.${body}`)
    .digest('hex');
  return `sha256=${mac}`;
}

/** sha256 hex — the same one-way store the refresh-token table uses. */
export function sha256Hex(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Constant-time string comparison. Comparing a presented credential with `===`
 * leaks its prefix through timing; every verification in this module goes
 * through here instead.
 */
export function timingSafeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on unequal lengths, which would itself be a signal.
  // Hash both to a fixed width first: the comparison stays constant-time and
  // the length difference stops being observable.
  const l = crypto.createHash('sha256').update(left).digest();
  const r = crypto.createHash('sha256').update(right).digest();
  return crypto.timingSafeEqual(l, r);
}

const SECRET_DOMAIN = 'aviora.webhook.secret.v1';

/**
 * The root key webhook secrets are derived from.
 *
 * DECISION (docs/30 §2 leaves this open). §2 says the platform signs with the
 * endpoint secret, and the schema says the column holds a HASH — both cannot
 * be true of the same stored bytes, because HMAC needs the key back and a hash
 * does not give it back. The resolution: the database stores only
 * `sha256(secret)`, and the secret itself is DERIVED at send time from an
 * environment key that never enters the database. A database dump therefore
 * yields no secret, which is the property the contract is protecting, and the
 * signature is computed with the real endpoint secret exactly as §2 specifies.
 *
 * The fallback to the JWT access secret keeps this working with no new
 * configuration. It is domain-separated by the label above, so the derived
 * value cannot collide with anything else that key signs — but a deployment
 * that rotates its JWT secret would invalidate every webhook signature, so
 * production should set AVIORA_WEBHOOK_SIGNING_KEY explicitly.
 */
function rootKey(): string {
  const key = process.env.AVIORA_WEBHOOK_SIGNING_KEY ?? process.env.AVIORA_JWT_ACCESS_SECRET;
  if (!key) {
    throw new Error(
      'AVIORA_WEBHOOK_SIGNING_KEY (or AVIORA_JWT_ACCESS_SECRET) is not configured; ' +
        'refusing to mint or sign a webhook secret',
    );
  }
  return key;
}

/** The endpoint's secret. Shown once at creation, recomputed to sign, never stored. */
export function deriveEndpointSecret(endpointId: string): string {
  const mac = crypto
    .createHmac('sha256', rootKey())
    .update(`${SECRET_DOMAIN}:${endpointId}`)
    .digest('base64url');
  return `whsec_${mac}`;
}

export const eventNameSchema = z
  .string()
  .max(80)
  .refine(
    (name) => KNOWN_EVENTS.has(name),
    (name) => ({
      message: `'${name}' is not an event this platform emits`,
    }),
  )
  .refine(
    (name) => !HEALTH_DENIED_EVENTS.has(name),
    (name) => ({
      message: `'${name}' carries health context and is never forwarded to a webhook (docs/30 §7)`,
    }),
  );

const httpsUrl = z
  .string()
  .max(2048)
  .refine(
    (value) => {
      try {
        return new URL(value).protocol === 'https:';
      } catch {
        return false;
      }
    },
    { message: 'A webhook URL must be https — a signed payload must not travel in the clear' },
  );

export const endpointCreateSchema = z
  .object({
    url: httpsUrl,
    // No wildcard and no "all events" shortcut (docs/30 §7): a subscription
    // that silently grows when a new event ships is one nobody agreed to.
    events: z.array(eventNameSchema).min(1).max(60),
    description: z.string().max(300).optional(),
  })
  .strict();

/**
 * Endpoint lifecycle. `active` is the only status that receives anything;
 * `paused` and `disabled` are the two words people reach for when they mean
 * "stop, but do not delete", and refusing one of them on a spelling grounds
 * would teach nobody anything. Everything that is not `active` is silence.
 */
export const ENDPOINT_STATUSES = ['active', 'paused', 'disabled'] as const;

export const endpointUpdateSchema = z
  .object({
    events: z.array(eventNameSchema).min(1).max(60).optional(),
    status: z.enum(ENDPOINT_STATUSES).optional(),
    description: z.string().max(300).nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'No endpoint fields to update' });

export type EndpointCreate = z.infer<typeof endpointCreateSchema>;
export type EndpointUpdate = z.infer<typeof endpointUpdateSchema>;

export function isSubscribable(name: string): name is EventName {
  return KNOWN_EVENTS.has(name) && !HEALTH_DENIED_EVENTS.has(name);
}
