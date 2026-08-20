import { ConflictException } from '@nestjs/common';
import { ERROR_CODES } from '@aviora/shared';

/**
 * Product availability by country (docs/29 §5).
 *
 * `availableCountries` EMPTY means EVERYWHERE. The common case — a tenant
 * selling wherever it operates — must not require enumerating the world, and a
 * default that fails closed would make every existing offering unbuyable the
 * day this shipped.
 */
export interface AvailabilityLike {
  name: string;
  availableCountries: string[];
}

export function isAvailableIn(offering: AvailabilityLike, country: string): boolean {
  if (offering.availableCountries.length === 0) return true;
  return offering.availableCountries.some((c) => c.toUpperCase() === country.toUpperCase());
}

/**
 * Checkout refuses an offering the tenant's country excludes, NAMING the
 * offering and the reason. "Checkout failed" sends somebody to support; "Retreat
 * Seat is not available in TH" tells them what to do about it.
 */
export function assertAvailable(offerings: readonly AvailabilityLike[], country: string): void {
  const blocked = offerings.filter((o) => !isAvailableIn(o, country));
  if (blocked.length === 0) return;
  throw new ConflictException({
    code: ERROR_CODES.CONFLICT,
    message: `Not available in ${country}: ${blocked.map((o) => o.name).join(', ')}`,
    details: {
      country,
      unavailable: blocked.map((o) => ({
        name: o.name,
        availableCountries: o.availableCountries,
        reason: `This offering is sold only in ${o.availableCountries.join(', ')} and this tenant operates in ${country}.`,
      })),
    },
  });
}
