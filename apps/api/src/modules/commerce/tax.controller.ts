import { Body, Controller, Get, Put } from '@nestjs/common';
import { z } from 'zod';
import { PERMISSIONS } from '@aviora/shared';
import { RequirePermissions } from '../../common/auth/decorators';
import { ZodPipe } from '../../common/validation/zod.pipe';
import { TaxService } from './tax.service';

const upsertSchema = z.object({
  country: z
    .string()
    .regex(/^[A-Za-z]{2}$/, 'Country is an ISO-3166-1 alpha-2 code')
    .transform((v) => v.toUpperCase()),
  /** Null (or omitted) is the country-wide rule; a value is the more specific one. */
  region: z.string().min(1).max(80).nullable().optional(),
  // 0–10000 mirrors the CHECK constraint on the table: a rate is a rate, so no
  // negatives and nothing above 100%.
  rateBasisPoints: z.number().int().min(0).max(10_000),
  inclusive: z.boolean().default(false),
  label: z.string().min(1).max(80),
});

/**
 * Tax rules (docs/29 §4). Catalogue permission, not a settings one: the rate is
 * part of what a thing costs, and whoever prices the catalogue prices this.
 */
@Controller('tax')
export class TaxController {
  constructor(private readonly tax: TaxService) {}

  @Get('rules')
  @RequirePermissions(PERMISSIONS.COMMERCE_CATALOG_MANAGE)
  async list() {
    return await this.tax.list();
  }

  @Put('rules')
  @RequirePermissions(PERMISSIONS.COMMERCE_CATALOG_MANAGE)
  async upsert(@Body(new ZodPipe(upsertSchema)) body: z.infer<typeof upsertSchema>) {
    return await this.tax.upsert(body);
  }
}
