import type { Tx } from '@aviora/db';

/**
 * The tenant's currency, from the setting `commerce.currency`.
 *
 * It lives here rather than inside the commerce module because ranks quote
 * money thresholds too, and a tenant has ONE currency — two modules resolving
 * it separately is how they end up disagreeing.
 */
export const DEFAULT_CURRENCY = 'THB';

/**
 * `tenantId` is only needed by callers holding a client that is NOT scoped to
 * one tenant — the platform dashboard reads across tenants through the owner
 * connection, where an unqualified findFirst would answer with someone else's
 * currency. Tenant-scoped callers pass a `Tx` and omit it, as RLS has already
 * bound the row set. The parameter is the tenantSetting delegate alone, so the
 * health-free analytics reader satisfies it too.
 */
export async function tenantCurrency(
  tx: Pick<Tx, 'tenantSetting'>,
  tenantId?: string,
): Promise<string> {
  const setting = await tx.tenantSetting.findFirst({
    where: { key: 'commerce.currency', ...(tenantId ? { tenantId } : {}) },
  });
  const value = setting?.value;
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value) ? value : DEFAULT_CURRENCY;
}
