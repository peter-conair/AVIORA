import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ERROR_CODES, newId } from '@aviora/shared';
import { AuditService } from '../../common/audit/audit.service';
import { TenantDb } from '../../common/db/tenant-db.service';
import {
  deriveEndpointSecret,
  sha256Hex,
  timingSafeEquals,
  type EndpointCreate,
  type EndpointUpdate,
} from './webhook';

export interface EndpointView {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

interface EndpointRow extends EndpointView {
  secretHash: string;
}

function view(row: EndpointRow | (EndpointView & Record<string, unknown>)): EndpointView {
  return {
    id: row.id,
    url: row.url,
    description: row.description,
    events: row.events,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Webhook endpoints and their delivery log (docs/30 §1, §6).
 *
 * The secret is returned exactly once, by `create`. No method on this class
 * reads it back, and none may: an endpoint whose secret can be read back is a
 * secret the platform is holding on the customer's behalf for no reason
 * (docs/30 §2). Losing it means a new endpoint.
 */
@Injectable()
export class WebhookService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<EndpointView[]> {
    const rows = await this.db.tx((tx) =>
      tx.webhookEndpoint.findMany({ orderBy: { createdAt: 'desc' } }),
    );
    return rows.map(view);
  }

  /** Returns the secret ONCE. Every later read of this endpoint omits it. */
  async create(input: EndpointCreate): Promise<{ endpoint: EndpointView; secret: string }> {
    // The id is minted here rather than by the database because the secret is
    // derived FROM it (see webhook.ts §rootKey) — the row and its secret have
    // to agree, and they cannot if the id only exists after the insert.
    const id = newId();
    const secret = deriveEndpointSecret(id);

    const row = await this.db.tx((tx) =>
      tx.webhookEndpoint.create({
        data: {
          id,
          tenantId: this.db.tenantId,
          url: input.url,
          description: input.description ?? null,
          secretHash: sha256Hex(secret),
          events: input.events,
          status: 'active',
        },
      }),
    );

    await this.audit.record({
      action: 'integration.webhook.create',
      entityType: 'webhook_endpoint',
      entityId: row.id,
      after: { url: row.url, events: row.events, status: row.status },
    });

    return { endpoint: view(row as EndpointRow), secret };
  }

  async update(id: string, input: EndpointUpdate): Promise<EndpointView> {
    const result = await this.db.tx(async (tx) => {
      const before = await tx.webhookEndpoint.findFirst({ where: { id } });
      if (!before) return null;
      const after = await tx.webhookEndpoint.update({
        where: { id },
        data: {
          ...(input.events !== undefined ? { events: input.events } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
        },
      });
      return { before, after };
    });
    if (!result) throw this.missing();

    await this.audit.record({
      action: 'integration.webhook.update',
      entityType: 'webhook_endpoint',
      entityId: id,
      before: { events: result.before.events, status: result.before.status },
      after: { events: result.after.events, status: result.after.status },
    });
    return view(result.after as EndpointRow);
  }

  /**
   * DECISION (docs/30 §6 lists DELETE without saying what happens to the log).
   *
   * `webhook_deliveries.endpoint_id` is ON DELETE RESTRICT, so the delivery
   * rows cannot outlive the endpoint — the choice is between deleting them
   * with it and refusing the delete entirely. Deleting wins: an endpoint a
   * tenant has removed is one they no longer want the platform holding URLs
   * and delivery bodies for, and "you cannot delete this, ever" is not an
   * answer. The audit entry records the url and how many deliveries went with
   * it, so the removal itself stays debuggable. A tenant who wants to keep the
   * log should disable the endpoint (PATCH status) instead.
   */
  async remove(id: string): Promise<{ deletedDeliveries: number }> {
    const result = await this.db.tx(async (tx) => {
      const before = await tx.webhookEndpoint.findFirst({ where: { id } });
      if (!before) return null;
      const deleted = await tx.webhookDelivery.deleteMany({ where: { endpointId: id } });
      await tx.webhookEndpoint.delete({ where: { id } });
      return { before, deletedDeliveries: deleted.count };
    });
    if (!result) throw this.missing();

    await this.audit.record({
      action: 'integration.webhook.delete',
      entityType: 'webhook_endpoint',
      entityId: id,
      before: {
        url: result.before.url,
        events: result.before.events,
        deliveries: result.deletedDeliveries,
      },
      after: null,
    });
    return { deletedDeliveries: result.deletedDeliveries };
  }

  /** Newest first, with the response code and the error text (docs/30 §1). */
  async deliveries(filter: {
    endpointId?: string;
    status?: string;
    limit?: number;
  }): Promise<unknown[]> {
    const take = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    return this.db.tx((tx) =>
      tx.webhookDelivery.findMany({
        where: {
          ...(filter.endpointId ? { endpointId: filter.endpointId } : {}),
          ...(filter.status ? { status: filter.status } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take,
        select: {
          id: true,
          endpointId: true,
          eventId: true,
          eventName: true,
          status: true,
          attempts: true,
          responseCode: true,
          error: true,
          nextAttemptAt: true,
          deliveredAt: true,
          createdAt: true,
        },
      }),
    );
  }

  /**
   * Manual retry resets the SCHEDULE, not the history: the delivery becomes
   * due again immediately, and `attempts` keeps counting from where it stopped
   * so the row still says how many times this event has been thrown at this
   * URL. A delivery that has already exhausted its five automatic attempts
   * therefore gets exactly one more per press of the button — which is what a
   * person pressing it is asking for.
   */
  async retry(id: string): Promise<{ id: string; status: string; attempts: number }> {
    const row = await this.db.tx(async (tx) => {
      const existing = await tx.webhookDelivery.findFirst({ where: { id } });
      if (!existing) return null;
      if (existing.status === 'delivered') {
        return { conflict: 'This delivery already succeeded' as const, existing };
      }
      const updated = await tx.webhookDelivery.update({
        where: { id },
        data: { status: 'pending', nextAttemptAt: new Date() },
        select: { id: true, status: true, attempts: true },
      });
      return { updated };
    });
    if (!row) throw this.missing('Delivery not found');
    if ('conflict' in row && row.conflict) {
      throw new ConflictException({ code: ERROR_CODES.CONFLICT, message: row.conflict });
    }
    return row.updated!;
  }

  /**
   * Confirms the derived secret still matches what this endpoint was created
   * with. Constant-time, and used by the dispatcher before it signs: if the
   * signing root key has been rotated the platform would otherwise post a
   * signature no receiver could verify, which looks like a delivery and is not.
   */
  secretMatches(endpointId: string, storedHash: string): string | null {
    const secret = deriveEndpointSecret(endpointId);
    return timingSafeEquals(sha256Hex(secret), storedHash) ? secret : null;
  }

  private missing(message = 'Webhook endpoint not found'): NotFoundException {
    return new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message });
  }
}
