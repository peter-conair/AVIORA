import type { Tx } from '@aviora/db';

/** The Prisma delegates that hold health data (docs/13 §6, spec §59). */
type HealthDelegate = 'habit' | 'habitLog' | 'healthMetric' | 'healthProfile' | 'healthDataGrant';

/**
 * A database handle with the health delegates removed FROM ITS TYPE.
 *
 * docs/28 §2 keeps health out of the leader, tenant and platform dashboards
 * entirely — not aggregated, not counted, because an average over a small team
 * identifies a person. Every measure those three scopes read takes this type,
 * so `reader.habitLog` is a compile error there rather than a review comment.
 *
 * The member's own dashboard may show their own health. It gets it from the
 * health module, which asks `HealthDataGrant` first — never from this reader.
 */
export type HealthFreeReader = Omit<Tx, HealthDelegate>;

/** Narrows a transaction handle. Identity at runtime; the type is the point. */
export function withoutHealth(tx: Tx): HealthFreeReader {
  return tx;
}
