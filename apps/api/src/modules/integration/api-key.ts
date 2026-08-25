import * as crypto from 'node:crypto';
import { z } from 'zod';
import { PERMISSIONS } from '@aviora/shared';

/**
 * API keys (docs/30 §3). Pure helpers: minting, parsing and the scope
 * vocabulary. Storage and verification live in the service and the guard.
 */

/** `avk_<prefix>_<secret>` — the prefix is kept in clear so two keys in a list can be told apart. */
export const KEY_PREFIX_LABEL = 'avk';
/**
 * `avpk_<prefix>_<secret>` — a key that belongs to NO tenant (docs/74 §2).
 *
 * A DIFFERENT label, not a flag in a database somebody has to look up. These
 * two keys authenticate against different tables and reach different routes,
 * and an operator holding one should be able to tell which it is by looking at
 * it. The guard reads the label to decide where to look, so a tenant key can
 * never accidentally be resolved against the platform table.
 */
export const PLATFORM_KEY_PREFIX_LABEL = 'avpk';
const PREFIX_BYTES = 6; // 12 hex chars — enough to name a key, useless to hold one
const SECRET_BYTES = 32;

/** Which table a presented key belongs to. */
export type KeyKind = 'tenant' | 'platform';

export interface MintedKey {
  /** Shown ONCE. Never stored, never returned again from any route. */
  raw: string;
  prefix: string;
}

export function mintKey(kind: KeyKind = 'tenant'): MintedKey {
  const label = kind === 'platform' ? PLATFORM_KEY_PREFIX_LABEL : KEY_PREFIX_LABEL;
  const id = crypto.randomBytes(PREFIX_BYTES).toString('hex');
  const secret = crypto.randomBytes(SECRET_BYTES).toString('base64url');
  // The stored prefix INCLUDES the label, so it is a real prefix of the key an
  // operator is holding. A bare fragment that does not match the start of the
  // string is a fragment they have to decode before they can compare it.
  const prefix = `${label}_${id}`;
  return { raw: `${prefix}_${secret}`, prefix };
}

/**
 * The prefix a presented key claims, or null if it is not shaped like one of
 * ours. Matched with an anchored pattern rather than split on `_`: the secret
 * is base64url, whose alphabet INCLUDES the underscore, so splitting would
 * reject perfectly valid keys roughly half the time.
 *
 * The two labels are matched by SEPARATE anchored patterns rather than one
 * alternation, because `avk` is a prefix of nothing but `avpk` shares its
 * opening letters — a single loose pattern would be one edit away from reading
 * a platform key as a tenant key, which is the one mistake that matters here.
 */
const TENANT_KEY_RE = new RegExp(`^(${KEY_PREFIX_LABEL}_[0-9a-f]{12})_([A-Za-z0-9_-]{20,})$`);
const PLATFORM_KEY_RE = new RegExp(
  `^(${PLATFORM_KEY_PREFIX_LABEL}_[0-9a-f]{12})_([A-Za-z0-9_-]{20,})$`,
);

export interface PresentedKey {
  prefix: string;
  kind: KeyKind;
}

/** What a presented key claims to be, or null if it is not shaped like one of ours. */
export function parseKey(raw: string): PresentedKey | null {
  const platform = PLATFORM_KEY_RE.exec(raw)?.[1];
  if (platform) return { prefix: platform, kind: 'platform' };
  const tenant = TENANT_KEY_RE.exec(raw)?.[1];
  if (tenant) return { prefix: tenant, kind: 'tenant' };
  return null;
}

export function prefixOf(raw: string): string | null {
  return parseKey(raw)?.prefix ?? null;
}

/**
 * Scopes ARE permission keys (docs/30 §3). An API key is a second way to
 * AUTHENTICATE, never a second authorization model — so the vocabulary is the
 * platform's existing catalog and nothing else.
 */
export const SCOPE_VOCABULARY: ReadonlySet<string> = new Set<string>(Object.values(PERMISSIONS));

const scopeSchema = z
  .string()
  .max(80)
  .refine((s) => s !== '*' && !s.includes('*'), {
    message: 'Wildcard scopes are refused (docs/30 §7) — a key lists what it may do',
  })
  .refine(
    (s) => SCOPE_VOCABULARY.has(s),
    (s) => ({
      message: `'${s}' is not a permission this platform defines`,
    }),
  );

export const apiKeyCreateSchema = z
  .object({
    name: z.string().min(1).max(120),
    scopes: z.array(scopeSchema).min(1).max(40),
    /** Optional expiry. A key that never expires is a key nobody ever revisits. */
    expiresAt: z
      .string()
      .datetime({ offset: true })
      .optional()
      .refine((v) => v === undefined || new Date(v).getTime() > Date.now(), {
        message: 'expiresAt must be in the future',
      }),
  })
  .strict();

export type ApiKeyCreate = z.infer<typeof apiKeyCreateSchema>;

/** What an authenticated public-API caller is, once the key has been verified. */
export interface ApiKeyPrincipal {
  keyId: string;
  /** NULL for a platform key: it speaks for the platform, not for a tenant. */
  tenantId: string | null;
  kind: KeyKind;
  name: string;
  scopes: string[];
}

/** Request augmentation — the public controllers read this, never the raw header. */
export interface ApiKeyRequest {
  apiKey?: ApiKeyPrincipal;
}
