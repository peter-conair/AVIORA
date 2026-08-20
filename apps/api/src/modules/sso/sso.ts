import { z } from 'zod';

/**
 * Provider configuration as a tenant administrator supplies it (docs/31 §4).
 *
 * `kind` is a one-value enum rather than a free string. SAML is not missing by
 * oversight — a request for it is refused by name, which is the difference
 * between "we decided not to" and "nobody thought of it" (docs/31 §5).
 */
export const SSO_KINDS = ['oidc'] as const;

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
    { message: 'Must be an https URL' },
  );

/**
 * A domain, not a pattern. No wildcards: `*.example.com` would let a provider
 * assert an address at any subdomain somebody can register, and the point of
 * this list is that the set of assertable people is one an administrator can
 * read and recognise.
 */
const emailDomain = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/,
    'Must be a bare email domain such as example.com — no wildcards, no @',
  );

export const ssoUpsertSchema = z
  .object({
    kind: z.enum(SSO_KINDS).default('oidc'),
    issuer: z.string().min(1).max(512),
    discoveryUrl: httpsUrl,
    clientId: z.string().min(1).max(512),
    /**
     * Write-only. It is accepted here, sealed before it is stored, and there
     * is no route, method or response shape anywhere that returns it.
     * Omitting it on an update keeps the stored one.
     */
    clientSecret: z.string().min(1).max(1024).optional(),
    /**
     * At least one. An empty list is not "any domain" — it is a provider that
     * may assert nobody, and accepting it here would make the callback's
     * refusal look like a bug (docs/31 §1).
     */
    allowedDomains: z.array(emailDomain).min(1).max(50),
    jitProvisioning: z.boolean().default(false),
    status: z.enum(['active', 'disabled']).default('active'),
  })
  .strict();

export type SsoUpsert = z.infer<typeof ssoUpsertSchema>;

/**
 * A provider as every route returns it. There is no `clientSecret` field and
 * no `clientSecretEncrypted` field: a shape that carried either would be a shape
 * inviting code that renders one.
 */
export interface SsoProviderView {
  kind: string;
  issuer: string;
  discoveryUrl: string;
  clientId: string;
  /** Whether a secret is stored — never what it is. */
  hasClientSecret: boolean;
  allowedDomains: string[];
  jitProvisioning: boolean;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}
