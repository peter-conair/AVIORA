import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { withTenant } from '@aviora/db';
import type { DomainEventEnvelope, EventName } from '@aviora/shared';
import { PrismaService } from '../../common/db/prisma.service';
import {
  HEALTH_DENIED_EVENTS,
  MAX_DELIVERY_ATTEMPTS,
  WEBHOOK_HEADERS,
  signWebhook,
  webhookBody,
} from './webhook';
import { WebhookService } from './webhook.service';

const POLL_MS = 2000;
const BATCH = 10;
const POST_TIMEOUT_MS = 10_000;

interface ClaimedRow {
  id: string;
  tenant_id: string;
  endpoint_id: string;
  event_id: string;
  event_name: string;
  attempts: number;
}

interface Settlement {
  status: 'delivered' | 'pending' | 'failed';
  responseCode: number | null;
  error: string | null;
}

/**
 * Webhook delivery (docs/30 §1).
 *
 * Two halves, deliberately split:
 *
 * 1. `record()` runs INSIDE the outbox relay, as one more handler on the
 *    existing event bus — the same seat automation took. It writes one
 *    `webhook_deliveries` row per subscribed endpoint and returns. It does no
 *    network I/O at all, because the relay holds a database transaction open
 *    while its handlers run and an unreachable customer server must not be
 *    able to hold that transaction hostage.
 * 2. `tick()` sends what has been recorded. It claims due rows by bumping
 *    `attempts` and pushing `next_attempt_at` forward in one statement — the
 *    claim IS the attempt count — then posts outside any transaction. A
 *    process that dies mid-post leaves the row due again after its backoff
 *    rather than lost or double-sent.
 *
 * `UNIQUE (endpoint_id, event_id)` is the arbiter. The row is inserted BEFORE
 * anything is posted, so a replayed event collides on the key and notifies
 * nobody a second time — the same defence commission runs, subscription
 * renewals and automation all rest on.
 */
