/**
 * Remembering what a station-day hashed to, and deciding what to do about it.
 *
 * This is the whole reason the adapter is worth having. Schedules Direct hands
 * out an md5 per station-day for a fraction of what the schedule itself costs,
 * so a run can ask "which of these 2,800 station-days actually moved?" in one
 * request and fetch only those. Its own Perl grabber keeps a SQLite database of
 * exactly this; the equivalent here is the site's own bag, which a run already
 * reads once and writes once.
 *
 * Kept apart from the pass for two reasons: none of it does any I/O, and the
 * decision has more cases than it looks like — enough that it is worth being a
 * table someone can read straight down rather than a chain of conditions inside
 * a generator.
 */

import type { CacheEntryMeta } from '../../cache/types.js';
import type { SiteState } from '../types.js';
import { SD_DATE_OUT_OF_RANGE, SD_OK, type WireMd5 } from './wire.js';

/** Where one station-day's md5 lives in the bag. */
const PREFIX = 'md5:';

/**
 * How many station-days' md5s are worth keeping.
 *
 * The backstop, not the limit that matters: pruning by day is what usually keeps
 * this bounded, and this catches what that cannot — a `days` that shrank, a
 * lineup swapped for another, a station that left. At 100,000 it is around 7,000
 * stations over a fortnight before anything is dropped, and it is applied where
 * the bag is pruned rather than where it is written to — see {@link pruneMd5}.
 */
export const MAX_MD5S = 100_000;

/** The key one station-day is remembered under. */
export function md5Key(stationID: string, day: string): string {
  return `${PREFIX}${stationID}:${day}`;
}

/** The md5 remembered for this station-day, if it is a usable one. */
export function storedMd5(state: SiteState, stationID: string, day: string): string | undefined {
  const held = state.get(md5Key(stationID, day));

  // It comes back out of a cache file, so it is checked rather than trusted.
  return typeof held === 'string' && held !== '' ? held : undefined;
}

/**
 * Remember what this station-day hashed to.
 *
 * A flat string rather than a structure, deliberately: `TrackedMap` records a
 * change only when the value differs, so a run where nothing moved re-sets the
 * same strings, marks nothing dirty, and writes no state file at all. An object
 * per day would differ by identity every time and rewrite the whole blob.
 */
export function rememberMd5(state: SiteState, stationID: string, day: string, md5: string): void {
  state.set(md5Key(stationID, day), md5);
}

/**
 * Drop what this run can no longer be asked about, and cap what is left.
 *
 * Mirrors `pruneValidators`: a run prunes cached days before its window, so an
 * md5 for a day earlier than that is one whose entry has gone — and an md5 with
 * no entry behind it is the one thing this must never keep, since "unchanged"
 * would then mean "keep what is not there".
 *
 * The cap is enforced **here**, in the one pass that already walks the bag,
 * rather than on every write. Counting on each write would mean either walking
 * the bag each time or trusting `state.size` — and `size` is the wrong number:
 * the bag is shared, so it counts the token and anything else beside these, and
 * a cap read off it is a cap on the wrong thing. The same goes for what gets
 * evicted: the oldest key in the bag is the *token*, which went in first.
 */
export function pruneMd5(state: SiteState, windowStart: string): SiteState {
  const ours: string[] = [];

  for (const key of state.keys()) {
    if (!key.startsWith(PREFIX)) {
      continue;
    }

    // `YYYY-MM-DD` compares correctly as a string, which is what lets the day
    // be the tail of the key rather than a field of a structure.
    if (key.slice(key.lastIndexOf(':') + 1) < windowStart) {
      state.delete(key);
      continue;
    }

    ours.push(key);
  }

  // Oldest of ours first, which a `Map`'s insertion order gives for nothing.
  for (let index = 0; ours.length - index > MAX_MD5S; index++) {
    state.delete(ours[index]!);
  }

  return state;
}

/** Forget every md5, so the next pass fetches the whole window. */
export function forgetMd5(state: SiteState): void {
  for (const key of state.keys()) {
    if (key.startsWith(PREFIX)) {
      state.delete(key);
    }
  }
}

/** What to do about one station-day. */
export type Md5Verdict =
  /** Ask for it: either it moved, or there is nothing to say it did not. */
  | 'fetch'
  /** Leave the cached entry exactly as it is, and count it unchanged. */
  | 'keep'
  /** The service has no listings for this day at all: cache it empty. */
  | 'empty'
  /** The service could not say — queued, or it did not answer for this day. */
  | 'unknown';

