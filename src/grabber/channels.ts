import ky, { type KyInstance } from 'ky';
import PQueue from 'p-queue';
import { readFile } from 'node:fs/promises';
import { parseChannelsXml } from '../channels/parse.js';
import { parseM3uFile } from '../m3u/parse.js';
import type { ChannelListEntry, ChannelListWarning } from '../channels/types.js';
import type { CacheStore } from '../cache/types.js';
import type { Emit, Says } from '../core/events.js';
import type {
  AnyIterable,
  M3uDirective,
  M3uEntry,
  M3uParseEvent,
  M3uPlaylist,
  M3uWarning,
} from '../m3u/types.js';
import { ChannelBuilder } from '../xmltv/builder.js';
import type { XmltvChannel } from '../xmltv/types.js';
import { revalidationHooks } from './revalidate.js';
import { channelsMaxAgeMs, SiteStateHandle } from './state.js';
import type { AnySiteConfig, ChannelsContext, GrabberChannel } from './types.js';

/**
 * A site's own HTTP client, built from its `ky` options.
 *
 * One place builds it, so everything that talks to a site — its requests and
 * its channel list — goes out with the same prefix, headers, retry and
 * dispatcher, and no site's settings can reach another's.
 *
 * `signal` is baked into the instance rather than handed to the site to pass
 * on: every call through `http` is then abortable whether or not whoever wrote
 * the site remembered to forward it. A site that brought a signal of its own in
 * `ky.signal` keeps it — both are honoured, either one aborts.
 */
export function siteHttp(config: AnySiteConfig, signal?: AbortSignal): KyInstance {
  const signals = [config.ky?.signal, signal].filter(
    (candidate): candidate is AbortSignal => candidate != null,
  );

  return ky.create({
    ...config.ky,
    // Only for a site that asked. ky hands each `afterResponse` hook a clone of
    // the response, so a site with no use for conditional requests should not be
    // paying for one — even a cheap one.
    ...(config.conditionalGet === true ? { hooks: revalidationHooks(config.ky?.hooks) } : {}),
    ...(signals.length > 0
      ? { signal: signals.length === 1 ? signals[0]! : AbortSignal.any(signals) }
      : {}),
  });
}

/** What a caller can offer {@link resolveChannels} beyond the site itself. */
export interface ResolveChannelsOptions {
  /** The site's client, when the caller already has one. Built otherwise. */
  http?: KyInstance;
  signal?: AbortSignal;
  /**
   * This site's state, when the caller has opened it — where a cached channel
   * list is read from and written to. Without one, a site that asked for
   * `cacheChannels` is simply asked for its list like any other.
   */
  state?: SiteStateHandle;
  /** Fetch the list whatever is cached — what `--refresh` amounts to here. */
  refresh?: boolean;
  /** "Now", for reckoning how old a cached list is. Defaults to the real one. */
  now?: Date;
  /**
   * Where the site's own `log` and `warn` go.
   *
   * Without it they are dropped, which is what a caller with nowhere to put
   * them wants — `--list-channels` writes a document to stdout and has no room
   * for a running commentary in the middle of it.
   */
  says?: Says;
}

/** Said to nobody, for a caller that has nowhere to put it. */
const SILENT: Says = { log: () => {}, warn: () => {} };

/**
 * A site's channels, whichever form it declares them in.
 *
 * The function form is called with the site's HTTP client, so a channel list
 * that has to be fetched needs nothing of its own — no second client, and no
 * copy of the credentials the site's `ky` options already carry. Pass `http`
 * when the caller already has the site's instance (a grab does); one is built
 * otherwise.
 *
 * Every caller resolves channels through this — the grab, the merge,
 * `--list-channels`, `--configure` and the lineups capability — so a fetched
 * list reaches all of them the same way. Which is also where a site's
 * `cacheChannels` is honoured: given a state handle, a list still inside its max
 * age comes back without the source being asked, and a freshly fetched one is
 * remembered for the next command. The handle is *not* saved here — whoever
 * opened it saves it once, when it is done with the site.
 */
