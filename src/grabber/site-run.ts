/**
 * One site's turn in a run: work out what is missing, ask the source for it, and
 * put what comes back in the cache.
 *
 * A class rather than a closure because of how much of it is shared — the site's
 * queue and client, its settings, its state, the run's counters — and how many
 * steps share it. What each step is for is in its own doc; how the four queues
 * fit together is the thing to know first:
 *
 * - **`requests`** (per site, from `sitePacing`) paces the source. A task in it
 *   is one request and nothing else, which is what lets a parse ask for one.
 * - **`pipelines`** (per site) bounds how many responses this site has in hand
 *   at once: fetched, and not yet written.
 * - **`localWork`** (per run) bounds what never leaves the machine — the
 *   staleness sweep, and parsing a channel-day and writing it.
 * - **`sites`** (per run, in {@link grab}) is how many sites go at once.
 */

import type { KyInstance } from 'ky';
import PQueue from 'p-queue';
import { isStale } from '../cache/main.js';
import type { CacheStore } from '../cache/types.js';
import { dayToDate } from '../core/days.js';
import type { Emit, GrabCounts } from '../core/events.js';
import { ProgrammeBuilder } from '../xmltv/builder.js';
import type { XmltvProgramme } from '../xmltv/types.js';
import { resolveChannels } from './channels.js';
import { sitePacing } from './pacing.js';
import { planRequests, type Pair, type Request } from './planner.js';
import {
  forget,
  isUnchanged,
  pruneValidators,
  revalidation,
  type Revalidation,
  type Validator,
} from './revalidate.js';
import { resolveSite, type ResolvedSite } from './site.js';
import { SiteStateHandle, StateKey, TrackedMap } from './state.js';
import type {
  AnySiteConfig,
  BaseRequestContext,
  BatchingOption,
  BatchMode,
  ChannelsDaysRequestContext,
  GrabberChannel,
  GrabOptions,
  ParsedProgramme,
  RequestContextFor,
  SiteConfig,
  SiteState,
  StreamContext,
  StreamSiteConfig,
} from './types.js';

/**
 * What a run counts as it goes, and answers with when it is done.
 *
 * The same five numbers a site keeps for itself, which is what makes summing
 * them a matter of adding rather than of merging two shapes.
 */
export type RunTally = GrabCounts;

/** Queue one task on `queue`, cancellable with the run — see {@link grab}. */
export type Enqueue = <T>(
  queue: PQueue,
  task: (options: { signal?: AbortSignal | undefined }) => Promise<T>,
  options?: { priority?: number },
) => Promise<T>;

/** What the run lends each of its sites. */
export interface Run {
  /** The options as given, for the defaults a site may fall back to. */
  options: GrabOptions;
  cache: CacheStore;
  /** The reference for staleness, settled once for the whole run. */
  now: Date;
  /** What every entry this run writes is stamped with. */
  grabbedAt: string;
  /** First day of the window. */
  startDay: string;
  /** Say what happened, for whoever is listening — see `core/events.ts`. */
  emit: Emit;
  signal?: AbortSignal | undefined;
  /** The run-wide queue for work that never leaves the machine. */
  localWork: PQueue;
  enqueue: Enqueue;
  tally: RunTally;
}

/** A parse may hand back either form; the cache only knows the object. */
function built(entry: ParsedProgramme): XmltvProgramme {
  return entry instanceof ProgrammeBuilder ? entry.build() : entry;
}

export class SiteRun {
  readonly #run: Run;
  readonly #config: AnySiteConfig;

  /**
   * Which shape this site is, with the config narrowed to match.
   *
   * Kept as the one object `resolveSite` handed back rather than picked apart,
   * because that is what carries the narrowing: reading `isStreaming` off it
   * tells the compiler what `config` is, so neither pipeline can be given the
   * wrong kind and neither has to assert what it was given.
   */
  readonly #resolved: ResolvedSite;

