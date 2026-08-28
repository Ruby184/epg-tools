/**
 * Cutting the channel × day grid into requests.
 *
 * All of it is arithmetic over what a site declared and what the cache already
 * has: no queues, no clients, nothing to cancel. Which is why it is here rather
 * than inside the run — the hardest part of a grab to get right is also the part
 * with nothing in it to mock.
 */

import type { BatchingOption, BatchMode, GrabberChannel } from './types.js';

/** One channel-day: the unit of caching, parsing and failure reporting. */
export interface Pair {
  channel: GrabberChannel;
  day: string;
}

/**
 * One request: the channels and days it covers, and the channel-days it is
 * expected to yield. `pairs` is a subset of `channels × days` — batching both
 * axes at once means a request can span a channel-day that is already fresh,
 * and that one is neither parsed nor rewritten.
 */
export interface Request {
  channels: GrabberChannel[];
  days: string[];
  pairs: Pair[];
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
export interface ResolvedBatching {
  manyChannels: boolean;
  manyDays: boolean;
  maxChannels: number;
  maxDays: number;
}

export function resolveBatching(batching: BatchingOption | undefined): ResolvedBatching {
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

/**
 * Cut the stale channel-days into requests: the window into runs of at most
 * `maxDays`, then each run's stale channels into groups of at most
 * `maxChannels`. Both axes are trimmed to what the group actually needs, so a
 * fresh channel-day is never what a request is made for. Channel order follows
 * `channels`, day order the window.
 *
 * Days are the outer cut, so the requests come out a day group at a time — every
 * channel of it before the next group. Which is the order a guide is wanted in:
 * a run that stops early, or a source that starts failing half way, leaves whole
 * early days rather than a fortnight of the first few channels. Inside one
 * request the channel-days are channel-major and then day-ascending, which is
 * what `channelDays` promises a site.
 *
 * The stale pairs are indexed by day first, because every question the grouping
 * asks is "is this channel stale on this day" — asked once per channel per day
 * either way, but a lookup rather than a scan of every stale pair. Scanning is
 * what made planning cost with the square of the channel count: a few hundred
 * channels over a fortnight is millions of comparisons before the first request
 * goes out.
 */
export function planRequests(options: {
  /** Every channel of the site, in the order it declared them. */
  channels: GrabberChannel[];
  /** Every day of the window, ascending. */
  window: string[];
  /** The channel-days worth fetching. */
  stale: Pair[];
  batching: ResolvedBatching;
}): Request[] {
  const { channels, window, stale } = options;
  const { maxChannels, maxDays } = options.batching;
  const staleByDay = new Map<string, Set<GrabberChannel>>();

  for (const { channel, day } of stale) {
    let channelsOfDay = staleByDay.get(day);

    if (!channelsOfDay) {
      channelsOfDay = new Set();
      staleByDay.set(day, channelsOfDay);
    }

    channelsOfDay.add(channel);
  }

  // Day groups are cut from the whole window rather than from the stale days, so
  // which days share a request does not shift with what happens to be cached.
  return chunk(window, maxDays).flatMap((dayGroup) => {
    const staleOn = dayGroup.map((day) => staleByDay.get(day));
    const staleChannels = channels.filter((channel) =>
      staleOn.some((channelsOfDay) => channelsOfDay?.has(channel)),
    );

    return chunk(staleChannels, maxChannels).map((group) => {
      // Channel-major, then day-ascending: the order `channelDays` promises.
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

      return { channels: group, days: dayGroup.filter((day) => days.has(day)), pairs };
    });
  });
}

/** How a request is named in the log: a channel-day, or the span it covers. */
export function describeRequest({ channels, days }: Request): string {
  const channelPart = channels.length === 1 ? channels[0]!.xmltvId : `${channels.length} channels`;
  const dayPart =
    days.length === 1 ? days[0]! : `${days[0]}..${days[days.length - 1]} (${days.length} days)`;

  return `${channelPart} ${dayPart}`;
}