export async function resolveChannels(
  config: AnySiteConfig,
  options: ResolveChannelsOptions = {},
): Promise<GrabberChannel[]> {
  // In a local, so the narrowing survives into the closure below.
  const source = config.channels;

  if (typeof source !== 'function') {
    return source;
  }

  const fromSource = async (): Promise<GrabberChannel[]> =>
    source({
      http: options.http ?? siteHttp(config, options.signal),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.says ?? SILENT),
    });

  const maxAgeMs = channelsMaxAgeMs(config);
  const { state } = options;

  // Nothing to read and nothing to keep: the site did not ask for its list to be
  // cached, or this caller has nowhere to put it.
  if (maxAgeMs === undefined || state === undefined) {
    return fromSource();
  }

  const now = options.now ?? new Date();
  const group = await state.channels();

  if (options.refresh !== true) {
    const held = group.fresh(maxAgeMs, now);

    if (held !== undefined) {
      return held;
    }
  }

  const channels = await fromSource();

  group.set(channels, now);

  return channels;
}

/**
 * Every site with its channels resolved to a plain list.
 *
 * What to reach for when more than one pass has to agree about the same sites:
 * a fetched list resolved separately by a grab and by the merge that reads what
 * it wrote can differ between the two, leaving the guide describing channels
 * nothing ever grabbed. Resolving up front is also one request per site instead
 * of one per pass.
 *
 * `concurrency` defaults to all of them at once — one request each, to one host
 * each; pass the run's `siteConcurrency` to hold it to the same bound the grab
 * itself uses.
 *
 * Given a `store`, a site that asked for `cacheChannels` reads its list from
 * there and writes a fetched one back — one state handle per site, opened and
 * saved here, since resolving is the whole of what this call does with a site.
 */
export async function resolveSites(
  sites: AnySiteConfig[],
  options: {
    signal?: AbortSignal;
    concurrency?: number;
    /** Where a cached channel list lives. Without it, every list is fetched. */
    store?: CacheStore;
    /** Fetch every list whatever is cached — `--refresh`. */
    refresh?: boolean;
    now?: Date;
    /**
     * Where each site's own `log` and `warn` go, as the events they are.
     *
     * An emitter rather than a `says` pair, because there is one per site and
     * only the name differs — the same two events a run's own contexts send.
     */
    emit?: Emit;
  } = {},
): Promise<AnySiteConfig[]> {
  const queue = new PQueue({ concurrency: Math.max(1, options.concurrency ?? sites.length) });
  const { store } = options;

  return Promise.all(
    sites.map((site) =>
      queue.add(async (): Promise<AnySiteConfig> => {
        const state = store === undefined ? undefined : SiteStateHandle.open(store, site.site);
        const { emit } = options;
        const channels = await resolveChannels(site, {
          ...(options.signal ? { signal: options.signal } : {}),
          ...(state ? { state } : {}),
          ...(options.refresh === undefined ? {} : { refresh: options.refresh }),
          ...(options.now ? { now: options.now } : {}),
          ...(emit
            ? {
                says: {
                  log: (message, data) =>
                    emit({
                      type: 'site:note',
                      site: site.site,
                      message,
                      ...(data ? { data } : {}),
                    }),
                  warn: (message, data) =>
                    emit({
                      type: 'site:warning',
                      site: site.site,
                      message,
                      ...(data ? { data } : {}),
                    }),
                },
              }
            : {}),
        });

        // Only a list that was fetched is one to write, and the handle knows
        // whether that happened — so a merge over a cached list touches nothing.
        await state?.save();

        return { ...site, channels };
      }),
    ),
  );
}

/**
 * The `<channel>` element a site gets when it defines no `channelInfo`:
 * id + display name + icon. Exported because the same mapping is what an
 * XMLTV grabber's `--list-channels` has to emit.
 */
export function defaultChannelInfo(channel: GrabberChannel): XmltvChannel {
  return {
    id: channel.xmltvId,
    displayName: [{ value: channel.name ?? channel.xmltvId }],
    ...(channel.logo ? { icon: [{ src: channel.logo }] } : {}),
  };
}

