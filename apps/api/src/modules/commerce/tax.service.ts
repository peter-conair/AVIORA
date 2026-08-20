import { Injectable } from '@nestjs/common';
import { TenantDb } from '../../common/db/tenant-db.service';
import { AuditService } from '../../common/audit/audit.service';
import { tenantCountry } from '../../common/time/tenant-zone';
import { TAX_DISCLOSURE, resolveTaxRule } from './tax';

export interface UpsertTaxRuleInput {
  country: string;
  region?: string | null;
  rateBasisPoints: number;
  inclusive: boolean;
  label: string;
}

/** Tax rules as configuration (docs/29 §4). One rule resolves; none stack. */
@Injectable()
export class TaxService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
  ) {}

  list() {
    return this.db.tx(async (tx) => {
      const rules = await tx.taxRule.findMany({
        orderBy: [{ country: 'asc' }, { region: 'asc' }],
      });
      const country = await tenantCountry(tx, this.db.tenantId);
      return {
        rules,
        tenantCountry: country,
        // Which rule an order with no region would resolve, so an admin can see
        // the answer rather than infer it from a list.
        wouldResolve: resolveTaxRule(rules, country) ?? null,
        disclosure: TAX_DISCLOSURE,
      };
    });
  }

  /** Upsert by (country, region) — the unique key the schema already enforces. */
  async upsert(input: UpsertTaxRuleInput) {
    const country = input.country.toUpperCase();
    const region = input.region?.trim() ? input.region.trim() : null;
    const rule = await this.db.tx(async (tx) => {
      const existing = await tx.taxRule.findFirst({ where: { country, region } });
      const data = {
        rateBasisPoints: input.rateBasisPoints,
        inclusive: input.inclusive,
        label: input.label,
      };
      return existing
        ? tx.taxRule.update({ where: { id: existing.id }, data })
        : tx.taxRule.create({ data: { tenantId: this.db.tenantId, country, region, ...data } });
    });

    await this.audit.record({
      action: 'commerce.tax.upsert',
      entityType: 'tax_rule',
      entityId: rule.id,
      after: {
        country: rule.country,
        region: rule.region,
        rateBasisPoints: rule.rateBasisPoints,
        inclusive: rule.inclusive,
      },
    });
    return { rule, disclosure: TAX_DISCLOSURE };
  }
}
