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
import type { Emit } from '../core/events.js';
import { sitePacing, type SitePacing } from './pacing.js';
import { SiteStateHandle } from './state.js';
import type { AnySiteConfig } from './types.js';

export interface SiteSession {
  /** The site's request queue, and the client that holds it on a `429`. */
  readonly pacing: SitePacing;
  /** What the site remembers, read once and saved by whoever is done with it. */
  readonly state: SiteStateHandle;
  /** Requests sent through {@link send}, the list fetch included. */
  readonly sent: number;
  /** How long they spent waiting on the source, pacing not included. */
  readonly spent: number;
  /**
   * One request through the queue, counted and timed — handed the queue's own
   * signal, which is the run's.
   *
   * Timed from inside the task rather than from the call, as `request:done` is:
   * what a site waited for a slot is pacing, not the source, and adding it in
   * would make a site paced to one request a second look like a site answering
   * in a second.
   */
  send<T>(
    task: (slot: { signal?: AbortSignal | undefined }) => Promise<T>,
    options?: { priority?: number },
  ): Promise<T>;
}

/** A session for one site — see {@link SiteSession}. */
export function openSession(
  config: AnySiteConfig,
  cache: CacheStore,
  options: { signal?: AbortSignal | undefined; emit?: Emit } = {},
): SiteSession {
  const pacing = sitePacing(config, {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.emit ? { emit: options.emit } : {}),
  });
  let sent = 0;
  let spent = 0;

  return {
    pacing,
    state: SiteStateHandle.open(cache, config.site),
    get sent() {
      return sent;
    },
    get spent() {
      return spent;
    },
    send: (task, sending = {}) => {
      sent += 1;

      // The run's signal on every task, as the run's own queues have it: a
      // waiting request is dropped on a cancel rather than started.
      return pacing.queue.add(
        async (slot) => {
          const began = Date.now();

          try {
            return await task(slot);
          } finally {
            spent += Date.now() - began;
          }
        },
        { ...sending, ...(options.signal ? { signal: options.signal } : {}) },
      );
    },
  };
}
