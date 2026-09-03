/**
 * A run: every site, into one cache.
 *
 * What lives here is what belongs to the run rather than to any site — the
 * counters it answers with, the bound on work that never leaves the machine, how
 * many sites go at once, and how a cancelled run stops. One site's turn is
 * {@link SiteRun}.
 */

import PQueue from 'p-queue';
import { toDayString } from '../core/days.js';
import { emitter, type GrabCounts } from '../core/events.js';
import { SiteRun, type Run } from './site-run.js';
import type { AnySiteConfig, GrabOptions, GrabSummary } from './types.js';

/**
 * How much cache work and parsing runs at once, across every site, when
 * `localConcurrency` says nothing. Node's own file operations go through a
 * threadpool of four by default (`UV_THREADPOOL_SIZE`), so a much larger number
 * buys nothing but open files and live programme lists.
 */
const DEFAULT_LOCAL_CONCURRENCY = 16;

export async function grab(configs: AnySiteConfig[], options: GrabOptions): Promise<GrabSummary> {
  const now = options.now ?? new Date();
  const emit = emitter(options);
  const { cache, signal } = options;
  const tally: GrabCounts = { fetched: 0, empty: 0, fromCache: 0, unchanged: 0, failed: 0 };

  /**
   * Everything that is not a request: the staleness sweep, and parsing a
   * channel-day out of a response and writing it.
   *
   * One queue for the whole run rather than one per site, because what it
   * bounds — open files, and how many parsed programme lists are alive at once —
   * is a property of the process, not of a site. A site's own `concurrency` and
   * `rateLimit` are about being polite to that site, so cache work must not be
   * throttled by them, nor take a request's slot.
   */
  const localWork = new PQueue({
    concurrency: Math.max(1, options.localConcurrency ?? DEFAULT_LOCAL_CONCURRENCY),
  });

  /**
   * Queue one task, cancellable without paying for the privilege.
   *
   * p-queue drops a waiting task and rejects it with the abort reason when the
   * signal it was given fires, which is exactly the wanted behaviour: a
   * cancelled run stops instead of dequeuing thousands of tasks only for each to
   * notice and record a failure. What it cannot be given is the run's own
   * signal, once per task — it registers two abort listeners for each, and
   * `addEventListener` scans the listeners already there to reject a duplicate,
   * so a shared signal costs with the square of what is queued at once.
   *
   * A signal of the task's own, following the run's, is that same behaviour for
   * nothing: each list holds only its own task's listeners, and aborting the run
   * aborts every one of them. Filling and draining 8000 tasks costs what passing
   * no signal at all costs.
   */
  const enqueue: Run['enqueue'] = (queue, task, taskOptions = {}) =>
    queue.add(task, {
      ...taskOptions,
      // Not `[signal]` for the sake of a copy: `any` is what makes the listeners
      // land on a list of this task's own.
      ...(signal ? { signal: AbortSignal.any([signal]) } : {}),
    });

  const run: Run = {
    defaults: {
      ...(options.days === undefined ? {} : { days: options.days }),
      ...(options.staleness === undefined ? {} : { staleness: options.staleness }),
    },
    cache,
    now,
    grabbedAt: now.toISOString(),
    startDay: options.startDay ?? toDayString(now),
    emit,
    ...(signal ? { signal } : {}),
    localWork,
    enqueue,
    tally,
  };

  const sites = new PQueue({ concurrency: Math.max(1, options.siteConcurrency ?? configs.length) });

  await Promise.all(
    configs.map((config) =>
      enqueue(sites, async () => {
        try {
          // A site that cannot be resolved throws in the constructor, before it
          // has a queue or a client to let go of.
          await new SiteRun(config, run).run();
        } catch (error) {
          // Only what the constructor threw reaches here: a site that could not
          // be *read* — a missing `site`, `channels`, `request` or `parseDay` —
          // which happens before it has a queue or a client to let go of. A
          // site that failed while running says so itself, where it can do it
          // before its own cleanup awaits anything.
          //
          // One, not one per channel-day: nothing of this site was reached, so
          // there is no grid to attribute it across.
          tally.failed++;
          emit({ type: 'site:failed', site: config.site, error });
        }
      }).catch(() => {}),
    ),
  );

  // A cancelled run is not a finished one, and the difference matters to
  // whoever is listening: `grab:done` is what a reporter treats as "this is
  // what the run came to", while a cancel says the opposite — most of what
  // failed was dropped by the cancel itself.
  emit(
    signal?.aborted
      ? { type: 'run:cancelled', fetched: tally.fetched }
      : { type: 'grab:done', ...tally },
  );

  return tally;
}
