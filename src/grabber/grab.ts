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
import { emitter, type GrabCounts, watchEventLoop } from '../core/events.js';
import { SiteRun, type Run } from './site-run.js';
import { SiteThreads, threadCount } from './thread.js';
import type { AnySiteConfig, GrabOptions, GrabSummary } from './types.js';

/**
 * How much cache work and parsing runs at once, across every site, when
 * `localConcurrency` says nothing. Node's own file operations go through a
 * threadpool of four by default (`UV_THREADPOOL_SIZE`), so a much larger number
 * buys nothing but open files and live programme lists.
 */
const DEFAULT_LOCAL_CONCURRENCY = 16;

export async function grab(configs: AnySiteConfig[], options: GrabOptions): Promise<GrabSummary> {
  // Before anything starts, rather than once per site that then cannot — it
  // throws when there are threads to start and no module to start them on.
  const threadsWanted = threadCount(options.threads, options.configModule);
  const threads =
    threadsWanted === 0 ? undefined : SiteThreads.for(threadsWanted, options.configModule!);
  /** Every site running in a thread, so a cancelled run can wait for them — see below. */
  const inThreads: Promise<void>[] = [];

  const now = options.now ?? new Date();
  const emit = emitter(options);
  const { cache, signal } = options;
  const tally: GrabCounts = {
    fetched: 0,
    empty: 0,
    fromCache: 0,
    unchanged: 0,
    failed: 0,
    sitesFailed: 0,
  };

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

  // Watched for the whole run, because the number it produces is the one that
  // explains the others — see `grab:done`.
  const loop = await watchEventLoop();

  /**
   * Queue one task, cancellable without paying for the privilege.
   *
   * p-queue drops a waiting task and rejects it with the abort reason when the
   * signal it was given fires, which is exactly the wanted behaviour: a
   * cancelled run stops instead of dequeuing thousands of tasks only for each
   * to notice and record a failure.
   *
   * The run's own signal, handed to every task. That used to be the expensive
   * way round — p-queue 9 registered two abort listeners per task on whatever
   * signal it was given, and `addEventListener` scans the listeners already
   * there to reject a duplicate, so a shared signal cost with the square of
   * what was queued. The way round it was a fresh `AbortSignal.any([signal])`
   * per task, whose listener list held only its own.
   *
   * p-queue 10 keeps its own bookkeeping instead, and the wrapper is now the
   * slower half of the trade: over 8000 tasks a shared signal fills in 59ms and
   * aborts in 27ms, against 128ms and 64ms for a signal derived per task.
   *
   * `clear()` is not the cheaper answer it looks like, though version 10 made
   * it a usable one by rejecting what it drops rather than leaving it pending.
   * It drops what is *waiting*; the signal is also what p-queue hands the task
   * it starts, and that is how a request already in flight learns to stop.
   */
  const enqueue: Run['enqueue'] = (queue, task, taskOptions = {}) =>
    queue.add(task, { ...taskOptions, ...(signal ? { signal } : {}) });

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

  // Said first, and the way a site says it when its list fails in its own turn,
  // so a run whose caller settled the lists reads the same as one that did not.
  for (const failed of options.failedSites ?? []) {
    tally.sitesFailed++;
    emit({ type: 'site:failed', site: failed.site, error: failed.error });
    emit({
      type: 'site:done',
      site: failed.site,
      requests: 0,
      ms: 0,
      requestMs: 0,
      fetched: 0,
      empty: 0,
      fromCache: 0,
      unchanged: 0,
      failed: 0,
      sitesFailed: 1,
    });
  }

  const sites = new PQueue({ concurrency: Math.max(1, options.siteConcurrency ?? configs.length) });

  await Promise.all(
    configs.map((config) =>
      enqueue(sites, async () => {
        try {
          // A site that cannot be resolved throws in the constructor, before it
          // has a queue or a client to let go of — and one in a thread rejects
          // the same way, for that or for a config its thread could not read.
          if (threads === undefined) {
            await new SiteRun(config, run).run();
          } else {
            const site = threads.run(config, run);

            inThreads.push(site);
            await site;
          }
        } catch (error) {
          // Only what the constructor threw reaches here: a site that could not
          // be *read* — a missing `site`, `channels`, `request` or `parseDay` —
          // which happens before it has a queue or a client to let go of. A
          // site that failed while running says so itself, where it can do it
          // before its own cleanup awaits anything.
          //
          // Its own count, not one added to the channel-days: nothing of this
          // site was reached, so there is no grid to attribute it across —
          // and a threshold that let a dead site pass as one lost channel-day
          // would be measuring the wrong thing.
          tally.sitesFailed++;
          emit({ type: 'site:failed', site: config.site, error });
        }
      }).catch(() => {}),
    ),
  );

  // A cancel lets go of every site at once, and a site in its own thread is
  // still winding down over there — finishing the write it started, saving its
  // state, counting what it did. Waited for, so all of that lands in this
  // run's summary rather than after it; a site on this thread goes on the same
  // way, but has counted as it went.
  await Promise.allSettled(inThreads);

  // A cancelled run is not a finished one, and the difference matters to
  // whoever is listening: `grab:done` is what a reporter treats as "this is
  // what the run came to", while a cancel says the opposite — most of what
  // failed was dropped by the cancel itself.
  const loopMaxMs = await loop.worst();

  emit(
    signal?.aborted
      ? { type: 'run:cancelled', fetched: tally.fetched }
      : { type: 'grab:done', loopMaxMs, ...tally },
  );

  loop.stop();

  return tally;
}
