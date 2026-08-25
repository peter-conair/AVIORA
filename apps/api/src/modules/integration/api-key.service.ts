import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { ERROR_CODES } from '@aviora/shared';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../common/db/prisma.service';
import { TenantDb } from '../../common/db/tenant-db.service';
import { CLS_PLATFORM_ROLE, CLS_USER_ID } from '../../common/auth/jwt-auth.guard';
import { CLS_PERMISSIONS, PLATFORM_BYPASS } from '../../common/auth/permissions.guard';
import { mintKey, type ApiKeyCreate } from './api-key';
import { sha256Hex } from './webhook';

export interface PlatformApiKeyView {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdBy: string | null;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

const PLATFORM_KEY_VIEW = {
  id: true,
  name: true,
  prefix: true,
  scopes: true,
  createdBy: true,
  lastUsedAt: true,
  expiresAt: true,
  revokedAt: true,
  createdAt: true,
} as const;

export interface ApiKeyView {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

/**
 * API keys (docs/30 §3). Prefixes in listings, the key itself exactly once.
 *
 * The rule this class exists to enforce is the delegation one: a key can never
 * hold a scope its creator lacks. Without it an administrator with
 * `integration.manage` mints themselves a key carrying `tenant.role.manage`
 * and has quietly granted themselves a promotion — the permission model would
 * still be intact and entirely bypassed.
 */
@Injectable()
export class ApiKeyService {
  constructor(
    private readonly db: TenantDb,
    private readonly prisma: PrismaService,
    private readonly cls: ClsService,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<ApiKeyView[]> {
    const rows = await this.db.tx((tx) =>
      tx.apiKey.findMany({
        orderBy: { createdAt: 'desc' },
        // `hash` is not selected anywhere in this file. There is no route, and
        // no method, that can return it or the key it stands for.
        select: {
          id: true,
          name: true,
          prefix: true,
          scopes: true,
          lastUsedAt: true,
          expiresAt: true,
          revokedAt: true,
          createdAt: true,
        },
      }),
    );
    return rows;
  }

  /** Returns the key ONCE. */
  async create(input: ApiKeyCreate): Promise<{ apiKey: ApiKeyView; key: string }> {
    await this.assertCallerHolds(input.scopes);

    const minted = mintKey();
    const row = await this.db.tx((tx) =>
      tx.apiKey.create({
        data: {
          tenantId: this.db.tenantId,
          name: input.name,
          prefix: minted.prefix,
          hash: sha256Hex(minted.raw),
          scopes: input.scopes,
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        },
        select: {
          id: true,
          name: true,
          prefix: true,
          scopes: true,
          lastUsedAt: true,
          expiresAt: true,
          revokedAt: true,
          createdAt: true,
        },
      }),
    );

    await this.audit.record({
      action: 'integration.api_key.create',
      entityType: 'api_key',
      entityId: row.id,
      after: { name: row.name, prefix: row.prefix, scopes: row.scopes, expiresAt: row.expiresAt },
    });

    return { apiKey: row, key: minted.raw };
  }

  /** Revoking is immediate and permanent (docs/30 §3). */
  async revoke(id: string): Promise<ApiKeyView> {
    const row = await this.db.tx(async (tx) => {
      const existing = await tx.apiKey.findFirst({ where: { id } });
      if (!existing) return null;
      if (existing.revokedAt) return existing;
      return tx.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
    });
    if (!row) {
      throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'API key not found' });
    }

    await this.audit.record({
      action: 'integration.api_key.revoke',
      entityType: 'api_key',
      entityId: row.id,
      before: { revokedAt: null },
      after: { revokedAt: row.revokedAt },
    });
    return {
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      scopes: row.scopes,
      lastUsedAt: row.lastUsedAt,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
      createdAt: row.createdAt,
    };
  }

  /* ── platform-scope keys (docs/74 §2) ──────────────────────────────────── */

  /**
   * Keys that belong to no tenant. Read and written through the OWNER client,
   * because `platform_api_keys` carries no policy and the app role holds no
   * grant on it — a table a tenant cannot reach at all is a stronger statement
   * than a policy that says the same thing and can be edited away.
   *
   * Every method here is reached only through `@RequirePlatformRoles`, and each
   * re-checks the role rather than trusting the route: a service that is safe
   * only because of the decorator above it is one refactor away from not being.
   */
  async listPlatform(): Promise<PlatformApiKeyView[]> {
    this.assertPlatformCaller();
    return this.prisma.owner.platformApiKey.findMany({
      orderBy: { createdAt: 'desc' },
      // `hash` is not selected here either. There is no route that returns it.
      select: PLATFORM_KEY_VIEW,
    });
  }

