import type { Prisma, PrismaClient } from '@prisma/client';
import { newId, type DomainEventEnvelope, type EventName } from '@aviora/shared';
import { tenantExtension } from './tenant-extension';

export type Tx = Prisma.TransactionClient;

/**
 * Runs `fn` inside a transaction scoped to one tenant, two ways at once:
 *
 * 1. `SET LOCAL app.tenant_id`, so RLS policies apply for the transaction
 *    (docs/03 §4.1), and
 * 2. the tenant extension, which filters and stamps tenant-owned models in the
 *    client itself.
 *
 * The second is not redundant. RLS is enforced by the DATABASE ROLE, and the
 * owner role — which seeds, scripts and tests use — bypasses it. Without the
 * extension, `withTenant(ownerClient, …)` reads every tenant's rows while
 * looking exactly like scoped code. That has already produced one cross-tenant
 * row in dev data and one wrong test result; the name promises scoping, so the
 * function has to deliver it whichever role is connected.
 */
export async function withTenant<T>(
  prisma: PrismaClient,
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const scoped = prisma.$extends(tenantExtension(() => tenantId)) as unknown as PrismaClient;
  return scoped.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx);
  });
}

export interface AppendEventInput<TPayload> {
  eventName: EventName;
  tenantId: string | null;
  aggregateType: string;
  aggregateId: string;
  actorUserId: string | null;
  payload: TPayload;
}

/**
 * Appends a domain event to the outbox INSIDE the caller's transaction —
 * the state change and the event commit or roll back together (docs/11 §4).
 */
export async function appendEvent<TPayload>(
  tx: Tx,
  input: AppendEventInput<TPayload>,
): Promise<DomainEventEnvelope<TPayload>> {
  const row = await tx.domainEvent.create({
    data: {
      id: newId(),
      eventName: input.eventName,
      tenantId: input.tenantId,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      actorUserId: input.actorUserId,
      payload: input.payload as object,
    },
  });
  return {
    eventId: row.id,
    eventName: row.eventName as EventName,
    tenantId: row.tenantId,
    aggregateType: row.aggregateType,
    aggregateId: row.aggregateId,
    actorUserId: row.actorUserId,
    payload: input.payload,
    occurredAt: row.occurredAt.toISOString(),
    version: 1,
  };
}
