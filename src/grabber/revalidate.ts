/**
 * Asking a source whether anything has changed, and hearing that it has not.
 *
 * A site writes no code for this: it goes in the site's own ky instance as two
 * hooks, so `conditionalGet: true` is the whole of what a config says and
 * `request` stays exactly as it was. What the hooks cannot know on their own —
 * whether a 304 could be honoured at all, and which days this request is for —
 * the run puts in an {@link AsyncLocalStorage} around each planned fetch.
 *
 * Which is also what keeps it out of a `parseDay`: a request made from there
 * runs on a queue of its own, in a context the store never reached, so a detail
 * page is never revalidated. A 304 on one could not mean "keep this channel-day"
 * anyway — the channel-day itself was just refetched.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Options as KyOptions } from 'ky';
import type { TrackedMap } from './state.js';

/**
 * Told that a channel-day is unchanged, so what is cached still stands.
 *
 * Thrown by the `afterResponse` hook below on a 304, which is how it reaches out
 * of a `request` or a `stream` that never mentions it — and throwable by a site
 * doing its own revalidating. The grab catches it and keeps every channel-day the
 * request was for.
 */
export class UnchangedError extends Error {
  override readonly name = 'UnchangedError';

  constructor(readonly url?: string) {
    super(url === undefined ? 'Unchanged' : `Unchanged: ${url}`);
  }
}

/**
 * Whether this is that answer.
 *
 * By name as well as by `instanceof`, so a duplicate copy of this package in a
 * dependency tree — two `epg-tools` in one `node_modules`, a site published as
 * its own package — does not turn "nothing has changed" into a failed run.
 */
export function isUnchanged(error: unknown): boolean {
  return (
    error instanceof UnchangedError || (error instanceof Error && error.name === 'UnchangedError')
  );
}

/** What one url last answered with, and what that answer was about. */
export interface Validator {
  etag?: string;
  lastModified?: string;
  /** When this url was last asked, as an ISO timestamp. */
  seenAt: string;
  /**
   * The last day the request covered.
   *
   * What a validator's lifetime hangs on: a run prunes cached days before its
   * window, so the same comparison drops the validators whose channel-days have
   * gone. One string, and no reverse index to keep.
   */
  lastDay: string;
}

/** What the run knows about the request a hook is running inside. */
export interface Revalidation {
  /**
   * Whether a 304 could be honoured at all: every channel-day this request
   * covers is already cached, none of them past `maxAgeDays`, and the run is not
   * refetching everything.
   *
   * The first clause is what stops a 304 leaving a hole; the second bounds what
   * a source with a lying `Last-Modified` can cost to `maxAgeDays` rather than
   * for ever; the third is what `--refresh` means.
   */
  mayKeep: boolean;
  /** `If-Modified-Since` when no validator is stored: the oldest `grabbedAt` of the pairs. */
  since?: string;
  /** The last day this request covers — stamped on whatever it remembers. */
  lastDay: string;
  validators: TrackedMap<Validator>;
  /** Urls this request stored a validator for, so a failure can take them back. */
  touched: string[];
}

export const revalidation = new AsyncLocalStorage<Revalidation>();

/**
 * How many urls' worth of validators a site keeps.
 *
 * A whole-document source needs one. A per-channel-day source's urls carry dates
 * and never repeat, so {@link Validator.lastDay} is what actually keeps that
 * bounded — this is the backstop for a site whose urls say nothing about a day
 * at all, and it evicts the least recently seen, which a `Map`'s insertion order
 * gives for nothing.
 */
export const MAX_VALIDATORS = 10_000;

/**
 * Drop the validators whose channel-days have left the window.
 *
 * A run prunes cached days before `windowStart`, so a validator for a request
 * that covered nothing later is one whose entries have gone — and asking
 * conditionally about entries that are not there is exactly what `mayKeep`
 * refuses. Done as the group is loaded: one pass, oldest first, no second sweep.
 */
