/**
 * One site's pacing and state for the length of a run — what its channel list
 * is fetched through as much as its days.
 *
 * A run that settles every list before it grabs — `build`, and a grab with a
 * selection or a `cover` to apply — used to fetch each list on a client of its
 * own: no queue, no `rateLimit`, no hold on a `429`, so the first request for a
 * day could land on the heels of the list fetch the source had just objected
 * to. And on a state handle of its own, so under `NoCacheDriver` whatever the
 * site's `channels` learnt — a token, a time zone — was gone before the first
 * request. A session opened when the list is settled and carried on by the grab
 * makes that fetch the first request of the site's turn, as it is when the grab
 * resolves the list itself.
 */

import type { CacheStore } from '../cache/types.js';
import { causes, failureOf } from '../core/error.js';
import {
  emitOf,
  noRequests,
  silent,
  type Emit,
  type EpgEventInput,
  type GrabCounts,
  type MeasuredTime,
  type RequestCounts,
} from '../core/events.js';
import { SiteClock, timeSpent, type TimeSink } from './clock.js';
import { sitePacing, type SitePacing } from './pacing.js';
import { isUnchanged } from './revalidate.js';
import { SiteStateHandle } from './state.js';
import type { AnySiteConfig } from './types.js';

/** Told of each request as it is done: what it was for, and what it came to. */
export type RequestSink = (label: string, done: RequestCounts) => void;

/**
 * How many labels a site's requests may come under without a word. One more,
 * and it is told a label names a kind of request, not one — each is a key of
 * `requestsBy` and a name on its line, and a site naming its requests by url
 * would make thousands. Told once, and every one still counted.
 */
export const MANY_LABELS = 64;

export interface SiteSession {
  /** The site's request queue, and the client that holds it on a `429`. */
  readonly pacing: SitePacing;
  /** What the site remembers, read once and saved by whoever is done with it. */
  readonly state: SiteStateHandle;
  /**
   * Requests sent through {@link send}, the list fetch included, and how long
   * they spent waiting on the source, pacing not included — by `label`, with
   * what failed them: a copy, for `site:done`. {@link totalOf} adds them up.
   */
  readonly requestsBy: Record<string, RequestCounts>;
  /**
   * From its first request asked for to its last answered, waiting on its
   * pacing included — the wall clock of what it sent, which is a site's own
   * where its requests were all it did, as a list settled before the grab's.
   */
  readonly spanMs: number;
  /**
   * Where the site's time goes, its requests' share of it measured here, its
   * pacing's by {@link pacing}, and the rest by whoever runs its turn — see
   * `site:done`'s `msBy`.
   */
  readonly clock: SiteClock;
  /**
   * One request through the queue, counted and timed under `label` — handed
   * the queue's own signal, which is the run's.
   *
   * Timed from inside the task rather than from the call, as `request:done` is:
   * what a site waited for a slot is pacing, not the source, and adding it in
   * would make a site paced to one request a second look like a site answering
   * in a second. Counted as its turn comes, so one a cancel dropped before it
   * is not, and one under way when the cancel came is; its time and how it
   * failed once it is done. A failure is read where the task throws it, so a
   * `404` the site goes on to catch is counted all the same.
   */
  send<T>(
    task: (slot: { signal?: AbortSignal | undefined }) => Promise<T>,
    options: { label: string; priority?: number },
  ): Promise<T>;
  /**
   * Be part of `run` from here: its `requested` told what has been counted so
   * far, and of every request after, and its `emit` what the session says —
   * for a session opened before the run it reports to, as one settling a
   * channel list is. Its time is read off its {@link clock} by whoever says
   * the site is done.
   */
  joinRun(run: { requested: RequestSink; emit: Emit }): void;
}

/**
 * Add `done` to what `into` holds under `label`. A `Map`, so a label that
 * happens to be `constructor` is a name like any other, not something every
 * object already has.
 */
export function addRequests(
  into: Map<string, RequestCounts>,
  label: string,
  done: RequestCounts,
): void {
  let total = into.get(label);

  if (total === undefined) {
    total = noRequests();
    into.set(label, total);
  }

  total.requests += done.requests;
  total.requestMs += done.requestMs;
  total.waitedMs += done.waitedMs;

  for (const [failure, n] of Object.entries(done.failed)) {
    total.failed[failure] = (total.failed[failure] ?? 0) + n;
  }
}

/**
 * Tell `sink` of every label, in order. What it is told it does not keep —
 * see {@link addRequests} — so it is handed the counts as they are.
 */
export function tellAll(sink: RequestSink, counted: Iterable<[string, RequestCounts]>): void {
  for (const [label, counts] of counted) {
    sink(label, counts);
  }
}

/** What requests came to, every label together. */
export function totalOf(counted: Iterable<RequestCounts>): { requests: number; requestMs: number } {
  let requests = 0;
  let requestMs = 0;

  for (const counts of counted) {
    requests += counts.requests;
    requestMs += counts.requestMs;
  }

  return { requests, requestMs };
}

/**
 * A site's `site:done`: its requests added up from `requestsBy`, beside its
 * channel-days, and its wall clock `ms` with what of it was `measured` — see
 * `timeSpent`.
 */
export function siteDone(
  site: string,
  wall: number,
  requestsBy: Record<string, RequestCounts>,
  counts: GrabCounts,
  measured: Record<MeasuredTime, number>,
): Extract<EpgEventInput, { type: 'site:done' }> {
  const { requests, requestMs } = totalOf(Object.values(requestsBy));
  const { ms, msBy } = timeSpent(wall, measured);
  // The counts and nothing else, whatever else `counts` holds — an event.
  const { fetched, empty, fromCache, unchanged, failed, sitesFailed } = counts;

  return {
    type: 'site:done',
    site,
    requests,
    ms,
    requestMs,
    requestsBy,
    msBy,
    fetched,
    empty,
    fromCache,
    unchanged,
    failed,
    sitesFailed,
  };
}

