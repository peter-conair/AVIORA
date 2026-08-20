/**
 * IANA-aware zone arithmetic (docs/29 §2).
 *
 * The platform rule is store UTC, convert at the edge. This file is the edge:
 * every instant in the database stays UTC, and the only thing resolved here is
 * what a DAY or a MONTH means to a particular tenant.
 *
 * The conversion is real, not an offset guess. A fixed "+07:00" is right for
 * Bangkok and wrong for every tenant whose zone observes DST — and wrong twice
 * a year rather than never, which is the kind of bug that is noticed in
 * October and blamed on the report. `Intl.DateTimeFormat` carries the tz
 * database, so it is asked instead of assumed.
 */

/** What the schema defaults to, so a tenant with no localisation row agrees with its own DB. */
export const DEFAULT_TIMEZONE = 'Asia/Bangkok';

const formatters = new Map<string, Intl.DateTimeFormat>();

/** A zone name is valid if ICU will build a formatter for it; invalid ones throw RangeError. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached) return cached;
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  formatters.set(timeZone, dtf);
  return dtf;
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** The wall-clock reading an observer in `timeZone` takes at `instant`. */
export function zonedParts(timeZone: string, instant: Date): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((p) => p.type === type);
    return found ? Number(found.value) : 0;
  };
  // Some ICU builds render midnight as hour 24 under hour12:false.
  const hour = get('hour');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: hour === 24 ? 0 : hour,
    minute: get('minute'),
    second: get('second'),
  };
}

/** Zone offset at `instant`, in ms, as (local wall clock − UTC). */
function offsetMsAt(timeZone: string, instant: Date): number {
  const p = zonedParts(timeZone, instant);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // formatToParts drops sub-second precision; align both sides on the second.
  return asIfUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The UTC instant at which the wall clock in `timeZone` reads the given parts.
 *
 * Resolved in two passes: the first guess uses the offset in force at the
 * naive timestamp, the second uses the offset in force at the answer. One pass
 * is wrong across a DST transition — exactly the boundary a "calendar month"
 * lands on twice a year.
 */
export function instantFromZoned(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  const first = naive - offsetMsAt(timeZone, new Date(naive));
  const second_ = naive - offsetMsAt(timeZone, new Date(first));
  return new Date(second_);
}

/** Midnight on the 1st of the month containing `instant`, as the tenant reckons it. */
export function startOfMonthInZone(timeZone: string, instant: Date): Date {
  const p = zonedParts(timeZone, instant);
  return instantFromZoned(timeZone, p.year, p.month, 1);
}

/** Midnight at the start of the day containing `instant`, as the tenant reckons it. */
export function startOfDayInZone(timeZone: string, instant: Date): Date {
  const p = zonedParts(timeZone, instant);
  return instantFromZoned(timeZone, p.year, p.month, p.day);
}

/** The tenant's calendar date for `instant`, as `YYYY-MM-DD`. */
export function calendarDateInZone(timeZone: string, instant: Date): string {
  const p = zonedParts(timeZone, instant);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}
