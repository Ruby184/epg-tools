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

import { once } from 'node:events';
import { PassThrough, pipeline, Readable } from 'node:stream';
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

/** How many bytes {@link sniff} needs to decide: the longest magic number below. */
const MAGIC_BYTES = 4;

/**
 * Wait for a stream to have more to say, or to have finished saying it.
 *
 * Both, because either can be next and only one of them will come. An empty
 * body emits `readable` first — with nothing to read — and `end` only on the
 * turn after, so waiting on `readable` alone hangs on a document that turned out
 * to be nothing at all.
 *
 * The controller is what takes the loser's listener away; without it a stream
 * that dribbles collects one per chunk. An `error` rejects both, which is how a
 * dying connection reaches the caller rather than stalling it.
 */
async function readableOrEnd(source: Readable): Promise<void> {
  const settled = new AbortController();
  const more = once(source, 'readable', { signal: settled.signal });
  const ended = once(source, 'end', { signal: settled.signal });

  // The loser rejects when the controller fires below; saying so here is what
  // keeps that from being an unhandled rejection.
  more.catch(() => {});
  ended.catch(() => {});

  try {
    await Promise.race([more, ended]);
  } finally {
    settled.abort();
  }
}

/**
 * The first bytes of a stream, put back where they came from.
 *
 * Enough of them to decide on, rather than one chunk of whatever length: a body
 * arrives as the socket gave it, and a dribbling origin or a proxy flushing
 * small frames hands over **one byte** first — measured, not supposed. A magic
 * number read out of that is a gzipped guide reported as "neither text nor a
 * compression this can undo", which is a whole site failed over a chunk boundary.
 *
 * Whatever is there is taken and held, rather than asking for `want` bytes and
 * waiting: `read(want)` on a stream holding fewer returns nothing *and* asks to
 * be told about the same bytes again, so a dribbling body spins — one byte
 * buffered, one byte reported, forever. Consuming empties the buffer, which
 * makes the next `readable` mean what it says.
 *
 * `unshift` then puts the head back and the stream carries on as though nobody
 * had looked, so everything after this is one stream that `pipeline` owns —
 * except for a document that ended inside the window, which is a document held
 * whole and worth handing over as one.
 */
async function peek(source: Readable, want: number): Promise<{ head: Buffer; body: Readable }> {
  const chunks: Buffer[] = [];
  let size = 0;

  while (size < want) {
    const chunk = source.read() as Buffer | null;

    if (chunk === null) {
      if (source.readableEnded) {
        break;
      }

      await readableOrEnd(source);
      continue;
    }

    chunks.push(chunk);
    size += chunk.length;
  }

  const head = Buffer.concat(chunks);

  if (source.readableEnded) {
    // Everything there was, and a stream that has said `end` refuses to take it
    // back. What is held is the whole document, so it is one to hand over.
    return { head, body: Readable.from(head.length > 0 ? [head] : []) };
  }

  if (head.length > 0) {
    source.unshift(head);
  }

  return { head, body: source };
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
    first === 0x3c || // < — an XML document
    first === 0x23 || // # — an M3U playlist, which opens #EXTM3U
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
    `The document at ${options.url} is neither text nor a compression this can undo ` +
      `(it starts ${[...head.subarray(0, 4)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join(' ')}). If it is brotli, say so with compression: 'brotli'.`,
  );
}

/**
 * The document's stream, and what it turned out to be compressed with.
 *
 * Both come from the same look at its first bytes, which is why they are
 * answered together — and why a document nobody can make sense of is let go of
 * here. Nothing has been piped yet at that point, so nothing else would: the
 * response would sit holding a socket until undici noticed that nobody was ever
 * going to read it.
 */
async function opened(
  response: Response,
  url: string,
  compression: CompressionFormat | false | undefined,
): Promise<{ body: Readable; format: CompressionFormat | undefined }> {
  // A response with no body at all — a `204`, a `HEAD` — is a document of no
  // bytes rather than a special case: it peeks as empty, sniffs as nothing in
  // particular, and pipes through to no programmes.
  const source = response.body === null ? Readable.from([]) : Readable.fromWeb(response.body);

  try {
    const { head, body } = await peek(source, MAGIC_BYTES);

    return {
      body,
      format:
        compression === undefined
          ? sniff(head, {
              url,
              contentType: response.headers.get('content-type'),
              contentEncoding: response.headers.get('content-encoding'),
            })
          : compression === false
            ? undefined
            : compression,
    };
  } catch (error) {
    source.destroy();

    throw error;
  }
}

