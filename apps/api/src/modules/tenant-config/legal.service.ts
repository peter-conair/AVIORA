import { createHash } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ERROR_CODES } from '@aviora/shared';
import type { Tx } from '@aviora/db';
import { PrismaService } from '../../common/db/prisma.service';
import { TenantDb } from '../../common/db/tenant-db.service';
import { AuditService } from '../../common/audit/audit.service';

export const LEGAL_KINDS = ['terms', 'privacy', 'refund', 'custom'] as const;
export type LegalKind = (typeof LEGAL_KINDS)[number];

export interface PublishInput {
  kind: LegalKind;
  locale: string;
  country?: string | null;
  title: string;
  body: string;
}

/**
 * Legal documents are versioned, and acceptance records WHICH VERSION
 * (docs/29 §3).
 *
 * Two rules carry this whole file:
 *
 *   1. A published document is IMMUTABLE. Publishing the same
 *      (kind, locale, country) creates version N+1; there is no update path at
 *      all — not a guarded one, not an admin one. Rewriting what somebody
 *      agreed to, after they agreed to it, is not an edit, so the safest way to
 *      refuse it is to never write the code that could do it.
 *   2. Acceptance stores `documentId`. "The member accepted the terms" is
 *      worthless evidence if nobody can say WHICH terms.
 */
