import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';
import { PERMISSIONS } from '@aviora/shared';
import {
  CurrentUser,
  RequirePermissions,
  type AuthenticatedUser,
} from '../../common/auth/decorators';
import { CLS_MEMBER_ID, PLATFORM_BYPASS } from '../../common/auth/permissions.guard';
import { ZodPipe } from '../../common/validation/zod.pipe';
import { RateTier } from '../../common/rate/rate-tier.guard';
import type { TeamActor } from '../team/team-scope.service';
import { MAX_PHOTO_BYTES, PhotosService } from './photos.service';

const consentSchema = z.object({ note: z.string().max(500).nullish() });

const uploadSchema = z.object({
  stepKey: z.string().min(1).max(60),
  contentType: z.string().min(1).max(60),
  // Base64 rather than multipart: one dependency fewer, and the cap is checked
  // in bytes after decoding, where it means something.
  dataBase64: z
    .string()
    .min(1)
    .max(Math.ceil((MAX_PHOTO_BYTES * 4) / 3) + 1024),
});

@Controller()
export class PhotosController {
  constructor(
    private readonly photos: PhotosService,
    private readonly cls: ClsService,
  ) {}

  private actor(user: AuthenticatedUser): TeamActor {
    return {
      memberId: (this.cls.get(CLS_MEMBER_ID) as string | undefined) ?? null,
      platformBypass: !!user.platformRole && PLATFORM_BYPASS.has(user.platformRole),
    };
  }

  @Get('crm/customers/:id/photo-consent')
  @RequirePermissions(PERMISSIONS.CRM_CUSTOMER_VIEW)
  async consent(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.photos.consentFor(this.actor(user), id);
  }

  @Post('crm/customers/:id/photo-consent')
  @RequirePermissions(PERMISSIONS.CRM_CUSTOMER_MANAGE)
  async grant(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(consentSchema)) body: z.infer<typeof consentSchema>,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return { consent: await this.photos.recordConsent(this.actor(user), id, body.note ?? null) };
  }

  @Delete('crm/customers/:id/photo-consent')
  @RequirePermissions(PERMISSIONS.CRM_CUSTOMER_MANAGE)
  async revoke(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.photos.revokeConsent(this.actor(user), id);
  }

  @Get('crm/customers/:id/photos')
  @RequirePermissions(PERMISSIONS.CRM_CUSTOMER_VIEW)
  async list(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.photos.list(this.actor(user), id);
  }

  @Post('crm/customers/:id/photos')
  @RequirePermissions(PERMISSIONS.CRM_CUSTOMER_MANAGE)
  // Megabytes per request, and an image decode behind it.
  @RateTier('expensive')
  async upload(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(uploadSchema)) body: z.infer<typeof uploadSchema>,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return { photo: await this.photos.upload(this.actor(user), id, body) };
  }

  @Get('photos/:id/content')
  @RequirePermissions(PERMISSIONS.CRM_CUSTOMER_VIEW)
  async content(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Res() res: Response,
  ) {
    const object = await this.photos.content(this.actor(user), id);
    // No caching anywhere shared: this is one customer's photograph and a proxy
    // holding a copy is a copy nobody consented to.
    res.setHeader('Content-Type', object.contentType);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(object.body);
  }

  @Delete('photos/:id')
  @RequirePermissions(PERMISSIONS.CRM_CUSTOMER_MANAGE)
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.photos.remove(this.actor(user), id);
  }
}
