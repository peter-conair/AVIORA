import { Controller, Get, Query } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { CurrentUser, type AuthenticatedUser } from '../../common/auth/decorators';
import { CLS_MEMBER_ID, PLATFORM_BYPASS } from '../../common/auth/permissions.guard';
import type { TeamActor } from '../team/team-scope.service';
import { LearningPathService } from './learning-path.service';

/**
 * A member's own path. Like the start path (docs/63 §5) it needs no permission
 * beyond membership — gating the screen that says what to learn behind a grant
 * hides it from exactly the person who needs it.
 */
@Controller('learning-path')
export class LearningPathController {
  constructor(
    private readonly path: LearningPathService,
    private readonly cls: ClsService,
  ) {}

  @Get()
  async mine(@CurrentUser() user: AuthenticatedUser, @Query('locale') locale?: string) {
    const actor: TeamActor = {
      memberId: (this.cls.get(CLS_MEMBER_ID) as string | undefined) ?? null,
      platformBypass: !!user.platformRole && PLATFORM_BYPASS.has(user.platformRole),
    };
    return this.path.forMember(actor, locale === 'en' ? 'en' : 'th');
  }
}
