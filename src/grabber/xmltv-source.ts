/**
 * A published guide as a source: point at an `xmltv.xml.gz` and grab it.
 *
 * No site config to write, because there is nothing to work out — the format is
 * the one this package already parses, and the only questions are where the
 * document is and which channels of it you want. What it does with that:
 *
 * - **streams** it through the parser rather than reading it in, so a 90 MiB
 *   guide costs what one channel of it costs;
 * - **splits** it by channel-day and writes each one as it becomes complete,
 *   which is what makes those entries mergeable with any other site's;
 * - **discovers** its channels from the head of the document, so a guide is a
 *   source with nothing written down at all;
 * - **asks whether it changed** on later runs, so an unchanged guide is a `304`
 *   rather than a download.
 *
 * Only the first of those is written here. Finding the document, fetching it
 * once for both passes and asking whether it changed are this file's business;
 * reading the bytes, reckoning the days and cutting the document into
 * channel-days live in `xmltv-document.ts`, which knows nothing about where a
 * document came from — which is what lets a playlist's guide and a program's
 * stdout be read the same way.
 */

import type { CompressionFormat } from '../core/output.js';
import { parseXmltvStream } from '../xmltv/main.js';
import type { XmltvChannel, XmltvParseOptions } from '../xmltv/types.js';
import { documentBytes, splitXmltvDocument, type XmltvDayZone } from './xmltv-document.js';
import type {
  ChannelsSource,
  GrabberChannel,
  StreamContext,
  StreamedChannelDay,
  StreamSiteConfig,
} from './types.js';

/**
 * Where the document is: a url, or a call that works it out when first asked.
 *
 * The second form is for a source that has to be read to find out — an M3U
 * playlist naming its guide in `x-tvg-url`, which is what
 * {@link defineM3uSite} is built on. It is handed the site's own HTTP client so
 * that lookup goes out with the site's headers, proxy and retry, and it is
 * called **once**, its answer shared by the channel pass and the grab.
 */
export type XmltvUrlSource =
  | string
  | ((ctx: { http: StreamContext['http']; signal?: AbortSignal }) => string | Promise<string>);

export interface XmltvSiteOptions<TData = XmltvChannel> extends Omit<
  StreamSiteConfig<TData>,
  'stream' | 'channels'
> {
  /** Where the document is, or how to find out. */
  url: XmltvUrlSource;
  /**
   * The channels to take from it, mapping `siteId` (the document's `<channel
   * id>`) to the id you want in the output.
   *
   * Left out, every channel the document declares is taken as itself — its
   * `<channel>` element kept in `data` and written back out unchanged, display
   * names, icons, urls and all. Which is the whole of what makes a published
   * guide a source with nothing written down.
   */
  channels?: ChannelsSource<TData>;
  /** Which day a programme belongs to. Defaults to `source`. */
  dayZone?: XmltvDayZone;
  /**
   * What the document is compressed with.
   *
   * Sniffed by default, which is the only thing that works: `Content-Encoding`
   * says what the origin claimed rather than what the bytes are now — `fetch`
   * decodes gzip, `br` and `zstd` before this ever sees them and leaves the
   * header on — and a `.gz` name is no better, since a server may serve one
   * `Content-Encoding: gzip` and hand over plain XML.
   *
   * Brotli is the exception: it has no magic number, so a brotli document must
   * be named here (or by a `.br` url, or an `application/x-brotli` type).
   */
  compression?: CompressionFormat | false;
  /** Passed to the parser: `timezones` for named zones, `tolerateMissingId`. */
  parse?: XmltvParseOptions;
  /**
   * Whether the document groups each channel's programmes together.
   *
   * `grouped` (the default) writes a channel-day as soon as the document moves
   * on to another channel, so what is held is one channel's worth. A document
   * that turns out to be ordered by time instead is noticed and held from there
   * on — correct either way, and said in the log.
   *
   * `any` starts held, for a source known to be time-ordered: no warning, no
   * second write, and the whole document in memory while it parses.
   */
  order?: 'grouped' | 'any';
}

/** One `<channel>` as a channel to grab, keeping the element for the output. */
function asGrabberChannel(channel: XmltvChannel): GrabberChannel<XmltvChannel> {
  const name = channel.displayName[0]?.value;
  const logo = channel.icon?.[0]?.src;

  return {
    xmltvId: channel.id,
    siteId: channel.id,
    ...(name === undefined ? {} : { name }),
    ...(logo === undefined ? {} : { logo }),
    data: channel,
  };
}

