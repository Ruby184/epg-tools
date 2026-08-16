import { diffDays, toDayString } from '../core/days.js';
import type { CacheEntryMeta, StalenessPolicy } from './types.js';

const DAY_MS = 86_400_000;

/**
 * Decide whether a cached channel-day entry must be refetched.
 *
 * An entry is stale when:
 * - it is not cached at all (`meta` is `undefined`), or
 * - the day falls within the policy's always-refetch window, i.e.
 *   `0 <= diffDays(day, today) < alwaysRefetchDays`, or
 * - the entry was grabbed more than `maxAgeDays` days before `now`.
 */
export function isStale(
  day: string,
  meta: CacheEntryMeta | undefined,
  policy: StalenessPolicy,
  now: Date,
): boolean {
  if (meta === undefined) {
    return true;
  }

  const offset = diffDays(day, toDayString(now));

  if (offset >= 0 && offset < policy.alwaysRefetchDays) {
    return true;
  }

  // An unparseable grabbedAt makes the age NaN; treat that as stale rather
  // than letting a corrupt entry stay "fresh" forever.
  const age = now.getTime() - Date.parse(meta.grabbedAt);
  return Number.isNaN(age) || age > policy.maxAgeDays * DAY_MS;
}