  /** This site's name, which every log line and cache key starts with. */
  readonly #site: string;

  /** The site's own client and request queue, and how to let them go. */
  readonly #http: KyInstance;
  readonly #requests: PQueue;
  readonly #dispose: () => void;

  /** One planned request each, start to finish. */
  readonly #pipelines: PQueue;

  /** What this site remembers between runs. */
  readonly #state: SiteStateHandle;

  /**
   * The channel-days this run has already written, so a second lot of
   * programmes for one of them is added rather than put in its place.
   *
   * Only a stream can do that — a request's channel-days are parsed once each —
   * and a document that is not grouped by channel is where it happens: the split
   * flushes what it has when the channel changes, and finds the channel again
   * later.
   */
  readonly #written = new Set<string>();

  /** Whether this site asked to be told when nothing has changed. */
  readonly #revalidates: boolean;

  /**
   * What this site came to, beside what the run came to.
   *
   * Both, rather than a diff of the run's at either end: sites go at once, so
   * the run's counters move under this one and nothing could be attributed
   * afterwards. Five numbers per site, and the site is the unit a reader
   * actually wants — "which of my six sources is the one that failed" has no
   * answer in a single total.
   */
  readonly #counts: GrabCounts = { fetched: 0, empty: 0, fromCache: 0, unchanged: 0, failed: 0 };

  /** Filled in by {@link run}, since each of them has to be waited for. */
  #siteState: SiteState = new Map();
  #validators: TrackedMap<Validator> = new TrackedMap();
  #channels: GrabberChannel[] = [];

  constructor(config: AnySiteConfig, run: Run) {
    // Before its queue exists, let alone a request: a site that cannot be
    // resolved is one nothing else here can be asked about.
    const resolved = resolveSite(config, run.options, run.startDay);

    this.#run = run;
    this.#config = config;
    this.#resolved = resolved;
    this.#site = resolved.site;
    this.#revalidates = config.conditionalGet === true;
    this.#state = SiteStateHandle.open(run.cache, resolved.site);

    // The queue and the client together: the signal rides on the instance, so
    // every call a site makes through it is abortable without the site having to
    // pass it on, and a slow-down the client meets stops the queue.
    //
    // A task of `requests` is one request to the source and nothing else — not
    // the work its response is for. That is what its `concurrency`, `rateLimit`
    // and backoff are about, and keeping it to that is what lets a `parseDay` ask
    // for a request of its own.
    const { queue, http, dispose } = sitePacing(config, {
      ...(run.signal ? { signal: run.signal } : {}),
      emit: run.emit,
    });

    this.#requests = queue;
    this.#http = http;
    this.#dispose = dispose;

    /**
     * What this bounds is how many responses the site has in hand at once:
     * fetched, and not yet parsed and written.
     *
     * The request queue used to bound that on its own, by holding a slot until
     * the response's channel-days were written — which is also what made a
     * request from inside `parseDay` impossible: the parse would have waited for
     * the slot its own response had arrived through. So that slot now covers the
     * fetch alone, and what a site may hold in memory is said here instead, where
     * it is not also what paces the source. The same number either way, so a site
     * keeps the footprint it had: one response per unit of concurrency, however
     * wide a response is.
     *
     * Its tasks are the only ones here added without a signal, deliberately.
     * p-queue drops a *waiting* task on abort but only rejects a *running* one's
     * promise — the task itself carries on, off the books, so the queue reports
     * idle with work still in it and a summary can be read before the work that
     * belongs in it has finished. A task with no signal is never abandoned, which
     * makes reaching idle mean what it says; cancelling is then the pipeline's own
     * business, where it can say what a dropped channel-day amounts to.
     */
    this.#pipelines = new PQueue({ concurrency: Math.max(1, config.concurrency ?? 1) });
  }

