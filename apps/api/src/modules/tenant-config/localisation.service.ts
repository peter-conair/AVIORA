import { Injectable } from '@nestjs/common';
import { TenantDb } from '../../common/db/tenant-db.service';
import { AuditService } from '../../common/audit/audit.service';
import { tenantCurrency } from '../../common/money/currency';
import { DEFAULT_TIMEZONE } from '../../common/time/zone';
import type { LocalisationUpdate } from './localisation';

export interface LocalisationView {
  country: string;
  currency: string;
  timezone: string;
  defaultLocale: string;
  supportedLocales: string[];
  addressFormat: unknown;
  /** Where each value actually came from, so a reader can tell configured from inherited. */
  source: 'localisation' | 'tenant-defaults';
}

/**
 * TenantLocalisation is currency's HOME (docs/29 §2). It is not currency's only
 * possible source: `commerce.currency` keeps working, and the resolver in
 * common/money owns that precedence so nothing here re-decides it.
 */
@Injectable()
export class LocalisationService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
  ) {}

  get(): Promise<LocalisationView> {
    return this.db.tx(async (tx) => {
      const row = await tx.tenantLocalisation.findFirst({});
      const currency = await tenantCurrency(tx);
      if (row) {
        return {
          country: row.country.toUpperCase(),
          currency,
          timezone: row.timezone,
          defaultLocale: row.defaultLocale,
          supportedLocales: row.supportedLocales,
          addressFormat: row.addressFormat,
          source: 'localisation' as const,
        };
      }
      // No row yet: answer from the platform tenant record rather than 404.
      // A member asking "what language and money is this?" always has an answer.
      const tenant = await tx.tenant.findUnique({
        where: { id: this.db.tenantId },
        select: { country: true, timezone: true, defaultLanguage: true },
      });
      const defaultLocale = tenant?.defaultLanguage ?? 'th';
      return {
        country: (tenant?.country ?? 'TH').toUpperCase(),
        currency,
        timezone: tenant?.timezone ?? DEFAULT_TIMEZONE,
        defaultLocale,
        supportedLocales: [...new Set([defaultLocale, 'en'])],
        addressFormat: null,
        source: 'tenant-defaults' as const,
      };
    });
  }

  async update(input: LocalisationUpdate): Promise<LocalisationView> {
    const saved = await this.db.tx(async (tx) => {
      const existing = await tx.tenantLocalisation.findFirst({});
      const currency = input.currency ?? existing?.currency ?? (await tenantCurrency(tx));
      const data = {
        country: input.country,
        currency,
        timezone: input.timezone,
        defaultLocale: input.defaultLocale,
        supportedLocales: input.supportedLocales,
        // Structural only — the shape of an address label, not free markup.
        ...(input.addressFormat !== undefined
          ? { addressFormat: (input.addressFormat ?? undefined) as object | undefined }
          : {}),
      };
      const row = existing
        ? await tx.tenantLocalisation.update({ where: { id: existing.id }, data })
        : await tx.tenantLocalisation.create({ data: { tenantId: this.db.tenantId, ...data } });

      // The `commerce.currency` setting predates this table and anything still
      // reading it must not disagree with the tenant's stated currency. Two
      // sources that can drift are worse than one that is merely older, so the
      // older one is kept in step rather than left to rot.
      const setting = await tx.tenantSetting.findFirst({ where: { key: 'commerce.currency' } });
      if (setting) {
        await tx.tenantSetting.update({ where: { id: setting.id }, data: { value: currency } });
      } else {
        await tx.tenantSetting.create({
          data: { tenantId: this.db.tenantId, key: 'commerce.currency', value: currency },
        });
      }
      return row;
    });

    await this.audit.record({
      action: 'tenant.localisation.update',
      entityType: 'tenant_localisation',
      entityId: saved.id,
      after: {
        country: saved.country,
        currency: saved.currency,
        timezone: saved.timezone,
        defaultLocale: saved.defaultLocale,
      },
    });
    return this.get();
  }
}
