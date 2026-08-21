import PQueue from 'p-queue';
import { DEFAULT_STALENESS, isStale } from '../cache/main.js';
import type { StalenessPolicy } from '../cache/types.js';
import { dayRange, dayToDate, toDayString } from '../core/days.js';
import { resolveChannels } from './channels.js';
import { sitePacing } from './pacing.js';
import type {
  AnySiteConfig,
  BatchingOption,
  BatchMode,
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
function resolveBatching(batching: BatchingOption | undefined): {
  manyChannels: boolean;
  manyDays: boolean;
  maxChannels: number;
  maxDays: number;
} {
  // Both shapes `batching` accepts, and its absence, as one object.
  const settings: { mode: BatchMode; channelsPerRequest?: number; daysPerRequest?: number } =
    typeof batching === 'string' ? { mode: batching } : batching ?? { mode: 'none' };
  const manyChannels = settings.mode === 'channels' || settings.mode === 'both';
  const manyDays = settings.mode === 'days' || settings.mode === 'both';
  const cap = (size: number | undefined): number => (size !== undefined && size > 0 ? size : Number.POSITIVE_INFINITY);

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
  const dayPart = days.length === 1 ? days[0]! : `${days[0]}..${days[days.length - 1]} (${days.length} days)`;

  return `${channelPart} ${dayPart}`;
}

export async function grab(configs: AnySiteConfig[], options: GrabOptions): Promise<GrabSummary> {
  const now = options.now ?? new Date();
  const startDay = options.startDay ?? toDayString(now);
  const log = options.logger ?? (() => {});
  const { cache, signal } = options;

  let fetched = 0;
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
  const local = new PQueue({ concurrency: Math.max(1, options.localConcurrency ?? DEFAULT_LOCAL_CONCURRENCY) });

  /**
   * Handed to every queued task, which is what makes an abort take effect at
   * once: p-queue drops a task that is still waiting and rejects it with the
   * abort reason, so a cancelled run stops instead of dequeuing thousands of
   * tasks only for each to notice and record a failure. What is already in
   * flight aborts on its own — the same signal rides on the site's client.
   */
  const queued = signal ? { signal } : {};

  const runSite = async (config: AnySiteConfig): Promise<void> => {
    if (typeof config.request !== 'function') {
      throw new Error(`Site "${config.site}" must define request`);
    }

    // The queue and the client together: the signal rides on the instance, so
    // every call a site makes through it is abortable without the site having
    // to pass it on, and a slow-down the client meets stops the queue.
    const { queue: inner, http, dispose } = sitePacing(config, { ...(signal ? { signal } : {}), log });
    const window = [...dayRange(startDay, config.days ?? options.days ?? 7)];
    const { manyChannels, manyDays, maxChannels, maxDays } = resolveBatching(config.batching);
    const policy: StalenessPolicy = { ...DEFAULT_STALENESS, ...options.staleness, ...config.staleness };
    const grabbedAt = now.toISOString();

    // Fetching the channel list is a request to the same source as the rest, so
    // it goes through the same queue: a site's `rateLimit` spaces the first EPG
    // request after it, rather than the two landing back to back.
    const channels = await inner.add(
      () => resolveChannels(config, { http, ...(signal ? { signal } : {}) }),
      queued,
    );

    // Parse one channel-day out of `data` and cache it. Queued: `parseDay` is
    // the site's own code and the write is a file, so a wide response must not
    // put every one of its channel-days through both at once.
    //
    // Ahead of the sweep in the queue, because a response already in hand is
    // held in memory until it is written, while a staleness check only
    // discovers more work to do.
    const store = (channel: GrabberChannel, day: string, data: unknown): Promise<void> =>
      local.add(async () => {
        const parsed = await config.parseDay({ channel, date: dayToDate(day), day, data });
        const programmes = parsed
          .map((programme) => ({ ...programme, channel: channel.xmltvId }))
          .sort((a, b) => a.start.getTime() - b.start.getTime());

        await cache.write({ site: config.site, channelId: channel.xmltvId, day }, programmes, { grabbedAt });
        fetched++;
        log(`[${config.site}] ${channel.xmltvId} ${day}: ${programmes.length} programmes`);
      }, { ...queued, priority: 1 });

    // Which channel-days actually need fetching. The meta reads never leave the
    // machine, so they go through the local queue rather than the request one —
    // a whole grid of them at once would be a file descriptor storm — and a
    // fresh one is accounted for here, exactly once, however the requests are
    // grouped afterwards.
    const collectStale = async (): Promise<Pair[]> => {
      const checked = await Promise.all(
        channels.flatMap((channel) => window.map((day) => local.add(async (): Promise<Pair | undefined> => {
          const meta = await cache.getMeta({ site: config.site, channelId: channel.xmltvId, day });

          if (isStale(day, meta, policy, now)) {
            return { channel, day };
          }

          fromCache++;
          log(`[${config.site}] ${channel.xmltvId} ${day}: fresh in cache, skipping`);
        }, queued))),
      );

      return checked.filter((pair): pair is Pair => pair !== undefined);
    };

    // Cut the stale channel-days into requests: the window into runs of at most
    // `maxDays`, then each run's stale channels into groups of at most
    // `maxChannels`. Both axes are trimmed to what the group actually needs, so
    // a fresh channel-day is never what a request is made for. Channel order
    // follows `channels`, day order the window.
    const plan = (stale: Pair[]): Request[] =>
      chunk(window, maxDays).flatMap((dayGroup) => {
        const pending = stale.filter((pair) => dayGroup.includes(pair.day));
        const staleChannels = channels.filter((channel) => pending.some((pair) => pair.channel === channel));

        return chunk(staleChannels, maxChannels).map((group) => {
          const pairs = pending.filter((pair) => group.includes(pair.channel));

          return {
            channels: group,
            days: dayGroup.filter((day) => pairs.some((pair) => pair.day === day)),
            pairs,
          };
        });
      });

    // The context for one request, in the shape this site's mode declares —
    // plus the channel-days it is for, which the plan already worked out.
    const contextFor = (request: Request): RequestContextFor<BatchMode> => {
      // A Date of its own everywhere one is handed out, `from` and `to`
      // included. They are mutable — `Object.freeze` does not help, a Date
      // keeps its value in an internal slot rather than a property — so the
      // hazard worth removing is not that a site can change one, it is that
      // changing one would silently change the others: `from` and `dates[0]`
      // as the same object is a bug nobody would find.
      const dates = request.days.map(dayToDate);
      const context = {
        channelDays: request.pairs.map(({ channel, day }) => ({ channel, day, date: dayToDate(day) })),
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

    for (const request of plan(await collectStale())) {
      // Nothing awaits this, and the task reports its own failures, so the only
      // rejection to swallow is the abort dropping it from the queue.
      void inner.add(async () => {
        let data: unknown;

        try {
          data = await config.request(contextFor(request));
        } catch (error) {
          // A failed request fails every channel-day it was covering.
          for (const { channel, day } of request.pairs) {
            failed.push({ site: config.site, channelId: channel.xmltvId, day, error });
          }

          log(`[${config.site}] ${describe(request)}: ${errorMessage(error)}`);
          return;
        }

        // Parsing and caching are per channel-day, so one bad slice does not
        // sink the rest of the response.
        await Promise.all(request.pairs.map(async ({ channel, day }) => {
          try {
            await store(channel, day, data);
          } catch (error) {
            failed.push({ site: config.site, channelId: channel.xmltvId, day, error });
            log(`[${config.site}] ${channel.xmltvId} ${day}: ${errorMessage(error)}`);
          }
        }));
      }, queued).catch(() => {});
    }

    try {
      await inner.onIdle();
    } finally {
      dispose();
    }
  };

  const outer = new PQueue({ concurrency: Math.max(1, options.siteConcurrency ?? configs.length) });

  await Promise.all(
    configs.map((config) =>
      outer.add(async () => {
        try {
          await runSite(config);
        } catch (error) {
          failed.push({ site: config.site, channelId: '*', day: '*', error });
          log(`[${config.site}] site failed: ${errorMessage(error)}`);
        }
      }, queued).catch(() => {}),
    ),
  );

  return { fetched, fromCache, failed };
}
