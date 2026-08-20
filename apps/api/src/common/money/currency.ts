import type { Tx } from '@aviora/db';

/**
 * The tenant's currency — ONE tenant, ONE currency, resolved in ONE place.
 *
 * It lives here rather than inside the commerce module because ranks quote
 * money thresholds too, and two modules resolving it separately is how they end
 * up disagreeing.
 *
 * Precedence (docs/29 §2). Currency's home is now `TenantLocalisation`, but the
 * `commerce.currency` setting KEEPS WORKING — a tenant configured before this
 * sprint must not silently start pricing in something else the day the row is
 * absent, so the setting is a fallback rather than a removal:
 *
 *   1. TenantLocalisation.currency  — the home
 *   2. tenantSetting `commerce.currency` — where it used to live
 *   3. DEFAULT_CURRENCY
 */
export const DEFAULT_CURRENCY = 'THB';

const CURRENCY_RE = /^[A-Z]{3}$/;

/** The delegates the resolver needs — narrow, so the health-free reader satisfies it too. */
export type CurrencyReader = Pick<Tx, 'tenantSetting' | 'tenantLocalisation'>;

/**
 * `tenantId` is only needed by callers holding a client that is NOT scoped to
 * one tenant — the platform dashboard reads across tenants through the owner
 * connection, where an unqualified findFirst would answer with someone else's
 * currency. Tenant-scoped callers pass a `Tx` and omit it, as RLS has already
 * bound the row set.
 */
export async function tenantCurrency(tx: CurrencyReader, tenantId?: string): Promise<string> {
  const localisation = await tx.tenantLocalisation.findFirst({
    where: tenantId ? { tenantId } : {},
    select: { currency: true },
  });
  if (localisation && CURRENCY_RE.test(localisation.currency)) return localisation.currency;

  const setting = await tx.tenantSetting.findFirst({
    where: { key: 'commerce.currency', ...(tenantId ? { tenantId } : {}) },
  });
  const value = setting?.value;
  return typeof value === 'string' && CURRENCY_RE.test(value) ? value : DEFAULT_CURRENCY;
}
