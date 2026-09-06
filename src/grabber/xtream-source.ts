/**
 * An Xtream Codes panel as a source.
 *
 * The panel software most commercial IPTV resellers run. The company behind it
 * was raided in 2019 and the API outlived it: every successor implements
 * `player_api.php`, and it is what a player means by "Xtream login" — a host, a
 * username and a password rather than a url with the credentials baked in.
 *
 * Two calls, against the site's own client so its retry, proxy, rate limit,
 * backoff and abort signal all apply:
 *
 * ```
 * player_api.php?action=get_live_streams
 * player_api.php?action=get_simple_data_table&stream_id=N
 * ```
 *
 * **The same panels also publish `xmltv.php`**, a whole-guide XMLTV dump that
 * `defineXmltvSite` already reads — and one request for everything beats nine
 * hundred when everything is what you want. This exists for when it is not: a
 * site is handed only the channel-days that are actually stale, so a run here
 * costs one request per channel that needs one, where the dump is
 * all-or-nothing every time.
 *
 * ## What arrives, and what is handed on
 *
 * The wire format is undocumented, reconstructed from its clients, and
 * inconsistent enough that the community documentation is wrong in at least one
 * way that would ship unreadable titles. So nothing downstream sees it: a
 * stream becomes an {@link XtreamChannel} and a listing an
 * {@link XtreamProgramme} — decoded, typed, camel-cased — and those are what
 * the extension hooks are given. The field names follow the maintained client's
 * own normalized shape, so moving between the two surprises nobody.
 */

import { GrabberError } from '../core/error.js';
import { xmltvDate } from '../xmltv/date.js';
import type { XmltvDate } from '../xmltv/date.js';
import type { ChannelBuilder, ProgrammeBuilder } from '../xmltv/builder.js';
import { dayOf, type XmltvDayZone } from './xmltv-source.js';
import { defineSiteConfig } from './types.js';
import type { ChannelElement, GrabberChannel, SiteConfig } from './types.js';

/**
 * One channel of a panel, normalized.
 *
 * Follows the shape the maintained client settles on, with one difference:
 * `addedAt` is epoch seconds rather than a `Date`, because this is a channel's
 * `data` and a channel's `data` goes through JSON when `cacheChannels` is on —
 * where a `Date` would come back a string.
 */
export interface XtreamChannel {
  /** The panel's stream id, as a string. What the schedule call takes. */
  id: string;
  name: string;
  /** Where it sits in the panel's own ordering. */
  number?: number;
  logo?: string;
  /** The panel's `epg_channel_id`, when it gave one worth having. */
  epgId?: string;
  /** Whether the panel keeps a catchup archive. */
  tvArchive: boolean;
  /** How many days of one, where it says. */
  tvArchiveDuration?: number;
  /** When the panel added the channel, in epoch seconds. */
  addedAt?: number;
  categoryIds: string[];
  /** The first category's name, where the panel's category list gave one. */
  category?: string;
}

/** One programme of a panel, normalized: decoded, dated, and without the noise. */
export interface XtreamProgramme {
  /** The panel's own id for the listing. */
  id?: string;
  /** The panel's id for the channel's schedule. */
  epgId?: string;
  title: string;
  description?: string;
  /** The language the panel says the title and description are in. */
  language?: string;
  /** Carrying the offset the panel wrote it in — see {@link offsetOf}. */
  start: XmltvDate;
  stop?: XmltvDate;
  /** Whether this one can still be watched back. */
  hasArchive: boolean;
}

export interface XtreamSiteOptions extends Omit<
  SiteConfig<XtreamProgramme[], 'days', XtreamChannel>,
  'request' | 'parseDay' | 'batching' | 'channels'
> {
  /** The panel, e.g. `http://host:8080`. */
  url: string;
  username: string;
  password: string;
  /** Which day a programme belongs to. Defaults to `source` — see below. */
  dayZone?: XmltvDayZone;
  /**
   * Ask for the category names as well as the ids. On by default.
   *
   * One extra call for the whole run, which turns `category_id="5"` into
   * `<category>Sports</category>`. Off for a panel that refuses it.
   */
  categories?: boolean;
  /**
   * What to keep from a programme that the DTD has no place for.
   *
   * {@link xtreamProgrammeExtras} by default. `false` keeps none of it. A
   * function of your own replaces it, and is handed the normalized programme —
   * which is the thing a site `transform` cannot see, since by then the panel's
   * fields are gone and only the `<programme>` is left.
   *
   * ```ts
   * programmeExtras: (element, programme) => {
   *   xtreamProgrammeExtras(element, programme);
   *   element.extraAttribute('mine', programme.epgId ?? '');
   * }
   * ```
   */
  programmeExtras?: false | ((element: ProgrammeBuilder, programme: XtreamProgramme) => void);
  /** The same for a channel — {@link xtreamChannelExtras} by default. */
  channelExtras?: false | ((element: ChannelBuilder, channel: XtreamChannel) => void);
}