export interface Md5Decision {
  verdict: Md5Verdict;
  /** What to remember once the day is written, where the service gave one. */
  md5?: string;
  /** Why, in the words a warning or a debug line wants. */
  reason?: string;
}

/**
 * What to do about one station-day, given everything known about it.
 *
 * The rules, in the order they are asked:
 *
 * | the service says | we have | then |
 * |---|---|---|
 * | nothing about this day | — | `unknown` — it was asked about and not answered |
 * | `7020`, outside its window | — | `empty`, and the md5 is worth keeping: it has *told* us there is nothing |
 * | any other non-zero code | — | `unknown` — queued, or something new |
 * | an md5 equal to the one stored | a cached entry | `keep` |
 * | an md5 equal to the one stored | **nothing cached** | `fetch` |
 * | an md5, none stored | an entry grabbed since its `lastModified` | `keep` |
 * | anything else | — | `fetch` |
 *
 * Two of those rows are the ones worth understanding.
 *
 * **An equal md5 with nothing cached is a fetch.** The state and the cache are
 * two files that can be copied, pruned or lost separately, and a run that said
 * "unchanged" here would be telling the grab to keep an entry that is not there
 * — which it reports as a failed channel-day, every run, until someone notices.
 * Believing the cache over the bag makes that self-correcting.
 *
 * **`lastModified` against `grabbedAt` is the bootstrap.** The first run after
 * this adapter ships has no md5s stored at all, and would otherwise refetch a
 * fortnight it already has. The service says when a station-day last changed;
 * the cache says when we took it. If we took it after it last changed, what we
 * have is current. It is the same reasoning `revalidate.ts` uses when it sends
 * an entry's own `grabbedAt` as `If-Modified-Since` with nothing else to ask
 * with — and it is only a fallback, because an md5 is an answer about content
 * while this is an answer about two clocks.
 */
export function decideMd5(
  stored: string | undefined,
  wire: WireMd5 | undefined,
  cached: CacheEntryMeta | undefined,
): Md5Decision {
  if (wire === undefined) {
    // **Not an answer of "unchanged".** The md5 call simply leaves out a day
    // outside what a station has — no entry, no code, nothing — while
    // `/schedules` answers `7020` for the very same day. Verified against the
    // live service, and it is the ordinary case rather than a strange one: a
    // window reaching past what the service publishes is every station's last
    // few days, and some stations outside North America hold only a week.
    //
    // So it is decided on what we have. Nothing cached means fetching it, which
    // gets the `7020` and caches the day empty — true, and settled from then
    // on. Reading it as "unchanged" instead is what made a real 21-day grab
    // report 435 failed channel-days, every run: the run is asked to keep an
    // entry that was never there.
    return cached === undefined
      ? { verdict: 'fetch', reason: 'the service said nothing about this day' }
      : { verdict: 'keep', reason: 'the service said nothing about this day' };
  }

  const code = wire.code ?? SD_OK;

  if (code === SD_DATE_OUT_OF_RANGE) {
    return {
      verdict: 'empty',
      ...(wire.md5 === undefined ? {} : { md5: wire.md5 }),
      reason:
        wire.minDate === undefined || wire.maxDate === undefined
          ? 'outside the days this station has'
          : `outside the days this station has (${wire.minDate} to ${wire.maxDate})`,
    };
  }

  if (code !== SD_OK) {
    return { verdict: 'unknown', reason: `the service answered code ${String(code)}` };
  }

  if (wire.md5 === undefined || wire.md5 === '') {
    return { verdict: 'fetch', reason: 'the service gave no md5 for this day' };
  }

  if (cached === undefined) {
    return { verdict: 'fetch', md5: wire.md5, reason: 'nothing is cached for this day' };
  }

  if (stored === wire.md5) {
    return { verdict: 'keep', md5: wire.md5 };
  }

  if (stored === undefined && changedBefore(wire.lastModified, cached.grabbedAt)) {
    return { verdict: 'keep', md5: wire.md5, reason: 'last changed before it was grabbed' };
  }

  return { verdict: 'fetch', md5: wire.md5 };
}

/**
 * Whether the service changed this day before we took our copy of it.
 *
 * Through `Date.parse` rather than as strings: both are ISO, but only one of
 * them is written here, and `2015-03-02T15:54:58Z` against
 * `2015-03-02T15:54:58.000Z` compares as text in the wrong direction.
 */
function changedBefore(lastModified: string | undefined, grabbedAt: string): boolean {
  if (lastModified === undefined) {
    return false;
  }

  const changed = Date.parse(lastModified);
  const grabbed = Date.parse(grabbedAt);

  return !Number.isNaN(changed) && !Number.isNaN(grabbed) && changed <= grabbed;
}
