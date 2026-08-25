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
import { parseKey, type ApiKeyPrincipal, type ApiKeyRequest, type KeyKind } from './api-key';
import { sha256Hex, timingSafeEquals } from './webhook';

export const REQUIRED_SCOPES = 'requiredApiKeyScopes';
/**
 * Scopes a public-API route needs. They are PERMISSION KEYS — the same
 * vocabulary the tenant permission model already uses. An API key is a second
 * way to authenticate, never a second authorization model, so this decorator
 * names an existing permission rather than inventing a parallel one.
 */
export const RequireScopes = (...scopes: string[]) => SetMetadata(REQUIRED_SCOPES, scopes);

export const REQUIRED_KEY_KIND = 'requiredApiKeyKind';
/**
 * Marks a route as PLATFORM scope: it acts on data that belongs to no tenant,
 * so it takes a platform key and refuses a tenant one (docs/74 §2).
 *
 * The check runs BOTH ways, which is the point. Without the decorator a
 * platform key is refused, so a key that speaks for everybody cannot wander
 * into a route written for one tenant and be handed whichever tenant the host
 * happened to resolve. With it, a tenant key is refused, so no single tenant's
 * key quietly rewrites the catalogue every tenant reads.
 */
export const RequirePlatformKey = () => SetMetadata(REQUIRED_KEY_KIND, 'platform');

/** Stands in for a real hash when no key matched, so both paths do the same work. */
const NO_SUCH_HASH = '0'.repeat(64);

/** The columns both key tables answer with, once a platform row has been mapped. */
interface KeyRow {
  id: string;
  name: string;
  hash: string;
  scopes: string[];
  tenantId: string | null;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

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
    const wanted =
      this.reflector.getAllAndOverride<KeyKind>(REQUIRED_KEY_KIND, [
        ctx.getHandler(),
        ctx.getClass(),
      ]) ?? 'tenant';
    const principal = await this.authenticate(req, wanted);

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

  private async authenticate(
    req: Request & ApiKeyRequest,
    wanted: KeyKind,
  ): Promise<ApiKeyPrincipal> {
    const header = req.header('authorization');
    const raw = header?.startsWith('Bearer ') ? header.slice(7).trim() : null;
    const presented = raw ? parseKey(raw) : null;
    if (!raw || !presented) throw this.unauthenticated();

    // The label decides which table is read. A tenant key is never looked up
    // against the platform table, so the two can never be confused for one
    // another by a query that happens to match.
    const match =
      presented.kind === 'platform'
        ? await this.findPlatformKey(presented.prefix, raw)
        : await this.findTenantKey(presented.prefix, raw);

    const now = new Date();
    if (match.revokedAt) throw this.unauthenticated('This API key has been revoked');
    if (match.expiresAt && match.expiresAt <= now) {
      throw this.unauthenticated('This API key has expired');
    }

    // Kind is checked AFTER the key is proven valid, so a caller holding no
    // valid key learns nothing about which of the two tables a prefix lives in.
    if (presented.kind !== wanted) throw this.wrongKind(presented.kind, wanted);

    if (match.tenantId) this.bindTenant(match.tenantId);
    this.touch(presented.kind, match.id, match.lastUsedAt);

    return {
      keyId: match.id,
      tenantId: match.tenantId,
      kind: presented.kind,
      name: match.name,
      scopes: match.scopes,
    };
  }

  private async findTenantKey(prefix: string, raw: string): Promise<KeyRow> {
    // The prefix is unique per tenant, so a lookup by prefix alone can in
    // principle return more than one row; the hash comparison is what decides.
    const candidates = await this.prisma.owner.apiKey.findMany({ where: { prefix } });
    return this.verify(candidates, raw);
  }

  private async findPlatformKey(prefix: string, raw: string): Promise<KeyRow> {
    const candidates = await this.prisma.owner.platformApiKey.findMany({ where: { prefix } });
    // Mapped rather than spread: the platform row has no tenant column at all,
    // and `tenantId: null` is the fact this returns rather than an omission.
    return this.verify(
      candidates.map((row) => ({ ...row, tenantId: null })),
      raw,
    );
  }

  private verify(candidates: KeyRow[], raw: string): KeyRow {
    const presented = sha256Hex(raw);
    const match = candidates.find((row) => timingSafeEquals(row.hash, presented));
    if (!match) {
      // Compare against a constant anyway, so an unknown prefix costs the same
      // as a wrong secret and the error cannot be timed apart.
      timingSafeEquals(NO_SUCH_HASH, presented);
      throw this.unauthenticated();
    }
    return match;
  }

  /** Refused by NAME: "forbidden" sends an integrator guessing, this does not. */
  private wrongKind(held: KeyKind, wanted: KeyKind): ForbiddenException {
    return new ForbiddenException({
      code: ERROR_CODES.FORBIDDEN,
      message:
        wanted === 'platform'
          ? 'This endpoint writes data no tenant owns, and needs a platform key'
          : 'This endpoint serves one tenant, and a platform key names none',
      details: { keyKind: held, required: wanted },
    });
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
  private touch(kind: KeyKind, id: string, lastUsedAt: Date | null): void {
    if (lastUsedAt && Date.now() - lastUsedAt.getTime() < LAST_USED_THROTTLE_MS) return;
    // Two statements rather than one delegate chosen by a ternary: the two
    // Prisma delegates are different generated types, and a union of them is
    // not callable however alike they look.
    const data = { lastUsedAt: new Date() };
    const write =
      kind === 'platform'
        ? this.prisma.owner.platformApiKey.update({ where: { id }, data })
        : this.prisma.owner.apiKey.update({ where: { id }, data });
    void Promise.resolve(write).catch((e: unknown) =>
      this.logger.warn(`could not record api key use: ${String(e)}`),
    );
  }

  private unauthenticated(message = 'A valid API key is required'): UnauthorizedException {
    return new UnauthorizedException({ code: ERROR_CODES.UNAUTHENTICATED, message });
  }
}
