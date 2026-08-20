import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ERROR_CODES, EVENTS, PERMISSIONS } from '@aviora/shared';
import { appendEvent, type Tx } from '@aviora/db';
import { TenantDb } from '../../common/db/tenant-db.service';
import { AuditService } from '../../common/audit/audit.service';
import type { TeamActor } from '../team/team-scope.service';
import { CommerceScopeService } from './commerce-scope.service';
import {
  addInterval,
  advanceTo,
  isOrderNumberConflict,
  isUniqueViolation,
  todayUtc,
  withOrderNumber,
} from './billing';

export interface RenewalResult {
  subscriptionId: string;
  orderId: string;
  number: string;
  scheduledFor: string;
  nextRunOn: string;
}

/**
 * Standing orders (docs/24 §40). The interval is data — `intervalUnit` ×
 * `intervalCount` — so monthly, quarterly and every custom cadence are one
 * code path, and adding a cadence never means adding a branch.
 */
@Injectable()
export class SubscriptionService {
  constructor(
    private readonly db: TenantDb,
    private readonly scope: CommerceScopeService,
    private readonly audit: AuditService,
  ) {}

  list(actor: TeamActor) {
    return this.db.tx(async (tx) => {
      const members = await this.scope.memberIds(
        tx,
        actor,
        PERMISSIONS.COMMERCE_SUBSCRIPTION_MANAGE,
      );
      return tx.subscription.findMany({
        where: this.scope.whereMember(members),
        orderBy: { nextRunOn: 'asc' },
        include: { offering: { select: { code: true, name: true } } },
      });
    });
  }

  async pause(id: string, actor: TeamActor, actorUserId: string) {
    const subscription = await this.db.tx(async (tx) => {
      const existing = await this.forUpdate(tx, id, actor);
      if (existing.status !== 'active') {
        throw new ConflictException({
          code: ERROR_CODES.CONFLICT,
          message: `A subscription that is ${existing.status} cannot be paused`,
        });
      }
      const paused = await tx.subscription.update({
        where: { id: existing.id },
        data: { status: 'paused', pausedAt: new Date() },
      });
      await appendEvent(tx, {
        eventName: EVENTS.SubscriptionPaused,
        tenantId: this.db.tenantId,
        aggregateType: 'subscription',
        aggregateId: existing.id,
        actorUserId,
        payload: { memberId: existing.memberId, offeringId: existing.offeringId },
      });
      return paused;
    });
    await this.audit.record({
      action: 'commerce.subscription.pause',
      entityType: 'subscription',
      entityId: subscription.id,
      after: { status: subscription.status },
    });
    return subscription;
  }

  async resume(id: string, actor: TeamActor, actorUserId: string) {
    const subscription = await this.db.tx(async (tx) => {
      const existing = await this.forUpdate(tx, id, actor);
      if (existing.status !== 'paused') {
        throw new ConflictException({
          code: ERROR_CODES.CONFLICT,
          message: `A subscription that is ${existing.status} cannot be resumed`,
        });
      }
      const nextRunOn = advanceTo(
        existing.nextRunOn,
        todayUtc(),
        existing.intervalUnit,
        existing.intervalCount,
      );
      const resumed = await tx.subscription.update({
        where: { id: existing.id },
        data: { status: 'active', pausedAt: null, nextRunOn },
      });
      await appendEvent(tx, {
        eventName: EVENTS.SubscriptionResumed,
        tenantId: this.db.tenantId,
        aggregateType: 'subscription',
        aggregateId: existing.id,
        actorUserId,
        payload: {
          memberId: existing.memberId,
          nextRunOn: nextRunOn.toISOString().slice(0, 10),
        },
      });
      return resumed;
    });
    await this.audit.record({
      action: 'commerce.subscription.resume',
      entityType: 'subscription',
      entityId: subscription.id,
      after: { status: subscription.status, nextRunOn: subscription.nextRunOn },
    });
    return subscription;
  }

  /** Skipping consumes a cycle: the run is recorded, no order is created. */
  async skip(id: string, actor: TeamActor) {
    const subscription = await this.db
      .tx(async (tx) => {
        const existing = await this.forUpdate(tx, id, actor);
        if (existing.status !== 'active') {
          throw new ConflictException({
            code: ERROR_CODES.CONFLICT,
            message: `A subscription that is ${existing.status} cannot skip a cycle`,
          });
        }
        await tx.subscriptionRun.create({
          data: {
            tenantId: this.db.tenantId,
            subscriptionId: existing.id,
            scheduledFor: existing.nextRunOn,
            outcome: 'skipped',
          },
        });
        return tx.subscription.update({
          where: { id: existing.id },
          data: {
            nextRunOn: addInterval(
              existing.nextRunOn,
              existing.intervalUnit,
              existing.intervalCount,
            ),
          },
        });
      })
      .catch((e: unknown) => {
        if (!isUniqueViolation(e)) throw e;
        throw new ConflictException({
          code: ERROR_CODES.CONFLICT,
          message: 'This cycle has already been processed',
        });
      });
    await this.audit.record({
      action: 'commerce.subscription.skip',
      entityType: 'subscription',
      entityId: subscription.id,
      after: { nextRunOn: subscription.nextRunOn },
    });
    return subscription;
  }

