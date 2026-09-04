/**
 * An M3U playlist as a source: point at a playlist and grab the guide it names.
 *
 * A playlist carries both halves of a site. Its entries are the channel list,
 * and its `#EXTM3U` line carries `x-tvg-url` — where the XMLTV guide for those
 * channels is published. So one url is a whole source, and everything after
 * finding the guide is what {@link defineXmltvSite} already does.
 *
 * That header attribute is the closest thing the IPTV world has to service
 * discovery, and this is what the two halves of the package are for: the
 * playlist says which channels and where their guide is, and the XMLTV source
 * streams the guide and splits it into channel-days.
 */

import { parseM3uStream, type M3uParseStreamOptions } from '../m3u/parse.js';
import type { M3uHeader, M3uParseEvent } from '../m3u/types.js';
import type { Says } from '../core/events.js';
import {
  channelsFromM3u,
  type M3uChannelData,
  type M3uChannelsOptions,
  type M3uSkipReason,
} from './channels.js';
import type { GrabberChannel, StreamContext, StreamSiteConfig } from './types.js';
import { defineXmltvSite, documentBytes, type XmltvSiteOptions } from './xmltv-source.js';

/**
 * Where a playlist says its guide is, in the order the header offered them.
 *
 * `x-tvg-url` is the attribute; `url-tvg` is the other spelling, and Kodi reads
 * both. The value **may be a comma-separated list** of guides — Kodi takes the
 * first and says in a comment that it does not support more than one. Here the
 * whole list comes back, because merging several guides for one channel list is
 * what this package does anyway.
 *
 * Empty when the playlist names none, which is not an error on its own: a
 * playlist is perfectly valid without a guide, it just cannot be a source.
 */
export function guideUrlsFromM3u(header: M3uHeader, base?: string): string[] {
  const value = header.attributes.get('x-tvg-url') ?? header.attributes.get('url-tvg') ?? '';

  return value
    .split(',')
    .map((one) => one.trim())
    .filter(Boolean)
    .map((one) => {
      // Against the playlist, when there is one: a header may name its guide
      // relatively (`guide.xml.gz` beside the playlist), and a relative url
      // handed to `http.get` is not the one the playlist meant.
      if (base === undefined) {
        return one;
      }

      try {
        return new URL(one, base).href;
      } catch {
        return one;
      }
    });
}

export interface M3uSiteOptions<TData = M3uChannelData> extends Omit<
  XmltvSiteOptions<TData>,
  'url' | 'channels'
> {
  /** Where the playlist is. */
  url: string;
  /**
   * How the playlist's entries become channels — `id`, `onSkipped`,
   * `onWarning`. See {@link channelsFromM3u}, and note that **15% of iptv-org's
   * entries have no `tvg-id`** and are skipped by default.
   */
  channels?: M3uChannelsOptions;
  /**
   * How to read the playlist's own bytes — its `charset`, and the
   * `maxLineLength` bound. Separate from `parse`, which is the *guide's*.
   *
   * A playlist has no encoding declaration, so a provider writing
   * `windows-1251` needs saying so here.
   */
  playlist?: M3uParseStreamOptions;
  /**
   * Which guide to grab when the playlist names more than one.
   *
   * The first by default. Given every url the header offered, in order, so a
   * caller can pick by hostname or by suffix. To grab *all* of them, define one
   * site per guide instead — that is what the merge is for, and it keeps each
   * one cached and revalidated separately.
   */
  guide?: (urls: string[], header: M3uHeader) => string;
}

/** What one read of the playlist yields, since both passes want a piece of it. */
interface Playlist<TData> {
  channels: GrabberChannel<TData>[];
  header: M3uHeader;
}

/**
 * An M3U playlist as a site.
 *
 * ```ts
 * export default defineConfig({
 *   sites: [defineM3uSite({ site: 'iptv-org', url: 'https://iptv-org.github.io/iptv/index.m3u' })],
 *   output: 'guide.xml',
 * });
 * ```
 *
 * The channel list comes from the playlist and the programmes from the guide it
 * names, which is what makes the two agree: `tvg-id` **is** the guide's
 * `<channel id>`, so it is used for both `siteId` and `xmltvId` and the two
 * halves line up with nothing written down.
 *
 * `<channel>` elements in the output are built from what the *playlist* said —
 * its name and its `tvg-logo` — rather than from the guide's own element, since
 * the playlist is the thing the caller chose. Pass `channelInfo` to do something
 * else with it; everything the entry carried is in `data`.
 */