/**
 * How a site describes one of its channels, whichever way it says it: the
 * default element, or what its `channelInfo` builds — as a builder or as a
 * plain object.
 *
 * Everything that emits a `<channel>` goes through this — the merge and
 * `--list-channels` — so a channel is described identically wherever it turns
 * up.
 */
export function channelElement(config: AnySiteConfig, channel: GrabberChannel): XmltvChannel {
  if (!config.channelInfo) {
    return defaultChannelInfo(channel);
  }

  const element = (displayName?: string): ChannelBuilder => {
    const builder = new ChannelBuilder({
      id: channel.xmltvId,
      displayName: displayName ?? channel.name ?? channel.xmltvId,
      ...(channel.lang === undefined ? {} : { lang: channel.lang }),
    });

    // Where the default element leaves off, so a site adds to it rather than
    // restating it.
    return channel.logo ? builder.icon(channel.logo) : builder;
  };

  const info = config.channelInfo(channel, element);

  return info instanceof ChannelBuilder ? info.build() : info;
}

/**
 * The id an entry carries, unless the caller says otherwise.
 *
 * `tvg-ID` as well as `tvg-id` because some providers spell it that way and
 * Kodi reads both — its own source calls the second one incorrect and accepts it
 * regardless, which is the right way round for a format with no authority.
 */
const defaultId = (entry: M3uEntry): string | undefined =>
  entry.attributes.get('tvg-id') ?? entry.attributes.get('tvg-ID');

/** A semi-colon separated list, which is how this format spells a list. */
const semicolons = (value: string | undefined): string[] =>
  value
    ? value
        .split(';')
        .map((one) => one.trim())
        .filter(Boolean)
    : [];

/**
 * A url as written, made absolute against the playlist it came from.
 *
 * A playlist may name its streams relatively — tvheadend resolves them against
 * the playlist's own url, and a channel list holding `stream/a.m3u8` is of no
 * use to anything downstream. Left exactly as it was when there is no base to
 * resolve against, or when it does not parse as a url at all: this is a channel
 * list, not a validator, and a value nobody can make sense of is better handed
 * over unchanged than replaced with a guess.
 */