  /** Count one channel-day, for this site and for the run it is part of. */
  #count(field: keyof GrabCounts, delta = 1): void {
    this.#counts[field] += delta;
    this.#run.tally[field] += delta;
  }

  /** Everything this site does, start to finish. */
  async run(): Promise<void> {
    const { enqueue } = this.#run;

    // Both groups at once, and before anything asks the source: a site's own code
    // expects its bag from the first request onwards, and what is stored about a
    // url decides what that request even looks like. Two small reads with nothing
    // to do with each other, so the site waits for the slower rather than both.
    const stored: Promise<TrackedMap<Validator>> = this.#revalidates
      ? this.#state.bag<Validator>(StateKey.VALIDATORS)
      : Promise.resolve(new TrackedMap<Validator>());
    const [siteState, validators] = await Promise.all([this.#state.bag(), stored]);

    this.#siteState = siteState;
    // Pruned as it is taken on: the days this window covers are the days its
    // entries survive a prune for, so a validator about anything earlier is one
    // whose channel-days have gone.
    this.#validators = pruneValidators(validators, this.#resolved.window[0] ?? this.#run.startDay);

    // Fetching the channel list is a request to the same source as the rest, so
    // it goes through the same queue: a site's `rateLimit` spaces the first EPG
    // request after it, rather than the two landing back to back. The signal it
    // is handed is p-queue's, this task's own: what governs the slot governs the
    // work in it.
    this.#channels = await enqueue(this.#requests, ({ signal }) =>
      resolveChannels(this.#config, {
        http: this.#http,
        ...(signal ? { signal } : {}),
        state: this.#state,
        refresh: this.#resolved.staleness.refetchAll,
        now: this.#run.now,
      }),
    );

    const requests = planRequests({
      channels: this.#channels,
      window: this.#resolved.window,
      stale: await this.#collectStale(),
      batching: this.#resolved.batching,
    });

    // The one thing said before the work rather than after it, and the only
    // place a run's shape is known in advance: the channel list has arrived, the
    // cache has been swept, and what is left is exactly this many requests.
    this.#run.emit({
      type: 'site:started',
      site: this.#site,
      channels: this.#channels.length,
      days: this.#resolved.window.length,
      requests: requests.length,
    });

    for (const request of requests) {
      // Nothing awaits this, and a pipeline reports its own failures, so there is
      // no rejection to swallow: a cancelled run leaves each of these to return
      // without doing anything.
      // Which pipeline runs and which config it is handed are the same decision,
      // taken here and nowhere else — so neither can be got wrong, and neither
      // pipeline has to assert what it was given.
      void this.#pipelines.add(() =>
        this.#resolved.isStreaming
          ? this.#streamPipeline(this.#resolved.config, request)
          : this.#requestPipeline(this.#resolved.config, request),
      );
    }

    try {
      // Everything this site does happens inside one of those pipelines — the
      // fetch, the parse, the write, and any request a parse made of its own —
      // and none of them is ever abandoned, so this is the site being done.
      await this.#pipelines.onIdle();
    } finally {
      this.#dispose();
      // Beside `dispose`, and for the same reason: a site that threw, or was
      // cancelled part way, has as much to hand back as one that finished — the
      // channel list it fetched, and whatever its own code remembered. Only the
      // groups that changed are written.
      await this.#state.save();
      this.#run.emit({ type: 'site:done', site: this.#site, ...this.#counts });
    }
  }

  /**
   * Which channel-days actually need fetching.
   *
   * The meta reads never leave the machine, so they go through `localWork` rather
   * than the request queue — a whole grid of them at once would be a file
   * descriptor storm — and a fresh one is accounted for here, exactly once,
   * however the requests are grouped afterwards.
   *
   * A channel's whole window is one piece of local work rather than one per day,
   * because the answer for a day is worth almost nothing on its own: a store that
   * can settle a window in one question — a database, or anything across a
   * network — then does, and one that cannot is asked day by day inside the same
   * slot.
   *
   * Which keeps the descriptors where they were, since the store asks in turn
   * rather than all at once: `localConcurrency` slots, one open file each. It does
   * change what a slot holds. A site with fewer channels than the bound now fills
   * fewer of them and reads its window in sequence — 14 reads of roughly 0.1ms
   * rather than 14 at a time — which is worth a millisecond and change per channel
   * against thousands of round trips saved for a store that has to make them.
   */
  async #collectStale(): Promise<Pair[]> {
    const { cache, emit, enqueue, localWork, now } = this.#run;
    const site = this.#site;

    const checked = await Promise.all(
      this.#channels.map((channel) =>
        enqueue(localWork, async (): Promise<Pair[]> => {
          const keys = this.#resolved.window.map((day) => ({
            site,
            channelId: channel.xmltvId,
            day,
          }));
          const metas = await cache.getMetas(keys);

          return this.#resolved.window.flatMap((day, index) => {
            const cached = metas[index];

            if (isStale(day, cached, this.#resolved.staleness, now)) {
              // The meta goes with it: what a conditional request asks with, and
              // what it would keep. Read once here rather than again later.
              return [{ channel, day, ...(cached === undefined ? {} : { cached }) }];
            }

            this.#count('fromCache');
            emit({ type: 'entry:cached', site, channelId: channel.xmltvId, day });

            return [];
          });
        }),
      ),
    );

    return checked.flat();
  }

  /**
   * What this request may ask the source, and what it is allowed to hear back.
   *
   * `mayKeep` is the guard on a conditional request, and every clause of it is a
   * way a 304 could do damage: with a channel-day of this request uncached, being
   * told "unchanged" would leave a hole in the guide; with one past `maxAgeDays`,
   * a source whose `Last-Modified` lies could freeze the guide indefinitely
   * rather than for a week; and under `--refresh` the whole point is to ask
   * outright.
   *
   * `since` is what to ask with when nothing is stored about the url: the oldest
   * `grabbedAt` of the channel-days this request covers, which is the moment
   * everything it would keep was known to be right.
   */
  #revalidationFor(request: Request): Revalidation {
    const cached = request.pairs.map((pair) => pair.cached);
    const oldest = cached.reduce<string | undefined>(
      (earliest, meta) =>
        meta !== undefined && (earliest === undefined || meta.grabbedAt < earliest)
          ? meta.grabbedAt
          : earliest,
      undefined,
    );
    const staleAt = this.#run.now.getTime() - this.#resolved.staleness.maxAgeDays * 86_400_000;
    const mayKeep =
      this.#revalidates &&
      !this.#resolved.staleness.refetchAll &&
      cached.every((meta) => meta !== undefined && Date.parse(meta.grabbedAt) >= staleAt);

    return {
      mayKeep,
      ...(oldest === undefined ? {} : { since: new Date(oldest).toUTCString() }),
      lastDay: request.days[request.days.length - 1] ?? this.#run.startDay,
      validators: this.#validators,
      touched: [],
    };
  }

  /** What every context carries, whichever shape the rest of it takes. */
  #contextBase(request: Request, signal?: AbortSignal): BaseRequestContext {
    return {
      channelDays: request.pairs.map(({ channel, day, cached }) => ({
        channel,
        day,
        date: dayToDate(day),
        ...(cached === undefined ? {} : { cached }),
      })),
      http: this.#http,
      state: this.#siteState,
      log: (message: string) => this.#run.emit({ type: 'site:note', site: this.#site, message }),
      warn: (message: string) =>
        this.#run.emit({ type: 'site:warning', site: this.#site, message }),
      ...(signal ? { signal } : {}),
    };
  }

  /**
   * The days a request covers, as a context that batches them says them.
   *
   * A Date of its own everywhere one is handed out, `from` and `to` included.
   * They are mutable — `Object.freeze` does not help, a Date keeps its value in
   * an internal slot rather than a property — so the hazard worth removing is not
   * that a site can change one, it is that changing one would silently change the
   * others: `from` and `dates[0]` as the same object is a bug nobody would find.
   */
  #manyDays(request: Request): Pick<ChannelsDaysRequestContext, 'days' | 'dates' | 'from' | 'to'> {
    return {
      days: request.days,
      dates: request.days.map(dayToDate),
      from: dayToDate(request.days[0]!),
      to: dayToDate(request.days[request.days.length - 1]!),
    };
  }

  /**
   * The context for one request, in the shape this site's mode declares — plus
   * the channel-days it is for, which the plan already worked out.
   */
  #contextFor(request: Request, signal?: AbortSignal): RequestContextFor<BatchMode> {
    const { manyChannels, manyDays } = this.#resolved.batching;
    const context = {
      ...this.#contextBase(request, signal),
      ...(manyChannels ? { channels: request.channels } : { channel: request.channels[0]! }),
      ...(manyDays
        ? this.#manyDays(request)
        : { day: request.days[0]!, date: dayToDate(request.days[0]!) }),
    };

    // The mode and this shape were chosen together right here; the compiler
    // cannot follow that through the conditional type.
    return context as RequestContextFor<BatchMode>;
  }

  /**
   * The context a stream is given: every channel and day it is being asked
   * about, and somewhere to say what it noticed on the way through.
   *
   * Built rather than cast from {@link #contextFor}'s: a stream site always
   * resolves to `both`, so this shape is not one of several and needs no
   * assertion to say which — a member added to `StreamContext` fails to compile
   * here instead of being quietly missing at runtime.
   */
  #streamContextFor(request: Request, signal?: AbortSignal): StreamContext {
    return {
      ...this.#contextBase(request, signal),
      ...this.#manyDays(request),
      channels: request.channels,
    };
  }

  /**
   * Put one channel-day in the cache, and account for it.
   *
   * Not queued: this is the inside of a `localWork` task, which is what makes a
   * parse and the write it is for one piece of work rather than two.
   */
  async #persist(
    channel: GrabberChannel,
    day: string,
    parsed: ParsedProgramme[],
    taskSignal?: AbortSignal,
  ): Promise<void> {
    // Cancelled while the parse was running. p-queue has let go of this task
    // already — it rejected what `add` returned the moment the signal fired — so
    // a write from here would land after the summary that should have accounted
    // for it, and be counted into a total nobody is going to read.
    taskSignal?.throwIfAborted();

    const { cache, emit, grabbedAt } = this.#run;
    const site = this.#site;
    const key = { site, channelId: channel.xmltvId, day };
    const id = `${channel.xmltvId}|${day}`;
    const mine = parsed
      .map((entry) => ({ ...built(entry), channel: channel.xmltvId }))
      .sort((a, b) => a.start.getTime() - b.start.getTime());

    if (!this.#written.has(id)) {
      this.#written.add(id);
      await cache.write(key, mine, { grabbedAt });
      this.#count('fetched');

      if (mine.length === 0) {
        this.#count('empty');
      }

      emit({
        type: 'entry:fetched',
        site,
        channelId: channel.xmltvId,
        day,
        programmes: mine.length,
      });

      return;
    }

    // Said twice, so the entry is what both emissions add up to. Read back rather
    // than held: what came before may have been written thousands of channel-days
    // ago, and this is the rare case rather than the hot path.
    const before = (await cache.read(key)) ?? [];
    const programmes = [...before, ...mine].sort((a, b) => a.start.getTime() - b.start.getTime());

    await cache.write(key, programmes, { grabbedAt });

    // Counted as one channel-day however many times it is mentioned — and no
    // longer an empty one, if the first emission was all there was of it.
    if (before.length === 0 && programmes.length > 0) {
      this.#count('empty', -1);
    }

    emit({
      type: 'entry:appended',
      site,
      channelId: channel.xmltvId,
      day,
      added: mine.length,
      total: programmes.length,
    });
  }

  /**
   * Parse one channel-day out of the payload and cache it.
   *
   * Queued on `localWork`: `parseDay` is the site's own code and the write is a
   * file, so a wide response must not put every one of its channel-days through
   * both at once. Ahead of the sweep in the queue, because a response already in
   * hand is held in memory until it is written, while a staleness check only
   * discovers more work to do.
   */
  #store(
    config: SiteConfig<any, BatchingOption, any>,
    channel: GrabberChannel,
    day: string,
    payload: unknown,
  ): Promise<void> {
    const { enqueue, localWork } = this.#run;

    return enqueue(
      localWork,
      async ({ signal: taskSignal }) => {
        const parsed = await config.parseDay({
          channel,
          date: dayToDate(day),
          day,
          payload,
          http: this.#http,
          state: this.#siteState,
          log: (message: string) =>
            this.#run.emit({ type: 'site:note', site: this.#site, message }),
          warn: (message: string) =>
            this.#run.emit({ type: 'site:warning', site: this.#site, message }),
          ...(taskSignal ? { signal: taskSignal } : {}),
          // A request of the parse's own goes through the site's queue, like the
          // request being parsed did — ahead of the planned ones, so a channel-day
          // in hand is finished rather than joined by another.
          paced: (task) => enqueue(this.#requests, task, { priority: 1 }),
          // Bound to the channel-day being parsed, so a parse repeats neither the
          // id nor the language on every programme it builds.
          programme: (start, title, options) =>
            new ProgrammeBuilder({
              channel: channel.xmltvId,
              start,
              title,
              ...(channel.lang === undefined ? {} : { lang: channel.lang }),
              ...options,
            }),
        });

        await this.#persist(channel, day, parsed, taskSignal);
      },
      { priority: 1 },
    );
  }

  /** The same, for a channel-day a stream has already worked out. */
  #storeStreamed(
    channel: GrabberChannel,
    day: string,
    programmes: ParsedProgramme[],
  ): Promise<void> {
    const { enqueue, localWork } = this.#run;

    return enqueue(
      localWork,
      ({ signal: taskSignal }) => this.#persist(channel, day, programmes, taskSignal),
      { priority: 1 },
    );
  }

  /** One channel-day's failure, reported and counted. */
  #fail(channel: GrabberChannel, day: string, error: unknown): void {
    this.#count('failed');
    this.#run.emit({
      type: 'entry:failed',
      site: this.#site,
      channelId: channel.xmltvId,
      day,
      error,
    });
  }

  /**
   * Keep these channel-days as they are: the source says nothing has changed.
   *
   * Counted in `unchanged` rather than `fetched`, and nothing is written — so
   * `grabbedAt` stands where it was, the entry ages as it was already ageing, and
   * the next run asks the same cheap question again.
   *
   * A channel-day with nothing cached cannot be kept, and saying otherwise would
   * leave a hole in the guide that nothing else would report. `mayKeep` is what
   * stops this package's own hooks ever asking in that position; a site that
   * throws `UnchangedError` on its own judgement can still land here, and is told
   * so as a failure.
   */
  #keep(pairs: Iterable<Pair>, error: unknown): void {
    const { emit } = this.#run;

    for (const { channel, day, cached } of pairs) {
      if (cached === undefined) {
        this.#fail(
          channel,
          day,
          new Error(`the source says this channel-day is unchanged, but nothing is cached for it`, {
            cause: error,
          }),
        );

        continue;
      }

      this.#count('unchanged');
      // One each rather than a count for the request: what a reader wants of a
      // kept channel-day is which one it was, and `site:done` already carries
      // how many there were.
      emit({ type: 'entry:unchanged', site: this.#site, channelId: channel.xmltvId, day });
    }
  }

  /**
   * A whole request's worth of failure: every channel-day it was owed, and one
   * line about the request rather than one per channel-day it covered.
   *
   * The same for either shape — a request that never returned, and a stream that
   * stopped part way — since what went wrong is the one fetch in both cases.
   */
  #failRequest(request: Request, pairs: Iterable<Pair>, error: unknown): void {
    let entries = 0;

    for (const _pair of pairs) {
      this.#count('failed');
      entries++;
    }

    // One event for the request, carrying how many channel-days went with it —
    // and deliberately no `entry:failed` for each, which is the difference
    // between one line about a site that is down and thousands.
    this.#run.emit({
      type: 'request:failed',
      site: this.#site,
      channels: request.channels.map((channel) => channel.xmltvId),
      days: request.days,
      entries,
      error,
    });
  }

  /**
   * One planned request, start to finish: fetch it, then parse and write every
   * channel-day it covered.
   *
   * Cancelling is handled here rather than by the queue this runs in, which is
   * what lets the two outcomes differ: a request the cancel never let start is
   * simply not made, while one interrupted in flight leaves the channel-days it
   * was for short, and says so.
   */
  async #requestPipeline(
    config: SiteConfig<any, BatchingOption, any>,
    request: Request,
  ): Promise<void> {
    const { enqueue, signal } = this.#run;

    if (signal?.aborted) {
      return;
    }

    const asking = this.#revalidationFor(request);
    let payload: unknown;

    try {
      // The request queue's slot covers this and nothing else, so a parse below is
      // free to ask for one of its own. What the request is handed is that task's
      // signal, not the run's — what governs the slot governs the work in it.
      //
      // The ambient store goes *inside* the task, not around `enqueue`: a task
      // that has to wait for a slot is started later by the queue's own drain
      // loop, in a context this one never reached — so wrapping the `add` would
      // work for the first request of a site and silently for none of the rest.
      // Around the site's call and nothing else, which is also what keeps a
      // request made later from inside `parseDay` out of it.
      payload = await enqueue(this.#requests, ({ signal: taskSignal }) =>
        revalidation.run(asking, () => config.request(this.#contextFor(request, taskSignal))),
      );
      // The run's own, and a different question: was this cancelled while it was
      // in flight? p-queue's task signal governs the slot, not the work in it, so
      // stopping is ours to do — and what it stops here is a response already paid
      // for, which is news.
      signal?.throwIfAborted();
    } catch (error) {
      if (isUnchanged(error)) {
        // Nothing has changed, so every channel-day this request was for keeps
        // the entry it has: no parse, no write, and `grabbedAt` unmoved.
        this.#keep(request.pairs, error);

        return;
      }

      // The request did not finish, so what it remembered on the way is not to be
      // asked with next time — see `forget`.
      forget(asking);
      // A failed request fails every channel-day it was covering.
      this.#failRequest(request, request.pairs, error);

      return;
    }

    // Parsing and caching are per channel-day, so one bad slice does not sink the
    // rest of the response.
    await Promise.all(
      request.pairs.map(async ({ channel, day }) => {
        try {
          await this.#store(config, channel, day, payload);
        } catch (error) {
          this.#fail(channel, day, error);
        }
      }),
    );
  }

  /**
   * The whole window in one pass: run the site's stream, and write each
   * channel-day it says it found.
   *
   * The request queue's slot covers the lot, since the pass *is* the request —
   * one long-lived response, from which channel-days fall out as they become
   * complete. A stream has no `parseDay` to ask for a request of its own, so
   * nothing is waiting behind that slot.
   */
  async #streamPipeline(config: StreamSiteConfig<any>, request: Request): Promise<void> {
    const { emit, enqueue, localWork, signal } = this.#run;

    if (signal?.aborted) {
      return;
    }

    // What is still owed, by channel-day. An emission takes its pair out; what is
    // left when the stream ends is what the source never mentioned.
    const owed = new Map(
      request.pairs.map((pair) => [`${pair.channel.xmltvId}|${pair.day}`, pair]),
    );
    // Writes in flight. Each records its own failure, so none of these ever
    // rejects and the whole lot can be waited for at the end.
    const writes: Promise<void>[] = [];
    /** Channel-days the pass said were unchanged, kept once it ends cleanly. */
    const keeping: Pair[] = [];
    const asking = this.#revalidationFor(request);
    let ignored = 0;
    let failure: unknown;

    const write = (pair: Pair, programmes: ParsedProgramme[]): void => {
      writes.push(
        this.#storeStreamed(pair.channel, pair.day, programmes).catch((error: unknown) => {
          this.#fail(pair.channel, pair.day, error);
        }),
      );
    };

    try {
      // The store goes inside the task rather than around `enqueue`, for the
      // reason the request pipeline gives: a task that waited for a slot starts
      // in a context this one never reached.
      await enqueue(this.#requests, async ({ signal: taskSignal }) =>
        revalidation.run(asking, async () => {
          for await (const emission of config.stream(this.#streamContextFor(request, taskSignal))) {
            // Between emissions, which is as often as this has anything to say: a
            // cancelled run stops here rather than writing the rest of a document
            // nobody is waiting for.
            signal?.throwIfAborted();

            const { channel, day } = emission;
            const id = `${channel?.xmltvId}|${day}`;
            const pair = owed.get(id);

            if (pair === undefined) {
              if (this.#written.has(id) && emission.unchanged !== true) {
                // Said again: added to what the earlier emission wrote, rather
                // than put in its place. A document not grouped by channel.
                write({ channel, day }, emission.programmes);
              } else {
                // A channel-day nobody asked about — one already fresh in the
                // cache, a channel outside the list, or an emission that makes no
                // sense. Counted, and reported once at the end.
                ignored++;
              }
            } else if (emission.unchanged === true) {
              // Nothing to write: the pass says what is cached still stands. Held
              // until the stream ends, since a pass that then fails has not
              // vouched for anything.
              owed.delete(id);
              keeping.push(pair);
            } else {
              owed.delete(id);
              write(pair, emission.programmes);
            }

            // Backpressure, and the only thing holding the parser back: writing is
            // queued rather than awaited, so the split runs on while entries land,
            // but no further ahead than `localConcurrency` of them.
            await localWork.onSizeLessThan(localWork.concurrency);
          }
        }),
      );
    } catch (error) {
      failure = error;
    }

    // Every write that was started, before deciding what was missed: one of them
    // may be the last mention of a channel-day still in `owed`.
    await Promise.all(writes);

    if (ignored > 0) {
      emit({ type: 'stream:ignored', site: this.#site, count: ignored });
    }

    if (failure !== undefined && isUnchanged(failure)) {
      // The whole document is unchanged — a 304 on the one request a pass makes.
      // Everything it was for keeps what it has, including anything it had
      // already said was unchanged before the answer came back.
      this.#keep([...keeping, ...owed.values()], failure);

      return;
    }

    if (failure !== undefined) {
      // The stream did not finish, so what it never reached is short — not empty.
      // Anything else would cache "nothing on" for a document that was cut off
      // half way. What it remembered on the way is dropped for the same reason.
      forget(asking);
      this.#failRequest(request, owed.values(), failure);
      // What it did vouch for before it broke is still cached and still counted:
      // those entries were not touched, and saying they were lost would be wrong.
      this.#keep(keeping, failure);

      return;
    }

    this.#keep(keeping, failure);

    if (owed.size === 0) {
      return;
    }

    // A clean end with channel-days unmentioned: the source has been through its
    // whole answer and had nothing to say about them, which is what a `parseDay`
    // returning `[]` means too. Cached empty, so the staleness policy decides when
    // to ask again rather than every run asking.
    emit({ type: 'stream:gaps', site: this.#site, count: owed.size });

    for (const pair of owed.values()) {
      write(pair, []);
    }

    await Promise.all(writes);
  }
}
