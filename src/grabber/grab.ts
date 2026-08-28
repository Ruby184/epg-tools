import PQueue from 'p-queue';
import { DEFAULT_STALENESS, isStale } from '../cache/main.js';
import type { StalenessPolicy } from '../cache/types.js';
import { dayRange, dayToDate, toDayString } from '../core/days.js';
import { ProgrammeBuilder } from '../xmltv/builder.js';
import type { XmltvProgramme } from '../xmltv/types.js';
import { resolveChannels } from './channels.js';
import { sitePacing } from './pacing.js';
import { SiteStateHandle } from './state.js';
import type {
  AnySiteConfig,
  BaseSiteConfig,
  BatchingOption,
  BatchMode,
  ParsedProgramme,
  RequestContextFor,
  GrabberChannel,
  GrabOptions,
  GrabSummary,
  GrabTaskError,
  SiteConfig,
  StreamContext,
  StreamSiteConfig,
} from './types.js';

/**
 * How much cache work and parsing runs at once, across every site, when
 * `localConcurrency` says nothing. Node's own file operations go through a
 * threadpool of four by default (`UV_THREADPOOL_SIZE`), so a much larger number
 * buys nothing but open files and live programme lists.
 */
const DEFAULT_LOCAL_CONCURRENCY = 16;

/** How many days a run covers when neither the site nor the run says. */
const DEFAULT_DAYS = 7;

