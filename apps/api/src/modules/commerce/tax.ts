/**
 * Tax is a rate, and says so (docs/29 §4).
 *
 * WHAT THIS IS: one configured rate, chosen by the most specific match on
 * (country, region), applied once at checkout and STORED on the order.
 *
 * WHAT THIS IS NOT — and the response says this out loud, because a field
 * labelled "tax" that quietly gets it wrong is worse than one that admits it is
 * a single rate: no nexus rules, no per-product categories, no exemption
 * certificates, no VAT registration validation, no reverse charge, no filing,
 * reporting or remittance.
 */
export const TAX_DISCLOSURE =
  'This is a single configured rate for the tenant country and region, not a tax engine: no nexus rules, no per-product categories, no exemption certificates, no VAT registration validation, no reverse charge, and no filing, reporting or remittance.';

export interface TaxRuleLike {
  country: string;
  region: string | null;
  rateBasisPoints: number;
  inclusive: boolean;
  label: string;
}

export interface ResolvedTax {
  rule: TaxRuleLike | null;
  /** Basis points: 700 = 7%. Integers only, like every other rate here. */
  rateBasisPoints: number;
  label: string | null;
  inclusive: boolean;
  taxMinor: number;
  /** What the order is charged: base + tax when exclusive, base when inclusive. */
  totalMinor: number;
  disclosure: string;
}

/**
 * ONE rule, most specific first: an exact (country, region) match beats a
 * country-wide rule, and nothing else is consulted. Two rules never combine —
 * stacking is where a "simple rate" quietly becomes a tax engine.
 */
export function resolveTaxRule(
  rules: readonly TaxRuleLike[],
  country: string,
  region?: string | null,
): TaxRuleLike | null {
  const inCountry = rules.filter((r) => r.country.toUpperCase() === country.toUpperCase());
  if (region) {
    const exact = inCountry.find(
      (r) => r.region !== null && r.region.toLowerCase() === region.toLowerCase(),
    );
    if (exact) return exact;
  }
  return inCountry.find((r) => r.region === null) ?? null;
}

/**
 * Tax on a base amount in minor units. Integer arithmetic end to end, with
 * exactly ONE `Math.round` on each path — rounding twice is how a total stops
 * matching the sum of its parts.
 *
 * Exclusive: tax = base × bp / 10000, and the customer pays base + tax.
 * Inclusive: the base ALREADY contains the tax, so the tax contained in it is
 * base × bp / (10000 + bp), and the customer pays base.
 */
export function computeTax(baseMinor: number, rule: TaxRuleLike | null): ResolvedTax {
  if (!rule || rule.rateBasisPoints === 0) {
    return {
      rule,
      rateBasisPoints: rule?.rateBasisPoints ?? 0,
      label: rule?.label ?? null,
      inclusive: rule?.inclusive ?? false,
      taxMinor: 0,
      totalMinor: baseMinor,
      disclosure: TAX_DISCLOSURE,
    };
  }
  const bp = rule.rateBasisPoints;
  const taxMinor = rule.inclusive
    ? Math.round((baseMinor * bp) / (10_000 + bp))
    : Math.round((baseMinor * bp) / 10_000);
  return {
    rule,
    rateBasisPoints: bp,
    label: rule.label,
    inclusive: rule.inclusive,
    taxMinor,
    totalMinor: rule.inclusive ? baseMinor : baseMinor + taxMinor,
    disclosure: TAX_DISCLOSURE,
  };
}

/**
 * What an order CARRIES. Read back from the order, never recomputed: an order
 * carries what it was charged, and a rate change next month must not rewrite
 * last month's receipt.
 */
export function taxOnOrder(order: {
  taxMinor: number;
  taxLabel: string | null;
  taxRateBasisPoints: number | null;
}) {
  return {
    amountMinor: order.taxMinor,
    label: order.taxLabel,
    rateBasisPoints: order.taxRateBasisPoints,
    disclosure: TAX_DISCLOSURE,
    note: 'Stored at checkout and never recomputed — this is what the order was charged.',
  };
}
