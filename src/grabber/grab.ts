import PQueue from 'p-queue';
import { DEFAULT_STALENESS, isStale } from '../cache/main.js';
import type { StalenessPolicy } from '../cache/types.js';
import { dayRange, dayToDate, toDayString } from '../core/days.js';
import { ProgrammeBuilder } from '../xmltv/builder.js';
import type { XmltvProgramme } from '../xmltv/types.js';
import { resolveChannels } from './channels.js';
import { sitePacing } from './pacing.js';
import type {
  AnySiteConfig,
  BatchingOption,
  BatchMode,
  ParsedProgramme,
  RequestContextFor,
  GrabberChannel,
  GrabOptions,
  GrabSummary,
  GrabTaskError,
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
 * Settings only — the site's `request` and `parseDay` are still called on the
 * config itself, so a site written with `this` keeps it.
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
}

/**
 * Resolve one site against the run: check what it must bring, then settle every
 * default in one pass, so nothing downstream spells one out again.
 *
 * The types make all four members mandatory, so the checks are for configs that
 * arrive without having been held to them — plain JS, or a config file the CLI
 * imported and this package never saw compiled. Each would otherwise surface a
 * long way from its cause: `parseDay` once per channel-day, and only after every
 * request had already gone out; `channels` as a missing `flatMap`; and `site`
 * not at all, quietly filing this site's cached days under `undefined`, in with
 * those of every other site that left it out.
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

  if (typeof config.request !== 'function') {
    throw new TypeError(
      `Site "${config.site}" must define request: a function fetching one request's raw data ` +
        `(got ${received(config.request)})`,
    );
  }

  if (typeof config.parseDay !== 'function') {
    throw new TypeError(
      `Site "${config.site}" must define parseDay: a function turning a response into one ` +
        `channel-day's programmes (got ${received(config.parseDay)})`,
    );
  }

  return {
    site: config.site,
    window: [...dayRange(startDay, config.days ?? options.days ?? DEFAULT_DAYS)],
    batching: resolveBatching(config.batching),
    staleness: { ...DEFAULT_STALENESS, ...options.staleness, ...config.staleness },
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
    } = resolveSite(config, options, startDay);

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
      resolveChannels(config, { http, ...(signal ? { signal } : {}) }),
    );

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
          const parsed = await config.parseDay({
            channel,
            date: dayToDate(day),
            day,
            payload,
            http,
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
          // Cancelled while the parse was running. p-queue has let go of this
          // task already — it rejected what `add` returned the moment the
          // signal fired — so a write from here would land after the summary
          // that should have accounted for it, and be counted into a total
          // nobody is going to read.
          taskSignal?.throwIfAborted();

          const programmes = parsed
            .map((entry) => ({ ...built(entry), channel: channel.xmltvId }))
            .sort((a, b) => a.start.getTime() - b.start.getTime());

          await cache.write({ site, channelId: channel.xmltvId, day }, programmes, {
            grabbedAt,
          });
          fetched++;

          if (programmes.length === 0) {
            empty++;
          }

          log(`[${site}] ${channel.xmltvId} ${day}: ${programmes.length} programmes`);
        },
        { priority: 1 },
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
          config.request(contextFor(request, taskSignal)),
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

    for (const request of plan(await collectStale())) {
      // Nothing awaits this, and a pipeline reports its own failures, so there
      // is no rejection to swallow: a cancelled run leaves each of these to
      // return without doing anything.
      void pipelines.add(() => pipeline(request));
    }

    try {
      // Everything this site does happens inside one of those pipelines — the
      // fetch, the parse, the write, and any request a parse made of its own —
      // and none of them is ever abandoned, so this is the site being done.
      await pipelines.onIdle();
    } finally {
      dispose();
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
