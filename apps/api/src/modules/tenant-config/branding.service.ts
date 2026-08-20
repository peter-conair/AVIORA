import { Injectable, NotFoundException } from '@nestjs/common';
import { ERROR_CODES } from '@aviora/shared';
import { PrismaService } from '../../common/db/prisma.service';
import { TenantDb } from '../../common/db/tenant-db.service';
import { AuditService } from '../../common/audit/audit.service';
import { HIDDEN_FEATURES_ARE_NAVIGATION_ONLY, type BrandingUpdate } from './branding';

export interface BrandingView {
  appName: string;
  logoUrl: string | null;
  colors: Record<string, string>;
  fontFamily: string | null;
  landing: unknown;
  hiddenFeatures: string[];
  /**
   * Stated in the payload, not only in a comment, so the client that reads
   * `hiddenFeatures` is told what it is: a navigation hint. The routes behind a
   * hidden feature still answer — permissions and entitlements are the refusal.
   */
  hiddenFeaturesNote: string;
}

/**
 * Branding is presentation, and never a permission (docs/29 §1).
 *
 * NOTHING in this service is consulted by a guard. `hiddenFeatures` is returned
 * to the client so a menu can omit an item; a hidden feature's routes answer
 * exactly as they did before. Enforcing it here would let a tenant "secure" a
 * feature by editing a menu, and the first person to type the URL would find it.
 */
@Injectable()
export class BrandingService {
  constructor(
    private readonly db: TenantDb,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * What a browser needs to paint the tenant. PUBLIC and resolved by host, so
   * it reads through the owner connection with an explicit tenant id: there is
   * no authenticated caller to bind RLS to, and the row is not secret — it is
   * the login page's own logo.
   */
  async publicBranding(tenantId: string | null): Promise<BrandingView> {
    if (!tenantId) {
      throw new NotFoundException({
        code: ERROR_CODES.TENANT_NOT_RESOLVED,
        message: 'No tenant resolves from this host',
      });
    }
    const tenant = await this.prisma.owner.tenant.findFirst({
      where: { id: tenantId, status: 'active' },
      select: { name: true, logoUrl: true },
    });
    if (!tenant) {
      throw new NotFoundException({
        code: ERROR_CODES.NOT_FOUND,
        message: 'Tenant not found',
      });
    }
    const branding = await this.prisma.owner.tenantBranding.findUnique({ where: { tenantId } });
    return view(branding, tenant.name, tenant.logoUrl);
  }

  /** The admin read — same shape, through the tenant-scoped connection. */
  async get(): Promise<BrandingView> {
    return this.db.tx(async (tx) => {
      const branding = await tx.tenantBranding.findFirst({});
      const tenant = await tx.tenant.findUnique({
        where: { id: this.db.tenantId },
        select: { name: true, logoUrl: true },
      });
      return view(branding, tenant?.name ?? 'AVIORA', tenant?.logoUrl ?? null);
    });
  }

  /** Upsert. Every value has already been validated as data, never as markup. */
  async update(input: BrandingUpdate): Promise<BrandingView> {
    const result = await this.db.tx(async (tx) => {
      const existing = await tx.tenantBranding.findFirst({});
      const data = {
        ...(input.appName !== undefined ? { appName: input.appName } : {}),
        ...(input.logoUrl !== undefined ? { logoUrl: input.logoUrl } : {}),
        ...(input.colors !== undefined ? { colors: input.colors ?? undefined } : {}),
        ...(input.fontFamily !== undefined ? { fontFamily: input.fontFamily } : {}),
        ...(input.landing !== undefined ? { landing: input.landing ?? undefined } : {}),
        ...(input.emailFromName !== undefined ? { emailFromName: input.emailFromName } : {}),
        ...(input.emailFooter !== undefined ? { emailFooter: input.emailFooter } : {}),
        ...(input.hiddenFeatures !== undefined ? { hiddenFeatures: input.hiddenFeatures } : {}),
      };
      const saved = existing
        ? await tx.tenantBranding.update({ where: { id: existing.id }, data })
        : await tx.tenantBranding.create({ data: { tenantId: this.db.tenantId, ...data } });
      const tenant = await tx.tenant.findUnique({
        where: { id: this.db.tenantId },
        select: { name: true, logoUrl: true },
      });
      return { saved, before: existing, tenant };
    });

    await this.audit.record({
      action: 'tenant.branding.update',
      entityType: 'tenant_branding',
      entityId: result.saved.id,
      before: result.before
        ? { appName: result.before.appName, hiddenFeatures: result.before.hiddenFeatures }
        : null,
      after: { appName: result.saved.appName, hiddenFeatures: result.saved.hiddenFeatures },
    });
    return view(result.saved, result.tenant?.name ?? 'AVIORA', result.tenant?.logoUrl ?? null);
  }
}

interface BrandingRow {
  appName: string | null;
  logoUrl: string | null;
  colors: unknown;
  fontFamily: string | null;
  landing: unknown;
  hiddenFeatures: string[];
}

function view(
  branding: BrandingRow | null,
  tenantName: string,
  tenantLogoUrl: string | null,
): BrandingView {
  return {
    appName: branding?.appName ?? tenantName,
    logoUrl: branding?.logoUrl ?? tenantLogoUrl,
    colors: isColorRecord(branding?.colors) ? branding.colors : {},
    fontFamily: branding?.fontFamily ?? null,
    landing: branding?.landing ?? null,
    hiddenFeatures: branding?.hiddenFeatures ?? [],
    hiddenFeaturesNote: HIDDEN_FEATURES_ARE_NAVIGATION_ONLY,
  };
}

function isColorRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value as Record<string, unknown>).every((v) => typeof v === 'string')
  );
}