export function pruneValidators(
  validators: TrackedMap<Validator>,
  windowStart: string,
): TrackedMap<Validator> {
  for (const [url, validator] of validators) {
    if (validator.lastDay < windowStart) {
      validators.delete(url);
    }
  }

  return validators;
}

/**
 * Remember what a response said, for the next run to ask with.
 *
 * Runs on the 304 path as well as the 200 one, and that is the trap in tying a
 * validator's lifetime to the days it covered: a url that is *never modified*
 * only ever gets 304s, so a `remember` that ran on 200 alone would leave
 * `lastDay` where the first full download put it, and it would age out of the
 * window and be dropped — earning a source that never changes a full re-download
 * every time the metadata timed out. The same goes for the order: a url asked
 * every run must not look least recently seen.
 *
 * So a 304 keeps the stored `etag`/`lastModified` unless it carries new ones (as
 * RFC 9110 allows) and advances `seenAt` and `lastDay`; and a 200 that offers no
 * validator at all forgets the url, since there is nothing left to ask with.
 */
export function remember(url: string, response: Response): void {
  const store = revalidation.getStore();

  if (store === undefined) {
    return;
  }

  const { validators, lastDay } = store;
  const held = validators.get(url);
  const etag = response.headers.get('etag') ?? (response.status === 304 ? held?.etag : undefined);
  const lastModified =
    response.headers.get('last-modified') ??
    (response.status === 304 ? held?.lastModified : undefined);

  // Out of its old position first: a `Map` keeps insertion order, so this is the
  // whole of the eviction order — delete, re-insert, and the front is the oldest.
  validators.delete(url);

  if (etag === undefined && lastModified === undefined) {
    return;
  }

  validators.set(url, {
    ...(etag === undefined ? {} : { etag }),
    ...(lastModified === undefined ? {} : { lastModified }),
    seenAt: new Date().toISOString(),
    lastDay,
  });
  store.touched.push(url);

  if (validators.size > MAX_VALIDATORS) {
    const oldest = validators.keys().next();

    if (oldest.done !== true) {
      validators.delete(oldest.value);
    }
  }
}

/**
 * Take back what a request remembered, because it did not finish.
 *
 * A validator stored for a download that was interrupted before its
 * channel-days were written would, on a later run where those days happen to be
 * cached from earlier, earn a 304 that keeps the *old* entries — for up to
 * `maxAgeDays`, which is the freeze `mayKeep` exists to prevent and cannot catch,
 * since those entries really are there.
 */
export function forget(store: Revalidation): void {
  for (const url of store.touched) {
    store.validators.delete(url);
  }

  store.touched.length = 0;
}

/**
 * The hooks that do the asking, for a site that wants them.
 *
 * Ours first on the way out, so a site's own `beforeRequest` can still strip or
 * override the header; ours last on the way in, so a site's own `afterResponse`
 * sees the 304 before we make it final.
 */
export function revalidationHooks(hooks: KyOptions['hooks']): NonNullable<KyOptions['hooks']> {
  return {
    ...hooks,
    beforeRequest: [
      ({ request, options }) => {
        const store = revalidation.getStore();

        // Not a planned fetch (a request from inside a `parseDay`), or one whose
        // 304 could not be honoured. Either way, ask outright.
        if (store?.mayKeep !== true || options.context.revalidate === false) {
          return;
        }

        const known = store.validators.get(request.url);

        if (known?.etag !== undefined) {
          request.headers.set('if-none-match', known.etag);
        } else if (known?.lastModified !== undefined) {
          request.headers.set('if-modified-since', known.lastModified);
        } else if (store.since !== undefined) {
          // Nothing stored, but the entries themselves say when they were
          // grabbed — which is a fair thing to ask "has it changed since?" with.
          request.headers.set('if-modified-since', store.since);
        }
      },
      ...(hooks?.beforeRequest ?? []),
    ],
    afterResponse: [
      ...(hooks?.afterResponse ?? []),
      ({ request, response }) => {
        remember(request.url, response);

        if (response.status === 304) {
          throw new UnchangedError(request.url);
        }

        return response;
      },
    ],
  };
}
