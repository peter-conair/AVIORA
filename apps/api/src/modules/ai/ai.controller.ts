import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';
import { ENTITLEMENTS, PERMISSIONS } from '@aviora/shared';
import { RequireEntitlements, RequirePermissions } from '../../common/auth/decorators';
import { CLS_MEMBER_ID } from '../../common/auth/permissions.guard';
import { ZodPipe } from '../../common/validation/zod.pipe';
import { AiService } from './ai.service';

const askSchema = z.object({
  question: z.string().min(2).max(2000),
  conversationId: z.string().uuid().optional(),
});

@Controller('ai')
export class AiController {
  constructor(
    private readonly ai: AiService,
    private readonly cls: ClsService,
  ) {}

  private memberId(): string | null {
    return (this.cls.get(CLS_MEMBER_ID) as string | undefined) ?? null;
  }

  @Get('usage')
  @RequirePermissions(PERMISSIONS.AI_ASSISTANT_USE)
  async usage() {
    return await this.ai.usage(this.memberId());
  }

  @Get('conversations')
  @RequirePermissions(PERMISSIONS.AI_ASSISTANT_USE)
  async conversations() {
    return { conversations: await this.ai.conversations(this.memberId()) };
  }

  @Get('conversations/:id')
  @RequirePermissions(PERMISSIONS.AI_ASSISTANT_USE)
  async conversation(@Param('id', ParseUUIDPipe) id: string) {
    return { conversation: await this.ai.conversation(id, this.memberId()) };
  }

  /** The assistant itself is an entitlement-gated capability (docs/04). */
  @Post('ask')
  @RequirePermissions(PERMISSIONS.AI_ASSISTANT_USE)
  @RequireEntitlements(ENTITLEMENTS.AI_COACH)
  async ask(@Body(new ZodPipe(askSchema)) body: z.infer<typeof askSchema>) {
    return await this.ai.ask(this.memberId(), body);
  }
}
