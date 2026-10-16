/**
 * When a server should grab next.
 *
 * One type reaches {@link EpgServeConfig.grab}: a function that says when the
 * next run is due. Everything else is a factory returning one — the shape
 * `channelsFromM3u` and `channelsFromChannelsXml` already have, where the field
 * takes a function and the convenient ways of building one are named helpers
 * rather than extra accepted types.
 *
 * That is also how a cron expression gets in without this package carrying a
 * cron parser: the next timestamp is exactly what a cron library already hands
 * out.
 *
 * ```ts
 * import { CronExpressionParser } from 'cron-parser';
 *
 * serve: {
 *   grab: ({ from }) =>
 *     CronExpressionParser.parse('0 4 * * *', { currentDate: from }).next().toDate(),
 * }
 * ```
 */

import { dayIn, resolveTimeZone, wallTimeIn } from '../core/days.js';
import { GrabberError } from '../core/error.js';

/**
 * What the cache holds for the window this server serves.
 *
 * The thing a schedule cannot find out for itself: the cache *file* exists from
 * the moment the server opens it, so "is there anything to serve?" is not a
 * question that can be answered from outside by looking.
 */
export interface GuideCached {
  /** Channel-days the cache holds for the window. `0` is nothing to serve. */
  present: number;
  /** How many it would hold if every site had answered for every day. */
  expected: number;
  /** The newest `grabbedAt` among them, or `undefined` with nothing cached. */
  grabbedAt?: Date;
}

/** What a schedule is asked with. See {@link NextGrab}. */
export interface GrabScheduleContext {
  /**
   * The moment to schedule from: when the server started, or when the grab
   * before it finished.
   */
  from: Date;
  /**
   * How many grabs this server has already finished — `0` while it is starting
   * up.
   *
   * Passed rather than left to the schedule to remember, so one schedule can be
   * handed to two servers without the first consuming it.
   */
  runs: number;
  /**
   * What is cached, swept now.
   *
   * A function rather than a value because answering costs something: every
   * site's channel list has to be resolved before the grid can be counted, and
   * a schedule that does not care should not pay for it. The answer is the
   * server's own snapshot, so asking again in the same breath costs nothing.
   */
  cached(): Promise<GuideCached>;
  /**
   * The zone the server's days are on — its `timezone` — for a schedule that
   * reads a time of day. Absent where none was given.
   */
  timezone?: string;
}

/**
 * When the next grab is due.
 *
 * Called once when the server starts and again after each grab finishes —
 * after, not before, so a grab that overruns its own interval cannot queue
 * another behind itself.
 *
 * Return the time the next run should happen, as a `Date` or an epoch
 * millisecond count. A time at or before `from` runs as soon as possible, which
 * is how a schedule asks to run at startup. Return `undefined` to stop
 * scheduling: nothing further is planned and the server carries on serving. A
 * promise is awaited, so a schedule may ask {@link GrabScheduleContext.cached}
 * what there is to serve before it decides.
 */
export type NextGrab = (
  context: GrabScheduleContext,
) => Date | number | undefined | Promise<Date | number | undefined>;

/** How a {@link grabEvery} schedule is anchored. See {@link grabEvery}. */
export interface GrabEveryOptions {
  /**
   * A wall-clock time of day to line the interval up with, as `HH:MM` on the
   * clock of {@link timezone}.
   *
   * Without one the interval is measured from startup and from each grab's
   * finish, and the **first run is at startup** — which is what "every six
   * hours" means for something long running, and what stops a fresh deployment
   * serving an empty cache until the first interval elapses.
   *
   * With one, startup is not a run: naming a time is saying when you want it.
   * Except with nothing cached — see {@link whenEmpty}.
   */
  at?: string;
  /**
   * Grab at startup anyway when there is nothing to serve. On by default, and
   * only relevant with {@link at}.
   *
   * A fresh deployment at three in the afternoon of a server that grabs at four
   * in the morning serves nothing at all for thirteen hours, which is nobody's
   * idea of "nightly at four". And it cannot duplicate work: the condition for
   * running early is that the cache is empty.
   *
   * Only at startup. A cache still empty after a grab has *failed*, and how
   * soon to try again is a retry policy rather than a schedule.
   */
  whenEmpty?: boolean;
  /**
   * The zone {@link at} is read in — an IANA name such as
   * `'Europe/Bratislava'`. Defaults to the server's own `timezone`, so a
   * config that says it once has its grabs at that zone's half past midnight,
   * and to the process's local time where neither says.
   */
  timezone?: string;
}