/** One stream of `get_live_streams`, as it arrives. */
interface WireStream {
  num?: number;
  name?: string;
  stream_id?: number;
  stream_icon?: string;
  epg_channel_id?: string | null;
  category_id?: string;
  category_ids?: unknown;
  added?: string | number;
  tv_archive?: number;
  tv_archive_duration?: number | string;
  /** Embeds the credentials on most panels, and so never read. */
  direct_source?: string;
}

/** One listing of `get_simple_data_table`, as it arrives. */
interface WireListing {
  id?: string;
  epg_id?: string;
  /** Base64 on every panel worth the name — see {@link decode}. */
  title?: string;
  /** Base64, the same. */
  description?: string;
  lang?: string;
  /** Wall clock with no zone, read only to work the offset out. */
  start?: string;
  /** Epoch seconds, **as a string**. */
  start_timestamp?: string | number;
  stop_timestamp?: string | number;
  has_archive?: number;
  /** True only at the moment of asking, and so never kept. */
  now_playing?: number;
}

/** The furthest any real UTC offset goes, either way. */
const MAX_OFFSET_MINUTES = 840;

/**
 * A panel's answer, as a list.
 *
 * *"Things that should be arrays are sometimes objects with numbered keys"* is
 * how the maintained client's own README puts it, and it is right. A panel that
 * answers `{"0":{…},"1":{…}}` is not broken enough to refuse.
 */
function asList<T>(value: unknown): T[] {
  if (Array.isArray(value)) {
    return value as T[];
  }

  return typeof value === 'object' && value !== null ? (Object.values(value) as T[]) : [];
}

/**
 * Base64 out of a panel, as text.
 *
 * **Not `atob`**, which the clients use and which yields latin1 — so every
 * non-ASCII title comes back mangled, which in a package that unions
 * language-tagged fields is most of the point of having them.
 *
 * Some panels do not encode at all, and decoding what was never encoded gives
 * mojibake rather than an error. So a value that does not survive the round
 * trip is taken as having been plain all along.
 */
function decode(value: string | undefined): string {
  const trimmed = value?.trim();

  if (!trimmed) {
    return '';
  }

  const decoded = Buffer.from(trimmed, 'base64').toString('utf8');
  const padless = (text: string): string => text.replace(/=+$/, '');

  return padless(Buffer.from(decoded, 'utf8').toString('base64')) === padless(trimmed)
    ? decoded
    : trimmed;
}

/** Epoch seconds out of a panel, which sends them as a string. */
function seconds(value: unknown): number | undefined {
  const at = typeof value === 'string' ? Number(value.trim()) : value;

  // `''` and `'0'` both occur, and `xmltvDate` throws on a non-finite number —
  // which would take a whole channel down over one bad listing.
  return typeof at === 'number' && Number.isFinite(at) && at > 0 ? at : undefined;
}

/**
 * What offset the panel wrote a listing in, from the listing itself.
 *
 * It gives both a wall clock (`start`) and the same instant as epoch seconds
 * (`start_timestamp`), so the difference between them *is* the offset — and it
 * is right across a DST boundary, where a configured zone would only be right
 * if it named the same place the panel is in.
 *
 * `undefined` where the two agree on nothing sensible, which leaves the time to
 * serialize as UTC rather than as a guess.
 */
function offsetOf(listing: WireListing, at: number): number | undefined {
  const wall = Date.parse(`${(listing.start ?? '').trim().replace(' ', 'T')}Z`);

  if (!Number.isFinite(wall)) {
    return undefined;
  }

  const offset = Math.round((wall - at * 1000) / 60_000);

  return Math.abs(offset) <= MAX_OFFSET_MINUTES ? offset : undefined;
}

/** A wire listing as a programme, or nothing if it cannot be one. */
function normalize(listing: WireListing): XtreamProgramme | undefined {
  const at = seconds(listing.start_timestamp);
  const title = decode(listing.title);

  // A listing with no start is not a listing, and one with no title cannot be
  // written: `<title>` is the one child the DTD requires.
  if (at === undefined || title === '') {
    return undefined;
  }

  const offset = offsetOf(listing, at);
  const stopAt = seconds(listing.stop_timestamp);
  const description = decode(listing.description);
  const language = listing.lang?.trim();

  return {
    ...(listing.id ? { id: String(listing.id) } : {}),
    ...(listing.epg_id ? { epgId: String(listing.epg_id) } : {}),
    title,
    ...(description ? { description } : {}),
    ...(language ? { language } : {}),
    start: offset === undefined ? xmltvDate(at) : xmltvDate(at, { offset }),
    ...(stopAt === undefined
      ? {}
      : { stop: offset === undefined ? xmltvDate(stopAt) : xmltvDate(stopAt, { offset }) }),
    hasArchive: listing.has_archive === 1,
  };
}

