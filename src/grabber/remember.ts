/**
 * What a site remembers between runs about one thing at a time — a
 * programme's details, say — and for how long.
 *
 * Kept in a state group of its own rather than in the site's bag. A group is
 * one blob, rewritten whole when anything in it changes: a few thousand
 * programmes' details beside a token would rewrite the token's file every run
 * for the details' sake. Each value carries when it is forgotten, and what has
 * passed that is dropped at the end of every run, so the group holds about a
 * window's worth however long a site has been running.
 */

import type { Says } from '../core/events.js';
import { unplain } from '../core/plain.js';
import { StateKey, type SiteStateHandle, type TrackedMap } from './state.js';

/**
 * One remembered value, and the instant it is forgotten.
 *
 * `missed` marks a `null` that a failure `miss` matched stands for — "this has
 * no details" — which is an answer only to an ask that says such failures are
 * answers. One that does not is asked again.
 */
interface Kept {
  until: number;
  value: unknown;
  missed?: true;
}

/**
 * What one ask came to: an answer, or the failure it ended in. Shared by every
 * ask of the key while it was on its way, each of which reads it with its own
 * `miss`.
 */
type Outcome = { value: unknown } | { error: unknown; refused?: true };

/**
 * How a caller waits on an ask somebody else started without holding a slot
 * meanwhile — a parse's `localWork` slot, which the ask it is waiting on may
 * need back before it can finish.
 */
export type Away = <T>(wait: () => Promise<T>) => Promise<T>;

/**
 * Whether a value kept in the `remembered` group is still remembered at `now`
 * — what a run keeps of the group, and what `epg cache state` counts. A pair
 * that is not one is forgotten with the rest: whatever wrote it, it is no
 * answer to anything.
 */
export function isRemembered(entry: unknown, now: number): boolean {
  const until = (entry as Partial<Kept> | null | undefined)?.until;

  return typeof until === 'number' && until > now;
}

/** One site's remembered values for the length of a run. */
export class Memory {
  readonly #handle: SiteStateHandle;
  readonly #site: string;
  readonly #now: number;
  readonly #refresh: boolean;
  readonly #warn: Says['warn'] | undefined;
  #kept: Promise<TrackedMap<Kept>> | undefined;
  /** Asks under way, so two of one key at once are one task. */
  readonly #asking = new Map<string, Promise<Outcome>>();
  /** Answered by this run — what `--refresh` still lets an ask read. */
  readonly #fresh = new Set<string>();
  /**
   * Answers given an `until` this run has already passed: good for the run,
   * and kept by nobody after it.
   */
  readonly #passing = new Map<string, Kept>();
  #warnedPast = false;

  /**
   * This site's memory, in the state its run holds, as of the run's `now`.
   *
   * Made up front and read the first time it is asked, so a site that never
   * remembers anything reads nothing more than it did until the run ends — see
   * {@link prune}. Under `refresh` nothing kept by an earlier run is read: as
   * everywhere else `--refresh` reaches, the cache's reading is turned off and
   * its writing is not.
   */
  constructor(
    handle: SiteStateHandle,
    site: string,
    now: Date,
    options: { refresh?: boolean; warn?: Says['warn'] } = {},
  ) {
    this.#handle = handle;
    this.#site = site;
    this.#now = now.getTime();
    this.#refresh = options.refresh === true;
    this.#warn = options.warn;
  }