/** `HH:MM`, and a real time of day rather than merely the shape of one. */
const TIME_OF_DAY = /^(\d{1,2}):(\d{2})$/;

/** A duration, as digits and an optional unit. */
const DURATION = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/;

const UNITS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * A duration as milliseconds: a number of them, or a string with a unit —
 * `'500ms'`, `'90s'`, `'30m'`, `'6h'`, `'1d'`.
 *
 * One resolver behind both doors, as `resolveAllowance` is for `allowMissing`:
 * the config field and the command-line flag mean the same thing because the
 * same function reads them, and a bad value is refused where it was written
 * rather than on the night it would first have mattered.
 */
export function resolveInterval(interval: number | string, label: string): number {
  const raw = typeof interval === 'number' ? String(interval) : interval.trim();
  const match = DURATION.exec(raw);
  const value = Number(match?.[1]) * (UNITS[match?.[2] ?? 'ms'] ?? 1);

  if (match === null || !Number.isFinite(value) || value <= 0) {
    throw new GrabberError(
      `Invalid ${label} value: ${String(interval)} (expected a duration like 6h, 30m or 1d, or a number of milliseconds)`,
    );
  }

  return value;
}

/**
 * Minutes past midnight for `HH:MM`, or a thrown explanation.
 *
 * Exported for the same reason {@link resolveInterval} is: `--grab-at` reads a
 * value this file defines the meaning of, and a flag that read it a second way
 * would be free to disagree.
 */
export function resolveTimeOfDay(at: string, label: string): number {
  const match = TIME_OF_DAY.exec(at.trim());
  const hours = Number(match?.[1]);
  const minutes = Number(match?.[2]);

  if (match === null || hours > 23 || minutes > 59) {
    throw new GrabberError(`Invalid ${label} value: ${at} (expected a time of day like 04:00)`);
  }

  return hours * 60 + minutes;
}

/**
 * Grab on a fixed interval, optionally lined up with a time of day.
 *
 * ```ts
 * import { grabEvery } from 'epg-tools/serve';
 *
 * serve: {
 *   grab: grabEvery('6h', { at: '04:00' }),  // 04:00, 10:00, 16:00, 22:00
 *   // grabEvery('1d', { at: '04:00' })      // nightly at four
 *   // grabEvery('6h')                       // at startup, then every six hours
 * }
 * ```
 *
 * An interval alone drifts — restart at three in the afternoon and that is when
 * you grab from then on, which is wrong when a source publishes overnight. A
 * time of day alone can only mean once a day. Together the next run is the
 * earliest `anchor + n × interval` still ahead of the moment it is asked about.
 *
 * The anchor is a wall-clock time rather than a fixed instant, so a daily
 * schedule keeps its hour across a daylight-saving change instead of sliding by
 * one.
 */
export function grabEvery(interval: number | string, options: GrabEveryOptions = {}): NextGrab {
  // Both read now rather than on the first tick: a schedule that cannot work is
  // worth refusing while somebody is still looking at the config.
  const every = resolveInterval(interval, 'grab.every');
  const at = options.at === undefined ? undefined : resolveTimeOfDay(options.at, 'grab.at');
  const whenEmpty = options.whenEmpty ?? true;
  // Only one given here is checked here: left out, it is the server's, which
  // the server has checked already.
  const zone =
    options.timezone === undefined ? undefined : resolveTimeZone(options.timezone, 'grab.timezone');

  return async ({ from, runs, cached, timezone }) => {
    if (at === undefined) {
      // Unanchored: at startup, now — and after that, spaced from each finish,
      // which drifts by however long a grab takes but can never pile up.
      return runs === 0 ? from : from.getTime() + every;
    }

    // Asked on the one tick where the answer can change anything, and after
    // the unanchored branch, which runs at startup regardless and would be
    // paying for a sweep to learn nothing.
    if (runs === 0 && whenEmpty && (await cached()).present === 0) {
      return from;
    }

    // That time of day on the day `from` falls on, in the zone's own calendar,
    // so the anchor follows the calendar rather than being a fixed instant —
    // and asked of the zone rather than added to its midnight, since a night
    // the clocks change is not 24 hours long.
    const timeZone = zone ?? timezone;
    const anchor = wallTimeIn(dayIn(from, timeZone), timeZone, at);
    const elapsed = from.getTime() - anchor;

    // Before today's anchor, so that is the next one. After it, the following
    // multiple — and `+ 1` rather than a ceiling because landing exactly on one
    // means that one has just been served.
    return elapsed < 0 ? anchor : anchor + (Math.floor(elapsed / every) + 1) * every;
  };
}