/** Several `requestsBy` as one, label by label — each label where it first came. */
export function mergedRequests(
  ...from: Array<Record<string, RequestCounts>>
): Record<string, RequestCounts> {
  const by = new Map<string, RequestCounts>();

  for (const requestsBy of from) {
    for (const [label, counts] of Object.entries(requestsBy)) {
      addRequests(by, label, counts);
    }
  }

  return requestsObject(by);
}

/** What `by` holds, as an event carries it: copies, which go on saying what they said. */
export function requestsObject(by: Map<string, RequestCounts>): Record<string, RequestCounts> {
  return Object.fromEntries(
    [...by].map(([label, { requests, requestMs, waitedMs, failed }]) => [
      label,
      { requests, requestMs, waitedMs, failed: { ...failed } },
    ]),
  );
}

/**
 * Whether `error` is the run's cancel, as a request it interrupted throws it:
 * the cancel's reason, or an `AbortError` — itself, or beneath what a site
 * wrapped it in. Not what a source answered as the cancel came, which is a
 * failure like any other.
 */
function cancelledBy(signal: AbortSignal | undefined, error: unknown): boolean {
  if (signal?.aborted !== true) {
    return false;
  }

  for (const link of causes(error)) {
    if (link === signal.reason || (link as { name?: unknown } | null)?.name === 'AbortError') {
      return true;
    }
  }

  return false;
}

/**
 * What a request's failure is counted as — nothing, for one that is not the
 * source's: the run's cancel, or a `304` saying what is cached still stands.
 *
 * Read off whatever the site threw, which may be anything — a getter that
 * throws, a revoked proxy — so a value it cannot read is `error`, and what the
 * site sees is always what it threw, never what counting it threw.
 */
function failureFor(error: unknown, signal: AbortSignal | undefined): string | undefined {
  try {
    return cancelledBy(signal, error) || isUnchanged(error) ? undefined : failureOf(error);
  } catch {
    return 'error';
  }
}

/** A session for one site — see {@link SiteSession}. */
export function openSession(
  config: AnySiteConfig,
  cache: CacheStore,
  options: {
    signal?: AbortSignal | undefined;
    emit?: Emit;
    /** The run's, told of each request as it is done — see {@link SiteSession.joinRun}. */
    counted?: RequestSink;
    /** Told of the site's time as it is spent: a thread's shared memory — see `Run.spent`. */
    spent?: TimeSink | undefined;
  } = {},
): SiteSession {
  /** Whoever is told what the session says: the run's, once it has joined one. */
  let say = options.emit;
  const clock = new SiteClock(options.spent);
  const pacing = sitePacing(config, {
    ...(options.signal ? { signal: options.signal } : {}),
    // To whoever is told now, and wanting what they want.
    emit: emitOf(
      (event) => say?.(event),
      () => (say ?? silent).hears,
    ),
    clock,
  });
  /** By label, in the order each was first sent — which is the order they are reported in. */
  const by = new Map<string, RequestCounts>();
  let sink = options.counted;
  /** When the first request was asked for, and when the last was answered — see `spanMs`. */
  let asked: number | undefined;
  let answered: number | undefined;

  /** Count what a request under `label` came to, here and for whoever is told. */
  const count = (label: string, done: RequestCounts): void => {
    // The first label over, about to be counted.
    if (by.size === MANY_LABELS && !by.has(label)) {
      say?.({
        type: 'site:warning',
        site: config.site,
        message:
          `its requests have come under more than ${MANY_LABELS} labels — a label names a ` +
          `kind of request, such as detail, not one request: each is counted apart, in ` +
          `site:done and on its line`,
      });
    }

    addRequests(by, label, done);
    sink?.(label, done);
  };

  return {
    pacing,
    state: SiteStateHandle.open(cache, config.site),
    get requestsBy() {
      return requestsObject(by);
    },
    get spanMs() {
      return asked === undefined || answered === undefined ? 0 : answered - asked;
    },
    clock,
    joinRun(run) {
      tellAll(run.requested, by);
      sink = run.requested;
      say = run.emit;
    },
    send: (task, { label, ...sending }) => {
      const queued = Date.now();
      // Waiting its turn — and outside a turn, what puts the site on the clock
      // until it is settled.
      const counted = clock.ask();

      asked ??= queued;

      // The run's signal on every task, as the run's own queues have it: a
      // waiting request is dropped on a cancel rather than started.
      const sent = pacing.queue.add(
        async (slot) => {
          const began = Date.now();

          // Sent now — and so listed in the order each label was first sent,
          // with how long it waited for its turn.
          count(label, { requests: 1, requestMs: 0, waitedMs: began - queued, failed: {} });
          clock.sent();

          let failure: string | undefined;

          try {
            return await task(slot);
          } catch (error) {
            failure = failureFor(error, options.signal);

            throw error;
          } finally {
            clock.answered();
            answered = Date.now();
            count(label, {
              requests: 0,
              requestMs: answered - began,
              waitedMs: 0,
              failed: failure === undefined ? {} : { [failure]: 1 },
            });
          }
        },
        { ...sending, ...(options.signal ? { signal: options.signal } : {}) },
      );
      if (counted) {
        // Settled however it went — answered, or dropped by a cancel before
        // its turn — and no longer keeping the site on the clock.
        const settled = (): void => clock.settled();

        void sent.then(settled, settled);
      }

      return sent;
    },
  };
}