  /**
   * What the site kept under `key`, or the task's answer, kept until the
   * options' `until` — a context's `remember`.
   *
   * `away` is how this caller waits on an ask another one started; a caller
   * without one holds something it cannot let go of meanwhile — a request, its
   * site's queue slot — and runs a task of its own instead of waiting.
   */
  async remember(
    key: string,
    options: unknown,
    task: () => unknown,
    away?: Away,
  ): Promise<unknown> {
    const { until, miss } = this.#read(key, options);
    const kept = await this.#open();
    const held =
      this.#passing.get(key) ??
      (this.#refresh && !this.#fresh.has(key) ? undefined : kept.get(key));

    // A "none" is an answer only to an ask that takes such failures for one.
    if (held !== undefined && (held.missed !== true || miss !== undefined)) {
      return structuredClone(held.value);
    }

    const asking = this.#asking.get(key);
    let outcome: Outcome;

    if (asking !== undefined && away !== undefined) {
      outcome = await away(() => asking);
    } else {
      const own = this.#ask(kept, key, until, miss, task);

      if (asking === undefined) {
        this.#asking.set(key, own);
        void own.then(() => {
          if (this.#asking.get(key) === own) {
            this.#asking.delete(key);
          }
        });
      }

      outcome = await own;
    }

    if ('value' in outcome) {
      return structuredClone(outcome.value);
    }

    // Each caller's own `miss` on what the ask came to, so the answer is the
    // one its types promise: a caller without one gets the failure, whoever
    // asked first and however they took it.
    if (outcome.refused !== true && miss?.(outcome.error) === true) {
      return null;
    }

    throw outcome.error;
  }

  /**
   * Drop what has passed its `until` — at the end of a run, whether or not
   * anything asked, so a site that stopped remembering stops keeping too.
   *
   * A group that cannot be read has nothing to drop: what failed is a read,
   * and the run it ends is not the place to say so.
   */
  async prune(): Promise<void> {
    await this.#open().catch(() => undefined);
  }

  /** The options, checked: an `until` that is a time, and a `miss` that is a function. */
  #read(
    key: string,
    options: unknown,
  ): { until: number; miss: ((error: unknown) => boolean) | undefined } {
    const { until, miss } = (typeof options === 'object' && options !== null ? options : {}) as {
      until?: unknown;
      miss?: unknown;
    };
    const at =
      typeof until === 'number' ? until : until instanceof Date ? until.getTime() : Number.NaN;

    if (!Number.isFinite(at)) {
      throw new TypeError(
        `Site "${this.#site}": remember(${JSON.stringify(key)}) needs an until, a Date or epoch ` +
          `milliseconds (got ${until === undefined ? 'none' : JSON.stringify(until)})`,
      );
    }

    if (miss !== undefined && typeof miss !== 'function') {
      throw new TypeError(
        `Site "${this.#site}": remember(${JSON.stringify(key)})'s miss must be a function`,
      );
    }

    return { until: at, miss: miss as ((error: unknown) => boolean) | undefined };
  }

  /**
   * The group, without what was to be forgotten by the run's `now`.
   *
   * Dropped as it is read, which does two things: the group is saved without
   * them, and within a run everything held is good. A read that fails is not
   * remembered, so the next ask tries again.
   */
  #open(): Promise<TrackedMap<Kept>> {
    this.#kept ??= this.#handle.bag<Kept>(StateKey.REMEMBERED).then(
      (kept) => {
        for (const [key, entry] of kept) {
          if (!isRemembered(entry, this.#now)) {
            kept.delete(key);
          }
        }

        return kept;
      },
      (error: unknown) => {
        this.#kept = undefined;
        throw error;
      },
    );

    return this.#kept;
  }

  /**
   * Ask, and keep the answer by the asker's own options — a failure its
   * `miss` matches as `null`, marked as standing for one. What it hands back
   * is the outcome itself, the failure included, for every caller to read with
   * its own `miss`.
   */
  async #ask(
    kept: TrackedMap<Kept>,
    key: string,
    until: number,
    miss: ((error: unknown) => boolean) | undefined,
    task: () => unknown,
  ): Promise<Outcome> {
    let value: unknown;

    try {
      value = await task();
    } catch (error) {
      // An answer that says "none" — a 404 for a programme with no details —
      // is as much worth keeping as one with something in it. Anything else
      // is a failure, kept by nobody, so the next run asks again.
      if (miss?.(error) === true) {
        this.#keep(kept, key, { until, value: null, missed: true });
      }

      return { error };
    }

    // Refused rather than kept as whatever JSON makes of it: this run would be
    // handed a `Date` and the next one a string, and a site would find out
    // only on the run after the one it was tried on.
    const found = value === undefined ? undefined : unplain(value, 'value');

    if (found !== undefined) {
      return {
        error: new TypeError(
          `Site "${this.#site}": remember(${JSON.stringify(key)}) was answered with ${found}. ` +
            `A remembered value must be plain — strings, finite numbers, booleans, null, ` +
            `arrays and plain objects — since it is stored as JSON and read back by the next run`,
        ),
        refused: true,
      };
    }

    // A copy, so what the task handed back can be changed by whoever was
    // handed it without changing what is kept.
    const entry: Kept = { until, value: structuredClone(value) };

    this.#keep(kept, key, entry);

    return { value: entry.value };
  }

  #keep(kept: TrackedMap<Kept>, key: string, entry: Kept): void {
    if (entry.until > this.#now) {
      kept.set(key, entry);
      this.#fresh.add(key);

      return;
    }

    // Already past: kept for this run, which is all it would have been good
    // for, rather than written to be dropped by the next one. Said once,
    // since an `until` in seconds where milliseconds were meant puts every
    // value here, and a run asking everything again with nothing said would
    // be a puzzle.
    this.#passing.set(key, entry);

    if (!this.#warnedPast) {
      this.#warnedPast = true;
      this.#warn?.(
        `remember(${JSON.stringify(key)}) was given an until already past ` +
          `(${new Date(entry.until).toISOString()}), so it is kept for this run only — ` +
          `an until in seconds rather than milliseconds?`,
      );
    }
  }
}
