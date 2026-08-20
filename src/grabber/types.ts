import type { KyInstance, Options as KyOptions } from 'ky';
import type { XmltvChannel, XmltvProgramme } from '../xmltv/types.js';
import type { CacheStore, StalenessPolicy } from '../cache/types.js';

/** A channel to grab: maps an output XMLTV id to a site-specific id. */
export interface GrabberChannel {
  /** Channel id used in the generated XMLTV output. */
  xmltvId: string;
  /** Channel id understood by the source site. */
  siteId: string;
  name?: string;
  lang?: string;
  logo?: string;
  /**
   * The number this channel appears on. Used by the `lineups` capability, which
   * writes it as a lineup entry's `<preset>`; ignored by the guide.
   */
  preset?: string;
}

/**
 * What one {@link SiteConfig.request} call covers — the axis, or axes, a single
 * request is batched along:
 *
 * - `none` (the default) — one channel and one day per request.
 * - `channels` — one day, many channels (`?ids=a,b,c&date=…`).
 * - `days` — one channel, many days (`?id=a&from=…&to=…`).
 * - `both` — many channels over many days in one request.
 *
 * Caching stays per channel-day whichever it is, so a run only ever requests
 * the channel-days that are missing or stale, and `parseDay` is always called
 * once per channel-day over the shared response.
 */
export type BatchMode = 'none' | 'channels' | 'days' | 'both';

/** One channel-day a request is expected to come back with. */
export interface ChannelDay {
  channel: GrabberChannel;
  /** The day as `YYYY-MM-DD`. */
  day: string;
  /** The same day as UTC midnight. */
  date: Date;
}

interface BaseRequestContext {
  /**
   * Exactly the channel-days this request is being made for — every one of
   * them stale, in channel order and then day order.
   *
   * Whatever the mode, this is what the request is *for*, while the channels
   * and days beside it are what it *covers*. The two differ only under `both`:
   * asking for a rectangle can catch a channel-day that was already fresh, so
   * use this where the source takes an explicit list of pairs and the rectangle
   * would over-fetch. A fresh channel-day in the response is neither parsed nor
   * rewritten either way.
   */
  channelDays: ChannelDay[];
  /** ky instance created from the config's `ky` options. */
  http: KyInstance;
  /** Abort signal from GrabOptions; forward it to your HTTP calls. */
  signal?: AbortSignal;
}

/** The channel a request covers, under a mode of `none` or `days`. */
interface OneChannel {
  channel: GrabberChannel;
}

/** The channels a request covers, under a mode of `channels` or `both`. */
interface ManyChannels {
  /**
   * The channels to fetch in this request — only those with a stale cached
   * entry (the grabber filters fresh ones out first), capped at
   * `batching.channelsPerRequest`.
   */
  channels: GrabberChannel[];
}

/** The day a request covers, under a mode of `none` or `channels`. */
interface OneDay {
  /** UTC midnight of the day being grabbed. */
  date: Date;
  /** The day as `YYYY-MM-DD`. */
  day: string;
}

/** The days a request covers, under a mode of `days` or `both`. */
interface ManyDays {
  /**
   * The days to fetch in this request as `YYYY-MM-DD`, ascending — only those
   * with a stale cached entry, capped at `batching.daysPerRequest`. Days
   * already fresh in the cache are left out, so this is not necessarily a
   * contiguous run.
   */
  days: string[];
  /** The same days as UTC midnights, in the same order. */
  dates: Date[];
  /**
   * First day of this request as UTC midnight, i.e. `dates[0]`. With
   * {@link to}, what a range API wants (`?from=…&to=…`) — mind that the range
   * can span days left out of {@link days} as fresh.
   */
  from: Date;
  /** Last day of this request as UTC midnight, i.e. the final {@link dates} entry. */
  to: Date;
}

/** Request context for the `none` mode — one channel, one day. */
export interface RequestContext extends BaseRequestContext, OneChannel, OneDay {}
/** Request context for the `channels` mode — one day, many channels. */
export interface ChannelsRequestContext extends BaseRequestContext, ManyChannels, OneDay {}
/** Request context for the `days` mode — one channel, many days. */
export interface DaysRequestContext extends BaseRequestContext, OneChannel, ManyDays {}
/** Request context for the `both` mode — many channels, many days. */
export interface ChannelsDaysRequestContext extends BaseRequestContext, ManyChannels, ManyDays {}

/** The request context a given {@link BatchMode} is called with. */
export type RequestContextFor<TBatch extends BatchMode> = TBatch extends 'none'
  ? RequestContext
  : TBatch extends 'channels'
    ? ChannelsRequestContext
    : TBatch extends 'days'
      ? DaysRequestContext
      : ChannelsDaysRequestContext;

/**
 * One channel-day per request — the default, and what `batching` means when
 * left out entirely. Neither request-size cap applies: there is nothing to cap.
 */
export interface NoBatching {
  mode: 'none';
  channelsPerRequest?: never;
  daysPerRequest?: never;
}

/** One day, many channels per request. */
export interface ChannelsBatching {
  mode: 'channels';
  /**
   * Max channels per request. Omit (or 0) to put every stale channel of a day
   * in one request; set a cap for APIs with URL-length or parameter limits.
   */
  channelsPerRequest?: number;
  daysPerRequest?: never;
}

