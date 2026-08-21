import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { TenantDb } from '../../common/db/tenant-db.service';
import { CLS_MEMBER_ID } from '../../common/auth/permissions.guard';
import { OfferingService } from './offering.service';

/**
 * The multi-brand marketplace (docs/44).
 *
 * It is deliberately thin. Browsing is the catalogue the tenant already has,
 * grouped by the brand each offering's product belongs to — a second listing
 * with its own pricing or availability rules would be a second answer to "what
 * does this cost and can I buy it", and the two would disagree the first time
 * one of them changed.
 *
 * What this file adds is the FACETS and the filter, plus the one rule that
 * makes it a brand-neutral marketplace rather than a shop window: brand is
 * never a ranking signal (docs/44 §2).
 */
export interface BrandFacet {
  id: string | null;
  name: string;
  count: number;
}

/** Offerings that link to no product have no brand, and say so rather than hiding. */
const UNBRANDED = 'Unbranded';

@Injectable()
export class MarketplaceService {
  constructor(
    private readonly db: TenantDb,
    private readonly cls: ClsService,
    private readonly offerings: OfferingService,
  ) {}

  async browse(filter: { brandId?: string; q?: string }) {
    // The member's own view of the catalogue: active, available in their
    // country, priced for their plan. `includeUnavailable` is never true here —
    // a marketplace that shows something unbuyable wastes people's time.
    const catalogue = await this.offerings.list(this.memberId(), false);
    const brands = await this.brandsFor(catalogue.map((o) => o.productId));

    const withBrand = catalogue.map((o) => ({
      ...o,
      brand: o.productId ? (brands.get(o.productId) ?? null) : null,
    }));

    const term = filter.q?.trim().toLowerCase();
    const matched = withBrand.filter((o) => {
      if (filter.brandId && o.brand?.id !== filter.brandId) return false;
      if (!term) return true;
      return (
        o.name.toLowerCase().includes(term) || (o.description ?? '').toLowerCase().includes(term)
      );
    });

    return {
      // Sorted by the offering's OWN attributes. Brand does not appear in this
      // comparison and must never appear in it: a marketplace is exactly where
      // a brand-neutral platform quietly stops being one, through a field
      // nobody argued about (spec §31, §33, docs/44 §2).
      offerings: [...matched].sort((a, b) => a.name.localeCompare(b.name)),
      brands: this.facets(withBrand),
      sort: 'name',
      appliedFilters: {
        brandId: filter.brandId ?? null,
        q: filter.q ?? null,
      },
      note:
        'Ordering never considers brand (spec §31). Brands are a filter and a ' +
        'count, and there is no field on a brand that could buy position.',
    };
  }

  /** The facets alone, for a filter UI that does not need the rows yet. */
  async brands(): Promise<BrandFacet[]> {
    const catalogue = await this.offerings.list(this.memberId(), false);
    const brands = await this.brandsFor(catalogue.map((o) => o.productId));
    return this.facets(
      catalogue.map((o) => ({
        ...o,
        brand: o.productId ? (brands.get(o.productId) ?? null) : null,
      })),
    );
  }

  /**
   * Products are read in the tenant's transaction, so row-level security shows
   * global knowledge products (tenant_id NULL) and this tenant's own, and
   * nothing else. The offering→product link is soft — there is no foreign key —
   * because an offering may live in a tenant's OWN database while the product
   * it names is platform knowledge, and a foreign key cannot cross that seam
   * (docs/31).
   */
  private async brandsFor(
    productIds: Array<string | null>,
  ): Promise<Map<string, { id: string; name: string }>> {
    const ids = [...new Set(productIds.filter((id): id is string => id !== null))];
    if (ids.length === 0) return new Map();
    return this.db.tx(async (tx) => {
      const products = await tx.product.findMany({
        where: { id: { in: ids } },
        select: { id: true, brand: { select: { id: true, name: true } } },
      });
      return new Map(products.map((p) => [p.id, { id: p.brand.id, name: p.brand.name }]));
    });
  }

  private facets(rows: Array<{ brand: { id: string; name: string } | null }>): BrandFacet[] {
    const counts = new Map<string, BrandFacet>();
    for (const row of rows) {
      const key = row.brand?.id ?? '';
      const existing = counts.get(key);
      if (existing) existing.count += 1;
      else
        counts.set(key, {
          id: row.brand?.id ?? null,
          name: row.brand?.name ?? UNBRANDED,
          count: 1,
        });
    }
    // Alphabetical, not by count: ordering facets by popularity is ordering
    // brands by prominence, which is the same rule broken in a smaller place.
    return [...counts.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The same source the catalogue reads, so membership pricing cannot differ. */
  private memberId(): string | null {
    return (this.cls.get(CLS_MEMBER_ID) as string | undefined) ?? null;
  }
}
