/**
 * The transactional outbox's defining guarantee (docs/11 §321, Sprint 32).
 *
 * docs/11 lists this test by name — "outbox atomicity: force rollback after
 * event append, assert no event row" — and it did not exist. That is the one
 * property the whole pattern is for: an event is written in the SAME
 * transaction as the state change it describes, so the two can never disagree.
 *
 * Get it wrong and the failure is silent and expensive in both directions. An
 * event written outside the transaction announces work that rolled back —
 * members told they were invited to a tenancy that does not exist, commissions
 * emitted for an order that never survived. A state change written without its
 * event is work nobody downstream ever hears about.
 *
 * Neither is visible to a test that only asserts happy paths, which is why this
 * one forces the rollback.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOwnerClient, appendEvent, withTenant, type PrismaClient } from '@aviora/db';
import { EVENTS } from '@aviora/shared';

let owner: PrismaClient;
let tenantId: string;

beforeAll(async () => {
  owner = createOwnerClient();
  const tenant = await owner.tenant.findFirst({ select: { id: true } });
  expect(tenant, 'no tenant in the database to attribute events to').toBeTruthy();
  tenantId = tenant!.id;
}, 60_000);

afterAll(async () => {
  await owner?.$disconnect();
});

describe('An event and the work it describes live or die together', () => {
  it('writes NO event row when the transaction rolls back', async () => {
    const aggregateId = crypto.randomUUID();

    await expect(
      owner.$transaction(async (tx) => {
        await appendEvent(tx, {
          eventName: EVENTS.GoalCompleted,
          tenantId,
          aggregateType: 'atomicity-probe',
          aggregateId,
          actorUserId: null,
          payload: { probe: true },
        });
        // The work fails AFTER the event was appended — the exact ordering that
        // an outbox exists to survive.
        throw new Error('forced rollback');
      }),
    ).rejects.toThrow('forced rollback');

    const leaked = await owner.domainEvent.findFirst({ where: { aggregateId } });
    expect(
      leaked,
      'an event survived a rolled-back transaction. Downstream would announce ' +
        'work that never happened — an invitation to a tenancy that does not ' +
        'exist, a commission for an order that did not survive.',
    ).toBeNull();
  }, 60_000);

  it('writes the event when the transaction commits', async () => {
    // The other half: a test that only proves nothing is written would pass on
    // an appendEvent that does nothing at all.
    const aggregateId = crypto.randomUUID();
    await owner.$transaction(async (tx) => {
      await appendEvent(tx, {
        eventName: EVENTS.GoalCompleted,
        tenantId,
        aggregateType: 'atomicity-probe',
        aggregateId,
        actorUserId: null,
        payload: { probe: true },
      });
    });

    const written = await owner.domainEvent.findFirst({ where: { aggregateId } });
    expect(written, 'a committed transaction produced no event row').toBeTruthy();
    expect(written!.processedAt, 'a fresh event should be unprocessed').toBeNull();
    await owner.domainEvent.delete({ where: { id: written!.id } });
  }, 60_000);

  it('rolls the STATE back too, not only the event', async () => {
    // The guarantee runs both ways: state without its event is work nobody
    // downstream ever hears about.
    const code = `atomicity-${Date.now().toString(36)}`;
    await expect(
      withTenant(owner, tenantId, async (tx) => {
        await tx.pipelineStage.create({
          data: { tenantId, code, name: 'Atomicity probe', order: 999 },
        });
        await appendEvent(tx, {
          eventName: EVENTS.GoalCompleted,
          tenantId,
          aggregateType: 'atomicity-probe',
          aggregateId: crypto.randomUUID(),
          actorUserId: null,
          payload: { probe: true },
        });
        throw new Error('forced rollback');
      }),
    ).rejects.toThrow('forced rollback');

    const stage = await withTenant(owner, tenantId, (tx) =>
      tx.pipelineStage.findFirst({ where: { code } }),
    );
    expect(stage, 'the state change survived a rolled-back transaction').toBeNull();
  }, 60_000);
});
