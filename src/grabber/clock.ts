/**
 * Where a site's wall clock goes — `site:done`'s `msBy`, measured as it runs.
 *
 * At any moment a site is in the first of these that holds: held, the source
 * having said slow down, with a request of its outstanding — waiting its turn,
 * or out, which under a hold is a request ky is retrying once the source's
 * `Retry-After` is up, or one sent before it that the hold holds up as much;
 * a request of its out to the source; one waiting on its own `rateLimit`; its
 * local work under way; its local work waiting for a slot; a streaming site's
 * pass reading its document, given to the source too — its body arriving and
 * split as it does, which is the one request's, though its headers came long
 * since. A hold with nothing outstanding holds nothing up: the site's own work
 * goes on, and is what it is doing.
 * Each change to what holds gives the time since the last change to whichever
 * held until it, so the parts never overlap — and what none of them covers is
 * `other`, the rest of `ms`.
 *
 * Measured only while the site is on the clock that `ms` is: its turn, and a
 * request it asked for outside one — its channel list, settled before the
 * grab. A hold that outlives the list it was answered to, waiting for the turn,
 * is time `ms` does not count either.
 */

import { performance } from 'node:perf_hooks';
import { MEASURED_TIME, type MeasuredTime, type TimeSpent } from '../core/events.js';

/** Told of each stretch of time as it is given to a part — a thread's shared memory. */
export type TimeSink = (part: MeasuredTime, ms: number) => void;

/** The measured parts at nought. */
export function noTime(): Record<MeasuredTime, number> {
  return { source: 0, held: 0, rateLimit: 0, working: 0, queued: 0 };
}

/**
 * What a moment is given to: a part — or `elsewhere`, local work waiting on the
 * run's thread with nothing else of the site's under way, given to `working`
 * until the answer says how much of it was a wait for a slot there.
 */
type Holding = MeasuredTime | 'elsewhere';

/** A stretch of time, `performance.now()` to `performance.now()`. */
type Stretch = [from: number, to: number];

export class SiteClock {
  readonly #spent = noTime();
  readonly #sink: TimeSink | undefined;
  /**
   * What the time since {@link #since} is being given to — nothing, where none
   * of the parts holds, or the site is off the clock.
   */
  #part: Holding | undefined;
  /** When it began to be. */
  #since = 0;
  /** Whether the site's turn is under way. */
  #turn = false;
  /** Requests asked for outside a turn and not yet settled: what puts the site on the clock then. */
  #asked = 0;
  /** Requests waiting in the site's queue, and out to the source. */
  #waiting = 0;
  #out = 0;
  #held = false;
  #rateLimited = false;
  /** Its local work under way, and waiting for a slot. */
  #working = 0;
  #queued = 0;
  /**
   * Of its work under way, the calls waiting on the run's thread — a thread's
   * cache call — by when each went.
   */
  readonly #calls: number[] = [];
  /**
   * The stretches given to `working` while those calls were all the site was
   * doing, and the stretches the calls back from there ran in, each as
   * `from, to` — kept until no call still out could change what they say.
   */
  #alone: Stretch[] = [];
  #ran: Stretch[] = [];
  /** Its passes reading their documents — see {@link reading}. */
  #reading = 0;
  /** Whether the run was cancelled: what is waiting then never begins. */
  #cancelled = false;

  constructor(sink?: TimeSink) {
    this.#sink = sink;
  }

