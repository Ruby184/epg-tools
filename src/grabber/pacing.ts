/**
 * How a site's requests are paced, and what happens when the source says stop.
 *
 * The queue and the HTTP client are built together because they have to talk:
 * a `429 Too Many Requests` is not news about one request, it is news about
 * the site, and the only useful reaction is to stop sending — which the client
 * cannot do on its own and the queue cannot know to do.
 */

import type { KyInstance } from 'ky';
import PQueue from 'p-queue';
import { siteHttp } from './channels.js';
import type { AnySiteConfig, SiteBackoff } from './types.js';

const DEFAULT_BACKOFF: Required<SiteBackoff> = {
  // The two statuses that carry `Retry-After`, and the two a grabber meets:
  // asked too often, or the source is briefly unavailable.
  statuses: [429, 503],
  fallbackMs: 5_000,
  maxMs: 60_000,
  adapt: true,
};

/**
 * Clean responses in a row before the concurrency lost to a slow-down is given
 * back, one at a time — additive increase after a multiplicative decrease, so
 * recovery is slower than the retreat was.
 */
const RECOVER_AFTER = 10;

/**
 * `Retry-After` in milliseconds: the header is either delta-seconds or an HTTP
 * date, and a source that sends something else has said nothing useful.
 */
export function retryAfterMs(
  header: string | null | undefined,
  now = Date.now(),
): number | undefined {
  // Trimmed first: `Number('   ')` is 0, which would read a header that says
  // nothing as "retry immediately" and skip the fallback wait entirely.
  const value = header?.trim();

  if (!value) {
    return undefined;
  }

  const seconds = Number(value);

  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }

  const date = Date.parse(value);

  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

export interface SitePacing {
  /**
   * The site's request queue: its concurrency, spacing and rate limit.
   *
   * A task of it is one request and no more — not the work the response is
   * for. Anything a site does with a response holds nothing here, which is
   * what lets a `parseDay` ask for a request of its own without waiting on the
   * slot its own response arrived through.
   */
  queue: PQueue;
  /** Its HTTP client, which reports a slow-down to the queue. */
  http: KyInstance;
  /**
   * Drop a hold that is still pending. A run that has finished must not be kept
   * alive by a timer counting down a minute for requests that will never come.
   */
  dispose(): void;
}

/** The queue for one site: how many requests at once, and how often. */
function requestQueue(config: AnySiteConfig): PQueue {
  const concurrency = config.concurrency ?? 1;
  const { rateLimit } = config;

  if (!rateLimit) {
    return new PQueue({ concurrency });
  }

  return new PQueue({
    concurrency,
    interval: rateLimit.perMs,
    intervalCap: rateLimit.requests,
    // A fixed window lets a burst straddle its boundary — the whole allowance
    // at :59.999 and again at :00.000 is twice the rate over the interval the
    // source is counting. (It makes no difference at one request per window,
    // where the two windows agree.)
    strict: rateLimit.strict ?? true,
  });
}

export function sitePacing(
  config: AnySiteConfig,
  options: { signal?: AbortSignal; log?: (message: string) => void } = {},
): SitePacing {
  const log = options.log ?? ((): void => {});
  const queue = requestQueue(config);
  const backoff = config.backoff === false ? undefined : { ...DEFAULT_BACKOFF, ...config.backoff };
  const ceiling = queue.concurrency;

  let timer: NodeJS.Timeout | undefined;
  let holdingUntil = 0;
  let clean = 0;

  const release = (): void => {
    timer = undefined;
    holdingUntil = 0;
    queue.start();
  };

  /** Whether a hold is currently running, i.e. this 429 is not the first of it. */
  const holding = (): boolean => Date.now() < holdingUntil;

  /**
   * Stop starting requests for a while. What is already in flight is left
   * alone — it is a response, not a mistake — and nothing is dropped: the
   * queue keeps its tasks and hands them out again on release.
   */
  const hold = (ms: number, status: number): void => {
    const until = Date.now() + ms;

    // A longer hold already covers this one; two 429s in flight together must
    // not shorten the wait to the second one's.
    if (until <= holdingUntil) {
      return;
    }

    holdingUntil = until;
    clearTimeout(timer);
    queue.pause();
    log(`[${config.site}] HTTP ${status}: holding requests for ${Math.round(ms)}ms`);
    // Deliberately not unref'd: a run in the middle of a hold has to stay
    // alive, or the process would exit with the guide half grabbed.
    timer = setTimeout(release, ms);
  };

  const client = siteHttp(config, options.signal);

  // A site with `backoff: false` gets the plain client. Not merely to save the
  // comparison the hook would begin with: ky clones a response so that a hook
  // may read it, and a clone left unread is a stream held open — a cost for
  // nothing, on a site that has said it does not want any of this.
  const http =
    backoff === undefined
      ? client
      : client.extend({
          hooks: {
            afterResponse: [
              ({ response }): void => {
                if (backoff.statuses.includes(response.status)) {
                  clean = 0;

                  // Concurrency the source has just told us was too much.
                  // Nothing to give back at 1, which is the default — this is
                  // for sites configured to run several requests at a time.
                  //
                  // Once per hold, not once per response: several requests in
                  // flight together are told off together, and halving for
                  // each of them would take a site from 8 to 1 over one
                  // violation — then charge it ten clean responses per step to
                  // climb back.
                  if (backoff.adapt && queue.concurrency > 1 && !holding()) {
                    queue.concurrency = Math.max(1, Math.floor(queue.concurrency / 2));
                    log(`[${config.site}] concurrency down to ${queue.concurrency}`);
                  }

                  hold(
                    Math.min(
                      retryAfterMs(response.headers.get('retry-after')) ?? backoff.fallbackMs,
                      backoff.maxMs,
                    ),
                    response.status,
                  );

                  return;
                }

                if (
                  backoff.adapt &&
                  response.ok &&
                  queue.concurrency < ceiling &&
                  ++clean >= RECOVER_AFTER
                ) {
                  clean = 0;
                  queue.concurrency += 1;
                  log(`[${config.site}] concurrency back up to ${queue.concurrency}`);
                }
              },
            ],
          },
        });

  // Only ever fires for a site that is paced, and it is the one thing a
  // `rateLimit` gives no other sign of.
  queue.on('rateLimit', () => log(`[${config.site}] rate limit reached, waiting for the window`));
  queue.on('rateLimitCleared', () => log(`[${config.site}] rate limit window open again`));

  // A cancelled run must not sit out the rest of a hold — the timer is not
  // unref'd, so it would hold the process open — and must not resume either.
  // Resuming would *send* what the cancel is dropping: a listener on the run's
  // signal is called before the task signals derived from it are aborted, so
  // starting the queue here hands out tasks that are about to be removed. The
  // hold is dropped and the queue left paused; each task takes itself out of it,
  // and an emptied queue reaches idle whether it is paused or not.
  options.signal?.addEventListener(
    'abort',
    () => {
      clearTimeout(timer);
      timer = undefined;
      holdingUntil = 0;
    },
    { once: true },
  );

  return {
    queue,
    http,
    dispose: () => clearTimeout(timer),
  };
}