/** The document's bytes, decompressed, however it arrives. */
export async function* documentBytes(
  response: Response,
  url: string,
  compression: CompressionFormat | false | undefined,
): AsyncGenerator<Buffer> {
  const { body, format } = await opened(response, url, compression);

  // Through a `pipeline` into a stream of its own, rather than `compose` or
  // `.pipe`: those two each drop an error in one direction — a truncated member
  // goes unhandled through `compose`, a dying connection through `.pipe` — and a
  // stream that ends quietly instead of throwing is read as a complete document,
  // which would cache "nothing on" for every channel-day past the break.
  //
  // The callback form, because it hands back the stream it was given and there
  // is nothing here to await. Its callback does nothing on purpose and cannot be
  // left out — `pipeline` refuses to run without one — since a failure destroys
  // every stream in the chain, so it arrives where the document is read.
  const out =
    format === undefined
      ? pipeline(body, new PassThrough(), () => {})
      : pipeline(body, decompressor(format), new PassThrough(), () => {});

  yield* out;
}

/**
 * The day a programme falls on, however this site reckons days.
 *
 * Exported because a second source adapter wants the same reckoning and a
 * second copy of it would be a second answer — see `defineXtreamSite`, whose
 * listings carry an offset derived from the panel rather than read from a
 * document.
 */
export function dayOf(start: XmltvProgramme['start'], zone: XmltvDayZone): string {
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
      // What was asked for, and who to hand it back as. A source channel may map
      // to more than one output channel — the same feed under two ids — so this
      // is a list.
      const wanted = new Map<string, GrabberChannel<TData>[]>();
      const planned = new Set<string>();

      for (const { channel, day } of channelDays) {
        planned.add(`${channel.xmltvId}|${day}`);

        const under = wanted.get(channel.siteId);

        if (under === undefined) {
          wanted.set(channel.siteId, [channel]);
        } else if (!under.includes(channel)) {
          // Once, not once per day of it: the same channel arrives here for every
          // day of its window.
          under.push(channel);
        }
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
        const channels = wanted.get(siteId) ?? [];

        open.delete(siteId);
        flushed.add(siteId);

        for (const [day, programmes] of days ?? []) {
          for (const channel of channels) {
            // Only what this channel was asked about. A day is kept as soon as
            // *any* channel sharing the source id wanted it, and two ids on one
            // feed need not have the same days stale — so the ones that did not
            // are dropped here rather than handed over to be ignored.
            if (planned.has(`${channel.xmltvId}|${day}`)) {
              yield { channel, day, programmes };
            }
          }
        }
      }

      const { response, at } = await fetchDocument(http, signal);

      for await (const event of parseXmltvStream(documentBytes(response, at, compression), {
        ...parse,
        ...(signal ? { signal } : {}),
      })) {
        if (event.type === 'warning') {
          // `warn`, not `log`: a document that does not parse cleanly is a
          // signal about the source rather than progress, so it is still said
          // when the run has been asked for errors only.
          warn(`${event.value.code} at line ${event.value.line}: ${event.value.message}`);
          continue;
        }

        if (event.type !== 'programme') {
          continue;
        }

        const programme = event.value;
        const siteId = programme.channel;
        const channels = wanted.get(siteId);

        // Before the ordering below, not after it: a channel nobody asked for
        // must not take part in deciding whether the document is grouped. It
        // used to, and `a … x … a` — a wanted channel split by an unwanted one —
        // made the pass give up and hold the *whole rest of the document* in
        // memory, when dropping `x` leaves `a` one contiguous run needing
        // neither a hold nor a second write. Memory being the point of this
        // adapter, that was the expensive way round.
        if (channels === undefined) {
          continue;
        }

        if (!holding && siteId !== current) {
          if (flushed.has(siteId)) {
            // The document has come back to a channel it had finished with, so
            // it is not grouped after all. Holding everything from here is what
            // keeps the rest correct; what was already written is added to
            // rather than replaced.
            holding = true;
            warn(
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

        const bucket = days.get(day);

        // Pushed, not rebuilt. `[...previous, programme]` is quadratic in a day's
        // length, which at a couple of hundred programmes a day is a few percent
        // of a grab and lost in the parse — but it grows with the one number a
        // dense channel makes large, on the innermost line of the split, for
        // nothing.
        if (bucket === undefined) {
          days.set(day, [programme]);
        } else {
          bucket.push(programme);
        }
      }

      for (const siteId of [...open.keys()]) {
        yield* release(siteId);
      }
    },
  };
}
