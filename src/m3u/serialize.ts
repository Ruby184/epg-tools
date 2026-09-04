import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { getDefaultHighWaterMark, Readable, Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { AnyIterable, M3uEntry, M3uHeader, M3uParseEvent, M3uWarning } from './types.js';

/** Options shared by every serialize entry point. */
export interface M3uSerializeOptions {
  /**
   * What ends a line. Defaults to `'\n'`.
   *
   * `'\r\n'` because a great deal of what consumes these playlists is a set-top
   * box or a Windows player, and the playlists they are used to — iptv-org's
   * among them — are CRLF throughout. The parser reads either without being
   * told, so this only decides what is written.
   */
  eol?: '\n' | '\r\n';
  /**
   * `writeM3uStream` accumulates serialized entries until roughly this many
   * characters before yielding a chunk (one yield per batch, not per entry),
   * since a generator has no buffer of its own. {@link M3uSerializeStream}
   * pushes each entry and lets its readable buffer coalesce them, so there this
   * is simply the readable `highWaterMark`. Ignored by the per-entry
   * {@link serializeM3uEntry}. Defaults to Node's stream `highWaterMark`
   * (16 KiB before Node 22, 64 KiB since).
   */
  highWaterMark?: number;
}

/**
 * What the *streaming* writer takes on top of the formatting: a playlist being
 * written is as long as the playlist, so it is the one thing here worth being
 * able to stop.
 */
export interface M3uWriteOptions extends M3uSerializeOptions {
  /**
   * Stop writing. Checked between entries — the granularity a playlist has —
   * and passed to the file write when there is one, so a partly written file is
   * closed rather than left open behind an abandoned promise.
   */
  signal?: AbortSignal;
}

export interface M3uSerializeStreamOptions extends M3uWriteOptions {
  /**
   * Header attributes that take **preference** over a `header` event on the
   * stream: the event supplies base attributes (the original ones, when
   * re-serializing a parsed playlist) and these override or add to them
   * name-by-name — set `x-tvg-url` here to point a passed-through playlist at a
   * different guide while keeping everything else it carried.
   */
  header?: M3uHeader;
}

/** What {@link writeM3uStream} writes: the header, then every entry. */
export interface M3uStreamInput {
  header?: M3uHeader;
  entries: AnyIterable<M3uEntry>;
}

/** See {@link M3uSerializeOptions.highWaterMark}. */
const DEFAULT_HIGH_WATER_MARK = getDefaultHighWaterMark(false);

/**
 * Ends a line, and so cannot appear inside one. This format has no escape for
 * anything, so a value carrying one of these has no representation at all.
 */
function breaksLine(value: string): boolean {
  // Two `includes` rather than a `/[\r\n]/` — both scan natively, and this is
  // measurably the quicker of the two across the ~66,000 checks a real playlist
  // needs. (A hand-rolled charcode loop is 2× *slower* than either: string
  // search is optimized in a way a per-character loop in JavaScript is not.)
  return value.includes('\n') || value.includes('\r');
}

/**
 * Would not come back out as the name it went in as: an attribute name is
 * terminated by whitespace or `=`, a `"` would open a value early, and a comma
 * would end the whole attribute list and begin the channel's display name.
 */
const BAD_ATTRIBUTE_NAME = /^$|[\s="',]/;

/**
 * ` key="value"` for each attribute, in the order the record holds them, each
 * with the space that separates it from what came before.
 *
 * Always quoted, even for a value that arrived unquoted. A quoted value is what
 * every reader of this format expects and the only form that survives a space,
 * so what round-trips here is the *model* rather than the bytes — parse,
 * serialize, parse again, and the entries are identical, which is the property
 * worth having.
 *
 * Anything that could not be read back as what it was is refused rather than
 * written, as {@link serializeProcessingInstruction} refuses a `?>`: a value
 * holding a double quote has no escape available (RFC 8216 §4.2 gives quoted
 * strings none), and writing one regardless produces a line that parses as
 * something else entirely.
 */
function attributes(record: Map<string, string>, on: string): string {
  let out = '';

  // Destructured straight off the Map's iterator, which measured as quick as
  // `keys()` plus a `get()` per attribute and reads better. Both are well
  // ahead of the `Object.keys`/`Object.entries` walk a record needed.
  for (const [name, value] of record) {
    if (BAD_ATTRIBUTE_NAME.test(name)) {
      throw new TypeError(
        `Invalid M3U attribute name ${JSON.stringify(name)} on ${on}: must be non-empty and free of whitespace and ="',`,
      );
    }

    if (value.includes('"')) {
      throw new TypeError(
        `Invalid M3U attribute ${name} on ${on}: a value cannot contain a double quote, and this format has no way to escape one`,
      );
    }

    if (breaksLine(value)) {
      throw new TypeError(
        `Invalid M3U attribute ${name} on ${on}: a value cannot contain a line break`,
      );
    }

    out += ` ${name}="${value}"`;
  }

  return out;
}

/** The `#EXTM3U` line, with whatever the header carries. */
export function serializeM3uHeader(header?: M3uHeader, options?: M3uSerializeOptions): string {
  return `#EXTM3U${header ? attributes(header.attributes, 'the #EXTM3U line') : ''}${options?.eol ?? '\n'}`;
}

/**
 * One entry: its `#EXTINF` line, whatever directives came with it, and its url.
 *
 * Newline-terminated, because an entry is at least two lines and a caller
 * joining them itself would have to know that.
 */
export function serializeM3uEntry(entry: M3uEntry, options?: M3uSerializeOptions): string {
  if (!Number.isFinite(entry.duration)) {
    throw new TypeError(
      `Invalid M3U duration ${JSON.stringify(entry.duration)} for ${JSON.stringify(entry.name)}: must be a number, and -1 where it is not known`,
    );
  }

  if (breaksLine(entry.name)) {
    throw new TypeError(
      `Invalid M3U name ${JSON.stringify(entry.name)}: a name runs to the end of its line and so cannot contain a line break`,
    );
  }

  if (breaksLine(entry.url)) {
    throw new TypeError(
      `Invalid M3U url ${JSON.stringify(entry.url)}: a url is a line of its own and so cannot contain a line break`,
    );
  }

  // A url is read back as "the line that does not begin with #", and a blank
  // line is skipped outright. So one that starts with `#`, or that is nothing
  // but whitespace, would come back as a directive or as no url at all — the
  // entry silently turning up incomplete on the far side of a round trip. An
  // empty url is the one allowed case: it is what an `incomplete-entry` already
  // holds, and it writes and reads back as exactly that.
  if (entry.url !== '' && (entry.url.trim() === '' || entry.url.trimStart().startsWith('#'))) {
    throw new TypeError(
      `Invalid M3U url ${JSON.stringify(entry.url)} for ${JSON.stringify(entry.name)}: a url line cannot begin with # or be only whitespace, since neither reads back as a url`,
    );
  }

  const eol = options?.eol ?? '\n';

  // Concatenated rather than pushed into an array and joined, which is the
  // obvious shape and measured 2.4× slower: V8 builds a string from `+=` far
  // more cheaply than from `Array#join`, and this runs once per entry. One
  // `join` or two made no difference — it is the array itself that costs.
  //
  // The attributes bring their own separating spaces; the name needs none,
  // since the comma that ends the attribute list is what introduces it.
  let out = `#EXTINF:${entry.duration}`;

  out += attributes(entry.attributes, `the entry ${JSON.stringify(entry.name)}`);
  out += `,${entry.name}${eol}`;

  for (const directive of entry.directives ?? []) {
    if (breaksLine(directive.name) || breaksLine(directive.value)) {
      throw new TypeError(
        `Invalid M3U directive #${directive.name}: a directive is one line and so cannot contain a line break`,
      );
    }

    out += `#${directive.name}:${directive.value}${eol}`;
  }

  // Terminated, not separated: an entry is a whole number of lines, so the url
  // gets an `eol` of its own rather than the caller having to add one.
  return `${out}${entry.url}${eol}`;
}

/**
 * Stream a whole playlist as string chunks (~`highWaterMark` each, default
 * Node's stream default): the header, then every entry. Never accumulates the
 * playlist.
 */
export async function* writeM3uStream(
  input: M3uStreamInput,
  options?: M3uWriteOptions,
): AsyncGenerator<string> {
  const highWaterMark = options?.highWaterMark ?? DEFAULT_HIGH_WATER_MARK;
  let pending = serializeM3uHeader(input.header, options);

  for await (const entry of input.entries) {
    // Between entries, which is as often as a playlist gives the chance.
    options?.signal?.throwIfAborted();

    pending += serializeM3uEntry(entry, options);

    if (pending.length >= highWaterMark) {
      yield pending;
      pending = '';
    }
  }

  if (pending) {
    yield pending;
  }
}

/** Stream a playlist to a file (parent directories are created). */
export async function writeM3uToFile(
  filePath: string,
  input: M3uStreamInput,
  options?: M3uWriteOptions,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await pipeline(Readable.from(writeM3uStream(input, options)), createWriteStream(filePath), {
    signal: options?.signal,
  });
}

/**
 * A Node `Transform` that serializes an object stream of tagged
 * `{ type, value }` events into M3U string chunks — the writable counterpart
 * to {@link M3uParseStream}, consuming exactly the events it emits, so a
 * `parse → serialize` pipeline round-trips:
 *
 * ```ts
 * await pipeline(createReadStream('in.m3u'), new M3uParseStream(), new M3uSerializeStream(), out);
 * ```
 *
 * A `header` event supplies base attributes, the constructor's `header` option
 * overriding them; `entry` events are serialized. A `warning` event has no
 * place in the output, so it is re-emitted as a `'warning'` event on this
 * stream carrying the {@link M3uWarning} (`stream.on('warning', …)`), exactly
 * as {@link XmltvSerializeStream} does.
 *
 * The `#EXTM3U` line is written before the first entry and, for a playlist with
 * no entries at all, on flush — RFC 8216 has it first or not at all, so a
 * `header` event arriving after an entry is too late to use and errors the
 * stream. A playlist parsed without one still gets one written, which is the
 * repair the `missing-header` warning told the caller was needed.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
// Merged into the class below on purpose: it is how a stream's `on`/`once`
// overloads get typed for the 'warning' event without redeclaring the class.
// oxlint-disable-next-line typescript/no-unsafe-declaration-merging
export interface M3uSerializeStream {
  /** A non-fatal problem forwarded from a piped parse stream. */
  on(event: 'warning', listener: (warning: M3uWarning) => void): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this;
  once(event: 'warning', listener: (warning: M3uWarning) => void): this;
  once(event: string | symbol, listener: (...args: any[]) => void): this;
  addListener(event: 'warning', listener: (warning: M3uWarning) => void): this;
  addListener(event: string | symbol, listener: (...args: any[]) => void): this;
  removeListener(event: 'warning', listener: (warning: M3uWarning) => void): this;
  removeListener(event: string | symbol, listener: (...args: any[]) => void): this;
  off(event: 'warning', listener: (warning: M3uWarning) => void): this;
  off(event: string | symbol, listener: (...args: any[]) => void): this;
  emit(event: 'warning', warning: M3uWarning): boolean;
  emit(event: string | symbol, ...args: any[]): boolean;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export class M3uSerializeStream extends Transform {
  readonly #options: M3uSerializeStreamOptions | undefined;
  /** Base attributes accumulated from `header` events (the option wins). */
  #eventHeader: M3uHeader | undefined;
  #started = false;

  constructor(options?: M3uSerializeStreamOptions) {
    // The signal goes to the stream itself: aborting destroys it with an
    // `AbortError` carrying the reason as its cause, which is what the rest of
    // a `pipeline()` around it is waiting to hear.
    super({
      writableObjectMode: true,
      readableHighWaterMark: options?.highWaterMark ?? DEFAULT_HIGH_WATER_MARK,
      signal: options?.signal,
    });

    this.#options = options;
  }

  override _transform(
    event: M3uParseEvent,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    try {
      switch (event.type) {
        case 'header':
          if (this.#started) {
            throw new Error('M3uSerializeStream: an #EXTM3U header must precede the first entry');
          }

          this.#eventHeader = {
            attributes: new Map([
              ...(this.#eventHeader?.attributes ?? []),
              ...event.value.attributes,
            ]),
          };

          return callback();
        case 'entry':
          return callback(null, this.#prelude() + serializeM3uEntry(event.value, this.#options));
        case 'warning':
          this.emit('warning', event.value);

          return callback();
        default:
          throw new Error(
            `M3uSerializeStream: unexpected event type ${JSON.stringify((event as { type?: unknown }).type)}`,
          );
      }
    } catch (error) {
      callback(error as Error);
    }
  }

  override _flush(callback: TransformCallback): void {
    try {
      // Covers the playlist that had no entries: the one line every playlist
      // must have is written even so. Nothing is pushed when the header has
      // already gone out — `push('')` on a stream not in object mode is a
      // documented special case rather than a no-op, and there is no reason to
      // find out which one.
      const prelude = this.#prelude();

      callback(null, prelude === '' ? undefined : prelude);
    } catch (error) {
      callback(error as Error);
    }
  }

  /** The `#EXTM3U` line, emitted lazily before the first entry. */
  #prelude(): string {
    if (this.#started) {
      return '';
    }

    this.#started = true;

    // Event attributes are the base; the constructor's `header` overrides them.
    return serializeM3uHeader(
      {
        attributes: new Map([
          ...(this.#eventHeader?.attributes ?? []),
          ...(this.#options?.header?.attributes ?? []),
        ]),
      },
      this.#options,
    );
  }
}
