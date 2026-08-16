/**
 * Day handling: a "day" is a UTC calendar date encoded as `YYYY-MM-DD`.
 * Cache keys, staleness checks and grab scheduling all operate on these.
 */

/** Format a Date as a UTC `YYYY-MM-DD` day string. */
export function toDayString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Convert a `YYYY-MM-DD` day string to a Date at UTC midnight. */
export function dayToDate(day: string): Date {
  const date = new Date(`${day}T00:00:00.000Z`);

  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`Invalid day string: ${day}`);
  }

  return date;
}

/** Add `n` days (may be negative) to a `YYYY-MM-DD` day string. */
export function addDays(day: string, n: number): string {
  const date = dayToDate(day);
  date.setUTCDate(date.getUTCDate() + n);
  return toDayString(date);
}

/** Difference in whole days between two day strings (`a - b`). */
export function diffDays(a: string, b: string): number {
  return Math.round((dayToDate(a).getTime() - dayToDate(b).getTime()) / 86_400_000);
}

/** Generate `days` consecutive day strings starting at `start` (inclusive). */
export function* dayRange(start: Date | string, days: number): Generator<string> {
  const first = typeof start === 'string' ? start : toDayString(start);

  for (let i = 0; i < days; i++) {
    yield addDays(first, i);
  }
}
