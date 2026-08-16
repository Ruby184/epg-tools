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

export interface FetchContext {
  channel: GrabberChannel;
  /** UTC midnight of the day being grabbed. */
  date: Date;
  /** The day as `YYYY-MM-DD`. */
  day: string;
  /** ky instance created from the config's `ky` options. */
  http: KyInstance;
  /** Abort signal from GrabOptions; forward it to your HTTP calls. */
  signal?: AbortSignal;
}

export interface ParseContext<TRaw> {
  channel: GrabberChannel;
  date: Date;
  day: string;
  data: TRaw;
}

/** Context for a batched fetch: one day, many channels, a single request. */
export interface BatchFetchContext {
  /**
   * The channels to fetch in this request — only those whose cached entry
   * for `day` is stale (the grabber filters fresh ones out first), capped at
   * {@link SiteConfig.batchSize} per request.
   */
  channels: GrabberChannel[];
  /** UTC midnight of the day being grabbed. */
  date: Date;
  /** The day as `YYYY-MM-DD`. */
  day: string;
  /** ky instance created from the config's `ky` options. */
  http: KyInstance;
  /** Abort signal from GrabOptions; forward it to your HTTP calls. */
  signal?: AbortSignal;
}

export interface SiteConfig<TRaw = unknown> {
  /** Unique site identifier, e.g. `webtv.sk`. Used as cache namespace. */
  site: string;
  channels: GrabberChannel[] | (() => GrabberChannel[] | Promise<GrabberChannel[]>);
  /** Override the number of days to grab for this site. */
  days?: number;
  /** Max concurrent requests for this site (per channel-day, or per batch). Defaults to 1. */
  concurrency?: number;
  /** Delay in ms between requests within this site's queue. Defaults to 0. */
  delayMs?: number;
  /**
   * Max channels per {@link fetchDayBatch} request. Omit (or 0) to put all of
   * a day's stale channels in a single request; set a cap for APIs with
   * URL-length or parameter limits. Ignored without `fetchDayBatch`.
   */
  batchSize?: number;
  /**
   * Base options for this site's own ky instance (`prefix`, `headers`,
   * `hooks`, `retry`, `timeout`, …). Each site gets its own, so nothing here
   * reaches another site — including a `dispatcher`, which is how one site
   * goes through a proxy and the rest do not.
   */
  ky?: KyOptions;
  /** Per-site override of the staleness policy. */
  staleness?: Partial<StalenessPolicy>;
  /** Fetch raw data for one channel-day. Provide this or {@link fetchDayBatch}. */
  fetchDay?(ctx: FetchContext): Promise<TRaw>;
  /**
   * Fetch one day for many channels in a single request — the grabber groups
   * a day's stale channels into batches (see {@link batchSize}) and calls this
   * once per batch. `parseDay` is then invoked per channel with the shared
   * response, extracting that channel's programmes. Provide this or
   * {@link fetchDay}; if both are set, `fetchDayBatch` wins.
   */
  fetchDayBatch?(ctx: BatchFetchContext): Promise<TRaw>;
  /** Parse raw data into programmes. `programme.channel` is normalized to `xmltvId` afterwards. */
  parseDay(ctx: ParseContext<TRaw>): XmltvProgramme[] | Promise<XmltvProgramme[]>;
  /** Customize the `<channel>` element. Defaults to id + name + logo. */
  channelInfo?(channel: GrabberChannel): XmltvChannel;
}

/** Identity helper for type inference in config files. */
export function defineSiteConfig<TRaw>(config: SiteConfig<TRaw>): SiteConfig<TRaw> {
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