  /** Returns the key ONCE. */
  async createPlatform(input: ApiKeyCreate): Promise<{ apiKey: PlatformApiKeyView; key: string }> {
    this.assertPlatformCaller();

    const minted = mintKey('platform');
    const row = await this.prisma.owner.platformApiKey.create({
      data: {
        name: input.name,
        prefix: minted.prefix,
        hash: sha256Hex(minted.raw),
        scopes: input.scopes,
        createdBy: (this.cls.get(CLS_USER_ID) as string | undefined) ?? null,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      },
      select: PLATFORM_KEY_VIEW,
    });

    // tenantId null on purpose: the row records a platform act, and a tenant
    // reading its own audit log must not find it (docs/53).
    await this.audit.record({
      tenantId: null,
      action: 'platform.api_key.create',
      entityType: 'platform_api_key',
      entityId: row.id,
      after: { name: row.name, prefix: row.prefix, scopes: row.scopes, expiresAt: row.expiresAt },
    });

    return { apiKey: row, key: minted.raw };
  }

  async revokePlatform(id: string): Promise<PlatformApiKeyView> {
    this.assertPlatformCaller();

    const existing = await this.prisma.owner.platformApiKey.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException({
        code: ERROR_CODES.NOT_FOUND,
        message: 'Platform API key not found',
      });
    }
    const row = existing.revokedAt
      ? existing
      : await this.prisma.owner.platformApiKey.update({
          where: { id },
          data: { revokedAt: new Date() },
        });

    await this.audit.record({
      tenantId: null,
      action: 'platform.api_key.revoke',
      entityType: 'platform_api_key',
      entityId: row.id,
      before: { revokedAt: existing.revokedAt },
      after: { revokedAt: row.revokedAt },
    });

    return {
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      scopes: row.scopes,
      createdBy: row.createdBy,
      lastUsedAt: row.lastUsedAt,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
      createdAt: row.createdAt,
    };
  }

  private assertPlatformCaller(): void {
    const role = this.cls.get(CLS_PLATFORM_ROLE) as string | null | undefined;
    if (!role || !PLATFORM_BYPASS.has(role)) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'Platform keys are minted by the platform, not by a tenant',
      });
    }
  }

  /**
   * Refuses with the offending scope NAMED. "Forbidden" tells an administrator
   * to try again at random; "you do not hold tenant.role.manage" tells them
   * what to ask their own administrator for.
   */
  private async assertCallerHolds(scopes: string[]): Promise<void> {
    const held = await this.callerPermissions();
    if (held === 'all') return;
    const missing = scopes.filter((scope) => !held.has(scope));
    if (missing.length > 0) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message:
          `A key cannot hold a scope you do not: ${missing.join(', ')}. ` +
          'Ask for the permission first, then mint the key.',
        details: { missingScopes: missing },
      });
    }
  }

  /**
   * The creator's OWN permission set. PermissionsGuard has already paid for
   * this lookup on the way in and left it in CLS; the fallback query exists so
   * this class is correct even if it is ever called from a route the guard
   * short-circuited.
   */
  private async callerPermissions(): Promise<Set<string> | 'all'> {
    const platformRole = this.cls.get(CLS_PLATFORM_ROLE) as string | null | undefined;
    if (platformRole && PLATFORM_BYPASS.has(platformRole)) return 'all';

    const cached = this.cls.get(CLS_PERMISSIONS) as Set<string> | undefined;
    if (cached) return cached;

    const memberId = this.cls.get('memberId') as string | undefined;
    if (!memberId) return new Set<string>();
    const rows = await this.db.tx((tx) =>
      tx.memberRole.findMany({
        where: { memberId },
        select: {
          role: {
            select: { rolePermissions: { select: { permission: { select: { key: true } } } } },
          },
        },
      }),
    );
    return new Set(rows.flatMap((r) => r.role.rolePermissions.map((rp) => rp.permission.key)));
  }
}