/** One channel, many days per request. */
export interface DaysBatching {
  mode: 'days';
  channelsPerRequest?: never;
  /**
   * Max days per request. Omit (or 0) to ask for a channel's whole stale
   * window at once; set a cap for APIs that only serve a few days a call.
   */
  daysPerRequest?: number;
}

/** Many channels over many days per request. */
export interface ChannelsDaysBatching {
  mode: 'both';
  /** Max channels per request. Omit (or 0) for no cap along that axis. */
  channelsPerRequest?: number;
  /** Max days per request. Omit (or 0) for no cap along that axis. */
  daysPerRequest?: number;
}

/**
 * A mode with its request-size caps. Each mode accepts only the caps it has a
 * use for, so a number that would be silently ignored is a type error instead.
 */
export type Batching = NoBatching | ChannelsBatching | DaysBatching | ChannelsDaysBatching;

/**
 * How a site batches: the bare {@link BatchMode} when the caps are all "as
 * many as it takes", or a {@link Batching} object to cap a request's size.
 */
export type BatchingOption = BatchMode | Batching;

/** The mode a {@link BatchingOption} selects. */
export type ModeOf<TBatching extends BatchingOption> = TBatching extends BatchMode
  ? TBatching
  : TBatching extends { mode: infer TMode extends BatchMode }
    ? TMode
    : never;

export interface ParseContext<TRaw> {
  channel: GrabberChannel;
  date: Date;
  day: string;
  data: TRaw;
}

/**
 * A site: where to fetch from, how much of the grid one request covers, and how
 * to turn a response into programmes.
 */
export interface SiteConfig<TRaw = unknown, TBatching extends BatchingOption = 'none'> {
  /** Unique site identifier, e.g. `webtv.sk`. Used as cache namespace. */
  site: string;
  channels: GrabberChannel[] | (() => GrabberChannel[] | Promise<GrabberChannel[]>);
  /** Override the number of days to grab for this site. */
  days?: number;
  /** Max concurrent requests for this site. Defaults to 1. */
  concurrency?: number;
  /** Delay in ms between requests within this site's queue. Defaults to 0. */
  delayMs?: number;
  /**
   * How much of the channel × day grid one {@link request} call covers: a bare
   * {@link BatchMode}, or that mode with a cap on the request's size
   * (`{ mode: 'days', daysPerRequest: 7 }`). Defaults to `none`, one
   * channel-day per request.
   *
   * The mode shapes the request context and decides which caps are accepted;
   * `parseDay` stays per channel-day whatever it is.
   */
  batching?: TBatching;
  /**
   * Base options for this site's own ky instance (`prefix`, `headers`,
   * `hooks`, `retry`, `timeout`, …). Each site gets its own, so nothing here
   * reaches another site — including a `dispatcher`, which is how one site
   * goes through a proxy and the rest do not.
   */
  ky?: KyOptions;
  /** Per-site override of the staleness policy. */
  staleness?: Partial<StalenessPolicy>;
  /**
   * Fetch this request's raw data. What one request covers — and so which
   * fields its context carries — is decided by {@link batching}.
   *
   * A failed request fails every channel-day it covered; one channel-day's
   * `parseDay` error only drops that channel-day.
   */
  request(ctx: RequestContextFor<ModeOf<TBatching>>): Promise<TRaw>;
  /**
   * Parse one channel-day out of a response — called once per channel-day the
   * request covered, each with the same `data`. `programme.channel` is
   * normalized to `xmltvId` afterwards.
   */
  parseDay(ctx: ParseContext<TRaw>): XmltvProgramme[] | Promise<XmltvProgramme[]>;
  /** Customize the `<channel>` element. Defaults to id + name + logo. */
  channelInfo?(channel: GrabberChannel): XmltvChannel;
}

/**
 * A site config whatever its batching — what a list of sites holds, since each
 * site picks its own and they need not agree.
 */
export type AnySiteConfig = SiteConfig<any, BatchingOption>;

/**
 * Identity helper for type inference in config files. The batching is inferred
 * from the `batching` property, which is what types `request`'s context and
 * which request-size caps are accepted.
 */
export function defineSiteConfig<TRaw, TBatching extends BatchingOption = 'none'>(
  config: SiteConfig<TRaw, TBatching>,
): SiteConfig<TRaw, TBatching> {
  return config;
}

export interface GrabOptions {
  cache: CacheStore;
  /** Default number of days to grab per site. Defaults to 7. */
  days?: number;
  /**
   * First day of the grab window as `YYYY-MM-DD`. Defaults to `now`'s day.
   *
   * Kept separate from {@link now} on purpose: `now` is the reference for
   * staleness and the `grabbedAt` stamp, so shifting the window must not
   * shift it (an XMLTV grabber's `--offset` needs exactly this split).
   */
  startDay?: string;
  /** How many sites run in parallel. Defaults to all. */
  siteConcurrency?: number;
  staleness?: Partial<StalenessPolicy>;
  /** "Now" reference, for tests. Defaults to `new Date()`. */
  now?: Date;
  logger?: (message: string) => void;
  /** Abort in-flight work. */
  signal?: AbortSignal;
}

export interface GrabTaskError {
  site: string;
  channelId: string;
  day: string;
  error: unknown;
}

export interface GrabSummary {
  /** Channel-days fetched from the network. */
  fetched: number;
  /** Channel-days skipped because the cache was fresh. */
  fromCache: number;
  failed: GrabTaskError[];
}
