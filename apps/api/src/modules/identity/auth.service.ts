import * as crypto from 'node:crypto';
import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { ERROR_CODES, newId } from '@aviora/shared';
import { withTenant } from '@aviora/db';
import { PrismaService } from '../../common/db/prisma.service';

const ACCESS_TTL = '15m';
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface SafeUser {
  id: string;
  email: string;
  displayName: string | null;
  locale: string;
  platformRole: string | null;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string; // raw — set as HttpOnly cookie, never stored raw
  refreshExpiresAt: Date;
  /** Row id of the stored token, used to link a rotated pair. */
  refreshTokenId: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async register(input: {
    email: string;
    password: string;
    displayName: string;
    locale?: string;
  }): Promise<SafeUser> {
    const email = input.email.toLowerCase().trim();
    const existing = await this.prisma.app.user.findUnique({ where: { email } });
    if (existing) {
      throw new ConflictException({
        code: ERROR_CODES.CONFLICT,
        message: 'An account with this email already exists',
      });
    }
    const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
    const user = await this.prisma.app.user.create({
      data: { email, passwordHash, displayName: input.displayName, locale: input.locale ?? 'th' },
    });
    return this.safe(user);
  }

  async validateCredentials(email: string, password: string): Promise<SafeUser> {
    const user = await this.prisma.app.user.findUnique({
      where: { email: email.toLowerCase().trim() },
    });
    // argon2.verify on a dummy hash keeps timing comparable for unknown emails
    const hash =
      user?.passwordHash ??
      '$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const ok = await argon2.verify(hash, password).catch(() => false);
    if (!user || !ok || user.status !== 'active') {
      throw new UnauthorizedException({
        code: ERROR_CODES.UNAUTHENTICATED,
        message: 'Invalid email or password',
      });
    }
    await this.prisma.app.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });
    return this.safe(user);
  }

  async issueTokens(
    user: SafeUser,
    meta?: { userAgent?: string; ip?: string },
  ): Promise<IssuedTokens> {
    const accessToken = await this.jwt.signAsync(
      { sub: user.id, email: user.email, prole: user.platformRole, type: 'access' },
      { secret: process.env.AVIORA_JWT_ACCESS_SECRET, expiresIn: ACCESS_TTL },
    );
    const raw = crypto.randomBytes(48).toString('base64url');
    const refreshExpiresAt = new Date(Date.now() + REFRESH_TTL_MS);
    const row = await this.prisma.app.refreshToken.create({
      data: {
        id: newId(),
        userId: user.id,
        tokenHash: this.hash(raw),
        expiresAt: refreshExpiresAt,
        userAgent: meta?.userAgent?.slice(0, 300),
        ip: meta?.ip,
      },
      select: { id: true },
    });
    return { accessToken, refreshToken: raw, refreshExpiresAt, refreshTokenId: row.id };
  }

  /** Rotate a refresh token; reuse of a revoked token revokes the whole family. */
  async rotate(
    rawToken: string,
    meta?: { userAgent?: string; ip?: string },
  ): Promise<{
    user: SafeUser;
    tokens: IssuedTokens;
  }> {
    const row = await this.prisma.app.refreshToken.findUnique({
      where: { tokenHash: this.hash(rawToken) },
    });
    if (!row || row.expiresAt < new Date()) {
      throw new UnauthorizedException({
        code: ERROR_CODES.UNAUTHENTICATED,
        message: 'Refresh token invalid or expired',
      });
    }
    if (row.revokedAt) {
      // reuse detection — kill every session for this user
      await this.prisma.app.refreshToken.updateMany({
        where: { userId: row.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedException({
        code: ERROR_CODES.UNAUTHENTICATED,
        message: 'Refresh token reuse detected — all sessions revoked',
      });
    }
    const userRow = await this.prisma.app.user.findUniqueOrThrow({ where: { id: row.userId } });
    const user = this.safe(userRow);
    const tokens = await this.issueTokens(user, meta);
    // replaced_by is a uuid column: it points at the successor ROW, not at a
    // hash. Storing a truncated hash here made every rotation fail at the
    // database with an invalid-uuid error.
    await this.prisma.app.refreshToken.update({
      where: { id: row.id },
      data: { revokedAt: new Date(), replacedBy: tokens.refreshTokenId },
    });
    return { user, tokens };
  }

  async revoke(rawToken: string): Promise<void> {
    await this.prisma.app.refreshToken.updateMany({
      where: { tokenHash: this.hash(rawToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async me(userId: string) {
    const user = await this.prisma.app.user.findUniqueOrThrow({ where: { id: userId } });
    // tenant_memberships is RLS-forced and this endpoint runs BEFORE a tenant
    // is selected — the user's own membership list is a legitimate cross-tenant
    // auth query (rule: auth lookups must work cross-tenant), so read as owner.
    const memberships = await this.prisma.owner.tenantMembership.findMany({
      where: { userId, status: 'active' },
      select: {
        tenantId: true,
        tenant: { select: { name: true, slug: true, defaultLanguage: true } },
      },
    });
    return {
      user: this.safe(user),
      tenants: memberships.map((m) => ({
        tenantId: m.tenantId,
        name: m.tenant.name,
        slug: m.tenant.slug,
      })),
    };
  }

  /**
   * What this user may do in ONE tenant. `/auth/me` carries no permission
   * requirement, so the guard never loaded these — and a screen that has to
   * guess what the server will accept guesses wrong. Read here, where the
   * question is actually being answered. It grants nothing: every route still
   * decides for itself.
   */
  async permissionsIn(userId: string, tenantId: string): Promise<string[]> {
    const rows = await withTenant(this.prisma.app, tenantId, async (tx) => {
      const member = await tx.member.findFirst({
        where: { userId, status: 'active' },
        select: { id: true },
      });
      if (!member) return [];
      return tx.memberRole.findMany({
        where: { memberId: member.id },
        select: {
          role: {
            select: { rolePermissions: { select: { permission: { select: { key: true } } } } },
          },
        },
      });
    });
    const keys = new Set(
      rows.flatMap((r) => r.role.rolePermissions.map((rp) => rp.permission.key)),
    );
    return [...keys].sort();
  }

  private hash(raw: string): string {
    return crypto.createHash('sha256').update(raw).digest('hex');
  }

  private safe(u: {
    id: string;
    email: string;
    displayName: string | null;
    locale: string;
    platformRole: string | null;
  }): SafeUser {
    return {
      id: u.id,
      email: u.email,
      displayName: u.displayName,
      locale: u.locale,
      platformRole: u.platformRole,
    };
  }
}
