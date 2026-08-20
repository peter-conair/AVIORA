export function formatDate(value: string | null | undefined, locale: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale === 'th' ? 'th-TH' : 'en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

/** Date plus hour/minute — used where the time of day matters (follow-ups, audit log). */
export function formatDateTime(value: string | null | undefined, locale: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale === 'th' ? 'th-TH' : 'en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

/**
 * Money for display only.
 *
 * The API speaks integer MINOR units plus an ISO-4217 code, and every sum,
 * discount and total is computed server-side in that integer form. This divides
 * by 100 exactly once, at the moment of rendering — the result is a string and
 * is never fed back into arithmetic or sent anywhere.
 */
export function formatMoney(
  amountMinor: number | null | undefined,
  currency: string,
  locale: string,
): string {
  if (amountMinor === null || amountMinor === undefined || !Number.isFinite(amountMinor))
    return '—';
  return new Intl.NumberFormat(locale === 'th' ? 'th-TH' : 'en-GB', {
    style: 'currency',
    currency,
  }).format(amountMinor / 100);
}

const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31_536_000_000],
  ['month', 2_592_000_000],
  ['week', 604_800_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

/** Coarse "3 hours ago" / "in 2 days" label. Falls back to the raw value when unparsable. */
export function formatRelativeTime(value: string | null | undefined, locale: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const diffMs = date.getTime() - Date.now();
  const formatter = new Intl.RelativeTimeFormat(locale === 'th' ? 'th-TH' : 'en-GB', {
    numeric: 'auto',
  });
  for (const [unit, unitMs] of RELATIVE_UNITS) {
    if (Math.abs(diffMs) >= unitMs) return formatter.format(Math.round(diffMs / unitMs), unit);
  }
  return formatter.format(0, 'minute');
}

/** Truncate an opaque identifier for dense tables. */
export function shortId(value: string | null | undefined): string {
  if (!value) return '—';
  return value.length > 8 ? `${value.slice(0, 8)}…` : value;
}

function numberLocale(locale: string): string {
  return locale === 'th' ? 'th-TH' : 'en-GB';
}

/**
 * A count, formatted with grouping only. Counts are never divided by 100 —
 * that is what money does, and 3 members are not 0.03 members.
 */
export function formatCount(value: number | null | undefined, locale: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat(numberLocale(locale)).format(value);
}

/**
 * A 0–1 ratio as a percentage. `null` means there was no denominator, which is
 * not the same as 0% — it is rendered as "not measured" by the caller's
 * fallback rather than invented.
 */
export function formatRatio(
  value: number | null | undefined,
  locale: string,
  fallback = '—',
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return fallback;
  return new Intl.NumberFormat(numberLocale(locale), {
    style: 'percent',
    maximumFractionDigits: 1,
  }).format(value);
}

/** A change, always signed: +2 and −2 must not read alike at a glance. */
export function formatSigned(value: number | null | undefined, locale: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat(numberLocale(locale), { signDisplay: 'exceptZero' }).format(value);
}

/** A rate such as engagement per active member — two decimals, no rounding to 0. */
export function formatDecimal(
  value: number | null | undefined,
  locale: string,
  fallback = '—',
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return fallback;
  return new Intl.NumberFormat(numberLocale(locale), { maximumFractionDigits: 2 }).format(value);
}

/** A cohort key of the form `2026-03`, shown as a month and year. */
export function formatMonth(value: string, locale: string): string {
  const date = new Date(`${value}-01T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(numberLocale(locale), {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

/**
 * A rate stored in BASIS POINTS, shown as a percentage beside the integer.
 *
 * 700 basis points is 7%. The stored integer is never divided into a float that
 * goes back into arithmetic — this produces a string for reading, and the API
 * keeps doing the sums in basis points.
 */
export function formatBasisPoints(basisPoints: number | null | undefined, locale: string): string {
  if (basisPoints === null || basisPoints === undefined || !Number.isFinite(basisPoints))
    return '—';
  return new Intl.NumberFormat(numberLocale(locale), {
    style: 'percent',
    maximumFractionDigits: 2,
  }).format(basisPoints / 10_000);
}
