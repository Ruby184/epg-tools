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
import type { CacheStore, StalenessPolicy } from '../cache/types.js';
import { dayToDate } from '../core/days.js';
import { errorMessage } from '../core/error.js';
import { ProgrammeBuilder } from '../xmltv/builder.js';
import type { XmltvProgramme } from '../xmltv/types.js';
import { resolveChannels } from './channels.js';
import { sitePacing } from './pacing.js';
import {
  describeRequest,
  planRequests,
  type Pair,
  type Request,
  type ResolvedBatching,
} from './planner.js';
import { resolveSite } from './site.js';
import { SiteStateHandle } from './state.js';
import type {
  AnySiteConfig,
  BatchingOption,
  BatchMode,
  GrabberChannel,
  GrabOptions,
  GrabTaskError,
  ParsedProgramme,
  RequestContextFor,
  SiteConfig,
  SiteState,
  StreamContext,
  StreamSiteConfig,
} from './types.js';

/** What a run counts as it goes, and answers with when it is done. */
export interface RunTally {
  fetched: number;
  empty: number;
  fromCache: number;
  failed: GrabTaskError[];
}

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
  log: (message: string) => void;
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

  /** Which shape this site is, and the two ways of reading it. */
  readonly #isStreaming: boolean;
  readonly #fetching: SiteConfig<any, BatchingOption, any>;
  readonly #streaming: StreamSiteConfig<any>;

  readonly #site: string;
  readonly #window: string[];
  readonly #batching: ResolvedBatching;
  readonly #policy: StalenessPolicy;

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

  /** Filled in by {@link run}, since both of them may have to be waited for. */
  #siteState: SiteState = new Map();
  #channels: GrabberChannel[] = [];

  constructor(config: AnySiteConfig, run: Run) {
    // Before its queue exists, let alone a request: a site that cannot be
    // resolved is one nothing else here can be asked about.
    const { site, window, batching, staleness, isStreaming } = resolveSite(
      config,
      run.options,
      run.startDay,
    );

    this.#run = run;
    this.#config = config;
    this.#site = site;
    this.#window = window;
    this.#batching = batching;
    this.#policy = staleness;
    this.#isStreaming = isStreaming;
    // Settled by `resolveSite` — including for a config the types never saw — so
    // these are just the two ways of reading it, and only one is ever called.
    this.#fetching = config as SiteConfig<any, BatchingOption, any>;
    this.#streaming = config as StreamSiteConfig<any>;
    this.#state = SiteStateHandle.open(run.cache, site);

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
      log: run.log,
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

  /** Everything this site does, start to finish. */
  async run(): Promise<void> {
    const { enqueue } = this.#run;

    // Read before anything asks the source: the channel list may be in there,
    // and a site's own code expects its bag from the first request onwards.
    this.#siteState = await this.#state.bag();

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
        refresh: this.#policy.refetchAll,
        now: this.#run.now,
      }),
    );

    const requests = planRequests({
      channels: this.#channels,
      window: this.#window,
      stale: await this.#collectStale(),
      batching: this.#batching,
    });

    for (const request of requests) {
      // Nothing awaits this, and a pipeline reports its own failures, so there is
      // no rejection to swallow: a cancelled run leaves each of these to return
      // without doing anything.
      void this.#pipelines.add(() =>
        this.#isStreaming ? this.#streamPipeline(request) : this.#requestPipeline(request),
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
    const { cache, enqueue, localWork, log, now, tally } = this.#run;
    const site = this.#site;

    const checked = await Promise.all(
      this.#channels.map((channel) =>
        enqueue(localWork, async (): Promise<Pair[]> => {
          const keys = this.#window.map((day) => ({ site, channelId: channel.xmltvId, day }));
          const metas = await cache.getMetas(keys);

          return this.#window.flatMap((day, index) => {
            if (isStale(day, metas[index], this.#policy, now)) {
              return [{ channel, day }];
            }

            tally.fromCache++;
            log(`[${site}] ${channel.xmltvId} ${day}: fresh in cache, skipping`);

            return [];
          });
        }),
      ),
    );

    return checked.flat();
  }

  /**
   * The context for one request, in the shape this site's mode declares — plus
   * the channel-days it is for, which the plan already worked out.
   */
  #contextFor(request: Request, signal?: AbortSignal): RequestContextFor<BatchMode> {
    const { manyChannels, manyDays } = this.#batching;
    // A Date of its own everywhere one is handed out, `from` and `to` included.
    // They are mutable — `Object.freeze` does not help, a Date keeps its value in
    // an internal slot rather than a property — so the hazard worth removing is
    // not that a site can change one, it is that changing one would silently
    // change the others: `from` and `dates[0]` as the same object is a bug nobody
    // would find.
    const dates = request.days.map(dayToDate);
    const context = {
      channelDays: request.pairs.map(({ channel, day }) => ({
        channel,
        day,
        date: dayToDate(day),
      })),
      ...(manyChannels ? { channels: request.channels } : { channel: request.channels[0]! }),
      ...(manyDays
        ? {
            days: request.days,
            dates,
            from: dayToDate(request.days[0]!),
            to: dayToDate(request.days[request.days.length - 1]!),
          }
        : { day: request.days[0]!, date: dates[0]! }),
      http: this.#http,
      state: this.#siteState,
      ...(signal ? { signal } : {}),
    };

    // The mode and this shape were chosen together right here; the compiler
    // cannot follow that through the conditional type.
    return context as RequestContextFor<BatchMode>;
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

    const { cache, grabbedAt, log, tally } = this.#run;
    const site = this.#site;
    const key = { site, channelId: channel.xmltvId, day };
    const id = `${channel.xmltvId}|${day}`;
    const mine = parsed
      .map((entry) => ({ ...built(entry), channel: channel.xmltvId }))
      .sort((a, b) => a.start.getTime() - b.start.getTime());

    if (!this.#written.has(id)) {
      this.#written.add(id);
      await cache.write(key, mine, { grabbedAt });
      tally.fetched++;

      if (mine.length === 0) {
        tally.empty++;
      }

      log(`[${site}] ${channel.xmltvId} ${day}: ${mine.length} programmes`);

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
      tally.empty--;
    }

    log(
      `[${site}] ${channel.xmltvId} ${day}: ${mine.length} more programmes, ` +
        `${programmes.length} in all`,
    );
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
  #store(channel: GrabberChannel, day: string, payload: unknown): Promise<void> {
    const { enqueue, localWork } = this.#run;

    return enqueue(
      localWork,
      async ({ signal: taskSignal }) => {
        const parsed = await this.#fetching.parseDay({
          channel,
          date: dayToDate(day),
          day,
          payload,
          http: this.#http,
          state: this.#siteState,
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
    this.#run.tally.failed.push({ site: this.#site, channelId: channel.xmltvId, day, error });
    this.#run.log(`[${this.#site}] ${channel.xmltvId} ${day}: ${errorMessage(error)}`);
  }

  /**
   * A whole request's worth of failure: every channel-day it was owed, and one
   * line about the request rather than one per channel-day it covered.
   *
   * The same for either shape — a request that never returned, and a stream that
   * stopped part way — since what went wrong is the one fetch in both cases.
   */
  #failRequest(request: Request, pairs: Iterable<Pair>, error: unknown): void {
    for (const { channel, day } of pairs) {
      this.#run.tally.failed.push({ site: this.#site, channelId: channel.xmltvId, day, error });
    }

    this.#run.log(`[${this.#site}] ${describeRequest(request)}: ${errorMessage(error)}`);
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
  async #requestPipeline(request: Request): Promise<void> {
    const { enqueue, signal } = this.#run;

    if (signal?.aborted) {
      return;
    }

    let payload: unknown;

    try {
      // The request queue's slot covers this and nothing else, so a parse below is
      // free to ask for one of its own. What the request is handed is that task's
      // signal, not the run's — what governs the slot governs the work in it.
      payload = await enqueue(this.#requests, ({ signal: taskSignal }) =>
        this.#fetching.request(this.#contextFor(request, taskSignal)),
      );
      // The run's own, and a different question: was this cancelled while it was
      // in flight? p-queue's task signal governs the slot, not the work in it, so
      // stopping is ours to do — and what it stops here is a response already paid
      // for, which is news.
      signal?.throwIfAborted();
    } catch (error) {
      // A failed request fails every channel-day it was covering.
      this.#failRequest(request, request.pairs, error);

      return;
    }

    // Parsing and caching are per channel-day, so one bad slice does not sink the
    // rest of the response.
    await Promise.all(
      request.pairs.map(async ({ channel, day }) => {
        try {
          await this.#store(channel, day, payload);
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
  async #streamPipeline(request: Request): Promise<void> {
    const { enqueue, localWork, log, signal } = this.#run;

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
      await enqueue(this.#requests, async ({ signal: taskSignal }) => {
        const context = {
          ...this.#contextFor(request, taskSignal),
          log: (message: string) => log(`[${this.#site}] ${message}`),
          // The shape a stream is handed is the one a `both`-batched request
          // gets, which is what `resolveSite` planned for it — the compiler
          // cannot follow that through the conditional type.
        } as unknown as StreamContext;

        for await (const { channel, day, programmes } of this.#streaming.stream(context)) {
          // Between emissions, which is as often as this has anything to say: a
          // cancelled run stops here rather than writing the rest of a document
          // nobody is waiting for.
          signal?.throwIfAborted();

          const id = `${channel?.xmltvId}|${day}`;
          const pair = owed.get(id);

          if (pair !== undefined) {
            owed.delete(id);
            write(pair, programmes);
          } else if (this.#written.has(id)) {
            // Said again: added to what the earlier emission wrote, rather than
            // put in its place. A document not grouped by channel.
            write({ channel, day }, programmes);
          } else {
            // A channel-day nobody asked about — one already fresh in the cache, a
            // channel outside the list, or an emission that makes no sense.
            // Counted, and reported once at the end.
            ignored++;
          }

          // Backpressure, and the only thing holding the parser back: writing is
          // queued rather than awaited, so the split runs on while entries land,
          // but no further ahead than `localConcurrency` of them.
          await localWork.onSizeLessThan(localWork.concurrency);
        }
      });
    } catch (error) {
      failure = error;
    }

    // Every write that was started, before deciding what was missed: one of them
    // may be the last mention of a channel-day still in `owed`.
    await Promise.all(writes);

    if (ignored > 0) {
      log(`[${this.#site}] ignored ${ignored} channel-day(s) it was not asked for`);
    }

    if (failure !== undefined) {
      // The stream did not finish, so what it never reached is short — not empty.
      // Anything else would cache "nothing on" for a document that was cut off
      // half way.
      this.#failRequest(request, owed.values(), failure);

      return;
    }

    if (owed.size === 0) {
      return;
    }

    // A clean end with channel-days unmentioned: the source has been through its
    // whole answer and had nothing to say about them, which is what a `parseDay`
    // returning `[]` means too. Cached empty, so the staleness policy decides when
    // to ask again rather than every run asking.
    log(`[${this.#site}] ${owed.size} channel-day(s) not in the document: caching them empty`);

    for (const pair of owed.values()) {
      write(pair, []);
    }

    await Promise.all(writes);
  }
}
