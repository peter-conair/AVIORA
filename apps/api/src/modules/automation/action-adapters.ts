import { Injectable } from '@nestjs/common';
import type { DomainEventEnvelope } from '@aviora/shared';
import { withTenant } from '@aviora/db';
import { PrismaService } from '../../common/db/prisma.service';
import { NotificationsService } from '../notification/notifications.service';
import { RewardService } from '../reward/reward.service';
import { ensureCourseAccess } from '../learning/course-access';
import { isSupportedAction, type RuleAction } from './rules';

export interface ActionContext {
  tenantId: string;
  memberId: string;
  ruleCode: string;
  event: DomainEventEnvelope;
}

const DAY_MS = 86_400_000;
const DEFAULT_FOLLOWUP_DAYS = 3;

/**
 * The four actions that have somewhere to go (docs/27 §1). Each hands off to
 * the module that owns the thing — notifications, rewards, CRM, learning —
 * rather than writing that module's rows itself, and none of them appends an
 * event: automation emits nothing (docs/27 §6).
 *
 * Every adapter runs from the outbox relay, which has no request and therefore
 * no tenant context, so each opens its own tenant-scoped transaction.
 */
@Injectable()
export class ActionAdapters {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly rewards: RewardService,
  ) {}

  async run(action: RuleAction, ctx: ActionContext): Promise<Record<string, unknown>> {
    // Rules are validated at creation, so an unknown type here means a row was
    // written around the API — refuse it rather than treat it as a no-op.
    if (!isSupportedAction(action.type)) {
      throw new Error(`'${action.type}' has no adapter`);
    }
    // An action is `{ type, ...config }`: the configuration IS the rest of it.
    const config = action as Record<string, unknown>;

    switch (action.type) {
      case 'send_notification': {
        const type = str(config.notificationType) ?? 'automation';
        await this.notifications.deliver({
          tenantId: ctx.tenantId,
          memberId: ctx.memberId,
          type,
          title: str(config.title) ?? 'Automation',
          body: str(config.body),
          link: str(config.link),
        });
        // `deliver` respects the member's preferences, so "delivered" here means
        // handed over, not necessarily written.
        return { notificationType: type };
      }

      case 'grant_reward': {
        const grant = await this.rewards.grant({
          tenantId: ctx.tenantId,
          rewardCode: str(config.rewardCode) ?? '',
          memberId: ctx.memberId,
          sourceType: 'automation',
          sourceRef: ctx.ruleCode,
          actorUserId: ctx.event.actorUserId,
        });
        return { grantId: grant.id, rewardCode: str(config.rewardCode) };
      }

      case 'create_followup': {
        const dueAt = new Date(
          Date.now() + (num(config.dueInDays) ?? DEFAULT_FOLLOWUP_DAYS) * DAY_MS,
        );
        return withTenant(this.prisma.app, ctx.tenantId, async (tx) => {
          // "The member's owner" is whoever owns them as a CRM customer. A
          // member nobody owns gets the follow-up themselves rather than none:
          // an unowned task is a task that never happens.
          const customer = await tx.customer.findFirst({
            where: { memberId: ctx.memberId },
            select: { id: true, ownerMemberId: true },
          });
          const followUp = await tx.followUp.create({
            data: {
              tenantId: ctx.tenantId,
              ownerMemberId: customer?.ownerMemberId ?? ctx.memberId,
              customerId: customer?.id,
              title: str(config.title) ?? 'Follow up',
              notes: str(config.notes),
              dueAt,
            },
          });
          return {
            followUpId: followUp.id,
            ownerMemberId: followUp.ownerMemberId,
            ownedByCustomerRecord: customer !== null,
          };
        });
      }

      case 'assign_course': {
        const courseId = str(config.courseId) ?? '';
        return withTenant(this.prisma.app, ctx.tenantId, async (tx) => {
          const access = await ensureCourseAccess(tx, ctx.tenantId, ctx.memberId, courseId);
          return { courseId, progressId: access.progressId, started: access.started };
        });
      }
    }
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
