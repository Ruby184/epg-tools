import { addDays, dayIn, diffDays, wallTimeIn } from '../core/days.js';
import type { CacheEntryMeta, StalenessPolicy } from './types.js';

const DAY_MS = 86_400_000;

/**
 * Decide whether a cached channel-day entry must be refetched.
 *
 * An entry is stale when:
 * - the policy says to refetch the whole window, or
 * - it is not cached at all (`meta` is `undefined`), or
 * - the day falls within the policy's always-refetch window, i.e.
 *   `0 <= diffDays(day, today) < alwaysRefetchDays`, or
 * - the entry was grabbed more than `maxAgeDays` days before `now` —
 *   `emptyMaxAgeDays` instead for an entry that holds no programmes, since a
 *   day that came back empty is as likely to be a source that was briefly
 *   broken as it is a channel with nothing on.
 *
 * Today is `now`'s day on the calendar of `timeZone`, the process's own without
 * one — the run's, so the days it always refetches are the ones it means by
 * today. `dayZone` is the calendar `day` is on, where a site keeps another: see
 * {@link alwaysRefetched}.
 */
export function isStale(
  day: string,
  meta: CacheEntryMeta | undefined,
  policy: StalenessPolicy,
  now: Date,
  timeZone?: string,
  dayZone?: string,
): boolean {
  // Ahead of the entry itself: a run asked to refetch everything is not asking
  // about this entry at all.
  if (policy.refetchAll || meta === undefined) {
    return true;
  }

  if (alwaysRefetched(day, policy.alwaysRefetchDays, now, timeZone, dayZone)) {
    return true;
  }

  // An unparseable grabbedAt makes the age NaN; treat that as stale rather
  // than letting a corrupt entry stay "fresh" forever.
  const age = now.getTime() - Date.parse(meta.grabbedAt);
  const maxAgeDays = meta.programmeCount === 0 ? policy.emptyMaxAgeDays : policy.maxAgeDays;

  return Number.isNaN(age) || age > maxAgeDays * DAY_MS;
}

/**
 * Whether a day is one the policy always fetches again: today, and the days
 * after it up to `days` — the run's today.
 *
 * A day of another calendar — a source keyed by UTC date, in a run on
 * Bratislava's — counts where it overlaps those days rather than by its date.
 * At half past midnight there, UTC's today is the day that has just ended, and
 * the UTC day holding most of the run's today is tomorrow by its date: going by
 * dates would refetch the one and leave the other as cached for a week.
 */
function alwaysRefetched(
  day: string,
  days: number,
  now: Date,
  timeZone: string | undefined,
  dayZone: string | undefined,
): boolean {
  if (days <= 0) {
    return false;
  }

  const today = dayIn(now, timeZone);

  if (dayZone === undefined || dayZone === timeZone) {
    const offset = diffDays(day, today);

    return offset >= 0 && offset < days;
  }

  return (
    wallTimeIn(day, dayZone) < wallTimeIn(addDays(today, days), timeZone) &&
    wallTimeIn(addDays(day, 1), dayZone) > wallTimeIn(today, timeZone)
  );
}
