/**
 * An XMLTV document, read: its bytes, its days, and its channel-days.
 *
 * Three things every source that *is* a document needs and none of which are
 * about where the document came from — which is the point of them being here.
 * A published guide arrives over HTTP, a playlist's guide arrives the same way,
 * and a program's arrives on its stdout; all three want the bytes sniffed and
 * decompressed, the days reckoned the same way, and the document cut into
 * channel-days as it streams past.
 *
 * {@link splitXmltvDocument} is the largest of them and the one with the
 * measured reasons in it. Read those comments before changing the order of
 * anything in it: two of them are there because the obvious arrangement held a
 * whole document in memory, and one because the obvious arrangement was
 * quadratic in a channel's busiest day.
 */

import { PassThrough, pipeline } from 'node:stream';
import { toDayString } from '../core/days.js';
import { compressionFromName, decompressor, type CompressionFormat } from '../core/output.js';
import { getXmltvOffset, parseXmltvStream, xmltvZoneOffset } from '../xmltv/main.js';
import type { XmltvParseOptions, XmltvProgramme } from '../xmltv/types.js';
import type { Says } from '../core/events.js';
import type { ChannelDay, GrabberChannel, StreamedChannelDay } from './types.js';

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

/** How many bytes {@link sniff} needs to decide: the longest magic number below. */
const MAGIC_BYTES = 4;

/**
 * The first bytes of a stream, put back where they came from.
 *
 * Enough of them to decide on, rather than one chunk of whatever length: a body
 * arrives as the socket gave it, and a dribbling origin or a proxy flushing
 * small frames hands over **one byte** first — measured, not supposed. A magic
 * number read out of that is a gzipped guide reported as "neither text nor a
 * compression this can undo", which is a whole site failed over a chunk
 * boundary. A document that ends inside the window is simply a short head.
 *
 * Over a **web stream**, which is what makes this twenty lines rather than the
 * seventy-five it was: `read()` returning `null`, racing `readable` against
 * `end`, `unshift` and `readableEnded` are all Node-stream problems that a
 * reader does not have. It is also what a `fetch` body already is, so the
 * commonest source is not converted to be looked at — and a child's stdout
 * becomes one with `Readable.toWeb`.
 */
async function peek(
  source: ReadableStream<Uint8Array>,
  want: number,
): Promise<{ head: Buffer; body: ReadableStream<Uint8Array> }> {
  const reader = source.getReader();
  const held: Uint8Array[] = [];
  let size = 0;

  while (size < want) {
    const next = await reader.read();

    if (next.done) {
      break;
    }

    held.push(next.value);
    size += next.value.length;
  }

  return {
    head: Buffer.concat(held),
    // What was taken, in front of whatever is left, so everything downstream
    // sees one stream that nobody looked at. `cancel` is why this is a stream
    // of its own rather than a generator: a consumer that stops early — the
    // channel pass, which stops at the first `<programme>` — reaches the reader
    // underneath through it, and without that a body would be left holding a
    // socket and a child would be left running.
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of held) {
          controller.enqueue(chunk);
        }
      },
      async pull(controller) {
        const next = await reader.read();

        if (next.done) {
          controller.close();

          return;
        }

        controller.enqueue(next.value);
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    }),
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
async function sniffed(
  source: ReadableStream<Uint8Array>,
  options: {
    name: string;
    compression: CompressionFormat | false | undefined;
    contentType?: string | null;
    contentEncoding?: string | null;
  },
): Promise<{ body: ReadableStream<Uint8Array>; format: CompressionFormat | undefined }> {
  const { name, compression } = options;
  const { head, body } = await peek(source, MAGIC_BYTES);

  try {
    return {
      body,
      format:
        compression === undefined
          ? sniff(head, {
              url: name,
              contentType: options.contentType ?? null,
              contentEncoding: options.contentEncoding ?? null,
            })
          : compression === false
            ? undefined
            : compression,
    };
  } catch (error) {
    // Nothing has been piped yet, so nothing else would let go of the source: a
    // response would sit holding a socket until undici noticed that nobody was
    // ever going to read it. Through `body` rather than the source, which
    // `peek`'s reader holds locked — cancelling a locked stream throws, and the
    // thrown lock error would be what reached the caller instead of the reason
    // the document was refused.
    await body.cancel();

    throw error;
  }
}

/**
 * A stream's bytes, decompressed, however they arrive.
 *
 * Where the bytes come from is not this function's business: a response body, a
 * child process's stdout, a file. `name` is only ever used to say what could
 * not be made sense of, and the two header values are what a response knows
 * about itself and a pipe does not.
 */
export async function* streamBytes(
  source: ReadableStream<Uint8Array>,
  options: {
    /** What to call it in an error — a url, a command line. */
    name: string;
    compression: CompressionFormat | false | undefined;
    contentType?: string | null;
    contentEncoding?: string | null;
  },
): AsyncGenerator<Buffer> {
  const { body, format } = await sniffed(source, options);

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

/** The same for a response, which is where two of the three sources get theirs. */
export function documentBytes(
  response: Response,
  url: string,
  compression: CompressionFormat | false | undefined,
): AsyncGenerator<Buffer> {
  // A response with no body at all — a `204`, a `HEAD` — is a document of no
  // bytes rather than a special case: it peeks as empty, sniffs as nothing in
  // particular, and pipes through to no programmes.
  return streamBytes(response.body ?? ReadableStream.from([]), {
    name: url,
    compression,
    contentType: response.headers.get('content-type'),
    contentEncoding: response.headers.get('content-encoding'),
  });
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

/** What {@link splitXmltvDocument} needs beyond the document itself. */
export interface SplitXmltvOptions<TData> {
  /** The channel-days this pass is for — what is kept, and who it is handed to. */
  channelDays: readonly ChannelDay<TData>[];
  /** Where a parse warning and an ungrouped document are reported. */
  warn: Says['warn'];
  signal?: AbortSignal;
  /** Which day a programme belongs to. Defaults to `source`. */
  dayZone?: XmltvDayZone;
  /** Whether the document groups each channel's programmes together. */
  order?: 'grouped' | 'any';
  /** Passed to the parser: `timezones` for named zones, `tolerateMissingId`. */
  parse?: XmltvParseOptions;
}

export async function* splitXmltvDocument<TData>(
  document: AsyncIterable<Buffer | string>,
  options: SplitXmltvOptions<TData>,
): AsyncGenerator<StreamedChannelDay<TData>> {
  const { channelDays, warn, signal, dayZone = 'source', order, parse } = options;
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

  for await (const event of parseXmltvStream(document, {
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
}
