import { BadRequestException, Body, Controller, Get, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { ERROR_CODES } from '@aviora/shared';
import { RequirePlatformRoles } from '../../common/auth/decorators';
import { ZodPipe } from '../../common/validation/zod.pipe';
import { PrismaService } from '../../common/db/prisma.service';
import { SCHEDULER_JOBS, SchedulerService, TENANT_JOBS } from './scheduler.service';

const MAX_LIMIT = 200;

const runSchema = z.object({
  job: z.enum(SCHEDULER_JOBS),
  /** Null and absent both mean "no tenant" — a platform job belongs to none. */
  tenantId: z.string().uuid().nullish(),
  /** Omitted means the occurrence happening now — what "run it" means at 3am. */
  scheduledFor: z.coerce.date().optional(),
});

/**
 * Operating the schedule (docs/35 §5).
 *
 * Platform scope, because the schedule is the platform's machinery and not a
 * tenant's: the listing answers "did it run" across every tenant, and one
 * tenant must not be able to read another's runs or force another's job.
 *
 * There is deliberately no route here that approves anything. The forced run
 * calls the same job the timer calls, and `commission.draft` drafts.
 */
@RequirePlatformRoles('PLATFORM_OWNER', 'SUPER_ADMIN')
@Controller('platform/scheduler')
export class SchedulerController {
  constructor(
    private readonly scheduler: SchedulerService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('runs')
  async list(
    @Query('job') job?: string,
    @Query('tenantId') tenantId?: string,
    @Query('status') status?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const take = Math.min(Number(limit) || 50, MAX_LIMIT);
    const rows = await this.prisma.owner.scheduledJobRun.findMany({
      where: {
        ...(job ? { job } : {}),
        ...(tenantId ? { tenantId } : {}),
        ...(status ? { status } : {}),
      },
      orderBy: [{ scheduledFor: 'desc' }, { createdAt: 'desc' }],
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > take;
    const items = hasMore ? rows.slice(0, take) : rows;
    return {
      runs: items,
      nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
    };
  }

  @Post('run')
  async run(@Body(new ZodPipe(runSchema)) body: z.infer<typeof runSchema>) {
    const perTenant = TENANT_JOBS.includes(body.job);
    if (perTenant && !body.tenantId) {
      throw new BadRequestException({
        code: ERROR_CODES.VALIDATION_FAILED,
        message: `${body.job} runs per tenant, so it needs a tenantId`,
      });
    }
    if (!perTenant && body.tenantId) {
      throw new BadRequestException({
        code: ERROR_CODES.VALIDATION_FAILED,
        message: `${body.job} is platform-wide and belongs to no tenant`,
      });
    }
    const run = await this.scheduler.runNow(body.job, body.tenantId ?? null, body.scheduledFor);
    return { run };
  }
}
