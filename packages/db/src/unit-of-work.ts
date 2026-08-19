import type { Prisma, PrismaClient } from '@prisma/client';
import { newId, type DomainEventEnvelope, type EventName } from '@aviora/shared';

export type Tx = Prisma.TransactionClient;

/**
 * Runs `fn` inside a transaction with `app.tenant_id` set via SET LOCAL,
 * so RLS policies apply for the duration of the transaction only (docs/03 §4.1).
 * Use with the app-role client for all tenant-scoped work.
 */
export async function withTenant<T>(
  prisma: PrismaClient,
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
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
