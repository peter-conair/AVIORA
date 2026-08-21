import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';
import { PERMISSIONS } from '@aviora/shared';
import { RequirePartner, RequirePermissions } from '../../common/auth/decorators';
import { CLS_PARTNER_ID } from '../../common/auth/permissions.guard';
import { ZodPipe } from '../../common/validation/zod.pipe';
import { PartnerService } from './partner.service';

const createSchema = z.object({
  code: z
    .string()
    .min(2)
    .max(60)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'code must be lower-case words joined by hyphens'),
  name: z.string().min(1).max(160),
  contactEmail: z.string().email().optional(),
});
const userSchema = z.object({ email: z.string().email() });
const inviteSchema = z.object({ email: z.string().email(), planId: z.string().uuid() });

/** The TENANT's view: creating partners and deciding who at them may sign in. */
@Controller('partners')
export class PartnerAdminController {
  constructor(private readonly partners: PartnerService) {}

  @Post()
  @RequirePermissions(PERMISSIONS.PARTNER_MANAGE)
  async create(@Body(new ZodPipe(createSchema)) body: z.infer<typeof createSchema>) {
    return { partner: await this.partners.create(body) };
  }

  @Get()
  @RequirePermissions(PERMISSIONS.PARTNER_MANAGE)
  async list() {
    return { partners: await this.partners.list() };
  }

  @Post(':id/users')
  @RequirePermissions(PERMISSIONS.PARTNER_MANAGE)
  async addUser(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(userSchema)) body: z.infer<typeof userSchema>,
  ) {
    return { partnerUser: await this.partners.addUser(id, body.email) };
  }

  @Delete('users/:id')
  @RequirePermissions(PERMISSIONS.PARTNER_MANAGE)
  async removeUser(@Param('id', ParseUUIDPipe) id: string) {
    return { partnerUser: await this.partners.removeUser(id) };
  }
}

/**
 * The PARTNER's own portal (docs/46 §1).
 *
 * Every method here takes its partner id from CLS, where the guard put it after
 * resolving the token's user inside this tenant. Note what no route accepts: a
 * partner id. There is nothing for a caller to change, which is the property
 * that keeps a third kind of principal from becoming a hole.
 */
@Controller('partner')
export class PartnerPortalController {
  constructor(
    private readonly partners: PartnerService,
    private readonly cls: ClsService,
  ) {}

  private me(): string {
    const id = this.cls.get(CLS_PARTNER_ID) as string | undefined;
    // Unreachable through the guard; thrown rather than defaulted, because a
    // partner route that fell back to "some partner" would be the bug this
    // whole design is arranged to prevent.
    if (!id) throw new Error('partner route reached with no partner in context');
    return id;
  }

  @Get('me')
  @RequirePartner()
  async profile() {
    return { partner: await this.partners.profile(this.me()) };
  }

  @Get('performance')
  @RequirePartner()
  async performance(@Query('days') days?: string) {
    const window = Math.min(Math.max(Number(days) || 30, 1), 365);
    return this.partners.performance(this.me(), window);
  }

  @Post('invitations')
  @RequirePartner()
  async invite(@Body(new ZodPipe(inviteSchema)) body: z.infer<typeof inviteSchema>) {
    return this.partners.invite(this.me(), body.email, body.planId);
  }
}