  /**
   * What each part has been given so far, in milliseconds — up to now, so the
   * stretch under way is given out first, and a thread's shared memory told of
   * it as of any other.
   */
  spent(): Record<MeasuredTime, number> {
    this.#close();

    return { ...this.#spent };
  }

  /** The site's turn begins, or ends. */
  turn(on: boolean): void {
    this.#turn = on;
    this.#moved();
  }

  /**
   * A request asked for, waiting in the site's queue until it is {@link sent}.
   * Outside the site's turn it is also what puts the site on the clock — and
   * this answers whether it did, so that it is {@link settled} once it is, and
   * a request in a turn costs nothing more.
   */
  ask(): boolean {
    // Dropped by the cancel the moment it is asked, and never sent.
    if (this.#cancelled) {
      return false;
    }

    this.#waiting++;

    if (this.#turn) {
      this.#moved();

      return false;
    }

    this.#asked++;
    this.#moved();

    return true;
  }

  /** A request {@link ask} counted outside a turn, settled — answered, or dropped before it was sent. */
  settled(): void {
    this.#asked--;
    this.#moved();
  }

  /** A request that was waiting, sent. */
  sent(): void {
    this.#waiting--;
    this.#out++;
    this.#moved();
  }

  /** A request that was out, answered. */
  answered(): void {
    this.#out--;
    this.#moved();
  }

  /** The source holding the site's requests, or letting them go. */
  held(on: boolean): void {
    this.#held = on;
    this.#moved();
  }

  /**
   * A streaming site's pass beginning to read its document, or done with it:
   * the source's, wherever nothing else holds.
   */
  reading(on: boolean): void {
    this.#reading += on ? 1 : -1;
    this.#moved();
  }

  /** The site's `rateLimit` holding the next request back, or letting it go. */
  rateLimited(on: boolean): void {
    this.#rateLimited = on;
    this.#moved();
  }

  /** Local work waiting for a slot. */
  queued(): void {
    if (this.#cancelled) {
      return;
    }

    this.#queued++;
    this.#moved();
  }

  /** Local work that was waiting for a slot, under way. */
  started(): void {
    this.#queued--;
    this.#working++;
    this.#moved();
  }

  /** Local work under way, done. */
  finished(): void {
    this.#working--;
    this.#moved();
  }

  /**
   * Local work under way that has gone to wait on the run's thread — a
   * thread's cache call — until it is {@link back}: answering when it went,
   * for that.
   */
  elsewhere(): number {
    const since = performance.now();

    this.#calls.push(since);
    this.#moved();

    return since;
  }

  /**
   * Local work back from the run's thread, gone `since`, which says the first
   * `queuedMs` of its call was a wait for a slot there and the rest its own
   * work there. Of what `working` was given while work waiting there was all
   * the site was doing, a moment no call ran in was every call there waiting
   * for a slot, and is given to `queued` — two calls there at once are not one's
   * wait during the other's work. A moment the site's other work was under way
   * here stays that work's.
   */
  back(since: number, queuedMs: number): void {
    const at = this.#calls.indexOf(since);

    // Only a call still out: one back twice is back once.
    if (at === -1) {
      return;
    }

    const now = this.#close();
    const ran = Math.min(since + queuedMs, now);

    if (ran < now) {
      this.#ran.push([ran, now]);
    }

    this.#calls.splice(at, 1);
    this.#settle();
    this.#moved();
  }

  /**
   * The run cancelled. What waits for a slot of the site's queue, or of the
   * run's local work, is dropped by the same cancel and never begins, nor does
   * anything asked after it: none of it waits any more. Nor does a hold, or a
   * rate limit, hold anything up.
   */
  cancelled(): void {
    this.#cancelled = true;
    this.#waiting = 0;
    this.#queued = 0;
    this.#held = false;
    this.#rateLimited = false;
    this.#moved();
  }

  /**
   * After a change, what holds now — and where that is not what held before,
   * the time since given to what did. Read only then: while a request is out,
   * a parse beginning or ending changes nothing, and asks the clock nothing.
   */
  #moved(): void {
    const part = this.#turn || this.#asked > 0 ? this.#holding() : undefined;

    if (part !== this.#part) {
      this.#close();
      this.#part = part;
    }
  }

  /**
   * What no call still out on the run's thread can change, settled: the time
   * before the earliest of them went, when every call there was one now back
   * and has said when it ran. A moment of it no call ran in is given to
   * `queued`.
   */
  #settle(): void {
    const upTo = this.#calls.length === 0 ? Infinity : Math.min(...this.#calls);
    // In the order they began, so that a sweep along them counts a moment two
    // ran in at once only once.
    const ran = this.#ran.length > 1 ? this.#ran.toSorted((a, b) => a[0] - b[0]) : this.#ran;
    const alone: Stretch[] = [];
    let waited = 0;

