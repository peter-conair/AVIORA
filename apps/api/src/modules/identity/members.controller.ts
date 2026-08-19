import { Body, Controller, ForbiddenException, Get, Patch } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';
import { ERROR_CODES, PERMISSIONS } from '@aviora/shared';
import { RequirePermissions } from '../../common/auth/decorators';
import { CLS_MEMBER_ID } from '../../common/auth/permissions.guard';
import { TenantDb } from '../../common/db/tenant-db.service';
import { ZodPipe } from '../../common/validation/zod.pipe';

const updateMeSchema = z.object({
  displayName: z.string().min(1).max(120).optional(),
});

@Controller('members')
export class MembersController {
  constructor(
    private readonly db: TenantDb,
    private readonly cls: ClsService,
  ) {}

  @Get()
  @RequirePermissions(PERMISSIONS.MEMBER_VIEW)
  async list() {
    const members = await this.db.tx((tx) =>
      tx.member.findMany({
        orderBy: { joinedAt: 'asc' },
        select: {
          id: true,
          displayName: true,
          status: true,
          joinedAt: true,
          user: { select: { email: true } },
          memberRoles: { select: { role: { select: { code: true, name: true } } } },
        },
      }),
    );
    return {
      members: members.map((m) => ({
        id: m.id,
        displayName: m.displayName,
        status: m.status,
        joinedAt: m.joinedAt,
        email: m.user.email,
        roles: m.memberRoles.map((r) => r.role.code),
      })),
    };
  }

  /** Any authenticated member of the tenant can read their own profile. */
  @Get('me')
  @RequirePermissions(PERMISSIONS.GOAL_VIEW)
  async me() {
    const memberId = this.requireMemberId();
    const member = await this.db.tx((tx) =>
      tx.member.findFirst({
        where: { id: memberId },
        select: {
          id: true,
          displayName: true,
          status: true,
          joinedAt: true,
          memberRoles: { select: { role: { select: { code: true, name: true } } } },
        },
      }),
    );
    return { member };
  }

  @Patch('me')
  @RequirePermissions(PERMISSIONS.GOAL_VIEW)
  async updateMe(@Body(new ZodPipe(updateMeSchema)) body: z.infer<typeof updateMeSchema>) {
    const memberId = this.requireMemberId();
    const member = await this.db.tx((tx) =>
      tx.member.update({
        where: { id: memberId },
        data: { displayName: body.displayName },
        select: { id: true, displayName: true },
      }),
    );
    return { member };
  }

  private requireMemberId(): string {
    const memberId = this.cls.get(CLS_MEMBER_ID) as string | undefined;
    if (!memberId) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'You are not a member of this tenant',
      });
    }
    return memberId;
  }
}