export function defineM3uSite<TData = M3uChannelData>(
  options: M3uSiteOptions<TData>,
): StreamSiteConfig<TData> {
  const { url, channels: channelOptions, guide, playlist, ...site } = options;

  /** What `read` is given: the client, and somewhere to say things, if there is one. */
  type Reading = { http: StreamContext['http']; signal?: AbortSignal } & Partial<Says>;

  const load = async (ctx: Reading): Promise<Playlist<TData>> => {
    const response = await ctx.http.get(url, {
      // A public playlist is megabytes; ky's ten seconds is for an API call.
      timeout: false,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });

    let header: M3uHeader = { attributes: new Map() };

    // The header goes by in the same pass that builds the channels — one read of
    // the playlist, and nothing held but the channel list it produces.
    async function* watched(): AsyncGenerator<M3uParseEvent> {
      // `documentBytes` so a `.m3u.gz` works the same as a `.m3u`, by the same
      // sniffing of the bytes that a compressed guide gets — but *always*
      // sniffed, never `compression`: that option names what the **guide** is
      // compressed with, and it exists mainly for brotli, which has no magic
      // number. Forwarding it here would take a caller who said `'brotli'` for a
      // `.xml.br` guide and try to brotli-decode their plain-text playlist.
      for await (const event of parseM3uStream(documentBytes(response, url, undefined), {
        ...playlist,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      })) {
        if (event.type === 'header') {
          header = event.value;
        }

        yield event;
      }
    }

    // How many entries did not become channels, and why. Counted rather than
    // announced one at a time: the default skips every entry with no `tvg-id`,
    // and on iptv-org that is 1,948 of them — a line each would bury the run,
    // and silence would hide a channel list a sixth shorter than its source.
    const skipped = new Map<M3uSkipReason, number>();

    const channels = await channelsFromM3u(watched(), {
      // The playlist's own url, so a relative stream url becomes absolute — the
      // caller can still override it, but never has to supply it.
      base: url,
      ...channelOptions,
      onWarning: (warning) => {
        // A playlist that does not parse cleanly is the caller's business, not
        // this module's to swallow — the same call `defineXmltvSite` makes about
        // a guide's warnings.
        ctx.warn?.(`playlist line ${warning.line}: ${warning.message}`);
        channelOptions?.onWarning?.(warning);
      },
      onSkipped: (entry, reason) => {
        skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
        channelOptions?.onSkipped?.(entry, reason);
      },
    })();

    for (const [reason, count] of skipped) {
      ctx.warn?.(`${count} playlist ${count === 1 ? 'entry' : 'entries'} skipped (${reason})`);
    }

    return { channels: channels as GrabberChannel<TData>[], header };
  };

  /**
   * One read of the playlist, shared.
   *
   * Both the channel pass and the grab need something out of it — the channels
   * and the guide url — and a playlist is megabytes. Not kept on failure, so a
   * dropped connection is retried rather than remembered.
   */
  let reading: Promise<Playlist<TData>> | undefined;

  const read = (ctx: Reading): Promise<Playlist<TData>> => {
    reading ??= load(ctx).catch((error: unknown) => {
      reading = undefined;

      throw error;
    });

    return reading;
  };

  return defineXmltvSite<TData>({
    ...site,
    channels: async (ctx) => (await read(ctx)).channels,
    url: async (ctx) => {
      const { header } = await read(ctx);
      const urls = guideUrlsFromM3u(header, url);

      if (urls.length === 0) {
        throw new Error(
          `The playlist at ${url} names no guide: its #EXTM3U line carries neither x-tvg-url nor url-tvg. ` +
            `Use defineXmltvSite with the guide's url if you know it, or channelsFromM3u if you only want the channel list.`,
        );
      }

      // `urls[0]` and not `at(0)`: the list is non-empty by the check above, and
      // a caller's own picker is trusted to return one of them.
      return guide ? guide(urls, header) : urls[0]!;
    },
  });
}