/** A parse may hand back either form; the cache only knows the object. */
function built(entry: ParsedProgramme): XmltvProgramme {
  return entry instanceof ProgrammeBuilder ? entry.build() : entry;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * What a site's `batching` amounts to for the planner: how wide a request may
 * be along each axis, and whether the context says `channel`/`day` or
 * `channels`/`days`. A mode that does not batch an axis pins it to 1; an absent
 * or zero cap on a batched axis means "as much as it takes".
 *
 * Keeping the two axes as plain numbers is what lets one chunking pass serve
 * every mode — `none` is just the grid cut into 1×1 requests.
 */
interface ResolvedBatching {
  manyChannels: boolean;
  manyDays: boolean;
  maxChannels: number;
  maxDays: number;
}

function resolveBatching(batching: BatchingOption | undefined): ResolvedBatching {
  // Both shapes `batching` accepts, and its absence, as one object.
  const settings: { mode: BatchMode; channelsPerRequest?: number; daysPerRequest?: number } =
    typeof batching === 'string' ? { mode: batching } : (batching ?? { mode: 'none' });
  const manyChannels = settings.mode === 'channels' || settings.mode === 'both';
  const manyDays = settings.mode === 'days' || settings.mode === 'both';
  const cap = (size: number | undefined): number =>
    size !== undefined && size > 0 ? size : Number.POSITIVE_INFINITY;

  return {
    manyChannels,
    manyDays,
    maxChannels: manyChannels ? cap(settings.channelsPerRequest) : 1,
    maxDays: manyDays ? cap(settings.daysPerRequest) : 1,
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  // Always a copy, even when the whole lot fits in one chunk: a chunk becomes
  // the `channels` a site is handed, and site code sorting that in place must
  // not reach back into the planner's own array.
  if (items.length <= size) {
    return items.length > 0 ? [[...items]] : [];
  }

  const chunks: T[][] = [];

  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }

  return chunks;
}

/** What arrived instead, so a message about a mandatory member can name it. */
function received(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  if (Array.isArray(value)) {
    return 'an array';
  }

  const kind = typeof value;

  return kind === 'undefined' ? 'undefined' : `${kind === 'object' ? 'an' : 'a'} ${kind}`;
}

/**
 * A site's settings as the planner needs them: checked, and with the run's
 * defaults and the site's own overrides already folded in.
 *
 * Settings only — whichever of `request`, `parseDay` and `stream` the site
 * brought are still called on the config itself, so a site written with `this`
 * keeps it.
 */
interface ResolvedSite {
  /** Cache namespace and log prefix. */
  site: string;
  /** The days this run covers for this site, ascending. */
  window: string[];
  /** How wide a request may be along each axis, and the context shape it gets. */
  batching: ResolvedBatching;
  /** When a cached day counts as stale: run policy under site override. */
  staleness: StalenessPolicy;
  /** Which of the two shapes this site is: one pass, or a request at a time. */
  isStreaming: boolean;
}

/**
 * A config as it actually arrived: the members of either shape, none of them
 * promised.
 *
 * What {@link resolveSite} checks against, because that is the situation it is
 * for — a config that was never held to the type at all. Narrowing the union
 * would be describing a config that has already been vouched for.
 */
type UncheckedSiteConfig = BaseSiteConfig<any> &
  Partial<Pick<SiteConfig<any, BatchingOption, any>, 'batching' | 'request' | 'parseDay'>> &
  Partial<Pick<StreamSiteConfig<any>, 'stream'>>;

/**
 * Resolve one site against the run: check what it must bring, then settle every
 * default in one pass, so nothing downstream spells one out again.
 *
 * The types make every one of these mandatory, so the checks are for configs
 * that arrive without having been held to them — plain JS, or a config file the
 * CLI imported and this package never saw compiled. Each would otherwise surface
 * a long way from its cause: `parseDay` once per channel-day, and only after
 * every request had already gone out; `channels` as a missing `flatMap`; and
 * `site` not at all, quietly filing this site's cached days under `undefined`,
 * in with those of every other site that left it out.
 *
 * It is also where the two shapes are told apart, by the one member that says
 * so: a site with `stream` answers its whole window in one pass and is asked for
 * neither `request` nor `parseDay`.
 *
 * Each message says what the member is *for*, because at this point the mistake
 * is usually a misspelling or a shape that has moved on, not ignorance that it
 * exists.
 */
function resolveSite(config: AnySiteConfig, options: GrabOptions, startDay: string): ResolvedSite {
  if (typeof config.site !== 'string' || config.site === '') {
    throw new TypeError(
      `A site must define site: a non-empty string, unique to it, naming its cache namespace ` +
        `(got ${received(config.site)})`,
    );
  }

  if (typeof config.channels !== 'function' && !Array.isArray(config.channels)) {
    throw new TypeError(
      `Site "${config.site}" must define channels: an array of channels, or a function ` +
        `returning one (got ${received(config.channels)})`,
    );
  }

  const unchecked = config as UncheckedSiteConfig;
  const isStreaming = typeof unchecked.stream === 'function';

  if (!isStreaming) {
    if (typeof unchecked.request !== 'function') {
      throw new TypeError(
        `Site "${config.site}" must define request: a function fetching one request's raw data ` +
          `— or stream, a function yielding one channel-day at a time out of a whole document ` +
          `(got ${received(unchecked.request)})`,
      );
    }

    if (typeof unchecked.parseDay !== 'function') {
      throw new TypeError(
        `Site "${config.site}" must define parseDay: a function turning a response into one ` +
          `channel-day's programmes (got ${received(unchecked.parseDay)})`,
      );
    }
  }

  return {
    site: config.site,
    window: [...dayRange(startDay, config.days ?? options.days ?? DEFAULT_DAYS)],
    // A site that streams is asked about its whole window at once, which is what
    // `both` with no caps already plans: one request over every stale
    // channel-day. So the planner needs no idea that this site is different.
    batching: resolveBatching(isStreaming ? { mode: 'both' } : unchecked.batching),
    staleness: { ...DEFAULT_STALENESS, ...options.staleness, ...config.staleness },
    isStreaming,
  };
}

/** One channel-day: the unit of caching, parsing and failure reporting. */
interface Pair {
  channel: GrabberChannel;
  day: string;
}

/**
 * One request: the channels and days it covers, and the channel-days it is
 * expected to yield. `pairs` is a subset of `channels × days` — batching both
 * axes at once means a request can span a channel-day that is already fresh,
 * and that one is neither parsed nor rewritten.
 */
interface Request {
  channels: GrabberChannel[];
  days: string[];
  pairs: Pair[];
}

/** How a request is named in the log: a channel-day, or the span it covers. */
function describe({ channels, days }: Request): string {
  const channelPart = channels.length === 1 ? channels[0]!.xmltvId : `${channels.length} channels`;
  const dayPart =
    days.length === 1 ? days[0]! : `${days[0]}..${days[days.length - 1]} (${days.length} days)`;

  return `${channelPart} ${dayPart}`;
}

export async function grab(configs: AnySiteConfig[], options: GrabOptions): Promise<GrabSummary> {
  const now = options.now ?? new Date();
  const startDay = options.startDay ?? toDayString(now);
  const log = options.logger ?? (() => {});
  const { cache, signal } = options;

  let fetched = 0;
  let empty = 0;
  let fromCache = 0;
  const failed: GrabTaskError[] = [];

  /**
   * Everything that is not a request: the staleness sweep, and parsing a
   * channel-day out of a response and writing it.
   *
   * One queue for the whole run rather than one per site, because what it
   * bounds — open files, and how many parsed programme lists are alive at once
   * — is a property of the process, not of a site. A site's own `concurrency`
   * and `rateLimit` are about being polite to that site, so cache work must not
   * be throttled by them, nor take a request's slot.
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
  const enqueue = <T>(
    queue: PQueue,
    task: (options: { signal?: AbortSignal | undefined }) => Promise<T>,
    options: { priority?: number } = {},
  ): Promise<T> =>
    queue.add(task, {
      ...options,
      // Not `[signal]` for the sake of a copy: `any` is what makes the listeners
      // land on a list of this task's own.
      ...(signal ? { signal: AbortSignal.any([signal]) } : {}),
    });

  const runSite = async (config: AnySiteConfig): Promise<void> => {
    // Before its queue exists, let alone a request: a site that cannot be
    // resolved is one nothing else here can be asked about.
    const {
      site,
      window,
      batching: { manyChannels, manyDays, maxChannels, maxDays },
      staleness: policy,
      isStreaming,
    } = resolveSite(config, options, startDay);

    // Which shape this site is has been settled by `resolveSite` — including for
    // a config the types never saw — so these are just the two ways of reading
    // it, and only the one that applies is ever called.
    const fetching = config as SiteConfig<any, BatchingOption, any>;
    const streaming = config as StreamSiteConfig<any>;

    // Everything this site remembers between runs, in one handle: its channel
    // list if it asked for that to be kept, and the bag its own code reads and
    // writes. Opened before anything asks the source, since the list may make
    // the first request unnecessary; read only as far as it is asked for, and
    // written once at the end of the site's run.
    const state = SiteStateHandle.open(cache, site);
    const siteState = await state.bag();

    // The queue and the client together: the signal rides on the instance, so
    // every call a site makes through it is abortable without the site having
    // to pass it on, and a slow-down the client meets stops the queue.
    //
    // A task of `requests` is one request to the source and nothing else — not
    // the work its response is for. That is what its `concurrency`, `rateLimit`
    // and backoff are about, and keeping it to that is what lets a `parseDay`
    // ask for a request of its own.
    const {
      queue: requests,
      http,
      dispose,
    } = sitePacing(config, {
      ...(signal ? { signal } : {}),
      log,
    });

    /**
     * One planned request each, start to finish — so what this bounds is how
     * many responses the site has in hand at once: fetched, and not yet parsed
     * and written.
     *
     * The request queue used to bound that on its own, by holding a slot until
     * the response's channel-days were written — which is also what made a
     * request from inside `parseDay` impossible: the parse would have waited
     * for the slot its own response had arrived through. So that slot now
     * covers the fetch alone, and what a site may hold in memory is said here
     * instead, where it is not also what paces the source. The same number
     * either way, so a site keeps the footprint it had: one response per unit
     * of concurrency, however wide a response is.
     *
     * Its tasks are the only ones here added without a signal, deliberately.
     * p-queue drops a *waiting* task on abort but only rejects a *running*
     * one's promise — the task itself carries on, off the books, so the queue
     * reports idle with work still in it and a summary can be read before the
     * work that belongs in it has finished. A task with no signal is never
     * abandoned, which makes reaching idle mean what it says; cancelling is
     * then the pipeline's own business, below, where it can say what a dropped
     * channel-day amounts to.
     */
    const pipelines = new PQueue({ concurrency: Math.max(1, config.concurrency ?? 1) });
    const grabbedAt = now.toISOString();

    // Fetching the channel list is a request to the same source as the rest, so
    // it goes through the same queue: a site's `rateLimit` spaces the first EPG
    // request after it, rather than the two landing back to back.
    // The signal it is handed is p-queue's, this task's own: what governs the
    // slot governs the work in it.
    const channels = await enqueue(requests, ({ signal }) =>
      resolveChannels(config, {
        http,
        ...(signal ? { signal } : {}),
        state,
        refresh: policy.refetchAll,
        now,
      }),
    );

    /**
     * The channel-days this run has already written, so a second lot of
     * programmes for one of them is added rather than put in its place.
     *
     * Only a stream can do that — a request's channel-days are parsed once each
     * — and a document that is not grouped by channel is where it happens: the
     * split flushes what it has when the channel changes, and finds the channel
     * again later. Kept per site rather than per request, since a stream is one
     * pass over the whole window.
     */
    const written = new Set<string>();

    /**
     * Put one channel-day in the cache, and account for it.
     *
     * Not queued: this is the inside of a `localWork` task, which is what makes
     * the parse and the write it is for one piece of work rather than two.
     */
    const persist = async (
      channel: GrabberChannel,
      day: string,
      parsed: ParsedProgramme[],
      taskSignal?: AbortSignal,
    ): Promise<void> => {
      // Cancelled while the parse was running. p-queue has let go of this task
      // already — it rejected what `add` returned the moment the signal fired —
      // so a write from here would land after the summary that should have
      // accounted for it, and be counted into a total nobody is going to read.
      taskSignal?.throwIfAborted();

      const key = { site, channelId: channel.xmltvId, day };
      const id = `${channel.xmltvId}|${day}`;
      const mine = parsed
        .map((entry) => ({ ...built(entry), channel: channel.xmltvId }))
        .sort((a, b) => a.start.getTime() - b.start.getTime());

      if (!written.has(id)) {
        written.add(id);
        await cache.write(key, mine, { grabbedAt });
        fetched++;

        if (mine.length === 0) {
          empty++;
        }

        log(`[${site}] ${channel.xmltvId} ${day}: ${mine.length} programmes`);

        return;
      }

      // Said twice, so the entry is what both emissions add up to. Read back
      // rather than held: what came before may have been written thousands of
      // channel-days ago, and this is the rare case rather than the hot path.
      const before = (await cache.read(key)) ?? [];
      const programmes = [...before, ...mine].sort((a, b) => a.start.getTime() - b.start.getTime());

      await cache.write(key, programmes, { grabbedAt });

      // Counted as one channel-day however many times it is mentioned — and no
      // longer an empty one, if the first emission was all there was of it.
      if (before.length === 0 && programmes.length > 0) {
        empty--;
      }

      log(
        `[${site}] ${channel.xmltvId} ${day}: ${mine.length} more programmes, ` +
          `${programmes.length} in all`,
      );
    };

    // Parse one channel-day out of the payload and cache it. Queued on
    // `localWork`: `parseDay` is the site's own code and the write is a file, so
    // a wide response must not put every one of its channel-days through both
    // at once.
    //
    // Ahead of the sweep in the queue, because a response already in hand is
    // held in memory until it is written, while a staleness check only
    // discovers more work to do.
    const store = (channel: GrabberChannel, day: string, payload: unknown): Promise<void> =>
      enqueue(
        localWork,
        async ({ signal: taskSignal }) => {
          const parsed = await fetching.parseDay({
            channel,
            date: dayToDate(day),
            day,
            payload,
            http,
            state: siteState,
            ...(taskSignal ? { signal: taskSignal } : {}),
            // A request of the parse's own goes through the site's queue, like
            // the request being parsed did — ahead of the planned ones, so a
            // channel-day in hand is finished rather than joined by another.
            paced: (task) => enqueue(requests, task, { priority: 1 }),
            // Bound to the channel-day being parsed, so a parse repeats neither
            // the id nor the language on every programme it builds.
            programme: (start, title, options) =>
              new ProgrammeBuilder({
                channel: channel.xmltvId,
                start,
                title,
                ...(channel.lang === undefined ? {} : { lang: channel.lang }),
                ...options,
              }),
          });

          await persist(channel, day, parsed, taskSignal);
        },
        { priority: 1 },
      );

    /** The same, for a channel-day a stream has already worked out. */
    const storeStreamed = (
      channel: GrabberChannel,
      day: string,
      programmes: ParsedProgramme[],
    ): Promise<void> =>
      enqueue(
        localWork,
        ({ signal: taskSignal }) => persist(channel, day, programmes, taskSignal),
        {
          priority: 1,
        },
      );

    // Which channel-days actually need fetching. The meta reads never leave the
    // machine, so they go through `localWork` rather than `requests` — a whole
    // grid of them at once would be a file descriptor storm — and a fresh one
    // is accounted for here, exactly once, however the requests are grouped
    // afterwards.
    //
    // A channel's whole window is one piece of local work rather than one per
    // day, because the answer for a day is worth almost nothing on its own: a
    // store that can settle a window in one question — a database, or anything
    // across a network — then does, and one that cannot is asked day by day
    // inside the same slot.
    //
    // Which keeps the descriptors where they were, since the store asks in turn
    // rather than all at once: `localConcurrency` slots, one open file each. It
    // does change what a slot holds. A site with fewer channels than the bound
    // now fills fewer of them and reads its window in sequence — 14 reads of
    // roughly 0.1ms rather than 14 at a time — which is worth a millisecond and
    // change per channel against thousands of round trips saved for a store
    // that has to make them.
    const collectStale = async (): Promise<Pair[]> => {
      const checked = await Promise.all(
        channels.map((channel) =>
          enqueue(localWork, async (): Promise<Pair[]> => {
            const keys = window.map((day) => ({ site, channelId: channel.xmltvId, day }));
            const metas = await cache.getMetas(keys);

            return window.flatMap((day, index) => {
              if (isStale(day, metas[index], policy, now)) {
                return [{ channel, day }];
              }

              fromCache++;
              log(`[${site}] ${channel.xmltvId} ${day}: fresh in cache, skipping`);

              return [];
            });
          }),
        ),
      );

      return checked.flat();
    };

    // Cut the stale channel-days into requests: the window into runs of at most
    // `maxDays`, then each run's stale channels into groups of at most
    // `maxChannels`. Both axes are trimmed to what the group actually needs, so
    // a fresh channel-day is never what a request is made for. Channel order
    // follows `channels`, day order the window.
    //
    // The stale pairs are indexed by day first, because every question the
    // grouping asks is "is this channel stale on this day" — asked once per
    // channel per day either way, but a lookup rather than a scan of every
    // stale pair. Scanning is what made planning cost with the square of the
    // channel count: a few hundred channels over a fortnight is millions of
    // comparisons before the first request goes out.
    const plan = (stale: Pair[]): Request[] => {
      const staleByDay = new Map<string, Set<GrabberChannel>>();

      for (const { channel, day } of stale) {
        let channelsOfDay = staleByDay.get(day);

        if (!channelsOfDay) {
          channelsOfDay = new Set();
          staleByDay.set(day, channelsOfDay);
        }

        channelsOfDay.add(channel);
      }

      // Day groups are cut from the whole window rather than from the stale
      // days, so which days share a request does not shift with what happens
      // to be cached.
      return chunk(window, maxDays).flatMap((dayGroup) => {
        const staleOn = dayGroup.map((day) => staleByDay.get(day));
        const staleChannels = channels.filter((channel) =>
          staleOn.some((channelsOfDay) => channelsOfDay?.has(channel)),
        );

        return chunk(staleChannels, maxChannels).map((group) => {
          // Channel-major, then day-ascending: the order `channelDays`
          // promises.
          const pairs: Pair[] = [];
          const days = new Set<string>();

          for (const channel of group) {
            for (const [index, day] of dayGroup.entries()) {
              if (staleOn[index]?.has(channel)) {
                pairs.push({ channel, day });
                days.add(day);
              }
            }
          }

          return {
            channels: group,
            days: dayGroup.filter((day) => days.has(day)),
            pairs,
          };
        });
      });
    };

    // The context for one request, in the shape this site's mode declares —
    // plus the channel-days it is for, which the plan already worked out.
    const contextFor = (request: Request, signal?: AbortSignal): RequestContextFor<BatchMode> => {
      // A Date of its own everywhere one is handed out, `from` and `to`
      // included. They are mutable — `Object.freeze` does not help, a Date
      // keeps its value in an internal slot rather than a property — so the
      // hazard worth removing is not that a site can change one, it is that
      // changing one would silently change the others: `from` and `dates[0]`
      // as the same object is a bug nobody would find.
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
        http,
        state: siteState,
        ...(signal ? { signal } : {}),
      };

      // The mode and this shape were chosen together right here; the compiler
      // cannot follow that through the conditional type.
      return context as RequestContextFor<BatchMode>;
    };

    /**
     * One planned request, start to finish: fetch it, then parse and write
     * every channel-day it covered.
     *
     * Cancelling is handled here rather than by the queue this runs in, which
     * is what lets the two outcomes differ: a request the cancel never let
     * start is simply not made, while one interrupted in flight leaves the
     * channel-days it was for short, and says so.
     */
    const pipeline = async (request: Request): Promise<void> => {
      if (signal?.aborted) {
        return;
      }

      let payload: unknown;

      try {
        // The request queue's slot covers this and nothing else, so a parse
        // below is free to ask for one of its own. What the request is handed
        // is that task's signal, not the run's — what governs the slot governs
        // the work in it.
        payload = await enqueue(requests, ({ signal: taskSignal }) =>
          fetching.request(contextFor(request, taskSignal)),
        );
        // The run's own, and a different question: was this cancelled while it
        // was in flight? p-queue's task signal governs the slot, not the work
        // in it, so stopping is ours to do — and what it stops here is a
        // response already paid for, which is news.
        signal?.throwIfAborted();
      } catch (error) {
        // A failed request fails every channel-day it was covering.
        for (const { channel, day } of request.pairs) {
          failed.push({ site, channelId: channel.xmltvId, day, error });
        }

        log(`[${site}] ${describe(request)}: ${errorMessage(error)}`);
        return;
      }

      // Parsing and caching are per channel-day, so one bad slice does not
      // sink the rest of the response.
      await Promise.all(
        request.pairs.map(async ({ channel, day }) => {
          try {
            await store(channel, day, payload);
          } catch (error) {
            failed.push({ site, channelId: channel.xmltvId, day, error });
            log(`[${site}] ${channel.xmltvId} ${day}: ${errorMessage(error)}`);
          }
        }),
      );
    };

    /**
     * The whole window in one pass: run the site's stream, and write each
     * channel-day it says it found.
     *
     * The request queue's slot covers the lot, since the pass *is* the request —
     * one long-lived response, from which channel-days fall out as they become
     * complete. A stream has no `parseDay` to ask for a request of its own, so
     * nothing is waiting behind that slot.
     */
    const streamPipeline = async (request: Request): Promise<void> => {
      if (signal?.aborted) {
        return;
      }

      // What is still owed, by channel-day. An emission takes its pair out; what
      // is left when the stream ends is what the source never mentioned.
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
          storeStreamed(pair.channel, pair.day, programmes).catch((error: unknown) => {
            failed.push({ site, channelId: pair.channel.xmltvId, day: pair.day, error });
            log(`[${site}] ${pair.channel.xmltvId} ${pair.day}: ${errorMessage(error)}`);
          }),
        );
      };

      try {
        await enqueue(requests, async ({ signal: taskSignal }) => {
          const context = {
            ...contextFor(request, taskSignal),
            log: (message: string) => log(`[${site}] ${message}`),
            // The shape a stream is handed is the one a `both`-batched request
            // gets, which is what `resolveSite` planned for it — the compiler
            // cannot follow that through the conditional type.
          } as unknown as StreamContext;

          for await (const { channel, day, programmes } of streaming.stream(context)) {
            // Between emissions, which is as often as this has anything to say:
            // a cancelled run stops here rather than writing the rest of a
            // document nobody is waiting for.
            signal?.throwIfAborted();

            const id = `${channel?.xmltvId}|${day}`;
            const pair = owed.get(id);

            if (pair !== undefined) {
              owed.delete(id);
              write(pair, programmes);
            } else if (written.has(id)) {
              // Said again: added to what the earlier emission wrote, rather
              // than put in its place. A document not grouped by channel.
              write({ channel, day }, programmes);
            } else {
              // A channel-day nobody asked about — one already fresh in the
              // cache, a channel outside the list, or an emission that makes no
              // sense. Counted, and reported once at the end.
              ignored++;
            }

            // Backpressure, and the only thing holding the parser back: writing
            // is queued rather than awaited, so the split runs on while entries
            // land, but no further ahead than `localConcurrency` of them.
            await localWork.onSizeLessThan(localWork.concurrency);
          }
        });
      } catch (error) {
        failure = error;
      }

      // Every write that was started, before deciding what was missed: one of
      // them may be the last mention of a channel-day still in `owed`.
      await Promise.all(writes);

      if (ignored > 0) {
        log(`[${site}] ignored ${ignored} channel-day(s) it was not asked for`);
      }

      if (failure !== undefined) {
        // The stream did not finish, so what it never reached is short — not
        // empty. Anything else would cache "nothing on" for a document that was
        // cut off half way.
        for (const { channel, day } of owed.values()) {
          failed.push({ site, channelId: channel.xmltvId, day, error: failure });
        }

        log(`[${site}] ${describe(request)}: ${errorMessage(failure)}`);

        return;
      }

      if (owed.size === 0) {
        return;
      }

      // A clean end with channel-days unmentioned: the source has been through
      // its whole answer and had nothing to say about them, which is what a
      // `parseDay` returning `[]` means too. Cached empty, so the staleness
      // policy decides when to ask again rather than every run asking.
      log(`[${site}] ${owed.size} channel-day(s) not in the document: caching them empty`);

      for (const pair of owed.values()) {
        write(pair, []);
      }

      await Promise.all(writes);
    };

    for (const request of plan(await collectStale())) {
      // Nothing awaits this, and a pipeline reports its own failures, so there
      // is no rejection to swallow: a cancelled run leaves each of these to
      // return without doing anything.
      void pipelines.add(() => (isStreaming ? streamPipeline(request) : pipeline(request)));
    }

    try {
      // Everything this site does happens inside one of those pipelines — the
      // fetch, the parse, the write, and any request a parse made of its own —
      // and none of them is ever abandoned, so this is the site being done.
      await pipelines.onIdle();
    } finally {
      dispose();
      // Beside `dispose`, and for the same reason: a site that threw, or was
      // cancelled part way, has as much to hand back as one that finished — the
      // channel list it fetched, and whatever its own code remembered. Only the
      // groups that changed are written.
      await state.save();
    }
  };

  const sites = new PQueue({ concurrency: Math.max(1, options.siteConcurrency ?? configs.length) });

  await Promise.all(
    configs.map((config) =>
      enqueue(sites, async () => {
        try {
          await runSite(config);
        } catch (error) {
          failed.push({ site: config.site, channelId: '*', day: '*', error });
          log(`[${config.site}] site failed: ${errorMessage(error)}`);
        }
      }).catch(() => {}),
    ),
  );

  return { fetched, empty, fromCache, failed };
}
