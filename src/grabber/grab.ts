/**
 * A run: every site, into one cache.
 *
 * What lives here is what belongs to the run rather than to any site — the
 * counters it answers with, the bound on work that never leaves the machine, how
 * many sites go at once, and how a cancelled run stops. One site's turn is
 * {@link SiteRun}.
 */

import PQueue from 'p-queue';
import { dayIn, resolveTimeZone } from '../core/days.js';
import {
  emitter,
  keepingThrows,
  noCounts,
  type RequestCounts,
  watchEventLoop,
} from '../core/events.js';
import {
  addRequests,
  requestsObject,
  siteDone,
  type RequestSink,
  type SiteSession,
} from './session.js';
import { noTime } from './clock.js';
import { SiteRun, type Run } from './site-run.js';
import { siteName } from './site.js';
import { SiteNotRunError, SiteThreads, threadCount } from './thread.js';
import type { AnySiteConfig, GrabOptions, GrabSummary } from './types.js';

/**
 * How much cache work and parsing runs at once, across every site, when
 * `localConcurrency` says nothing. Node's own file operations go through a
 * threadpool of four by default (`UV_THREADPOOL_SIZE`), so a much larger number
 * buys nothing but open files and live programme lists.
 */
const DEFAULT_LOCAL_CONCURRENCY = 16;

/**
 * How many slots the run's local work has: `localConcurrency`, at least one —
 * what a run is given, and what `--explain` says it had.
 */
export function localSlots(localConcurrency: number | undefined): number {
  return Math.max(1, localConcurrency ?? DEFAULT_LOCAL_CONCURRENCY);
}

export async function grab(configs: AnySiteConfig[], options: GrabOptions): Promise<GrabSummary> {
  return grabWith(configs, options, new Map());
}

/**
 * {@link grab}, carrying on with the sessions a run opened while it settled the
 * sites' lists — so a list fetch and the requests after it share one queue,
 * one hold on a `429` and one state. A site on this thread carries on with its
 * session; one in a thread cannot, since a session is a queue and a timer and
 * neither crosses to a worker, so it is handed the session for what its list
 * cost, added to its `site:done` as that passes — see `hostSite`.
 */
export async function grabWith(
  configs: AnySiteConfig[],
  options: GrabOptions,
  sessions: ReadonlyMap<string, SiteSession>,
): Promise<GrabSummary> {
  /**
   * What a reporter throws, kept rather than let loose. Loose, it would end a
   * site part way through saying what it did — counted failed on this thread,
   * and not on another's — or end the process, from a thread's listener where
   * nothing can catch it. Kept, the run goes on saying everything, and rejects
   * with it once it has: a reporter that throws is a bug in it, and is never
   * swallowed — see `combineReporters`. And once the run is done it is said
   * no more, though a request a parse did not wait for is still going.
   */
  const kept = keepingThrows(options);

  return kept.settle(grabbing(configs, kept.options, sessions));
}

