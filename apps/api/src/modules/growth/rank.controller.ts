import { Body, Controller, ForbiddenException, Get, Post } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';
import { ENTITLEMENTS, ERROR_CODES, PERMISSIONS } from '@aviora/shared';
import {
  CurrentUser,
  RequireEntitlements,
  RequirePermissions,
  type AuthenticatedUser,
} from '../../common/auth/decorators';
import { CLS_MEMBER_ID } from '../../common/auth/permissions.guard';
import { ZodPipe } from '../../common/validation/zod.pipe';
import { RANK_COMPARATORS, RANK_METRICS, RANK_WINDOWS } from './metrics';
import { RankService } from './rank.service';

const qualificationSchema = z.object({
  metric: z.enum(RANK_METRICS),
  comparator: z.enum(RANK_COMPARATORS).default('gte'),
  threshold: z.number().int().min(0).max(1_000_000_000_000),
  window: z.enum(RANK_WINDOWS).default('lifetime'),
  params: z.record(z.unknown()).optional(),
});

const createSchema = z.object({
  code: z.string().regex(/^[a-z0-9-]{2,40}$/),
  name: z.string().min(1).max(160),
  level: z.number().int().min(0).max(1000),
  status: z.enum(['active', 'archived']).optional(),
  requalifyWindowDays: z.number().int().positive().max(3650).optional(),
  /** Course ids to suggest on the way to this rank (docs/27 §3). */
  recommendedCourseIds: z.array(z.string().uuid()).max(20).optional(),
  qualifications: z.array(qualificationSchema).max(20).default([]),
});

const evaluateSchema = z.object({
  memberId: z.string().uuid().optional(),
  asOf: z.coerce.date().optional(),
});

/**
 * Administration and evaluation are permission-scoped only; `growth.ranks`
 * gates the member-facing dashboard (docs/25 §4).
 */
@Controller('ranks')
export class RankController {
  constructor(
    private readonly ranks: RankService,
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
  @RequirePermissions(PERMISSIONS.RANK_VIEW)
  async list() {
    return await this.ranks.list();
  }

  @Post()
  @RequirePermissions(PERMISSIONS.RANK_MANAGE)
  async create(@Body(new ZodPipe(createSchema)) body: z.infer<typeof createSchema>) {
    return { rank: await this.ranks.create(body) };
  }

  @Get('me')
  @RequirePermissions(PERMISSIONS.RANK_VIEW)
  @RequireEntitlements(ENTITLEMENTS.RANKS)
  async me() {
    return await this.ranks.me(this.memberId());
  }

  @Post('evaluate')
  @RequirePermissions(PERMISSIONS.RANK_MANAGE)
  async evaluate(
    @Body(new ZodPipe(evaluateSchema)) body: z.infer<typeof evaluateSchema>,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return await this.ranks.evaluate(body.memberId, body.asOf ?? new Date(), user.userId);
  }
}
