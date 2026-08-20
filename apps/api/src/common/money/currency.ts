import type { Tx } from '@aviora/db';

/**
 * The tenant's currency, from the setting `commerce.currency`.
 *
 * It lives here rather than inside the commerce module because ranks quote
 * money thresholds too, and a tenant has ONE currency — two modules resolving
 * it separately is how they end up disagreeing.
 */
export const DEFAULT_CURRENCY = 'THB';

export async function tenantCurrency(tx: Tx): Promise<string> {
  const setting = await tx.tenantSetting.findFirst({ where: { key: 'commerce.currency' } });
  const value = setting?.value;
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value) ? value : DEFAULT_CURRENCY;
}
