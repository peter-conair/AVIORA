import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';
import { ERROR_CODES, PERMISSIONS } from '@aviora/shared';
import { RequirePermissions } from '../../common/auth/decorators';
import { CLS_MEMBER_ID } from '../../common/auth/permissions.guard';
import { ZodPipe } from '../../common/validation/zod.pipe';
import { NotificationsService } from './notifications.service';

const preferenceSchema = z.object({
  type: z.string().min(1).max(80),
  inApp: z.boolean(),
  email: z.boolean(),
});

@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly cls: ClsService,
  ) {}

  private memberId(): string {
    const id = this.cls.get(CLS_MEMBER_ID) as string | undefined;
    if (!id) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'You are not a member of this tenant',
      });
    }
    return id;
  }

  @Get()
  @RequirePermissions(PERMISSIONS.NOTIFICATION_VIEW)
  async list(@Query('unread') unread?: string) {
    const memberId = this.memberId();
    const [notifications, unreadCount] = await Promise.all([
      this.notifications.list(memberId, unread === 'true'),
      this.notifications.unreadCount(memberId),
    ]);
    return { notifications, unreadCount };
  }

  @Patch(':id/read')
  @RequirePermissions(PERMISSIONS.NOTIFICATION_VIEW)
  async markRead(@Param('id', ParseUUIDPipe) id: string) {
    return { notification: await this.notifications.markRead(id, this.memberId()) };
  }

  @Post('read-all')
  @RequirePermissions(PERMISSIONS.NOTIFICATION_VIEW)
  async markAllRead() {
    const result = await this.notifications.markAllRead(this.memberId());
    return { updated: result.count };
  }

  @Get('preferences')
  @RequirePermissions(PERMISSIONS.NOTIFICATION_VIEW)
  async preferences() {
    return { preferences: await this.notifications.preferences(this.memberId()) };
  }

  @Post('preferences')
  @RequirePermissions(PERMISSIONS.NOTIFICATION_VIEW)
  async setPreference(@Body(new ZodPipe(preferenceSchema)) body: z.infer<typeof preferenceSchema>) {
    const pref = await this.notifications.setPreference(
      this.memberId(),
      body.type,
      body.inApp,
      body.email,
    );
    return { preference: pref };
  }
}
