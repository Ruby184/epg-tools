import { createReadStream } from 'node:fs';
import { Transform, type TransformCallback } from 'node:stream';
import { XmltvScanner } from './scan.js';
import type { AnyIterable, XmltvDocument, XmltvParseEvent, XmltvParseOptions } from './types.js';

/**
 * What the *streaming* parsers take on top of the scanning: a document being
 * read is as long as the document, so it is the one thing here worth being able
 * to stop. {@link parseXmltvString} has the whole thing in hand already and
 * nothing to interrupt.
 */
export interface ParseStreamOptions extends XmltvParseOptions {
  /**
   * Stop parsing. Checked between chunks, handed to the file read when there is
   * one, and — for {@link XmltvParseStream} — what destroys it.
   */
  signal?: AbortSignal;
}

/**
 * Streaming XMLTV parser: consumes string/byte chunks and yields `meta`,
 * `channel` and `programme` events while buffering at most one incomplete
 * element at a time. All scanning lives in {@link XmltvScanner}; this is
 * just the I/O adapter (byte decoding and carry-over buffering).
 */
export async function* parseXmltvStream(
  source: AnyIterable<string | Uint8Array>,
  options?: ParseStreamOptions,
): AsyncGenerator<XmltvParseEvent> {
  const decoder = new TextDecoder();
  const scanner = new XmltvScanner(options);
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
 * A Node `Transform` that parses a byte/string stream into XMLTV parse events
 * — the readable counterpart to {@link parseXmltvStream}, for use in
 * `stream.pipeline()`:
 *
 * ```ts
 * await pipeline(createReadStream('guide.xml'), new XmltvParseStream(), async (events) => {
 *   for await (const event of events) { ... }
 * });
 * ```
 *
 * The writable side accepts `Buffer`/`Uint8Array`/`string` chunks (bytes may
 * split anywhere, including inside a multi-byte character); the readable side
 * is object-mode and emits {@link XmltvParseEvent} (`meta`, `channel`,
 * `programme` and `warning`). A malformed document that would make the scanner
 * throw surfaces as an `error` on the stream.
 */
export class XmltvParseStream extends Transform {
  readonly #scanner: XmltvScanner;
  readonly #decoder = new TextDecoder();
  #buf = '';

  constructor(options?: ParseStreamOptions) {
    // A stream takes a signal itself: aborting destroys it with an `AbortError`
    // carrying the reason as its cause, which is what the rest of a
    // `pipeline()` around it is waiting to hear.
    super({ readableObjectMode: true, signal: options?.signal });
    this.#scanner = new XmltvScanner(options);
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
}

/**
 * Streaming-parse an XMLTV file from disk. A 512 KiB read buffer (vs Node's
 * 64 KiB file default) keeps effectively every `<programme>` — even one with
 * a huge `<desc>` and a large cast — inside a single chunk, so the scanner's
 * restart-on-`NEED_MORE` model rarely re-parses an element across a boundary.
 */
export async function* parseXmltvFile(
  filePath: string,
  options?: ParseStreamOptions,
): AsyncGenerator<XmltvParseEvent> {
  yield* parseXmltvStream(
    createReadStream(filePath, {
      highWaterMark: 512 * 1024,
      // `fs` closes the descriptor itself on abort, which a generator abandoned
      // part-way through a 16 GiB file would otherwise leave to the collector.
      signal: options?.signal,
    }),
    options,
  );
}

/**
 * Parse a whole XMLTV string into one in-memory document, synchronously —
 * the same call-it-and-get-a-result ergonomic as other XMLTV parsers (e.g.
 * `@iptv/xmltv`'s `parseXmltv`). For guides too large to hold in memory at
 * once, use `parseXmltvStream` instead.
 */
export function parseXmltvString(xml: string, options?: XmltvParseOptions): XmltvDocument {
  const doc: XmltvDocument = { meta: {}, channels: [], programmes: [], warnings: [] };

  for (const event of new XmltvScanner(options).consume(xml, true)) {
    switch (event.type) {
      case 'meta':
        doc.meta = event.value;
        break;
      case 'channel':
        doc.channels.push(event.value);
        break;
      case 'programme':
        doc.programmes.push(event.value);
        break;
      case 'warning':
        doc.warnings.push(event.value);
        break;
    }
  }

  return doc;
}
