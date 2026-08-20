import { randomBytes } from 'node:crypto';

export const INTERVAL_UNITS = ['day', 'week', 'month'] as const;
export type IntervalUnit = (typeof INTERVAL_UNITS)[number];

/** Billing days are calendar days: `nextRunOn` is a date column, not an instant. */
export function todayUtc(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * `from` + (unit × count) as a calendar date. Month arithmetic clamps to the
 * last day of the target month, so a subscription billed on the 31st does not
 * skip February.
 */
export function addInterval(from: Date, unit: string, count: number): Date {
  const year = from.getUTCFullYear();
  const month = from.getUTCMonth();
  const day = from.getUTCDate();

  if (unit === 'day') return new Date(Date.UTC(year, month, day + count));
  if (unit === 'week') return new Date(Date.UTC(year, month, day + count * 7));

  const target = new Date(Date.UTC(year, month + count, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  return new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(day, lastDay)));
}

/** First date at or after `floor` reached by stepping whole intervals from `from`. */
export function advanceTo(from: Date, floor: Date, unit: string, count: number): Date {
  let next = from;
  // A subscription paused for six months must not wake up owing six orders,
  // so the schedule is walked forward rather than billed retroactively.
  for (let i = 0; next < floor && i < 1000; i++) next = addInterval(next, unit, count);
  return next;
}

// Crockford-style alphabet: no I/L/O/U, so a number read aloud is unambiguous.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Order numbers are unique per tenant, never globally sequential — a global
 * sequence would leak one tenant's order volume to every other.
 */
export function nextOrderNumber(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
  const suffix = [...randomBytes(6)].map((b) => ALPHABET[b % ALPHABET.length]).join('');
  return `${date}-${suffix}`;
}

export function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: string } | null)?.code === 'P2002';
}

export function isOrderNumberConflict(e: unknown): boolean {
  if (!isUniqueViolation(e)) return false;
  const target = (e as { meta?: { target?: unknown } }).meta?.target;
  const text = Array.isArray(target) ? target.join(',') : typeof target === 'string' ? target : '';
  return /number/i.test(text);
}

/**
 * Runs `fn` with a fresh order number, retrying the whole transaction if the
 * per-tenant unique key rejects it — the constraint is the arbiter, not a
 * read-then-write check that two concurrent checkouts could both pass.
 */
export async function withOrderNumber<T>(
  fn: (orderNumber: string) => Promise<T>,
  attempts = 4,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(nextOrderNumber());
    } catch (e) {
      if (attempt >= attempts || !isOrderNumberConflict(e)) throw e;
    }
  }
}
