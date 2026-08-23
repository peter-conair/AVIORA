import { Body, Controller, Get, Param, Put, Query } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';
import { CurrentUser, type AuthenticatedUser } from '../../common/auth/decorators';
import { CLS_MEMBER_ID, PLATFORM_BYPASS } from '../../common/auth/permissions.guard';
import { ZodPipe } from '../../common/validation/zod.pipe';
import type { TeamActor } from '../team/team-scope.service';
import { StartService } from './start.service';

const manualSchema = z.object({ done: z.boolean() });

/**
 * The start path (docs/63).
 *
 * Deliberately requires no permission beyond tenant membership: it is a
 * member's own first steps, and gating it behind a grant would hide the one
 * screen a brand-new member needs on the day their grants are thinnest.
 */
@Controller('start')
export class StartController {
  constructor(
    private readonly start: StartService,
    private readonly cls: ClsService,
  ) {}

  private actor(user: AuthenticatedUser): TeamActor {
    return {
      memberId: (this.cls.get(CLS_MEMBER_ID) as string | undefined) ?? null,
      platformBypass: !!user.platformRole && PLATFORM_BYPASS.has(user.platformRole),
    };
  }

  @Get()
  async status(@CurrentUser() user: AuthenticatedUser, @Query('locale') locale?: string) {
    return this.start.status(this.actor(user), locale === 'en' ? 'en' : 'th');
  }

  @Put(':key')
  async setManual(
    @Param('key') key: string,
    @Body(new ZodPipe(manualSchema)) body: z.infer<typeof manualSchema>,
    @CurrentUser() user: AuthenticatedUser,
    @Query('locale') locale?: string,
  ) {
    return this.start.setManual(this.actor(user), key, body.done, locale === 'en' ? 'en' : 'th');
  }
}