@Injectable()
export class WebhookDispatcher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WebhookDispatcher.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly webhooks: WebhookService,
  ) {}

  onModuleInit() {
    // Same switch the outbox relay honours: a test that drives the relay by
    // hand must be able to drive delivery by hand too, or the two race.
    if (process.env.AVIORA_OUTBOX_DISABLED === 'true') return;
    this.timer = setInterval(() => void this.tick(), POLL_MS);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** The event-bus handler. Records intent; never posts, never swallows a DB error. */
  async record(event: DomainEventEnvelope): Promise<void> {
    // Platform-scope events (tenant_id NULL) belong to no tenant's subscriptions.
    if (!event.tenantId) return;

    if (HEALTH_DENIED_EVENTS.has(event.eventName)) {
      this.logger.log(
        `event ${event.eventName} (${event.eventId}) not forwarded: it carries health ` +
          `context and is on the webhook deny-list (docs/30 §7)`,
      );
      return;
    }

    const tenantId = event.tenantId;
    const endpoints = await withTenant(this.prisma.app, tenantId, (tx) =>
      tx.webhookEndpoint.findMany({
        where: { status: 'active', events: { has: event.eventName } },
        select: { id: true },
      }),
    );
    if (endpoints.length === 0) return;

    for (const endpoint of endpoints) {
      try {
        await withTenant(this.prisma.app, tenantId, (tx) =>
          tx.webhookDelivery.create({
            data: {
              tenantId,
              endpointId: endpoint.id,
              eventId: event.eventId,
              eventName: event.eventName,
              status: 'pending',
              nextAttemptAt: new Date(),
            },
          }),
        );
      } catch (e) {
        // (endpoint_id, event_id) already claimed — a replay, or a second relay
        // instance. Expected, and the whole point of the unique key.
        if ((e as { code?: string } | null)?.code === 'P2002') continue;
        throw e;
      }
    }
  }

  /**
   * Sends everything due. Runs as the owner client because delivery is a
   * cross-tenant system job, exactly as the outbox relay is.
   */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const claimed = await this.claim();
      if (claimed.length === 0) return;

      const endpoints = new Map(
        (
          await this.prisma.owner.webhookEndpoint.findMany({
            where: { id: { in: [...new Set(claimed.map((c) => c.endpoint_id))] } },
          })
        ).map((e) => [e.id, e]),
      );
      const events = new Map(
        (
          await this.prisma.owner.domainEvent.findMany({
            where: { id: { in: [...new Set(claimed.map((c) => c.event_id))] } },
          })
        ).map((e) => [e.id, e]),
      );

      for (const row of claimed) {
        const settlement = await this.attempt(row, endpoints.get(row.endpoint_id), {
          event: events.get(row.event_id),
        });
        await this.settle(row.id, settlement);
      }
    } catch (e) {
      this.logger.error('webhook dispatch tick failed', e as Error);
    } finally {
      this.running = false;
    }
  }

  /**
   * Claims due deliveries: one statement that increments `attempts` and pushes
   * `next_attempt_at` to the exponential backoff for THIS attempt. Doing both
   * in the claim is what makes a crash mid-post safe — the row simply comes
   * back round later instead of being retried instantly forever.
   */
  private async claim(): Promise<ClaimedRow[]> {
    return this.prisma.owner.$queryRaw<ClaimedRow[]>`
      UPDATE webhook_deliveries d
         SET attempts = d.attempts + 1,
             next_attempt_at =
               now() + make_interval(secs => LEAST(5 * power(2, d.attempts), 600)::int)
        FROM (
          SELECT id FROM webhook_deliveries
           WHERE status = 'pending'
             AND (next_attempt_at IS NULL OR next_attempt_at <= now())
           ORDER BY created_at
           LIMIT ${BATCH}
             FOR UPDATE SKIP LOCKED
        ) AS due
       WHERE d.id = due.id
      RETURNING d.id, d.tenant_id, d.endpoint_id, d.event_id, d.event_name, d.attempts`;
  }

  private async attempt(
    row: ClaimedRow,
    endpoint:
      { id: string; url: string; status: string; secretHash: string; events: string[] } | undefined,
    context: {
      event:
        | {
            id: string;
            eventName: string;
            tenantId: string | null;
            aggregateType: string;
            aggregateId: string;
            actorUserId: string | null;
            payload: unknown;
            occurredAt: Date;
          }
        | undefined;
    },
  ): Promise<Settlement> {
    if (!endpoint) return this.give(row, 'The endpoint no longer exists');
    if (endpoint.status !== 'active') return this.give(row, 'The endpoint is disabled');

    // Checked again here, not only at record time. The deny-list is the
    // structural promise that no health context leaves the platform, and a
    // promise enforced at exactly one point is a promise one refactor away
    // from being untrue.
    if (HEALTH_DENIED_EVENTS.has(row.event_name)) {
      this.logger.warn(
        `delivery ${row.id} dropped: ${row.event_name} is on the webhook deny-list (docs/30 §7)`,
      );
      return this.give(row, `${row.event_name} carries health context and is never forwarded`);
    }

    if (!context.event) return this.give(row, 'The event is no longer available to send');

    const secret = this.webhooks.secretMatches(endpoint.id, endpoint.secretHash);
    if (!secret) {
      return this.give(
        row,
        'The webhook signing key has changed since this endpoint was created; ' +
          'recreate the endpoint to mint a new secret',
      );
    }

    const envelope: DomainEventEnvelope = {
      eventId: context.event.id,
      eventName: context.event.eventName as EventName,
      tenantId: context.event.tenantId,
      aggregateType: context.event.aggregateType,
      aggregateId: context.event.aggregateId,
      actorUserId: context.event.actorUserId,
      payload: context.event.payload,
      occurredAt: context.event.occurredAt.toISOString(),
      version: 1,
    };
    const body = JSON.stringify(webhookBody(envelope));
    const timestamp = Math.floor(Date.now() / 1000);

    try {
      const res = await fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [WEBHOOK_HEADERS.event]: row.event_name,
          [WEBHOOK_HEADERS.delivery]: row.id,
          [WEBHOOK_HEADERS.timestamp]: String(timestamp),
          [WEBHOOK_HEADERS.signature]: signWebhook(secret, timestamp, body),
        },
        body,
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      });
      if (res.ok) {
        return { status: 'delivered', responseCode: res.status, error: null };
      }
      const text = await res.text().catch(() => '');
      return {
        ...this.give(row, text.slice(0, 900) || `Receiver answered ${res.status}`),
        responseCode: res.status,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return this.give(row, message.slice(0, 900));
    }
  }

  /**
   * A failed attempt: still `pending` while attempts remain, `failed` once they
   * are spent. Either way the response code and the error text are kept —
   * "it didn't work" is not a support answer (docs/30 §1).
   */
  private give(row: ClaimedRow, error: string): Settlement {
    return {
      status: row.attempts >= MAX_DELIVERY_ATTEMPTS ? 'failed' : 'pending',
      responseCode: null,
      error,
    };
  }

  private async settle(deliveryId: string, settlement: Settlement): Promise<void> {
    await this.prisma.owner.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: settlement.status,
        responseCode: settlement.responseCode,
        error: settlement.error,
        ...(settlement.status === 'delivered'
          ? { deliveredAt: new Date(), nextAttemptAt: null }
          : {}),
        ...(settlement.status === 'failed' ? { nextAttemptAt: null } : {}),
      },
    });
  }
}