/** {@link grabWith}'s run, reporting through what keeps a reporter's throws. */
async function grabbing(
  configs: AnySiteConfig[],
  options: GrabOptions,
  sessions: ReadonlyMap<string, SiteSession>,
): Promise<GrabSummary> {
  // Before anything starts, rather than once per site that then cannot — it
  // throws when there are threads to start and no module to start them on.
  const threadsWanted = threadCount(options.threads, options.configModule);
  const timeZone = resolveTimeZone(options.timeZone);
  const threads =
    threadsWanted === 0 ? undefined : SiteThreads.for(threadsWanted, options.configModule!);
  /**
   * Every site running in a thread, so a cancelled run can wait for them — and
   * what hangs up on each, which tells the run what it counted: see below.
   */
  const inThreads: Array<Promise<() => void>> = [];
  /** Every site running on this thread, so a cancelled run waits for them too. */
  const onThisThread: Array<Promise<void>> = [];
  /** What threw out of a site's task that was not the cancel — see below. */
  const faults: unknown[] = [];

  const now = options.now ?? new Date();
  const emit = emitter(options);
  let nameless = 0;
  /**
   * What a site's events call it: its name — or, for a config that left it
   * out, which is refused for it, words saying so, numbered so two are two
   * sites. Never `undefined`, which no reporter is promised.
   */
  const nameOf = (site: unknown): string => {
    try {
      return siteName({ site });
    } catch {
      return `a site with no name (${++nameless})`;
    }
  };
  /** Every request of the run, label by label, for `grab:done` — told as each is done. */
  const requests = new Map<string, RequestCounts>();
  const requested: RequestSink = (label, done) => {
    addRequests(requests, label, done);
  };

  // A list settled before the run was asked for, and is counted with it — as
  // is whatever is asked through the same session after, and said as the run
  // says it.
  for (const session of sessions.values()) {
    session.joinRun({ requested, emit });
  }
  const { cache, signal } = options;
  const tally = noCounts();

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
    concurrency: localSlots(options.localConcurrency),
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
    startDay: options.startDay ?? dayIn(now, timeZone),
    timeZone,
    emit,
    ...(signal ? { signal } : {}),
    localWork,
    enqueue,
    tally,
    requested,
    // Nothing to keep of a site's time as it goes: each site's is read off its
    // own clock as its turn ends — and a run's is no sum of its sites', which
    // run side by side.
    spent: undefined,
  };

  // Said first, and the way a site says it when its list fails in its own turn,
  // so a run whose caller settled the lists reads the same as one that did not.
  /**
   * A site that never ran — its list failed as the run settled it, or it could
   * not be read — said as a site that failed running says it: `site:failed`,
   * then a `site:done` whose counts are nought, save what its list cost.
   */
  const unrun = (site: string, error: unknown): void => {
    const session = sessions.get(site);
    const named = nameOf(site);

    tally.sitesFailed++;
    emit({ type: 'site:failed', site: named, error });
    emit(
      siteDone(
        named,
        // Its list was all it did, so its wall clock is its list's — waiting
        // on its pacing included, which its `requestMs` leaves out.
        session?.spanMs ?? 0,
        // What its list cost — the `404` it was answered with included.
        session?.requestsBy ?? {},
        { ...noCounts(), sitesFailed: 1 },
        session?.clock.spent() ?? noTime(),
      ),
    );
  };

  for (const failed of options.failedSites ?? []) {
    unrun(failed.site, failed.error);
  }

  const sites = new PQueue({ concurrency: Math.max(1, options.siteConcurrency ?? configs.length) });

  await Promise.all(
    configs.map((config) =>
      enqueue(sites, async () => {
        if (threads !== undefined) {
          // With what its list was settled with here, which a thread's session
          // of its own would not otherwise know.
          const site = threads.run(config, run, sessions.get(config.site));

          inThreads.push(site);

          // A site its thread never ran says so as a site whose list failed
          // does — and its thread says one that went part way through itself.
          await site.then(
            () => {},
            (error: unknown) => {
              unrun(config.site, error instanceof SiteNotRunError ? error.cause : error);
            },
          );

          return;
        }

        let site: SiteRun;

        // A site that cannot be resolved throws here, before it has a queue or
        // a client to let go of — so nothing of it ran, as a thread says of one
        // it never began.
        try {
          site = new SiteRun(config, run, sessions.get(config.site));
        } catch (error) {
          unrun(config.site, error);

          return;
        }

        // Never rejected: what fails in a site's turn it says itself, and what a
        // reporter throws is kept. Should it be, that is heard where the run
        // waits for it — see below — cancelled or not.
        const running = site.run();

        onThisThread.push(running);
        await running.catch(() => {});
      }).catch((error: unknown) => {
        // A site the cancel let go of, which winds down as it was. Anything
        // else is a fault in this package, which fails the grab rather than
        // being said of the site as something it did — once the run is done,
        // as a reporter's throw does: the other sites still finish, and
        // nothing of theirs is left holding the cache or the run's signal.
        if (signal?.aborted !== true || error !== signal.reason) {
          faults.push(error);
        }
      }),
    ),
  );

  // A cancel lets go of every site at once, while each is still winding down —
  // finishing the write it started, saving its state, counting and saying what
  // it did, here or in its own thread. Waited for, so all of that lands in this
  // run's summary rather than after it, and whatever a reporter throws at it
  // is still the run's to reject with.
  for (const turn of await Promise.allSettled(onThisThread)) {
    if (turn.status === 'rejected') {
      faults.push(turn.reason);
    }
  }

  // And each in a thread then told the run what it counted, which a site on
  // this thread has as it went: here, so a request a parse did not wait for is
  // counted as far as it has got by now on either.
  for (const hosted of await Promise.allSettled(inThreads)) {
    if (hosted.status === 'fulfilled') {
      hosted.value();
    }
  }

  // A cancelled run is not a finished one, and the difference matters to
  // whoever is listening: `grab:done` is what a reporter treats as "this is
  // what the run came to", while a cancel says the opposite — most of what
  // failed was dropped by the cancel itself.
  const loopMaxMs = await loop.worst();

  loop.stop();

  // A fault in this package is not a run that came to what it came to: said by
  // the grab rejecting, and not by a `grab:done` telling every reporter the run
  // went as it should.
  if (faults.length > 0) {
    throw faults.length === 1
      ? faults[0]
      : new AggregateError(faults, `${faults.length} sites' turns threw`);
  }

  emit(
    signal?.aborted
      ? { type: 'run:cancelled', fetched: tally.fetched }
      : { type: 'grab:done', loopMaxMs, requestsBy: requestsObject(requests), ...tally },
  );

  return tally;
}