/**
 * What a programme carries that a `<programme>` has no field for.
 *
 * The panel's own ids are how anything downstream asks it a further question,
 * and `hasArchive` is whether it can still be watched back. Exported so a hook
 * of your own can keep these and add to them rather than choosing between.
 */
export function xtreamProgrammeExtras(element: ProgrammeBuilder, programme: XtreamProgramme): void {
  element.extraAttributes({
    ...(programme.id ? { xtreamId: programme.id } : {}),
    ...(programme.epgId ? { xtreamEpgId: programme.epgId } : {}),
    ...(programme.hasArchive ? { catchup: 'yes' } : {}),
  });
}

/** The same for a channel: its category, its catchup window, when it appeared. */
export function xtreamChannelExtras(element: ChannelBuilder, channel: XtreamChannel): void {
  element.extraAttributes({
    ...(channel.tvArchive ? { catchup: 'yes' } : {}),
    ...(channel.tvArchiveDuration === undefined
      ? {}
      : { catchupDays: String(channel.tvArchiveDuration) }),
    ...(channel.addedAt === undefined ? {} : { added: String(channel.addedAt) }),
  });

  if (channel.category) {
    element.extra({ name: 'category', value: channel.category });
  }
}

/** Strip a query string, so a url in an error message carries no credentials. */
function withoutQuery(text: string): string {
  return text.replace(/\?\S*/g, '?…');
}

/**
 * An Xtream Codes panel as a site.
 *
 * ```ts
 * defineXtreamSite({
 *   site: 'panel.example',
 *   url: 'http://host:8080',
 *   username: process.env.PANEL_USER!,
 *   password: process.env.PANEL_PASS!,
 * })
 * ```
 *
 * Everything the panel says is kept: what the DTD has a place for goes there,
 * and what it does not becomes a provider extension, which `--no-extensions`
 * strips for a guide that has to validate. Two things are dropped rather than
 * kept — `now_playing`, true only at the instant of asking and a lie by the
 * time the guide is read, and `direct_source`, which carries the credentials.
 */
