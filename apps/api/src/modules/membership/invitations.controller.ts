import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';
import { PERMISSIONS } from '@aviora/shared';
import { Public, RequirePermissions } from '../../common/auth/decorators';
import { CLS_MEMBER_ID } from '../../common/auth/permissions.guard';
import { ZodPipe } from '../../common/validation/zod.pipe';
import { InvitationsService } from './invitations.service';

const inviteSchema = z.object({
  email: z.string().email(),
  planId: z.string().uuid(),
});

const acceptSchema = z.object({
  displayName: z.string().min(1).max(120),
  password: z.string().min(10).max(200),
});

@Controller('invitations')
export class InvitationsController {
  constructor(
    private readonly invitations: InvitationsService,
    private readonly cls: ClsService,
  ) {}

  @Post()
  @RequirePermissions(PERMISSIONS.MEMBER_INVITE)
  async invite(@Body(new ZodPipe(inviteSchema)) body: z.infer<typeof inviteSchema>) {
    const memberId = (this.cls.get(CLS_MEMBER_ID) as string | undefined) ?? null;
    const invitation = await this.invitations.invite(body, memberId);
    return {
      invitation: {
        id: invitation.id,
        email: invitation.email,
        status: invitation.status,
        expiresAt: invitation.expiresAt,
      },
    };
  }

  @Get()
  @RequirePermissions(PERMISSIONS.MEMBER_INVITE)
  async list() {
    return { invitations: await this.invitations.list() };
  }

  @Public()
  @Get(':token')
  async inspect(@Param('token') token: string) {
    return { invitation: await this.invitations.inspect(token) };
  }

  @Public()
  @HttpCode(201)
  @Post(':token/accept')
  async accept(
    @Param('token') token: string,
    @Body(new ZodPipe(acceptSchema)) body: z.infer<typeof acceptSchema>,
  ) {
    return await this.invitations.accept(token, body);
  }
}