function resolve(url: string, base: string | undefined): string {
  if (!base || url === '') {
    return url;
  }

  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

/** Why {@link channelsFromM3u} passed an entry over. */
export type M3uSkipReason =
  /** No `tvg-id`, and nothing to put in its place — see {@link M3uChannelsOptions.id}. */
  | 'no-id'
  /** An id already taken by an earlier entry; the first one is kept. */
  | 'duplicate-id';

/** What {@link channelsFromM3u} keeps from the entry a channel came from. */
export interface M3uChannelData {
  /** The stream url, which the guide has no use for and a caller may. */
  url: string;
  /**
   * The groups this channel is in, from **both** ways a playlist can say it.
   *
   * `group-title` on the `#EXTINF`, split on `;` because it is a *list* — the
   * thing most readers of this format get wrong — together with any `#EXTGRP`
   * in force. `#EXTGRP` is a **begin directive**: Kodi sets the group from one
   * and deliberately does not clear it after each entry, so a single line
   * groups every entry that follows until the next one. Empty when the playlist
   * said neither.
   */
  groups: string[];
  /** Every `#EXTINF` attribute as spelled, including the ones mapped above. */
  attributes: Record<string, string>;
  /** `#EXTVLCOPT` and friends, in order, when the entry had any. */
  directives?: M3uDirective[];
}

export interface M3uChannelsOptions {
  /**
   * The id for an entry. `tvg-id` by default; an entry this returns empty for
   * is skipped.
   *
   * Worth overriding rather than an edge case: **1,948 of iptv-org's 12,946
   * entries (15%) have no `tvg-id`**, and a playlist assembled by hand often
   * has none at all. `(entry) => entry.attributes.get('tvg-id') || entry.name` is
   * the usual repair, and takes the risk of two channels sharing a name.
   */
  id?: (entry: M3uEntry) => string | undefined;
  /**
   * Told about every entry that did not become a channel, and why.
   *
   * Offered because the default skips 15% of the best-known playlist there is,
   * and a channel list quietly a sixth shorter than its source is the kind of
   * thing that is noticed a long way downstream.
   */
  onSkipped?: (entry: M3uEntry, reason: M3uSkipReason) => void;
  /** Told about every non-fatal parse problem; see {@link M3uWarning}. */
  onWarning?: (warning: M3uWarning) => void;
  /**
   * The playlist's own url, so a relative stream url becomes absolute.
   *
   * A playlist served at `https://host/lists/uk.m3u` may name its streams as
   * `stream/a.m3u8`, and tvheadend resolves those against the playlist the same
   * way. {@link defineM3uSite} passes this for you. Without it the url is kept
   * exactly as the playlist wrote it.
   */
  base?: string;
}

/**
 * Read an M3U playlist as a site's channel list.
 *
 * ```ts
 * channels: channelsFromM3u('./channels.m3u'),
 * channels: channelsFromM3u(parseM3uString(await response.text())),
 * ```
 *
 * Returns the `channels` function rather than the channels, so a config reads
 * like that — and so the playlist is read when the list is *resolved* rather
 * than when the config module loads. The function is handed the site's own
 * context, so a playlist that does not parse cleanly says so under the site's
 * name without a caller having to wire `onWarning` up.
 *
 * A string is a **path**, streamed with {@link parseM3uFile} — a playlist is
 * megabytes and there is no reason to hold one. A url is refused rather than
 * fetched here: {@link defineM3uSite} already does that properly, with the
 * site's own client, no timeout, and `.m3u.gz` sniffed. Anything else `src/m3u`
 * produces is taken as it is, which is the way in for a playlist that came from
 * somewhere this knows nothing about.
 *
 * The mapping is the conventional one the Kodi IPTV Simple Client documents:
 * `tvg-id` → `xmltvId` **and** `siteId`, `tvg-name` (falling back to the
 * display name) → `name`, `tvg-logo` → `logo`, `tvg-chno` → `preset`,
 * `tvg-language` → `lang`. Everything else is kept in `data`.
 *
 * `siteId` defaults to the same id because a playlist has no second identity to
 * offer — which is what makes the result usable as a site's `channels` directly.
 * A site that fetches by something else should map over the result and say so.
 *
 * The reverse direction is deliberately not a helper: only the caller knows
 * what url a channel has, and building entries for `writeM3uStream` is three
 * lines once they do.
 */
export function channelsFromM3u(
  source: string | AnyIterable<M3uParseEvent> | M3uPlaylist,
  options?: M3uChannelsOptions,
): (context?: ChannelsContext) => Promise<GrabberChannel<M3uChannelData>[]> {
  return async (context) => {
    const channels: GrabberChannel<M3uChannelData>[] = [];
    const seen = new Set<string>();
    const warn =
      options?.onWarning ??
      ((warning: M3uWarning) => context?.warn(`playlist line ${warning.line}: ${warning.message}`));

    const base = options?.base;
    /**
     * The groups the last `#EXTGRP` put in force, which stay in force.
     *
     * Updated before the skip checks below, because a directive applies to the
     * entries after it whether or not the one carrying it became a channel.
     */
    let carriedGroups: string[] = [];

    const take = (entry: M3uEntry): void => {
      for (const directive of entry.directives ?? []) {
        if (directive.name === 'EXTGRP') {
          // Replaces rather than adds, as Kodi's does — it clears the list first.
          carriedGroups = semicolons(directive.value);
        }
      }

      const id = (options?.id ?? defaultId)(entry);

      if (!id) {
        options?.onSkipped?.(entry, 'no-id');

        return;
      }

      if (seen.has(id)) {
        options?.onSkipped?.(entry, 'duplicate-id');

        return;
      }

      seen.add(id);

      const { attributes } = entry;
      const name = attributes.get('tvg-name') || entry.name;

      channels.push({
        xmltvId: id,
        siteId: id,
        ...(name ? { name } : {}),
        ...(attributes.get('tvg-language') ? { lang: attributes.get('tvg-language')! } : {}),
        ...(attributes.get('tvg-logo') ? { logo: attributes.get('tvg-logo')! } : {}),
        ...(attributes.get('tvg-chno') ? { preset: attributes.get('tvg-chno')! } : {}),
        data: {
          url: resolve(entry.url, base),
          groups: [...new Set([...semicolons(attributes.get('group-title')), ...carriedGroups])],
          // A plain object, not the entry's `Map`: this is handed back to a site
          // and cached, and the cache stores it with `JSON.stringify`, which
          // turns a `Map` into `{}` without saying so.
          attributes: Object.fromEntries(attributes),
          ...(entry.directives ? { directives: entry.directives } : {}),
        },
      });
    };

    const events = typeof source === 'string' ? parseM3uFile(playlistPath(source)) : source;

    if (Symbol.iterator in events || Symbol.asyncIterator in events) {
      for await (const event of events as AnyIterable<M3uParseEvent>) {
        if (event.type === 'entry') {
          take(event.value);
        } else if (event.type === 'warning') {
          warn(event.value);
        }
      }
    } else {
      for (const warning of events.warnings) {
        warn(warning);
      }

      for (const entry of events.entries) {
        take(entry);
      }
    }

    return channels;
  };
}

/** A path, checked for the two things handed over in its place by mistake. */
function playlistPath(source: string): string {
  // A document would otherwise fail as a filename megabytes long, and a url as
  // one with a scheme in it — neither says anything about the mistake.
  if (source.startsWith('#EXTM3U') || source.includes('#EXTINF:')) {
    throw new TypeError(
      'channelsFromM3u takes a path or parsed events, not a document: use parseM3uString(text)',
    );
  }

  if (/^https?:\/\//i.test(source)) {
    throw new TypeError(
      `channelsFromM3u takes a path, not a url: use defineM3uSite({ url: ${JSON.stringify(source)} }) for a playlist that is the whole source, or parseM3uStream over your own response`,
    );
  }

  return source;
}

/** A path, read and parsed, with whatever it had to say passed on. */
async function readChannelList(
  path: string,
  options: ChannelsXmlOptions | undefined,
  context: ChannelsContext | undefined,
): Promise<readonly ChannelListEntry[]> {
  // A document handed over where a path belongs would otherwise fail as a
  // filename several kilobytes long, which says nothing about the mistake.
  if (path.trimStart().startsWith('<')) {
    throw new TypeError(
      'channelsFromChannelsXml takes a path or entries, not a document: use parseChannelsXml(text).entries',
    );
  }

  const list = parseChannelsXml(await readFile(path, 'utf8'));

  for (const warning of list.warnings) {
    // The site's own `warn` by default, so an unmapped channel is said out loud
    // in a run rather than needing a caller to have asked for it.
    (options?.onWarning ?? ((found) => context?.warn(`${path}:${found.line}: ${found.message}`)))(
      warning,
    );
  }

  return list.entries;
}

/** Why {@link channelsFromChannelsXml} passed an entry over. */
export type ChannelsXmlSkipReason =
  /** No `xmltv_id`, so nothing in a guide could ever match it. */
  | 'unmapped'
  /** Belongs to a different `site` than the one asked for. */
  | 'other-site'
  /** A `site_id` already taken by an earlier entry; the first one is kept. */
  | 'duplicate-site-id';

/** What a channel list knows that a {@link GrabberChannel} has no field for. */
export interface ChannelsXmlChannelData {
  /**
   * Which source the entry named, when it named one.
   *
   * A `GrabberChannel` has no field for it because a site config knows its own
   * name — but a file may hold several sources, and read without the `site`
   * filter that is the only record of which channel came from where.
   */
  site?: string;
  /** The channel's own page, which is not the stream's. */
  url?: string;
  /**
   * WebGrab+Plus's `update`, carried for the reason the reader keeps it.
   *
   * A grab does not act on it — it is that program's refresh policy — but a
   * channel list built from one of its files and written back out would
   * otherwise come back with everyone's policy silently reset.
   */
  update?: string;
}

export interface ChannelsXmlOptions {
  /**
   * Told about every non-fatal problem the file has.
   *
   * Worth listening to when a path was given, since the reading happens in here
   * and the warnings would otherwise have nowhere to go — and the one that
   * matters, `unmapped-channel`, is the reason this whole thing exists.
   */
  onWarning?: (warning: ChannelListWarning) => void;
  /**
   * Take only the channels of this site.
   *
   * A `*.channels.xml` is usually one source's, and then this is unnecessary —
   * but the format carries `site` per channel precisely so several can share a
   * file, and a site config wants its own.
   */
  site?: string;
  /**
   * Told about every entry that did not become a channel, and why.
   *
   * Worth listening to for `unmapped`: an `xmltv_id=""` is the state real files
   * are in — tvtv.us's own list has 69 of them — and each is a channel the
   * grabber will not fetch and nobody will notice is absent.
   */
  onSkipped?: (entry: ChannelListEntry, reason: ChannelsXmlSkipReason) => void;
}

/**
 * Read a `*.channels.xml` as a site's channel list.
 *
 * The counterpart to {@link channelsFromM3u}, and a tidier mapping than that
 * one: a playlist has a single `tvg-id` doing both jobs, while this format
 * keeps the two ids the grabber actually needs apart — `site_id` is what the
 * source is asked for, `xmltv_id` is what comes out in the guide.
 *
 * ```ts
 * channels: channelsFromChannelsXml('./example.com.channels.xml'),
 * ```
 *
 * Returns the `channels` function rather than the channels, which is what lets
 * a config read like that — and is not only sugar. The file is then read when
 * the list is *resolved* rather than when the config module loads, so a config
 * does no I/O on import; and the function is handed the site's own context, so
 * an unmapped channel is reported through the site's `warn` without a caller
 * having to ask.
 *
 * A path is read here rather than by the caller, since a site wanting its
 * channel list beside it is the whole of what this is for. Entries can be
 * passed instead for a list that came from somewhere else — an HTTP response,
 * say — parsed with {@link parseChannelsXml}, and the returned function then
 * needs no context: `await channelsFromChannelsXml(entries)()`.
 *
 * An entry with no `xmltv_id` is skipped: it names something the source has but
 * nothing a guide could refer to, so grabbing it would write programmes under
 * an id no consumer can ask for.
 */
export function channelsFromChannelsXml(
  source: string | readonly ChannelListEntry[],
  options?: ChannelsXmlOptions,
): (context?: ChannelsContext) => Promise<GrabberChannel<ChannelsXmlChannelData>[]> {
  return async (context) => {
    const entries =
      typeof source === 'string' ? await readChannelList(source, options, context) : source;
    const channels: GrabberChannel<ChannelsXmlChannelData>[] = [];
    const seen = new Set<string>();

    for (const entry of entries) {
      if (options?.site !== undefined && entry.site !== undefined && entry.site !== options.site) {
        options.onSkipped?.(entry, 'other-site');
        continue;
      }

      if (entry.xmltvId === '') {
        options?.onSkipped?.(entry, 'unmapped');
        continue;
      }

      if (seen.has(entry.siteId)) {
        options?.onSkipped?.(entry, 'duplicate-site-id');
        continue;
      }

      seen.add(entry.siteId);

      channels.push({
        xmltvId: entry.xmltvId,
        siteId: entry.siteId,
        ...(entry.name === '' ? {} : { name: entry.name }),
        ...(entry.lang === undefined ? {} : { lang: entry.lang }),
        ...(entry.logo === undefined ? {} : { logo: entry.logo }),
        // `lcn` is the number a box shows the channel at, which is what `preset`
        // is — the lineups capability writes it as a `<preset>`.
        ...(entry.lcn === undefined ? {} : { preset: entry.lcn }),
        // Only what a `GrabberChannel` has nowhere else to put — and nothing at
        // all when there is none of it, rather than an empty object. Everything
        // else the file said is a field above.
        ...(entry.site === undefined && entry.url === undefined && entry.update === undefined
          ? {}
          : {
              data: {
                ...(entry.site === undefined ? {} : { site: entry.site }),
                ...(entry.url === undefined ? {} : { url: entry.url }),
                ...(entry.update === undefined ? {} : { update: entry.update }),
              },
            }),
      });
    }

    return channels;
  };
}