@Injectable()
export class LegalService {
  constructor(
    private readonly db: TenantDb,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The version in force for a caller. PUBLIC and resolved by host, so it reads
   * through the owner connection with an explicit tenant id — a terms page has
   * no logged-in reader by definition.
   *
   * Resolution walks from most specific to least: this locale in this country,
   * then this locale with no country, then the tenant's default locale. A
   * tenant operating in two countries publishes two versions and each member
   * gets the one that is theirs.
   */
  async current(tenantId: string | null, kind: LegalKind, requestedLocale?: string) {
    const id = requireTenant(tenantId);
    const reader = this.prisma.owner;
    const localisation = await reader.tenantLocalisation.findUnique({ where: { tenantId: id } });
    const tenant = await reader.tenant.findUnique({
      where: { id },
      select: { country: true, defaultLanguage: true },
    });
    const country = (localisation?.country ?? tenant?.country ?? 'TH').toUpperCase();
    const defaultLocale = localisation?.defaultLocale ?? tenant?.defaultLanguage ?? 'th';

    // `supportedLocales` bounds what the switcher OFFERS; it does not bound
    // what can be read. A published document is itself proof the tenant admits
    // that language, and a tenant that published English terms before filling
    // in its locale list must not find them unreachable. The list still decides
    // ordering: the requested locale is tried, then the tenant's default.
    const requested = requestedLocale?.trim() || defaultLocale;
    const ordered = [requested, defaultLocale];

    const attempts: Array<{ locale: string; country: string | null }> = [];
    for (const locale of [...new Set(ordered)]) {
      attempts.push({ locale, country }, { locale, country: null });
    }
    const locale = requested;
    for (const attempt of attempts) {
      const found = await reader.legalDocument.findFirst({
        where: { tenantId: id, kind, locale: attempt.locale, country: attempt.country },
        orderBy: { version: 'desc' },
      });
      if (found)
        return {
          document: found,
          resolvedFor: { locale: attempt.locale, country: attempt.country },
        };
    }
    throw new NotFoundException({
      code: ERROR_CODES.NOT_FOUND,
      message: `No published ${kind} document for locale ${locale}`,
    });
  }

  /**
   * Every version, including superseded — the audit view.
   *
   * The body is included: a superseded version has to stay READABLE, and the
   * point of keeping it is being able to see what somebody actually agreed to.
   * A tenant has a handful of documents times a handful of locales, so this is
   * not the place to save bytes.
   */
  list() {
    return this.db.tx((tx) =>
      tx.legalDocument.findMany({
        orderBy: [{ kind: 'asc' }, { locale: 'asc' }, { version: 'desc' }],
        take: 200,
        select: {
          id: true,
          kind: true,
          locale: true,
          country: true,
          version: true,
          title: true,
          body: true,
          publishedAt: true,
          _count: { select: { acceptances: true } },
        },
      }),
    );
  }

  /**
   * Publishing is the ONLY write. The same (kind, locale, country) published
   * again becomes version N+1 — an edit is a new version, and the previous one
   * stays exactly as the people who accepted it read it.
   */
  async publish(input: PublishInput) {
    const country = input.country ? input.country.toUpperCase() : null;
    const document = await this.db.tx(async (tx) => {
      const latest = await tx.legalDocument.findFirst({
        where: { kind: input.kind, locale: input.locale, country },
        orderBy: { version: 'desc' },
        select: { version: true, body: true },
      });
      // Republishing an identical body would mint a version nobody can tell
      // apart from the one before it, and members would be asked to re-accept
      // text that did not change.
      if (latest && latest.body === input.body) {
        throw new ConflictException({
          code: ERROR_CODES.CONFLICT,
          message:
            'This body is identical to the current version — publishing would create a version that differs from nothing',
        });
      }
      return tx.legalDocument.create({
        data: {
          tenantId: this.db.tenantId,
          kind: input.kind,
          locale: input.locale,
          country,
          version: (latest?.version ?? 0) + 1,
          title: input.title,
          body: input.body,
        },
      });
    });

    await this.audit.record({
      action: 'legal.document.publish',
      entityType: 'legal_document',
      entityId: document.id,
      after: {
        kind: document.kind,
        locale: document.locale,
        country: document.country,
        version: document.version,
      },
    });
    return document;
  }

  /**
   * Records the version accepted. `documentId` is what the member was actually
   * shown — if a new version was published between render and submit, the
   * record says which text they read, not which text is now current.
   */
  async accept(
    userId: string,
    kind: LegalKind,
    input: { documentId?: string; ip?: string; locale?: string },
  ) {
    // Resolved BEFORE the transaction: `current()` reads through the owner
    // connection, and taking a second connection while holding the first is how
    // a pool deadlocks under load.
    const targetId =
      input.documentId ??
      (await this.current(this.db.tenantIdOrNull, kind, input.locale)).document.id;

    const result = await this.db.tx(async (tx) => {
      const memberId = await this.memberIdFor(tx, userId);
      const document = await tx.legalDocument.findFirst({ where: { id: targetId, kind } });
      if (!document) {
        throw new NotFoundException({
          code: ERROR_CODES.NOT_FOUND,
          message: 'Legal document not found',
        });
      }
      const existing = await tx.legalAcceptance.findFirst({
        where: { memberId, documentId: document.id },
      });
      // Accepting twice is not an error and not a second record: the evidence
      // is "this member agreed to this version", and it is already true.
      const acceptance =
        existing ??
        (await tx.legalAcceptance.create({
          data: {
            tenantId: this.db.tenantId,
            memberId,
            documentId: document.id,
            ipHash: this.hashIp(input.ip),
          },
        }));
      return { acceptance, document, alreadyAccepted: !!existing };
    });

    if (!result.alreadyAccepted) {
      await this.audit.record({
        action: 'legal.document.accept',
        entityType: 'legal_acceptance',
        entityId: result.acceptance.id,
        after: {
          documentId: result.document.id,
          kind: result.document.kind,
          version: result.document.version,
        },
      });
    }
    return {
      acceptance: {
        id: result.acceptance.id,
        acceptedAt: result.acceptance.acceptedAt,
        documentId: result.acceptance.documentId,
        // The version travels ON the record. An acceptance that needs a join
        // to say what was agreed to is evidence somebody has to reconstruct.
        kind: result.document.kind,
        version: result.document.version,
      },
      document: {
        id: result.document.id,
        kind: result.document.kind,
        locale: result.document.locale,
        country: result.document.country,
        version: result.document.version,
        title: result.document.title,
      },
      alreadyAccepted: result.alreadyAccepted,
    };
  }

  /** What this member has accepted, and whether anything has since superseded it. */
  acceptances(userId: string) {
    return this.db.tx(async (tx) => {
      const memberId = await this.memberIdFor(tx, userId);
      return tx.legalAcceptance.findMany({
        where: { memberId },
        orderBy: { acceptedAt: 'desc' },
        select: {
          id: true,
          acceptedAt: true,
          document: {
            select: {
              id: true,
              kind: true,
              locale: true,
              country: true,
              version: true,
              title: true,
            },
          },
        },
      });
    });
  }

  /**
   * The address itself is never stored — only a hash, salted with the tenant id
   * so the same address in two tenants does not produce the same token.
   */
  private hashIp(ip?: string): string | undefined {
    if (!ip) return undefined;
    return createHash('sha256').update(`${this.db.tenantId}:${ip}`).digest('hex');
  }

  private async memberIdFor(tx: Tx, userId: string): Promise<string> {
    const member = await tx.member.findFirst({
      where: { userId, status: 'active' },
      select: { id: true },
    });
    if (!member) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'You are not a member of this tenant',
      });
    }
    return member.id;
  }
}

function requireTenant(tenantId: string | null): string {
  if (!tenantId) {
    throw new NotFoundException({
      code: ERROR_CODES.TENANT_NOT_RESOLVED,
      message: 'No tenant resolves from this host',
    });
  }
  return tenantId;
}