export function defineXtreamSite(
  options: XtreamSiteOptions,
): SiteConfig<XtreamProgramme[], 'days', XtreamChannel> {
  const {
    url,
    username,
    password,
    dayZone = 'source',
    categories = true,
    programmeExtras = xtreamProgrammeExtras,
    channelExtras = xtreamChannelExtras,
    ...site
  } = options;

  return defineSiteConfig<XtreamProgramme[], 'days', XtreamChannel>({
    ...site,
    ky: {
      ...site.ky,
      prefix: url,
      // Merged rather than replaced by ky, so every call carries these without
      // a call site having to remember them.
      // Spread only where the caller gave an object; ky also accepts a string
      // or a `URLSearchParams`, neither of which spreads into one.
      searchParams: {
        ...(typeof site.ky?.searchParams === 'object' && !Array.isArray(site.ky.searchParams)
          ? (site.ky.searchParams as Record<string, string>)
          : {}),
        username,
        password,
      },
      hooks: {
        ...site.ky?.hooks,
        // The credentials are query parameters because that is the only place
        // this API takes them — which means ky's own error message would carry
        // the password into `request:failed`, into the text reporter's stderr,
        // and into the JSON reporter's `stack` and `cause`. Rewritten here so
        // it covers retries and anything added later, rather than per call.
        beforeError: [
          ...(site.ky?.hooks?.beforeError ?? []),
          ({ error }) => {
            error.message = withoutQuery(error.message);

            return error;
          },
        ],
      },
    },
    batching: 'days',

    async channels({ http, warn }) {
      const [streams, named] = await Promise.all([
        http.get('player_api.php', { searchParams: { action: 'get_live_streams' } }).json(),
        categories
          ? http.get('player_api.php', { searchParams: { action: 'get_live_categories' } }).json()
          : Promise.resolve([]),
      ]);

      const list = asList<WireStream>(streams);
      const names = new Map(
        asList<{ category_id?: string; category_name?: string }>(named).map((category) => [
          String(category.category_id),
          category.category_name ?? '',
        ]),
      );

      const channels: GrabberChannel<XtreamChannel>[] = [];
      const seen = new Set<string>();
      let duplicates = 0;

      for (const stream of list) {
        const streamId = stream.stream_id;

        if (typeof streamId !== 'number') {
          continue;
        }

        // A panel leaves this `''`, `'0'` or absent about as often as it fills
        // it in, and the stream id is the only other thing identifying it.
        const declared = stream.epg_channel_id?.trim();
        const epgId = declared && declared !== '0' ? declared : undefined;
        const xmltvId = epgId ?? String(streamId);

        // SD, HD and FHD variants of one channel routinely share an
        // `epg_channel_id`. The cache is keyed by `(site, channel, day)`, so a
        // second one does not replace the first — it *appends*, and the guide
        // ends up with every programme twice.
        if (seen.has(xmltvId)) {
          duplicates++;
          continue;
        }

        seen.add(xmltvId);

        const categoryIds = asList<unknown>(stream.category_ids ?? []).map(String);
        const ids = categoryIds.length > 0 ? categoryIds : [String(stream.category_id ?? '')];
        const category = names.get(ids[0] ?? '');
        const archive = stream.tv_archive === 1;
        const duration = archive ? seconds(stream.tv_archive_duration) : undefined;
        const addedAt = seconds(stream.added);
        const name = stream.name ?? xmltvId;

        channels.push({
          xmltvId,
          siteId: String(streamId),
          name,
          ...(stream.stream_icon ? { logo: stream.stream_icon } : {}),
          ...(typeof stream.num === 'number' ? { preset: String(stream.num) } : {}),
          data: {
            id: String(streamId),
            name,
            ...(typeof stream.num === 'number' ? { number: stream.num } : {}),
            ...(stream.stream_icon ? { logo: stream.stream_icon } : {}),
            ...(epgId ? { epgId } : {}),
            tvArchive: archive,
            ...(duration === undefined ? {} : { tvArchiveDuration: duration }),
            ...(addedAt === undefined ? {} : { addedAt }),
            categoryIds: ids.filter((id) => id !== ''),
            ...(category ? { category } : {}),
          },
        });
      }

      // Asked *after* the mapping rather than of the raw payload, because the
      // shapes a panel refuses credentials with are not all empty: `[]`, `{}`,
      // and `{"user_info":{"auth":0}}` — all at HTTP 200, so nothing threw and
      // the last of them even survives `asList`. What they have in common is
      // that no channel came out. Left alone this reads as "the panel has no
      // channels" and publishes an empty guide; thrown, the site is counted
      // failed and said out loud, which is the truth.
      if (channels.length === 0) {
        throw new GrabberError(
          `${site.site}: the panel listed no channels — check the username and password, which it answers 200 to when they are wrong`,
        );
      }

      // Counted rather than named one at a time: a panel with a dozen quality
      // variants of everything would otherwise bury the run.
      if (duplicates > 0) {
        warn(
          `${duplicates} ${duplicates === 1 ? 'channel shares an epg id' : 'channels share an epg id'} with one already taken, and ${duplicates === 1 ? 'was' : 'were'} left out`,
        );
      }

      return channels;
    },

    async request({ channel, http }) {
      const payload = await http
        .get('player_api.php', {
          searchParams: { action: 'get_simple_data_table', stream_id: channel.siteId },
        })
        .json<{ epg_listings?: unknown }>();

      return asList<WireListing>(payload?.epg_listings)
        .map((listing) => normalize(listing))
        .filter((listing): listing is XtreamProgramme => listing !== undefined);
    },

    parseDay({ payload, day, programme }) {
      const programmes: ProgrammeBuilder[] = [];

      for (const item of payload) {
        // One call brings a channel's whole table and `parseDay` is asked for
        // one day of it at a time — filed by where it *starts*, so a programme
        // running through midnight stays in the entry already cached for it
        // rather than moving when the next day is refetched.
        if (dayOf(item.start, dayZone) !== day) {
          continue;
        }

        const built = item.language
          ? programme(item.start, item.title, { lang: item.language })
          : programme(item.start, item.title);

        if (item.stop !== undefined) {
          built.stop(item.stop);
        }

        if (item.description !== undefined) {
          built.desc(item.description, item.language);
        }

        if (programmeExtras !== false) {
          programmeExtras(built, item);
        }

        programmes.push(built);
      }

      return programmes;
    },

    channelInfo(channel, element) {
      // The caller's own `channelInfo` is composed with rather than replaced:
      // it is handed an `element` whose builder already carries the panel's
      // extras, so it adds to them exactly as it would to the defaults.
      const withExtras: ChannelElement = (displayName) => {
        const built = element(displayName);

        if (channelExtras !== false && channel.data !== undefined) {
          channelExtras(built, channel.data);
        }

        return built;
      };

      return site.channelInfo ? site.channelInfo(channel, withExtras) : withExtras();
    },
  });
}
