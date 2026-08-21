import {
  instantFromZoned,
  startOfDayInZone,
  startOfMonthInZone,
  zonedParts,
} from '../../common/time/zone';

/**
 * When each job's slots fall, in the tenant's own reckoning (docs/35 §3), and
 * which of them a tick still owes (docs/35 §4).
 *
 * Nothing here touches the database. An occurrence is a pure function of a
 * cadence, a timezone, the clock and the last slot already on record — which is
 * what makes "did last night's renewal run?" answerable by looking for one row
 * rather than by reasoning about what the scheduler was doing at the time.
 *
 * An occurrence is an INSTANT, never a date. The same nominal day starts two
 * hours apart in Bangkok and Tokyo, and a date column would lose exactly the
 * difference the tenant-timezone rule exists to keep.
 */

/** docs/35 §4: an occurrence missed by more than this is recorded, never run. */
export const CATCHUP_DAYS = 3;
const CATCHUP_MS = CATCHUP_DAYS * 24 * 60 * 60 * 1000;

/** docs/35 §4: the most `skipped` rows one job writes for one tenant in one tick. */
export const MAX_SKIP_ROWS = 30;

/**
 * How many slots are examined before the walk gives up counting. A scheduler
 * that has been off for years must not spend the tick enumerating the years.
 */
const MAX_SCAN = 400;

/** docs/35 §3: the webhook sweep runs every five minutes, platform-wide. */
export const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export interface OccurrencePlan {
  /** Inside the catch-up window, oldest first — these run. */
  due: Date[];
  /** Older than the window, oldest first — these are recorded as skipped. */
  skip: Date[];
  /** Older still, and not even recorded: the count the oldest skip row reports. */
  elided: number;
  /** True when the walk stopped counting, so `elided` is a floor and not a total. */
  truncated: boolean;
}

const EMPTY: OccurrencePlan = { due: [], skip: [], elided: 0, truncated: false };

/** The local midnight one calendar day before `occurrence`. */
function previousDayInZone(timeZone: string, occurrence: Date): Date {
  const p = zonedParts(timeZone, occurrence);
  const shifted = new Date(Date.UTC(p.year, p.month - 1, p.day));
  shifted.setUTCDate(shifted.getUTCDate() - 1);
  return instantFromZoned(
    timeZone,
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate(),
  );
}

/** The local midnight one calendar day after `occurrence`. */
function nextDayInZone(timeZone: string, occurrence: Date): Date {
  const p = zonedParts(timeZone, occurrence);
  const shifted = new Date(Date.UTC(p.year, p.month - 1, p.day));
  shifted.setUTCDate(shifted.getUTCDate() + 1);
  return instantFromZoned(
    timeZone,
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate(),
  );
}

/** Local midnight on the 1st of the month before the one `occurrence` opens. */
function previousMonthInZone(timeZone: string, occurrence: Date): Date {
  const p = zonedParts(timeZone, occurrence);
  const month = p.month === 1 ? 12 : p.month - 1;
  const year = p.month === 1 ? p.year - 1 : p.year;
  return instantFromZoned(timeZone, year, month, 1);
}

/**
 * Everything a cadence still owes, walking back from the slot in force now.
 *
 * Catch-up starts at `floor` — the newest occurrence already on record for this
 * job and this tenant (docs/35 §4). With no record at all it starts at NOW and
 * backfills nothing: a tenant that did not exist last week does not owe last
 * week's renewals, and a job that has never run has missed nothing.
 */
function walk(
  current: Date,
  previous: (slot: Date) => Date,
  now: Date,
  floor: Date | null,
): OccurrencePlan {
  if (!floor) {
    return now.getTime() - current.getTime() <= CATCHUP_MS
      ? { due: [current], skip: [], elided: 0, truncated: false }
      : EMPTY;
  }

  const due: Date[] = [];
  const skip: Date[] = [];
  let elided = 0;
  let truncated = false;
  let cursor = current;
  for (let scanned = 0; cursor.getTime() > floor.getTime(); scanned++) {
    if (scanned >= MAX_SCAN) {
      truncated = true;
      break;
    }
    if (now.getTime() - cursor.getTime() <= CATCHUP_MS) due.push(cursor);
    else if (skip.length < MAX_SKIP_ROWS) skip.push(cursor);
    else elided++;
    cursor = previous(cursor);
  }
  // Oldest first: a catch-up that ran yesterday's slot after today's would bill
  // a period out of order and report it that way too.
  return { due: due.reverse(), skip: skip.reverse(), elided, truncated };
}

/** Daily at local midnight. */
export function planDaily(timeZone: string, now: Date, floor: Date | null): OccurrencePlan {
  return walk(
    startOfDayInZone(timeZone, now),
    (slot) => previousDayInZone(timeZone, slot),
    now,
    floor,
  );
}

/** Monthly at local midnight on the 1st. */
export function planMonthly(timeZone: string, now: Date, floor: Date | null): OccurrencePlan {
  return walk(
    startOfMonthInZone(timeZone, now),
    (slot) => previousMonthInZone(timeZone, slot),
    now,
    floor,
  );
}

/**
 * The five-minute bucket `now` falls in, UTC — the sweep is platform-wide and
 * belongs to no tenant's calendar.
 *
 * The one cadence with no catch-up, deliberately. The sweep reports what is
 * stuck NOW; replaying a bucket from yesterday would record an answer to a
 * question nobody asked, over data that has since moved on.
 */
export function planSweep(now: Date, floor: Date | null): OccurrencePlan {
  const current = currentSweepSlot(now);
  if (floor && floor.getTime() >= current.getTime()) return EMPTY;
  return { due: [current], skip: [], elided: 0, truncated: false };
}

/** The slot in force right now, whether or not the catch-up window still wants it. */
export function currentDailySlot(timeZone: string, now: Date): Date {
  return startOfDayInZone(timeZone, now);
}

export function currentMonthlySlot(timeZone: string, now: Date): Date {
  return startOfMonthInZone(timeZone, now);
}

export function currentSweepSlot(now: Date): Date {
  return new Date(Math.floor(now.getTime() / SWEEP_INTERVAL_MS) * SWEEP_INTERVAL_MS);
}

/**
 * The instant a daily occurrence covers up to: the end of that local day, or
 * the clock if the day is still running.
 *
 * A catch-up run therefore asks the question its own slot asked — "what was
 * due by the end of that day" — rather than the question today would ask.
 */
export function dailyAsOf(timeZone: string, occurrence: Date, now: Date): Date {
  const endOfDay = new Date(nextDayInZone(timeZone, occurrence).getTime() - 1);
  return endOfDay < now ? endOfDay : now;
}

export interface DraftPeriod {
  periodStart: Date;
  periodEnd: Date;
}

/**
 * The month that ended when `occurrence` opened (docs/35 §3).
 *
 * `periodEnd` is a millisecond BEFORE the new month because the metric windows
 * a run computes over are inclusive at both ends — landing it on the boundary
 * itself would count an order placed at 00:00 on the 1st in both months.
 */
export function monthJustEnded(timeZone: string, occurrence: Date): DraftPeriod {
  return {
    periodStart: previousMonthInZone(timeZone, occurrence),
    periodEnd: new Date(occurrence.getTime() - 1),
  };
}