  async cancel(id: string, actor: TeamActor, actorUserId: string) {
    const subscription = await this.db.tx(async (tx) => {
      const existing = await this.forUpdate(tx, id, actor);
      if (existing.status === 'cancelled') {
        throw new ConflictException({
          code: ERROR_CODES.CONFLICT,
          message: 'This subscription is already cancelled',
        });
      }
      const cancelled = await tx.subscription.update({
        where: { id: existing.id },
        data: { status: 'cancelled', cancelledAt: new Date(), autoRenew: false },
      });
      await appendEvent(tx, {
        eventName: EVENTS.SubscriptionCancelled,
        tenantId: this.db.tenantId,
        aggregateType: 'subscription',
        aggregateId: existing.id,
        actorUserId,
        payload: { memberId: existing.memberId, offeringId: existing.offeringId },
      });
      return cancelled;
    });
    await this.audit.record({
      action: 'commerce.subscription.cancel',
      entityType: 'subscription',
      entityId: subscription.id,
      after: { status: subscription.status },
    });
    return subscription;
  }

  /**
   * Scheduler tick: bills every active subscription due on or before `asOf`.
   * Paused subscriptions are never selected, so they accrue nothing while paused.
   */
  async runDue(asOf: Date, actorUserId: string) {
    const due = await this.db.tx((tx) =>
      tx.subscription.findMany({
        where: { status: 'active', autoRenew: true, nextRunOn: { lte: asOf } },
        orderBy: { nextRunOn: 'asc' },
        select: { id: true },
      }),
    );

    const renewed: RenewalResult[] = [];
    const alreadyBilled: string[] = [];
    for (const { id } of due) {
      try {
        const result = await this.renewOne(id, asOf, actorUserId);
        if (result) renewed.push(result);
      } catch (e) {
        // The unique key on (subscriptionId, scheduledFor) is what stops double
        // billing: a repeated tick — or two ticks racing — loses here and the
        // cycle is left exactly as the winner wrote it.
        if (isUniqueViolation(e) && !isOrderNumberConflict(e)) {
          alreadyBilled.push(id);
          continue;
        }
        throw e;
      }
    }
    return { asOf, dueCount: due.length, renewed, alreadyBilled };
  }

  private renewOne(id: string, asOf: Date, actorUserId: string): Promise<RenewalResult | null> {
    return withOrderNumber((orderNumber) =>
      this.db.tx(async (tx) => {
        const subscription = await tx.subscription.findFirst({
          where: { id, status: 'active', autoRenew: true, nextRunOn: { lte: asOf } },
        });
        if (!subscription) return null;
        const offering = await tx.offering.findFirst({
          where: { id: subscription.offeringId },
        });
        if (!offering) return null;

        // Inserted BEFORE the order on purpose — the constraint, not a prior
        // read, is what makes this cycle billable exactly once.
        const run = await tx.subscriptionRun.create({
          data: {
            tenantId: this.db.tenantId,
            subscriptionId: subscription.id,
            scheduledFor: subscription.nextRunOn,
            outcome: 'ordered',
          },
        });

        const totalMinor = subscription.priceMinor * subscription.quantity;
        const order = await tx.order.create({
          data: {
            tenantId: this.db.tenantId,
            memberId: subscription.memberId,
            number: orderNumber,
            currency: subscription.currency,
            subtotalMinor: totalMinor,
            totalMinor,
            subscriptionId: subscription.id,
          },
        });
        await tx.orderItem.create({
          data: {
            tenantId: this.db.tenantId,
            orderId: order.id,
            offeringId: offering.id,
            name: offering.name,
            quantity: subscription.quantity,
            unitPriceMinor: subscription.priceMinor,
            lineTotalMinor: totalMinor,
          },
        });
        await tx.subscriptionRun.update({ where: { id: run.id }, data: { orderId: order.id } });

        const nextRunOn = addInterval(
          subscription.nextRunOn,
          subscription.intervalUnit,
          subscription.intervalCount,
        );
        await tx.subscription.update({ where: { id: subscription.id }, data: { nextRunOn } });
        await appendEvent(tx, {
          eventName: EVENTS.SubscriptionRenewed,
          tenantId: this.db.tenantId,
          aggregateType: 'subscription',
          aggregateId: subscription.id,
          actorUserId,
          payload: {
            memberId: subscription.memberId,
            orderId: order.id,
            number: order.number,
            totalMinor,
            currency: order.currency,
            scheduledFor: subscription.nextRunOn.toISOString().slice(0, 10),
            nextRunOn: nextRunOn.toISOString().slice(0, 10),
          },
        });
        return {
          subscriptionId: subscription.id,
          orderId: order.id,
          number: order.number,
          scheduledFor: subscription.nextRunOn.toISOString().slice(0, 10),
          nextRunOn: nextRunOn.toISOString().slice(0, 10),
        };
      }),
    );
  }

  private async forUpdate(tx: Tx, id: string, actor: TeamActor) {
    const subscription = await tx.subscription.findFirst({ where: { id } });
    const members = await this.scope.memberIds(tx, actor, PERMISSIONS.COMMERCE_SUBSCRIPTION_MANAGE);
    if (!subscription || !this.scope.canAccess(members, subscription.memberId)) {
      throw new NotFoundException({
        code: ERROR_CODES.NOT_FOUND,
        message: 'Subscription not found',
      });
    }
    return subscription;
  }
}
