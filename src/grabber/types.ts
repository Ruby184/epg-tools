import type { KyInstance, Options as KyOptions } from 'ky';
import type { ChannelBuilder, ProgrammeBuilder, ProgrammeOptions } from '../xmltv/builder.js';
import type { DateInput } from '../xmltv/date.js';
import type { XmltvChannel, XmltvProgramme } from '../xmltv/types.js';
import type { CacheStore, StalenessPolicy } from '../cache/types.js';

/**
 * A channel to grab: maps an output XMLTV id to a site-specific id.
 *
 * `TData` is whatever the site keeps alongside it — see {@link data}.
 */
export interface GrabberChannel<TData = unknown> {
  /** Channel id used in the generated XMLTV output. */
  xmltvId: string;
  /** Channel id understood by the source site. */
  siteId: string;
  name?: string;
  /**
   * The language this channel broadcasts in. Used as the default `lang` for
   * every text element the scoped {@link ParseContext.programme} builds, so a
   * site says it once here instead of on every title and description.
   */
  lang?: string;
  logo?: string;
  /**
   * The number this channel appears on. Used by the `lineups` capability, which
   * writes it as a lineup entry's `<preset>`; ignored by the guide.
   */
  preset?: string;
  /**
   * Anything else the site knows about this channel, kept as it came and
   * handed back to `channelInfo` and `parseDay` — display names in three
   * languages, icon dimensions, an LCN, a per-channel token. The grabber never
   * looks inside it; its type is inferred from what `channels` returns, so both
   * callbacks see the real shape rather than `unknown`.
   */
  data?: TData;
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
export interface ChannelDay<TData = unknown> {
  channel: GrabberChannel<TData>;
  /** The day as `YYYY-MM-DD`. */
  day: string;
  /** The same day as UTC midnight. */
  date: Date;
}

interface BaseRequestContext<TData> {
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
  channelDays: ChannelDay<TData>[];
  /** ky instance created from the config's `ky` options. */
  http: KyInstance;
  /**
   * Abort signal from GrabOptions, already applied to {@link http} — anything
   * requested through it aborts on its own. Here for work that does not go
   * through it: another client, or a check between two pages of your own.
   */
  signal?: AbortSignal;
}

/**
 * Context for the function form of {@link SiteConfig.channels} — a channel list
 * that is fetched rather than written out.
 */
export interface ChannelsContext {
  /**
   * The site's ky instance, the very one its requests use: same prefix,
   * headers, retry, proxy and abort signal.
   */
  http: KyInstance;
  /** As on a request context: already applied to {@link http}. */
  signal?: AbortSignal;
}

/**
 * Where a site's channels come from: a list, or a function fetching one with
 * the site's own HTTP client.
 */
export type ChannelsSource<TData = unknown> =
  | GrabberChannel<TData>[]
  | ((ctx: ChannelsContext) => GrabberChannel<TData>[] | Promise<GrabberChannel<TData>[]>);

/** The channel a request covers, under a mode of `none` or `days`. */
interface OneChannel<TData> {
  channel: GrabberChannel<TData>;
}

/** The channels a request covers, under a mode of `channels` or `both`. */
interface ManyChannels<TData> {
  /**
   * The channels to fetch in this request — only those with a stale cached
   * entry (the grabber filters fresh ones out first), capped at
   * `batching.channelsPerRequest`.
   */
  channels: GrabberChannel<TData>[];
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
export interface RequestContext<TData = unknown>
  extends BaseRequestContext<TData>, OneChannel<TData>, OneDay {}
/** Request context for the `channels` mode — one day, many channels. */
export interface ChannelsRequestContext<TData = unknown>
  extends BaseRequestContext<TData>, ManyChannels<TData>, OneDay {}
/** Request context for the `days` mode — one channel, many days. */
export interface DaysRequestContext<TData = unknown>
  extends BaseRequestContext<TData>, OneChannel<TData>, ManyDays {}
/** Request context for the `both` mode — many channels, many days. */
export interface ChannelsDaysRequestContext<TData = unknown>
  extends BaseRequestContext<TData>, ManyChannels<TData>, ManyDays {}

/** The request context a given {@link BatchMode} is called with. */
export type RequestContextFor<TBatch extends BatchMode, TData = unknown> = TBatch extends 'none'
  ? RequestContext<TData>
  : TBatch extends 'channels'
    ? ChannelsRequestContext<TData>
    : TBatch extends 'days'
      ? DaysRequestContext<TData>
      : ChannelsDaysRequestContext<TData>;

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

/**
 * How a site retreats when the source tells it to.
 *
 * A `429` is news about the site, not about one request: every other request
 * in flight or waiting is just as unwelcome. So the site's whole request queue
 * stops for as long as `Retry-After` asks — nothing is dropped, the queue keeps
 * its tasks and hands them out again afterwards — and only then does the usual
 * per-request retry get its turn.
 */
export interface SiteBackoff {
  /** Statuses that mean stop. Defaults to 429 and 503, the two that carry `Retry-After`. */
  statuses?: number[];
  /** How long to hold when there is no `Retry-After` to go by. Defaults to 5000. */
  fallbackMs?: number;
  /** Cap on a single hold, however long `Retry-After` asks for. Defaults to 60000. */
  maxMs?: number;
  /**
   * Halve the site's concurrency on a slow-down and give it back one clean
   * response at a time. Defaults to true, and does nothing at the default
   * concurrency of 1 — there is nothing to halve.
   */
  adapt?: boolean;
}

/**
 * Run one request through the site's own queue — what {@link ParseContext.paced}
 * hands a parse that needs a second request.
 *
 * The callback is the request, not its result: the queue has to own the *making*
 * of it for the site's `concurrency`, `rateLimit` and backoff to mean anything.
 * Which is also why the wait is out here rather than inside the client — a
 * request that sat out a rate-limit window inside `ky` would be counted against
 * its `timeout` and aborted for taking a turn it was told to wait for.
 */
export type PacedRequest = <T>(
  task: (options: { signal?: AbortSignal | undefined }) => Promise<T>,
) => Promise<T>;

export interface ParseContext<TRaw, TData = unknown> {
  /** The channel this call is parsing, as the site declared it. */
  channel: GrabberChannel<TData>;
  /** The day as UTC midnight, a `Date` of this call's own. */
  date: Date;
  /** The same day as `YYYY-MM-DD`. */
  day: string;
  /**
   * What {@link SiteConfig.request} handed back, whole and unchanged. A request
   * covering several channel-days is parsed once for each of them, and every
   * one of those calls sees this same value — pick out the part that belongs to
   * `channel` and `day`.
   */
  payload: TRaw;
  /**
   * A programme builder for this channel-day, with the parts a parse should not
   * have to repeat already filled in: the channel is this context's channel,
   * and text elements default to its `lang`.
   *
   * ```ts
   * parseDay({ payload, programme }) {
   *   return payload.items.map((item) => programme(item.start, item.title)
   *     .stop(item.end)
   *     .desc(item.summary)
   *     .category(item.genre));
   * }
   * ```
   *
   * Return the builders as they are — `parseDay` takes either those or plain
   * {@link XmltvProgramme} objects, in any mix — or call `.build()` yourself if
   * you would rather hand back the object.
   *
   * `start` is a {@link DateInput}: a `Date`, unix **seconds**, or an XMLTV
   * datetime string. An ISO timestamp out of a JSON API is none of those, so
   * it goes in as `new Date(item.start)` — the same as it would in a plain
   * programme object.
   */
  programme(start: DateInput, title: string, options?: ProgrammeOptions): ProgrammeBuilder;
  /**
   * The site's ky instance, the very one {@link SiteConfig.request} was handed:
   * same prefix, headers, retry, proxy and abort signal.
   *
   * A parse that needs a second request — a detail page per programme, a
   * synopsis behind its own endpoint — asks for it here instead of building a
   * client of its own. Send it through {@link paced} to have the site's queue
   * pace it.
   */
  http: KyInstance;
  /**
   * As on a request context: already applied to {@link http}, and here for work
   * that does not go through it.
   */
  signal?: AbortSignal;
  /**
   * Make a request through the site's request queue, so a parse is as polite as
   * the grab around it: the site's `concurrency` counts it, its `rateLimit`
   * spaces it, and a `429` anywhere holds it with everything else.
   *
   * ```ts
   * async parseDay({ payload, programme, http, paced }) {
   *   return Promise.all(payload.items.map(async (item) => {
   *     const detail = await paced(({ signal }) =>
   *       http.get(`detail/${item.id}`, { signal }).json<Detail>());
   *
   *     return programme(new Date(item.start), item.title).desc(detail.synopsis);
   *   }));
   * }
   * ```
   *
   * Called with a signal of the queued task's own, following the run's, for
   * anything inside that does not go through {@link http}. Requests made
   * straight through `http` still work and still abort with the run — they are
   * simply not queued, so nothing spaces them.
   */
  paced: PacedRequest;
}

/**
 * What a parse may hand back per programme: the object, or a builder for it
 * that the grabber will build.
 */
export type ParsedProgramme = XmltvProgramme | ProgrammeBuilder;

/**
 * A `<channel>` builder for the channel being described, starting where the
 * default element would: the id, a display name (the channel's `name`, or its
 * id) and its `logo` as an icon, with text elements defaulting to its `lang`.
 *
 * Pass a display name to use instead of the default one; further calls to
 * `.displayName()` add to it rather than replacing it, which is how a channel
 * carries a second language or a call sign.
 */
export type ChannelElement = (displayName?: string) => ChannelBuilder;

/**
 * A site: where to fetch from, how much of the grid one request covers, and how
 * to turn a response into programmes.
 */
export interface SiteConfig<
  TRaw = unknown,
  TBatching extends BatchingOption = 'none',
  TData = unknown,
> {
  /** Unique site identifier, e.g. `webtv.sk`. Used as cache namespace. */
  site: string;
  /**
   * The channels to grab. A function is called with the site's HTTP client, so
   * a list that has to be fetched costs no extra setup — and it is called only
   * when channels are actually needed, never by `--capabilities` and friends.
   */
  channels: ChannelsSource<TData>;
  /** Override the number of days to grab for this site. */
  days?: number;
  /** Max concurrent requests for this site. Defaults to 1. */
  concurrency?: number;
  /**
   * How often this site may be asked — what the source says it allows. "20
   * requests a minute" is `{ requests: 20, perMs: 60_000 }`, and plain spacing
   * between single requests is `{ requests: 1, perMs: 250 }`. Unset, requests
   * go out as fast as `concurrency` allows.
   *
   * The window slides unless you set `strict: false`. A fixed window is
   * cheaper, but with more than one request per window it lets a burst straddle
   * the boundary — the full allowance at the end of one window and again at the
   * start of the next, which is twice the rate over the interval the source is
   * actually counting.
   */
  rateLimit?: { requests: number; perMs: number; strict?: boolean };
  /**
   * What to do when the source says slow down — see {@link SiteBackoff}. On by
   * default; `false` turns it off and leaves the reaction to `ky`'s own retry.
   */
  backoff?: false | SiteBackoff;
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
  request(ctx: RequestContextFor<ModeOf<TBatching>, TData>): Promise<TRaw>;
  /**
   * Parse one channel-day out of a response — called once per channel-day the
   * request covered, each with the same `payload`. `programme.channel` is
   * normalized to `xmltvId` afterwards.
   */
  parseDay(ctx: ParseContext<TRaw, TData>): ParsedProgramme[] | Promise<ParsedProgramme[]>;
  /**
   * A last look at each of this site's programmes on the way *out* of the
   * cache: return it, a different one, or nothing at all to leave it out.
   *
   * For what is wrong with a particular source rather than with the guide — a
   * category vocabulary of its own, a title with the channel name stuck on the
   * front, the filler it pads an unpublished schedule with. `parseDay` could do
   * the same, but this runs when the cache is *read*, so changing it takes
   * effect on the next merge instead of after a refetch — and it applies to
   * everything already cached.
   *
   * It runs before this site's programmes meet another site's, so what it
   * returns is what merging sees, and before `fillStop` and `clipOverlaps`, so
   * a gap it leaves behind is closed up rather than left open.
   */
  transform?(
    programme: XmltvProgramme,
    context: { channel: GrabberChannel<TData>; day: string; date: Date },
  ): XmltvProgramme | undefined | null;
  /**
   * Customize the `<channel>` element. Defaults to id + name + logo.
   *
   * `element` is that default as a builder — see {@link ChannelElement} — so
   * describing a channel more fully is a matter of adding to it:
   *
   * ```ts
   * channelInfo({ data }, element) {
   *   return element()
   *     .displayName(data.callSign)
   *     .url(data.page)
   *     .extra({ name: 'lcn', value: String(data.lcn) });
   * }
   * ```
   *
   * Hand back the builder or a plain {@link XmltvChannel}, whichever suits.
   */
  channelInfo?(
    channel: GrabberChannel<TData>,
    element: ChannelElement,
  ): XmltvChannel | ChannelBuilder;
}

/**
 * A site config whatever its batching — what a list of sites holds, since each
 * site picks its own and they need not agree.
 */
export type AnySiteConfig = SiteConfig<any, BatchingOption, any>;

/**
 * Identity helper for type inference in config files. The batching is inferred
 * from the `batching` property — which types `request`'s context and which
 * request-size caps are accepted — and a channel's `data` from what `channels`
 * returns.
 */
export function defineSiteConfig<TRaw, TBatching extends BatchingOption = 'none', TData = unknown>(
  config: SiteConfig<TRaw, TBatching, TData>,
): SiteConfig<TRaw, TBatching, TData> {
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
  /**
   * How much work that never leaves the machine runs at once, across every
   * site: the staleness sweep, and parsing a channel-day out of a response and
   * writing it to the cache. Defaults to 16.
   *
   * Separate from a site's `concurrency` on purpose — that one paces requests to
   * be kind to the source, while this bounds open files and how many parsed
   * programme lists are alive at once. Worth raising only alongside
   * `UV_THREADPOOL_SIZE`, which is what actually runs Node's file operations.
   */
  localConcurrency?: number;
  staleness?: Partial<StalenessPolicy>;
  /** "Now" reference, for tests. Defaults to `new Date()`. */
  now?: Date;
  logger?: (message: string) => void;
  /**
   * Cancel the run. Anything still queued — requests, staleness checks, cache
   * writes — is dropped rather than started, and whatever is already in flight
   * aborts on the same signal, which every site's HTTP client carries.
   *
   * The grab then resolves with the partial summary instead of rejecting: the
   * channel-days that made it are in the cache and count as `fetched`, and only
   * what was actually interrupted is in `failed`. A cancelled run is not a
   * pile of one failure per channel-day it never got to.
   */
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
  /**
   * Of those, the ones that parsed to no programmes at all — counted here as
   * well as in {@link fetched}, since the request did happen.
   *
   * A day that comes back empty is the one failure a run cannot see: nothing
   * threw, and the entry is cached like any other. It is reported rather than
   * treated as a failure because a channel with nothing on is a legitimate
   * answer; a number that climbs is what says otherwise. `emptyMaxAgeDays`
   * governs how soon such an entry is asked about again.
   */
  empty: number;
  /** Channel-days skipped because the cache was fresh. */
  fromCache: number;
  failed: GrabTaskError[];
}
