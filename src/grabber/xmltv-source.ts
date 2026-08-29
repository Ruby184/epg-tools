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
 */

import { PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { toDayString } from '../core/days.js';
import { compressionFromName, decompressor, type CompressionFormat } from '../core/output.js';
import { getXmltvOffset, parseXmltvStream, xmltvZoneOffset } from '../xmltv/main.js';
import type { XmltvChannel, XmltvParseOptions, XmltvProgramme } from '../xmltv/types.js';
import type {
  ChannelsSource,
  GrabberChannel,
  StreamContext,
  StreamedChannelDay,
  StreamSiteConfig,
} from './types.js';

/**
 * Which day a programme belongs to.
 *
 * - `source` — the day it falls on in the offset the document wrote it with,
 *   which is the day the broadcaster means and what a hand-written site's
 *   `parseDay` would file it under.
 * - `utc` — the day of its UTC instant, which is literally what a cache key
 *   says. A guide written in `+0200` then files its small hours a day early.
 * - an IANA zone (`Europe/Bratislava`) — the day it falls on there, for a source
 *   that writes everything in UTC but means a local schedule.
 */
export type XmltvDayZone = 'source' | 'utc' | (string & {});

export interface XmltvSiteOptions<TData = XmltvChannel> extends Omit<
  StreamSiteConfig<TData>,
  'stream' | 'channels'
> {
  /** Where the document is. */
  url: string;
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

/** The first chunk of a stream, and the stream with it put back. */
async function peek(source: Readable): Promise<{ head: Buffer; body: Readable }> {
  const reader = source[Symbol.asyncIterator]();
  const first = await reader.next();
  const head = first.done === true ? Buffer.alloc(0) : Buffer.from(first.value as Uint8Array);

  return {
    head,
    body: Readable.from(
      (async function* () {
        try {
          if (head.length > 0) {
            yield head;
          }

          while (true) {
            const next = await reader.next();

            if (next.done === true) {
              return;
            }

            yield next.value;
          }
        } finally {
          // A consumer that stopped early — channel discovery does, at the first
          // programme — lets go of the response here rather than leaving it to
          // the collector.
          await reader.return?.();
        }
      })(),
    ),
  };
}

const MAGIC: Array<{ format: CompressionFormat; bytes: number[] }> = [
  { format: 'gzip', bytes: [0x1f, 0x8b] },
  { format: 'zstd', bytes: [0x28, 0xb5, 0x2f, 0xfd] },
];

/** Whether these bytes are the start of something that could be XML. */
function looksLikeText(head: Buffer): boolean {
  const first = head[0];

  return (
    head.length === 0 ||
    first === 0x3c || // <
    first === 0xef || // a UTF-8 BOM
    first === 0x20 ||
    first === 0x09 ||
    first === 0x0a ||
    first === 0x0d
  );
}

/**
 * What the body is compressed with, from the body itself.
 *
 * The bytes are the only thing that is true here. `Content-Encoding` survives on
 * a response `fetch` has already decoded, so its presence says nothing; and it
 * is not decoded for a coding undici does not know, so its absence says nothing
 * either. `Content-Type: application/gzip` is set by servers that then hand over
 * plain XML. A magic number is a fact.
 *
 * Brotli has none, so it is the one case left to the name — and to
 * `Content-Encoding` in the negative: if the response says it was brotli, `fetch`
 * has already undone it, and bytes that are still unreadable are not brotli but
 * something to complain about.
 */
function sniff(
  head: Buffer,
  options: { url: string; contentType: string | null; contentEncoding: string | null },
): CompressionFormat | undefined {
  for (const { format, bytes } of MAGIC) {
    if (bytes.every((byte, index) => head[index] === byte)) {
      return format;
    }
  }

  if (looksLikeText(head)) {
    return undefined;
  }

  const named =
    compressionFromName(new URL(options.url, 'http://example.invalid').pathname) ??
    (options.contentType?.includes('brotli') === true ? 'brotli' : undefined);

  if (named === 'brotli' && options.contentEncoding?.includes('br') !== true) {
    return 'brotli';
  }

  throw new TypeError(
    `The document at ${options.url} is neither XML nor anything recognizable ` +
      `(it starts ${[...head.subarray(0, 4)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join(' ')}). If it is brotli, say so with compression: 'brotli'.`,
  );
}

/** The document's bytes, decompressed, however it arrives. */
async function* documentBytes(
  response: Response,
  url: string,
  compression: CompressionFormat | false | undefined,
): AsyncGenerator<Buffer> {
  if (response.body === null) {
    return;
  }

  const { head, body } = await peek(Readable.fromWeb(response.body));
  const format =
    compression === undefined
      ? sniff(head, {
          url,
          contentType: response.headers.get('content-type'),
          contentEncoding: response.headers.get('content-encoding'),
        })
      : compression === false
        ? undefined
        : compression;

  // Through a `pipeline` into a stream of its own, rather than `compose` or
  // `.pipe`: those two each drop an error in one direction — a truncated member
  // goes unhandled through `compose`, a dying connection through `.pipe` — and a
  // stream that ends quietly instead of throwing is read as a complete document,
  // which would cache "nothing on" for every channel-day past the break.
  const out = new PassThrough();
  const chain =
    format === undefined ? pipeline(body, out) : pipeline(body, decompressor(format), out);

  // The pipeline's failure destroys `out`, which is what makes the iteration
  // below reject rather than end.
  void chain.catch(() => {});

  yield* out;
}

/** The day a programme falls on, however this site reckons days. */
function dayOf(start: XmltvProgramme['start'], zone: XmltvDayZone): string {
  if (zone === 'utc') {
    return toDayString(start);
  }

  const offset = zone === 'source' ? getXmltvOffset(start) : xmltvZoneOffset(zone, start);

  return toDayString(new Date(start.getTime() + offset * 60_000));
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

  /** One request for the document, the same way for both passes. */
  const fetchDocument = async (
    http: StreamContext['http'],
    signal?: AbortSignal,
  ): Promise<Response> =>
    http.get(url, {
      // A guide is a long download; ky's ten seconds is for an API call.
      timeout: false,
      ...(signal ? { signal } : {}),
    });

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
          const response = await fetchDocument(
            http,
            signal ? AbortSignal.any([signal, stop.signal]) : stop.signal,
          );

          for await (const event of parseXmltvStream(documentBytes(response, url, compression), {
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
      const { channelDays, http, log, signal } = ctx;
      // What was asked for, and who to hand it back as. A source channel may map
      // to more than one output channel — the same feed under two ids — so this
      // is a list.
      const wanted = new Map<string, GrabberChannel<TData>[]>();
      const planned = new Set<string>();

      for (const { channel, day } of channelDays) {
        planned.add(`${channel.xmltvId}|${day}`);
        wanted.set(channel.siteId, [
          ...(wanted.get(channel.siteId) ?? []).filter((one) => one !== channel),
          channel,
        ]);
      }

      /** Programmes waiting to be handed over, by source channel and day. */
      const open = new Map<string, Map<string, XmltvProgramme[]>>();
      const flushed = new Set<string>();
      let holding = order === 'any';
      let current: string | undefined;

      /** Everything held for one source channel, as channel-days. */
      function* release(siteId: string | undefined): Generator<StreamedChannelDay<TData>> {
        if (siteId === undefined) {
          return;
        }

        const days = open.get(siteId);

        open.delete(siteId);
        flushed.add(siteId);

        for (const [day, programmes] of days ?? []) {
          for (const channel of wanted.get(siteId) ?? []) {
            yield { channel, day, programmes };
          }
        }
      }

      const response = await fetchDocument(http, signal);

      for await (const event of parseXmltvStream(documentBytes(response, url, compression), {
        ...parse,
        ...(signal ? { signal } : {}),
      })) {
        if (event.type === 'warning') {
          log(`${event.value.code} at line ${event.value.line}: ${event.value.message}`);
          continue;
        }

        if (event.type !== 'programme') {
          continue;
        }

        const programme = event.value;
        const siteId = programme.channel;

        if (!holding && siteId !== current) {
          if (flushed.has(siteId)) {
            // The document has come back to a channel it had finished with, so
            // it is not grouped after all. Holding everything from here is what
            // keeps the rest correct; what was already written is added to
            // rather than replaced.
            holding = true;
            log(
              `this document is not grouped by channel (${siteId} appears again), ` +
                `so the rest of it is held until the end`,
            );
          } else {
            yield* release(current);
            current = siteId;
          }
        } else if (current === undefined) {
          current = siteId;
        }

        const channels = wanted.get(siteId);

        if (channels === undefined) {
          continue;
        }

        const day = dayOf(programme.start, dayZone);

        // Only what was asked for is kept: a channel-day outside the window, or
        // one already fresh in the cache, is dropped here rather than held and
        // handed over to be ignored.
        if (!channels.some((channel) => planned.has(`${channel.xmltvId}|${day}`))) {
          continue;
        }

        let days = open.get(siteId);

        if (days === undefined) {
          days = new Map();
          open.set(siteId, days);
        }

        days.set(day, [...(days.get(day) ?? []), programme]);
      }

      for (const siteId of [...open.keys()]) {
        yield* release(siteId);
      }
    },
  } as StreamSiteConfig<TData>;
}
