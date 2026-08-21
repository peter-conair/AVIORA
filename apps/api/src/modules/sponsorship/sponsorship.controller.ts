import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';
import { PERMISSIONS } from '@aviora/shared';
import { RequirePermissions } from '../../common/auth/decorators';
import { CLS_MEMBER_ID } from '../../common/auth/permissions.guard';
import { ZodPipe } from '../../common/validation/zod.pipe';
import { SponsorshipService } from './sponsorship.service';

const createSchema = z.object({
  code: z
    .string()
    .min(2)
    .max(60)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'code must be lower-case words joined by hyphens'),
  name: z.string().min(1).max(160),
  planId: z.string().uuid(),
  seats: z.number().int().positive().max(100_000),
  sponsorName: z.string().max(160).optional(),
});

const patchSchema = z.object({
  seats: z.number().int().positive().max(100_000).optional(),
  status: z.enum(['active', 'closed']).optional(),
});

const inviteSchema = z.object({ email: z.string().email() });

/**
 * Corporate wellness sponsorship (docs/45 §3).
 *
 * Every route is `sponsorship.manage`, held by the tenant owner. There is no
 * member-facing route: a sponsored member's experience is a member's
 * experience, and telling them which pool pays for them adds nothing they can
 * act on.
 */
@Controller('sponsorships')
export class SponsorshipController {
  constructor(
    private readonly sponsorship: SponsorshipService,
    private readonly cls: ClsService,
  ) {}

  @Post()
  @RequirePermissions(PERMISSIONS.SPONSORSHIP_MANAGE)
  async create(@Body(new ZodPipe(createSchema)) body: z.infer<typeof createSchema>) {
    return { sponsorship: await this.sponsorship.create(body) };
  }

  @Get()
  @RequirePermissions(PERMISSIONS.SPONSORSHIP_MANAGE)
  async list() {
    return { sponsorships: await this.sponsorship.list() };
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.SPONSORSHIP_MANAGE)
  async patch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(patchSchema)) body: z.infer<typeof patchSchema>,
  ) {
    return { sponsorship: await this.sponsorship.resize(id, body) };
  }

  @Post(':id/invitations')
  @RequirePermissions(PERMISSIONS.SPONSORSHIP_MANAGE)
  async invite(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(inviteSchema)) body: z.infer<typeof inviteSchema>,
  ) {
    const invitedBy = (this.cls.get(CLS_MEMBER_ID) as string | undefined) ?? null;
    return { invitation: await this.sponsorship.invite(id, body.email, invitedBy) };
  }

  @Delete('seats/:id')
  @RequirePermissions(PERMISSIONS.SPONSORSHIP_MANAGE)
  async release(@Param('id', ParseUUIDPipe) id: string) {
    return { seat: await this.sponsorship.release(id) };
  }

  /**
   * Participation, and nothing about health — the response says so itself,
   * every time, rather than leaving a sponsor to notice the gap and ask for it
   * as a feature (docs/45 §1).
   */
  @Get(':id/participation')
  @RequirePermissions(PERMISSIONS.SPONSORSHIP_MANAGE)
  async participation(@Param('id', ParseUUIDPipe) id: string, @Query('days') days?: string) {
    const window = Math.min(Math.max(Number(days) || 30, 1), 365);
    return this.sponsorship.participation(id, window);
  }
}
