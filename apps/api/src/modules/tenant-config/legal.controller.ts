import { Body, Controller, Get, Ip, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { PERMISSIONS } from '@aviora/shared';
import {
  CurrentUser,
  Public,
  RequirePermissions,
  type AuthenticatedUser,
} from '../../common/auth/decorators';
import { ClsService } from 'nestjs-cls';
import { CLS_TENANT_ID } from '../../common/tenant/tenant-context.middleware';
import { ZodPipe } from '../../common/validation/zod.pipe';
import { plainText } from './branding';
import { LEGAL_KINDS, LegalService, type LegalKind } from './legal.service';

const kindSchema = z.enum(LEGAL_KINDS);
const localeSchema = z
  .string()
  .regex(/^[a-z]{2}(-[A-Z]{2})?$/)
  .optional();

const publishSchema = z.object({
  kind: kindSchema,
  locale: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/),
  country: z
    .string()
    .regex(/^[A-Za-z]{2}$/)
    .nullable()
    .optional(),
  title: plainText(200),
  // Plain text, like every other tenant-supplied string (docs/29 §7). A terms
  // page that renders tenant HTML is a tenant shipping code into a member's
  // browser, and it is not made safe by the page being called "legal".
  body: plainText(200_000),
});

const acceptSchema = z.object({
  /**
   * What the member was actually SHOWN. Optional so a simple client can accept
   * "whatever is current", but when supplied it is what gets recorded — the
   * evidence must say which text they read, not which text is current now.
   */
  documentId: z.string().uuid().optional(),
  locale: localeSchema,
});

/**
 * Versioned legal documents and recorded acceptance (docs/29 §3).
 *
 * Route order matters here: `documents` is declared BEFORE `:kind`, or the
 * parameter would swallow it and `GET /legal/documents` would look for a
 * document of kind "documents".
 *
 * There is deliberately NO update route. A published document is immutable;
 * publishing again creates version N+1.
 */
@Controller('legal')
export class LegalController {
  constructor(
    private readonly legal: LegalService,
    private readonly cls: ClsService,
  ) {}

  /** Resolved from the host by TenantContextMiddleware — a terms page has no logged-in reader. */
  private tenantId(): string | null {
    return (this.cls.get(CLS_TENANT_ID) as string | undefined) ?? null;
  }

  @Get('documents')
  @RequirePermissions(PERMISSIONS.TENANT_SETTINGS_MANAGE)
  async listDocuments() {
    return { documents: await this.legal.list() };
  }

  @Post('documents')
  @RequirePermissions(PERMISSIONS.TENANT_SETTINGS_MANAGE)
  async publish(@Body(new ZodPipe(publishSchema)) body: z.infer<typeof publishSchema>) {
    return { document: await this.legal.publish(body) };
  }

  /** What THIS member has accepted, and which version of it. */
  @Get('acceptances')
  async myAcceptances(@CurrentUser() user: AuthenticatedUser) {
    return { acceptances: await this.legal.acceptances(user.userId) };
  }

  @Get(':kind')
  @Public()
  async current(
    @Param('kind', new ZodPipe(kindSchema)) kind: LegalKind,
    @Query('locale', new ZodPipe(localeSchema)) locale?: string,
  ) {
    const resolved = await this.legal.current(this.tenantId(), kind, locale);
    return { document: resolved.document, resolvedFor: resolved.resolvedFor };
  }

  @Post(':kind/accept')
  async accept(
    @CurrentUser() user: AuthenticatedUser,
    @Param('kind', new ZodPipe(kindSchema)) kind: LegalKind,
    @Body(new ZodPipe(acceptSchema)) body: z.infer<typeof acceptSchema>,
    @Ip() ip: string,
  ) {
    return await this.legal.accept(user.userId, kind, { ...body, ip });
  }
}
