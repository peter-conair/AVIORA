import type { Tx } from '@aviora/db';
import { DEFAULT_TIMEZONE, isValidTimeZone } from './zone';

/**
 * The tenant's timezone — resolved in ONE place, for the same reason currency
 * is (docs/29 §2). "This month" must mean the same month to the analytics
 * dashboard, a report and anything else that cuts a day boundary.
 *
 * Precedence:
 *   1. TenantLocalisation.timezone — the home
 *   2. Tenant.timezone             — the platform record, set at provisioning
 *   3. DEFAULT_TIMEZONE
 *
 * A stored value that ICU does not recognise is treated as absent rather than
 * thrown: a dashboard that 500s because somebody typed "GMT+7" into a settings
 * field is worse than one that falls back and says which zone it used.
 */
export type ZoneReader = Pick<Tx, 'tenantLocalisation' | 'tenant'>;

export async function tenantTimezone(tx: ZoneReader, tenantId: string): Promise<string> {
  const localisation = await tx.tenantLocalisation.findFirst({
    where: { tenantId },
    select: { timezone: true },
  });
  if (localisation?.timezone && isValidTimeZone(localisation.timezone))
    return localisation.timezone;

  const tenant = await tx.tenant.findUnique({
    where: { id: tenantId },
    select: { timezone: true },
  });
  if (tenant?.timezone && isValidTimeZone(tenant.timezone)) return tenant.timezone;

  return DEFAULT_TIMEZONE;
}

/** The tenant's country, on the same precedence. Used by tax and availability. */
export async function tenantCountry(tx: ZoneReader, tenantId: string): Promise<string> {
  const localisation = await tx.tenantLocalisation.findFirst({
    where: { tenantId },
    select: { country: true },
  });
  if (localisation?.country) return localisation.country.toUpperCase();

  const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { country: true } });
  return (tenant?.country ?? 'TH').toUpperCase();
}