    for (const [from, to] of this.#alone) {
      if (from >= upTo) {
        alone.push([from, to]);
        continue;
      }

      const until = Math.min(to, upTo);

      waited += until - from - this.#covered(from, until, ran);

      if (to > upTo) {
        alone.push([upTo, to]);
      }
    }

    this.#alone = alone;
    this.#ran = this.#ran.filter(([, to]) => to > upTo);

    if (waited > 0) {
      this.#spent.working -= waited;
      this.#spent.queued += waited;
      this.#sink?.('working', -waited);
      this.#sink?.('queued', waited);
    }
  }

  /** How much of `from` to `to` the stretches `ran`, in the order they began, cover. */
  #covered(from: number, to: number, ran: readonly Stretch[]): number {
    let ms = 0;
    let reached = from;

    for (const [start, end] of ran) {
      const since = Math.max(start, reached);
      const until = Math.min(end, to);

      if (until > since) {
        ms += until - since;
        reached = until;
      }
    }

    return ms;
  }

  /**
   * The stretch since the last change given to what held through it, and a new
   * one begun — answering when.
   */
  #close(): number {
    const now = performance.now();
    const ms = now - this.#since;

    // Nothing to give for a stretch of no time — two changes in one instant.
    if (this.#part !== undefined && ms > 0) {
      const part = this.#part === 'elsewhere' ? 'working' : this.#part;

      if (this.#part === 'elsewhere') {
        const last = this.#alone.at(-1);

        // Split only by a call back while another is still out.
        if (last?.[1] === this.#since) {
          last[1] = now;
        } else {
          this.#alone.push([this.#since, now]);
        }
      }

      this.#spent[part] += ms;
      this.#sink?.(part, ms);
    }

    this.#since = now;

    return now;
  }

  /** The first part that holds, or none. */
  #holding(): Holding | undefined {
    if (this.#held && (this.#waiting > 0 || this.#out > 0)) {
      return 'held';
    }

    if (this.#out > 0) {
      return 'source';
    }

    if (this.#waiting > 0 && this.#rateLimited) {
      return 'rateLimit';
    }

    // Some of its work under way here, not only waiting on the run's thread —
    // read off two counts, each call there taken for one of the work counted
    // here. A parse that runs on without its slot, given up for a `paced` it
    // never awaited, is not counted: while it writes there, another parse's
    // work reads as a wait.
    if (this.#working > this.#calls.length) {
      return 'working';
    }

    if (this.#calls.length > 0) {
      return 'elsewhere';
    }

    if (this.#queued > 0) {
      return 'queued';
    }

    // Below a wait for a slot: a pass held back while its writes wait for one
    // is waiting for it too.
    return this.#reading > 0 ? 'source' : undefined;
  }
}

/**
 * `ms` as `site:done` says it, with `measured` given out of it whole and what
 * is left as `other` — `ms` taken up to what was measured where a clock read on
 * another thread, or rounded, comes to a little more.
 */
export function timeSpent(
  ms: number,
  measured: Record<MeasuredTime, number>,
): { ms: number; msBy: TimeSpent } {
  const parts = noTime();
  let total = 0;

  for (const part of MEASURED_TIME) {
    parts[part] = Math.round(measured[part]);
    total += parts[part];
  }

  const whole = Math.max(Math.round(ms), total);

  return { ms: whole, msBy: { ...parts, other: whole - total } };
}

/** Two measures of a site's time, part by part. */
export function addedTime(
  a: Record<MeasuredTime, number>,
  b: Record<MeasuredTime, number>,
): Record<MeasuredTime, number> {
  const sum = noTime();

  for (const part of MEASURED_TIME) {
    sum[part] = a[part] + b[part];
  }

  return sum;
}

/** The measured parts of `msBy`, without `other` — what two of them are added from. */
export function measuredOf(msBy: TimeSpent): Record<MeasuredTime, number> {
  const { other: _other, ...measured } = msBy;

  return measured;
}
