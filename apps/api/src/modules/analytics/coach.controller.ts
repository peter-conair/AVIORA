import { Body, Controller, Headers, Post } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';
import { PERMISSIONS } from '@aviora/shared';
import {
  CurrentUser,
  RequirePermissions,
  type AuthenticatedUser,
} from '../../common/auth/decorators';
import { CLS_MEMBER_ID } from '../../common/auth/permissions.guard';
import { ZodPipe } from '../../common/validation/zod.pipe';
import type { TeamActor } from '../team/team-scope.service';
import { COACH_QUESTIONS, CoachService } from './coach.service';
import { ANALYTICS_WINDOWS, DEFAULT_ANALYTICS_WINDOW } from './window';

const PLATFORM_BYPASS = new Set(['PLATFORM_OWNER', 'SUPER_ADMIN']);

const askSchema = z.object({
  question: z.enum(COACH_QUESTIONS),
  window: z.enum(ANALYTICS_WINDOWS).default(DEFAULT_ANALYTICS_WINDOW),
});

/**
 * The coach carries `team.analytics.view` and nothing else (docs/28 §5): it
 * answers from the leader's own scoped dashboard, so the permission that opens
 * the dashboard is the permission that opens the coach.
 */
@Controller('ai/coach')
export class CoachController {
  constructor(
    private readonly coach: CoachService,
    private readonly cls: ClsService,
  ) {}

  private actor(user: AuthenticatedUser): TeamActor {
    return {
      memberId: (this.cls.get(CLS_MEMBER_ID) as string | undefined) ?? null,
      platformBypass: !!user.platformRole && PLATFORM_BYPASS.has(user.platformRole),
    };
  }

  @Post('team')
  @RequirePermissions(PERMISSIONS.TEAM_ANALYTICS_VIEW)
  async team(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodPipe(askSchema)) body: z.infer<typeof askSchema>,
    @Headers('accept-language') acceptLanguage?: string,
  ) {
    const locale = acceptLanguage?.split(',')[0]?.trim().slice(0, 2).toLowerCase();
    return await this.coach.askTeam(this.actor(user), {
      question: body.question,
      window: body.window,
      locale: locale === 'th' ? 'th' : 'en',
    });
  }
}
