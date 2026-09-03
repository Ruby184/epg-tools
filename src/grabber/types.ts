import type { KyInstance, Options as KyOptions } from 'ky';
import type { ChannelBuilder, ProgrammeBuilder, ProgrammeOptions } from '../xmltv/builder.js';
import type { DateInput } from '../xmltv/date.js';
import type { XmltvChannel, XmltvProgramme } from '../xmltv/types.js';
import type { CacheEntryMeta, CacheStore, StalenessPolicy } from '../cache/types.js';
import type { GrabCounts, Reporter } from '../core/events.js';

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
  /**
   * What the cache already holds for this channel-day, or `undefined` when it
   * holds nothing.
   *
   * A stale channel-day is not the same as a missing one: it may be there and
   * simply old enough to ask about again. `grabbedAt` is what a source can be
   * asked "has it changed since?" with, and `programmeCount` says what would be
   * kept if the answer is no.
   *
   * Every channel-day here is one this request is *for*, so a cached one is a
   * candidate for `conditionalGet` rather than something to skip — the run has
   * already left out what is still fresh.
   */
  cached?: CacheEntryMeta;
}

/**
 * What a site remembers between runs, as a site sees it: a `Map` of its own,
 * read once at the start of the run and written back at the end if it changed.
 *
 * For what a site would otherwise fetch again to get back to where it was — a
 * token, a cursor, a page count, an id it has already dealt with. One per site
 * for the whole run rather than per channel-day, so anything put here by one
 * request is there for every later request and every `parseDay`. Whatever goes
 * in must survive `JSON.stringify`, this being a cache file, and a store that
 * remembers nothing (`NoCacheDriver`) leaves it empty at the start of every run.
 */
export type SiteState = Map<string, unknown>;

/**
 * What every context carries, whichever shape the rest of it takes: the
 * channel-days it is for, the site's client, its state, and the run's signal.
 */
export interface BaseRequestContext<TData = unknown> extends SiteSays {
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
  /** What this site remembers between runs — see {@link SiteState}. */
  state: SiteState;
}

/**
 * Context for the function form of {@link SiteConfig.channels} — a channel list
 * that is fetched rather than written out.
 */
export interface ChannelsContext extends SiteSays {
  /**
   * The site's ky instance, the very one its requests use: same prefix,
   * headers, retry, proxy and abort signal.
   */
  http: KyInstance;
  /** As on a request context: already applied to {@link http}. */
  signal?: AbortSignal;
}

/**
 * How a site's own code says something — the pair every context carries.
 *
 * Named because four of them carry it and one place builds it, and because it
 * is the answer to the question a site author otherwise answers with
 * `console.log`: there is somewhere to say things, it goes wherever the run's
 * own messages go, and it is quietened by the same flags.
 */
export interface SiteSays {
  /**
   * Say something about what this site is doing, wherever the run's own
   * messages go.
   *
   * Progress, so it is shown at the run's default verbosity and hidden when the
   * run is asked to be quiet. The site's name is added for you — say what
   * happened, not who it happened to.
   */
  log(message: string, data?: SiteSaid): void;
  /**
   * The same, for something the reader has to see.
   *
   * A warning is a signal rather than progress: it survives a run asked to
   * report errors only, because "the source moved this channel" is worth
   * hearing even then. Throw instead when the whole thing should also fail.
   */
  warn(message: string, data?: SiteSaid): void;
}

/**
 * The fields a site attaches to what it says — `{ page: 3, of: 12 }`.
 *
 * The message is the sentence a person reads; this is what a machine reads,
 * and it is why `--reporter json` is worth pointing at a pipeline: a consumer
 * gets the ids and the counts as fields rather than parsing them back out of
 * prose. A text reporter appends it compactly, which is what makes this a
 * replacement for the `console.log` a site author would otherwise reach for.
 *
 * It must survive `JSON.stringify`. A reporter that cannot serialize it says so
 * in place of the value rather than throwing — a run is not worth ending over a
 * log line — but a cycle in here is still a bug worth not writing.
 */
export type SiteSaid = Record<string, unknown>;

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

/**
 * What a parse is handed. `log` and `warn` come from {@link SiteSays}, and a
 * parse is where a site most often has something to say — a field the source
 * has started leaving out, a programme it had to skip.
 */
