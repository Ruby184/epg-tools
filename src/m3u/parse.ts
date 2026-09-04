import { createReadStream } from 'node:fs';
import { Transform, type TransformCallback } from 'node:stream';
import { M3uIptvReader } from './iptv.js';
import { M3uScanner } from './scan.js';
import type {
  AnyIterable,
  M3uCharset,
  M3uParseEvent,
  M3uParseOptions,
  M3uPlaylist,
} from './types.js';

/**
 * What the *streaming* parsers take on top of the scanning: a playlist being
 * read is as long as the playlist, so it is the one thing here worth being able
 * to stop. {@link parseM3uString} has the whole thing in hand already and
 * nothing to interrupt.
 */
export interface M3uParseStreamOptions extends M3uParseOptions {
  /**
   * Stop parsing. Checked between chunks, handed to the file read when there is
   * one, and — for {@link M3uParseStream} — what destroys it.
   */
  signal?: AbortSignal;
  /**
   * What the bytes are encoded in. `'utf-8'` by default.
   *
   * This format carries no encoding declaration — neither RFC 8216 nor the IPTV
   * layer says what a playlist is written in — so a provider writing
   * `windows-1251` produces a file that is simply not valid UTF-8, and every
   * channel name comes back as replacement characters. tvheadend takes the
   * charset the same way and for the same reason.
   *
   * An unknown label throws where it is given, rather than falling back to
   * UTF-8 and mangling the playlist quietly.
   *
   * Only for the byte-reading entry points: {@link parseM3uString} is handed
   * text that whoever read it has already decoded.
   */
  charset?: M3uCharset;
}

/**
 * Streaming M3U parser: consumes string/byte chunks and yields `header` and
 * `entry` events while buffering at most one incomplete line at a time. All
 * scanning lives in {@link M3uScanner}; this is just the I/O adapter (byte
 * decoding and carry-over buffering).
 *
 * The reason to have one at all: every other M3U parser takes the whole
 * playlist as a string, and a public IPTV index is megabytes of it. This holds
 * one line and one entry however large the playlist gets.
 */
export async function* parseM3uStream(
  source: AnyIterable<string | Uint8Array>,
  options?: M3uParseStreamOptions,
): AsyncGenerator<M3uParseEvent> {
  const decoder = new TextDecoder(options?.charset);
  // The scanner reads lines; the reader says what they mean. Composed here
  // rather than folded together, so another dialect can supply its own reader.
  const scanner = new M3uScanner(new M3uIptvReader(options), options);
  let buf = '';

  for await (const chunk of source) {
    // Between chunks: a source that carries the signal itself has stopped
    // already, and one that does not stops here.
    options?.signal?.throwIfAborted();

    buf += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    buf = yield* scanner.consume(buf, false);
  }

  yield* scanner.consume(buf + decoder.decode(), true);
}

/**
 * A Node `Transform` that parses a byte/string stream into M3U parse events —
 * the readable counterpart to {@link parseM3uStream}, for use in
 * `stream.pipeline()`:
 *
 * ```ts
 * await pipeline(createReadStream('index.m3u'), new M3uParseStream(), async (events) => {
 *   for await (const event of events) { ... }
 * });
 * ```
 *
 * The writable side accepts `Buffer`/`Uint8Array`/`string` chunks (bytes may
 * split anywhere, including inside a multi-byte character); the readable side
 * is object-mode and emits {@link M3uParseEvent} (`header`, `entry` and
 * `warning`).
 */
export class M3uParseStream extends Transform {
  readonly #scanner: M3uScanner<M3uParseEvent>;
  readonly #decoder: TextDecoder;
  #buf = '';

  constructor(options?: M3uParseStreamOptions) {
    // A stream takes a signal itself: aborting destroys it with an `AbortError`
    // carrying the reason as its cause, which is what the rest of a
    // `pipeline()` around it is waiting to hear.
    super({ readableObjectMode: true, signal: options?.signal });
    // Before the scanner, so an unknown charset throws from the constructor
    // rather than from the middle of a pipeline.
    this.#decoder = new TextDecoder(options?.charset);
    this.#scanner = new M3uScanner(new M3uIptvReader(options), options);
  }

  override _transform(
    chunk: Buffer | Uint8Array | string,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    try {
      this.#buf +=
        typeof chunk === 'string' ? chunk : this.#decoder.decode(chunk, { stream: true });
      this.#pump(false);
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  override _flush(callback: TransformCallback): void {
    try {
      this.#buf += this.#decoder.decode();
      this.#pump(true);
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  #pump(final: boolean): void {
    const events = this.#scanner.consume(this.#buf, final);
    let step = events.next();

    while (!step.done) {
      this.push(step.value);
      step = events.next();
    }

    this.#buf = step.value; // the unconsumed remainder
  }
}

/**
 * Streaming-parse an M3U file from disk.
 *
 * A 512 KiB read buffer, as {@link parseXmltvFile} uses and for a related
 * reason: a playlist line is short but there are a great many of them, and a
 * larger buffer is fewer round trips per thousand entries.
 */
export async function* parseM3uFile(
  filePath: string,
  options?: M3uParseStreamOptions,
): AsyncGenerator<M3uParseEvent> {
  yield* parseM3uStream(
    createReadStream(filePath, {
      highWaterMark: 512 * 1024,
      // `fs` closes the descriptor itself on abort, which a generator abandoned
      // part-way through a large playlist would otherwise leave to the
      // collector.
      signal: options?.signal,
    }),
    options,
  );
}

/**
 * Parse a whole M3U string into one in-memory playlist, synchronously — the
 * same call-it-and-get-a-result ergonomic as other M3U parsers (e.g.
 * `@iptv/playlist`'s `parseM3U`). For playlists too large to hold in memory at
 * once, use {@link parseM3uStream} instead.
 */
export function parseM3uString(text: string, options?: M3uParseOptions): M3uPlaylist {
  // An empty header, so a caller gets the same shape whether or not the
  // playlist carried one.
  const playlist: M3uPlaylist = {
    header: { attributes: new Map() },
    entries: [],
    warnings: [],
  };

  // Ordered by how often a playlist produces each: it is overwhelmingly
  // entries, and the header happens once or not at all.
  for (const event of new M3uScanner(new M3uIptvReader(options), options).consume(text, true)) {
    switch (event.type) {
      case 'entry':
        playlist.entries.push(event.value);
        break;
      case 'header':
        playlist.header = event.value;
        break;
      case 'warning':
        playlist.warnings.push(event.value);
        break;
    }
  }

  return playlist;
}