/**
 * A published XMLTV guide as a site.
 *
 * ```ts
 * export default defineConfig({
 *   sites: [defineXmltvSite({ site: 'iptv-org', url: 'https://example.test/guide.xml.gz' })],
 *   output: 'guide.xml',
 * });
 * ```
 */
export function defineXmltvSite<TData = XmltvChannel>(
  options: XmltvSiteOptions<TData>,
): StreamSiteConfig<TData> {
  const {
    url,
    channels,
    dayZone = 'source',
    compression,
    parse,
    order = 'grouped',
    ...site
  } = options;

  /**
   * Where the document is, worked out at most once.
   *
   * Memoized because both passes ask and a lookup can be a whole request of its
   * own — reading an M3U playlist to find its `x-tvg-url`, say. A failure is
   * *not* kept: a lookup that fell over on a dropped connection should be tried
   * again by the next pass rather than poisoning the site for the process.
   */
  let located: Promise<string> | undefined;

  const locate = (http: StreamContext['http'], signal?: AbortSignal): Promise<string> => {
    located ??= Promise.resolve(
      typeof url === 'function' ? url({ http, ...(signal ? { signal } : {}) }) : url,
    ).catch((error: unknown) => {
      located = undefined;

      throw error;
    });

    return located;
  };

  /** One request for the document, the same way for both passes. */
  const fetchDocument = async (
    http: StreamContext['http'],
    signal?: AbortSignal,
  ): Promise<{ response: Response; at: string }> => {
    const at = await locate(http, signal);

    return {
      response: await http.get(at, {
        // A guide is a long download; ky's ten seconds is for an API call.
        timeout: false,
        ...(signal ? { signal } : {}),
      }),
      at,
    };
  };

  return {
    // Both on by default, and both about the same thing: a published guide is
    // one file that changes once a day at most, and asking for it again is the
    // expensive thing this site does.
    cacheChannels: true,
    conditionalGet: true,
    ...site,
    channels:
      channels ??
      (async ({ http, signal }): Promise<GrabberChannel<TData>[]> => {
        // The DTD puts every `<channel>` before the first `<programme>`, so the
        // head of the document is the whole channel list — and stopping there
        // stops the download. Measured on a 200,000-programme guide: 200
        // channels in hand after one 16 KiB chunk.
        const stop = new AbortController();
        const found: GrabberChannel<XmltvChannel>[] = [];

        try {
          const { response, at } = await fetchDocument(
            http,
            signal ? AbortSignal.any([signal, stop.signal]) : stop.signal,
          );

          for await (const event of parseXmltvStream(documentBytes(response, at, compression), {
            ...parse,
            ...(signal ? { signal } : {}),
          })) {
            if (event.type === 'channel') {
              found.push(asGrabberChannel(event.value));
            } else if (event.type === 'programme') {
              break;
            }
          }
        } finally {
          stop.abort();
        }

        return found as GrabberChannel<TData>[];
      }),
    channelInfo:
      site.channelInfo ??
      ((channel, element) => {
        const source = channel.data as XmltvChannel | undefined;

        // What the document said about it, under the id the output uses — every
        // display name, icon and url it carried, rather than the three fields a
        // default element can hold.
        return source !== undefined && typeof source.id === 'string'
          ? { ...source, id: channel.xmltvId }
          : element();
      }),
    async *stream(ctx): AsyncGenerator<StreamedChannelDay<TData>> {
      const { channelDays, http, signal, warn } = ctx;

      // Through the queue, so the site's `rateLimit` spaces this against
      // whatever else it is doing and a slow-down holds it — and only the fetch,
      // since the body goes on arriving while the document is parsed and a slot
      // held for all of that would be a slot held for the whole run.
      const { response, at } = await ctx.paced(({ signal: taskSignal }) =>
        fetchDocument(http, taskSignal ?? signal),
      );

      yield* splitXmltvDocument<TData>(documentBytes(response, at, compression), {
        channelDays,
        warn,
        ...(signal ? { signal } : {}),
        dayZone,
        ...(order === undefined ? {} : { order }),
        ...(parse === undefined ? {} : { parse }),
      });
    },
  };
}
