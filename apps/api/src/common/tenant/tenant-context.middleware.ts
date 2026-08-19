import { BadRequestException, Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { ERROR_CODES } from '@aviora/shared';
import { PrismaService } from '../db/prisma.service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Hosts whose subdomain is NOT a tenant slug. */
const RESERVED_SUBDOMAINS = new Set(['www', 'admin', 'api', 'app', 'platform']);

export const CLS_TENANT_ID = 'tenantId';
export const CLS_TENANT_SOURCE = 'tenantSource';

/**
 * Resolves TenantContext for every request (docs/03 §3).
 * Precedence: subdomain / custom domain → X-Tenant-ID header (internal).
 * If two sources resolve to DIFFERENT tenants → 400 TENANT_MISMATCH (never widen).
 * JWT-claim resolution is layered on in Sprint 1 with authentication.
 */
@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  constructor(
    private readonly cls: ClsService,
    private readonly prisma: PrismaService,
  ) {}

  async use(req: Request, _res: Response, next: NextFunction) {
    const fromHost = await this.resolveFromHost(req.hostname);
    const fromHeader = this.resolveFromHeader(req.header('x-tenant-id'));

    if (fromHost && fromHeader && fromHost !== fromHeader) {
      throw new BadRequestException({
        code: ERROR_CODES.TENANT_MISMATCH,
        message: 'Tenant resolved from host and X-Tenant-ID header do not match',
      });
    }

    const tenantId = fromHost ?? fromHeader ?? null;
    this.cls.set(CLS_TENANT_ID, tenantId);
    this.cls.set(CLS_TENANT_SOURCE, fromHost ? 'subdomain' : fromHeader ? 'header' : 'platform');
    next();
  }

  private resolveFromHeader(raw: string | undefined): string | null {
    if (!raw) return null;
    if (!UUID_RE.test(raw)) {
      throw new BadRequestException({
        code: ERROR_CODES.TENANT_NOT_RESOLVED,
        message: 'X-Tenant-ID must be a uuid',
      });
    }
    return raw.toLowerCase();
  }

  private async resolveFromHost(hostname: string): Promise<string | null> {
    if (!hostname || hostname === 'localhost' || hostname === '127.0.0.1') return null;

    const parts = hostname.split('.');
    // {slug}.localhost or {slug}.aviora.local style dev hosts, or {slug}.<platform-domain>
    const sub = parts.length >= 2 ? parts[0] : null;
    if (sub && !RESERVED_SUBDOMAINS.has(sub)) {
      const bySlug = await this.prisma.app.tenant.findUnique({
        where: { slug: sub },
        select: { id: true },
      });
      if (bySlug) return bySlug.id;
    }
    // full custom domain
    const byDomain = await this.prisma.app.tenant.findFirst({
      where: { OR: [{ customDomain: hostname }, { primaryDomain: hostname }] },
      select: { id: true },
    });
    return byDomain?.id ?? null;
  }
}
