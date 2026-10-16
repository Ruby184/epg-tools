/**
 * Day handling: a "day" is a calendar date encoded as `YYYY-MM-DD`.
 * Cache keys, staleness checks and grab scheduling all operate on these.
 *
 * A day string is a calendar date and nothing else: which zone's calendar is a
 * question of the source that filed a programme under it, and of the run that
 * asks which one is today. The arithmetic below is on the dates alone, so it is
 * the same whatever the answer.
 */

import { xmltvZoneOffset, zonedXmltvDate } from '../xmltv/zone.js';

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

/**
 * The zone this process runs in — what `TZ` says, and UTC where nothing says
 * otherwise, as in a container that sets none.
 *
 * The one default for a run's days and a schedule's time of day alike, so the
 * two cannot disagree: a server whose clock says half past midnight grabs then,
 * and takes the day it has just started as today.
 *
 * Asked of `Intl` each time, since `TZ` can be changed while a process runs —
 * which is also why a run resolves its zone once rather than asking per day.
 */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
}

/**
 * The zone a run's days are on: the one it was given, checked, or the
 * process's own.
 *
 * Asked once, where a run starts, rather than wherever a day is worked out: a
 * name `Intl` does not know would otherwise fail part way through a run, with an
 * error that does not say which setting was wrong.
 */
export function resolveTimeZone(timeZone: string | undefined, field = 'timezone'): string {
  if (timeZone === undefined) {
    return localTimeZone();
  }

  try {
    xmltvZoneOffset(timeZone);
  } catch {
    throw new TypeError(
      `${field} must be an IANA time zone such as "Europe/Bratislava" ` +
        `(got ${JSON.stringify(timeZone)})`,
    );
  }

  return timeZone;
}

/**
 * The day an instant falls on in a zone — the process's own when none is said.
 *
 * What a run means by today. A grab at half past midnight in Bratislava is
 * still the day before in UTC, and a run that took that for today would refetch
 * the day that has just ended and leave its window a day short.
 */
export function dayIn(instant: Date, timeZone = localTimeZone()): string {
  return toDayString(new Date(instant.getTime() + xmltvZoneOffset(timeZone, instant) * 60_000));
}

/**
 * When a wall-clock time on a day happens in a zone, in epoch milliseconds —
 * `minutes` after the day's midnight on its clock, the process's zone when none
 * is said.
 *
 * Asked of the zone rather than added up: a day where the clocks change is 23
 * or 25 hours long, so `04:00` is not always four hours after midnight.
 */
export function wallTimeIn(day: string, timeZone = localTimeZone(), minutes = 0): number {
  const hours = String(Math.floor(minutes / 60)).padStart(2, '0');
  const rest = String(minutes % 60).padStart(2, '0');

  return zonedXmltvDate(`${day} ${hours}:${rest}`, timeZone).getTime();
}

/**
 * The days of another calendar that a run's days cover — for a source whose
 * days are kept on a calendar other than the run's.
 *
 * A run's days run midnight to midnight on its own clock; a source keyed by UTC
 * date has its own midnights, hours away. The days it would have to be asked
 * for, to cover every hour of the run's, are the ones those hours fall on by
 * its clock — one more than the run's at one edge or the other, depending on
 * which way the two clocks differ.
 */
export function daysCovering(
  days: readonly string[],
  timeZone: string,
  otherZone: string,
): string[] {
  if (days.length === 0 || otherZone === timeZone) {
    return [...days];
  }

  const first = dayIn(new Date(wallTimeIn(days[0]!, timeZone)), otherZone);
  const last = dayIn(new Date(wallTimeIn(addDays(days.at(-1)!, 1), timeZone) - 1), otherZone);

  return [...dayRange(first, diffDays(last, first) + 1)];
}
