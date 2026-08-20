import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';
import { ERROR_CODES } from '@aviora/shared';
import { PrismaService } from '../../common/db/prisma.service';
import { CLS_TENANT_ID, CLS_TENANT_SOURCE } from '../../common/tenant/tenant-context.middleware';
import { prefixOf, type ApiKeyPrincipal, type ApiKeyRequest } from './api-key';
import { sha256Hex, timingSafeEquals } from './webhook';

export const REQUIRED_SCOPES = 'requiredApiKeyScopes';
/**
 * Scopes a public-API route needs. They are PERMISSION KEYS — the same
 * vocabulary the tenant permission model already uses. An API key is a second
 * way to authenticate, never a second authorization model, so this decorator
 * names an existing permission rather than inventing a parallel one.
 */
export const RequireScopes = (...scopes: string[]) => SetMetadata(REQUIRED_SCOPES, scopes);

/** Stands in for a real hash when no key matched, so both paths do the same work. */
const NO_SUCH_HASH = '0'.repeat(64);

/** Only revisit `last_used_at` occasionally — an operator needs the day, not the millisecond. */
const LAST_USED_THROTTLE_MS = 60_000;

/**
 * `Authorization: Bearer <key>` on `/public/*` (docs/30 §3).
 *
 * The key names its own tenant, so this guard is also where tenant context
 * comes from for the public surface. If the host already resolved a DIFFERENT
 * tenant, the request is refused rather than widened — the same rule
 * TenantContextMiddleware applies when two sources disagree.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly cls: ClsService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & ApiKeyRequest>();
    const principal = await this.authenticate(req);

    const required =
      this.reflector.getAllAndOverride<string[]>(REQUIRED_SCOPES, [
        ctx.getHandler(),
        ctx.getClass(),
      ]) ?? [];
    const held = new Set(principal.scopes);
    const missing = required.filter((scope) => !held.has(scope));
    if (missing.length > 0) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'This API key does not carry the scope this endpoint requires',
        details: { required: missing },
      });
    }

    req.apiKey = principal;
    return true;
  }

  private async authenticate(req: Request & ApiKeyRequest): Promise<ApiKeyPrincipal> {
    const header = req.header('authorization');
    const raw = header?.startsWith('Bearer ') ? header.slice(7).trim() : null;
    const prefix = raw ? prefixOf(raw) : null;
    if (!raw || !prefix) throw this.unauthenticated();

    // The prefix is unique per tenant, so a lookup by prefix alone can in
    // principle return more than one row; the hash comparison is what decides.
    const candidates = await this.prisma.owner.apiKey.findMany({ where: { prefix } });
    const presented = sha256Hex(raw);
    const match = candidates.find((row) => timingSafeEquals(row.hash, presented));
    if (!match) {
      // Compare against a constant anyway, so an unknown prefix costs the same
      // as a wrong secret and the error cannot be timed apart.
      timingSafeEquals(NO_SUCH_HASH, presented);
      throw this.unauthenticated();
    }

    const now = new Date();
    if (match.revokedAt) throw this.unauthenticated('This API key has been revoked');
    if (match.expiresAt && match.expiresAt <= now) {
      throw this.unauthenticated('This API key has expired');
    }

    this.bindTenant(match.tenantId);
    this.touch(match.id, match.lastUsedAt);

    return {
      keyId: match.id,
      tenantId: match.tenantId,
      name: match.name,
      scopes: match.scopes,
    };
  }

  /** A key is bound to one tenant; two sources that disagree are never widened. */
  private bindTenant(tenantId: string): void {
    const resolved = this.cls.get(CLS_TENANT_ID) as string | undefined;
    if (resolved && resolved !== tenantId) {
      throw new BadRequestException({
        code: ERROR_CODES.TENANT_MISMATCH,
        message: 'This API key belongs to a different tenant than the host it was presented to',
      });
    }
    this.cls.set(CLS_TENANT_ID, tenantId);
    // 'system': the caller is an integration rather than a person or a host.
    // The TenantContext source vocabulary is shared and closed; nothing here
    // needs a new member of it.
    this.cls.set(CLS_TENANT_SOURCE, 'system');
  }

  /** Best-effort: `last_used_at` tells an operator whether a key is still in traffic. */
  private touch(id: string, lastUsedAt: Date | null): void {
    if (lastUsedAt && Date.now() - lastUsedAt.getTime() < LAST_USED_THROTTLE_MS) return;
    void this.prisma.owner.apiKey
      .update({ where: { id }, data: { lastUsedAt: new Date() } })
      .catch((e: unknown) => this.logger.warn(`could not record api key use: ${String(e)}`));
  }

  private unauthenticated(message = 'A valid API key is required'): UnauthorizedException {
    return new UnauthorizedException({ code: ERROR_CODES.UNAUTHENTICATED, message });
  }
}