export interface ParseContext<TRaw, TData = unknown> extends SiteSays {
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
  /**
   * What this site remembers between runs — see {@link SiteState}. The same
   * `Map` every request and every parse of this site is handed.
   */
  state: SiteState;
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
 * What is true of a site whichever way it fetches: who it is, what channels it
 * covers, how politely to ask it, and what it has to say about its own
 * programmes on the way back out.
 *
 * The two ways part company below — {@link SiteConfig} fetches a request at a
 * time and parses each channel-day out of it, {@link StreamSiteConfig} streams a
 * whole document and says what it found as it goes — and everything either of
 * them has in common is here.
 */
export interface BaseSiteConfig<TData = unknown> {
  /** Unique site identifier, e.g. `webtv.sk`. Used as cache namespace. */
  site: string;
  /**
   * The channels to grab. A function is called with the site's HTTP client, so
   * a list that has to be fetched costs no extra setup — and it is called only
   * when channels are actually needed, never by `--capabilities` and friends.
   */
  channels: ChannelsSource<TData>;
  /**
   * Keep a fetched channel list in the cache, so the next command reads it
   * instead of asking the source again.
   *
   * For the function form of {@link channels} only — a list written out in the
   * config is already there. Worth turning on when fetching it is not free: a
   * paginated API, a list of thousands, or a request that has to be paid for in
   * some other way. `epg grab` and then `epg merge` are two processes and each
   * resolves the list, so caching it also stops the two disagreeing about which
   * channels the run was for.
   *
   * `true` keeps it for a day; `{ maxAgeDays }` for as long as you like. Off by
   * default, since a list that is cheap to fetch is better fetched — a channel
   * added to a source then turns up on the next run rather than a day later.
   * `--refresh` fetches it whatever this says.
   *
   * It goes through JSON, so a channel's `data` must survive that: a `Date` or a
   * `Map` in there comes back a string or `{}`, and every run but the one that
   * fetched it sees the round-tripped form.
   */
  cacheChannels?: boolean | { maxAgeDays?: number };
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
   * Base options for this site's own ky instance (`prefix`, `headers`,
   * `hooks`, `retry`, `timeout`, …). Each site gets its own, so nothing here
   * reaches another site — including a `dispatcher`, which is how one site
   * goes through a proxy and the rest do not.
   */
  ky?: KyOptions;
  /** Per-site override of the staleness policy. */
  staleness?: Partial<StalenessPolicy>;
  /**
   * Ask the source whether anything has changed, and keep what is cached when it
   * says no.
   *
   * A site writes no code for this. Turning it on puts two hooks in the site's
   * own client: one sends `If-None-Match` or `If-Modified-Since` with a request,
   * the other turns a `304` into an {@link UnchangedError} — which reaches out of
   * `request` or `stream` without either of them mentioning it, and tells the run
   * to keep every channel-day that request was for. They are counted in
   * `unchanged` rather than `fetched`, and nothing is rewritten.
   *
   * What it asks with, in order: an `ETag` the source gave last time, then a
   * `Last-Modified`, then — with neither stored — the `grabbedAt` of the entries
   * themselves, which is a fair thing to ask "has it changed since?" with and
   * needs nothing remembered at all.
   *
   * **Off by default, and worth understanding before turning on.** It makes any
   * 304 from any request inside `request` mean "nothing changed for these
   * channel-days", which is true of a source whose channel-day comes from one
   * request and wrong for one that pages through several. Send
   * `context: { revalidate: false }` with a request that should never be asked
   * conditionally — a page after the first, a lookup that is not the listings.
   *
   * A validator is never sent where a `304` could not be honoured: not when a
   * channel-day it covers has nothing cached, not when one is past
   * `maxAgeDays`, and not under `--refresh`.
   */
  conditionalGet?: boolean;
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
 * A site: where to fetch from, how much of the grid one request covers, and how
 * to turn a response into programmes.
 */
export interface SiteConfig<
  TRaw = unknown,
  TBatching extends BatchingOption = 'none',
  TData = unknown,
> extends BaseSiteConfig<TData> {
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
}

/**
 * What a {@link StreamSiteConfig.stream} says it found: one channel-day, and
 * either the programmes on it or word that what is cached still stands.
 *
 * The channel is one of the context's own — the site looks up whatever its source
 * called the channel and hands back the {@link GrabberChannel} it belongs to, so
 * nothing has to be matched up by id afterwards.
 */
export type StreamedChannelDay<TData = unknown> =
  | {
      channel: GrabberChannel<TData>;
      /** The day as `YYYY-MM-DD`. */
      day: string;
      programmes: ParsedProgramme[];
      unchanged?: false;
    }
  | {
      channel: GrabberChannel<TData>;
      day: string;
      programmes?: undefined;
      /**
       * Nothing has changed here: keep the cached entry as it is.
       *
       * For a pass that can tell — a document with a per-channel revision, a
       * source answering `304` for part of what was asked. The entry is left
       * alone, `grabbedAt` and all, and counted in `unchanged` rather than
       * `fetched`. A channel-day with nothing cached cannot be kept, and is
       * reported as a failure rather than quietly left out of the guide.
       */
      unchanged: true;
    };

/**
 * What a stream is given: the same context a `both`-batched request gets —
 * every channel and day it is being asked about at once.
 *
 * Which now includes {@link BaseRequestContext.log} and
 * {@link BaseRequestContext.warn}, so it is an alias rather than a shape of its
 * own: a whole-document source is the one place a parse has plenty to report —
 * a warning from the parser, a channel the list did not mention, a document not
 * sorted the way it usually is — but it stopped being the only place that has
 * anything.
 */
export type StreamContext<TData = unknown> = ChannelsDaysRequestContext<TData>;

/**
 * A site that answers its whole window in one pass: it streams, and says what it
 * found as it goes.
 *
 * For a source that publishes the lot in one document rather than a request per
 * channel-day — a `xmltv.xml.gz`, a dump behind one endpoint. Splitting that with
 * {@link SiteConfig.request} would mean holding all of it in memory before the
 * first entry could be written, since `parseDay` is only called once the request
 * has returned; a stream writes each channel-day as it becomes complete and
 * keeps whatever is still open.
 *
 * What the grab does with what it yields:
 *
 * - a channel-day it was **asked** for is written, counted and logged, exactly as
 *   a parsed one is;
 * - one it was **not** asked for — a channel-day already fresh in the cache, or a
 *   channel nobody asked about — is ignored;
 * - one yielded **again** has its programmes added to what the earlier emission
 *   wrote, so a document that turns out not to be grouped by channel costs a
 *   second write rather than the programmes it already reported;
 * - one **never** yielded, once the stream ends cleanly, is written empty — the
 *   source has been through its whole answer and had nothing to say about it,
 *   which is what `parseDay` returning `[]` means too.
 *
 * That last one is why a stream that could not finish must **throw**: ending
 * quietly is read as "that was the whole answer", and every channel-day it never
 * reached would be cached as having nothing on. Throwing fails exactly those and
 * writes nothing.
 */
export interface StreamSiteConfig<TData = unknown> extends BaseSiteConfig<TData> {
  /**
   * Fetch and split this site's whole window, yielding each channel-day as it is
   * complete.
   *
   * Called once per run — with every stale channel-day the site has, in
   * `channelDays` — and nothing waits for it to finish before the first of its
   * channel-days is written.
   */
  stream(ctx: StreamContext<TData>): AsyncIterable<StreamedChannelDay<TData>>;
}

/**
 * A site config whichever shape it is — what a list of sites holds, since each
 * site picks its own way of fetching and they need not agree.
 */
export type AnySiteConfig = SiteConfig<any, BatchingOption, any> | StreamSiteConfig<any>;

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

/**
 * The same, for a site that streams — a channel's `data` inferred from what
 * `channels` returns, so `stream` sees the real shape.
 */
export function defineStreamSiteConfig<TData = unknown>(
  config: StreamSiteConfig<TData>,
): StreamSiteConfig<TData> {
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
  /**
   * Where this run's events go — see {@link Reporter}.
   *
   * A function told what happened as it happens. `textReporter` and
   * `jsonReporter` are the ones this package ships; anything of your own is a
   * function of one argument.
   */
  reporter?: Reporter;
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

/**
 * What a run answers with: the five counts, and nothing that grows with the
 * size of the guide.
 *
 * The shape is {@link GrabCounts}, which is also what a `*:done` event carries —
 * one declaration, so a site's total and the run's cannot describe themselves
 * differently. What each of them means is documented there.
 */
export interface GrabSummary extends GrabCounts {}
