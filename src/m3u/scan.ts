/**
 * The M3U line scanner: bytes of playlist in, tags and urls out.
 *
 * Deliberately knows nothing about what a playlist *means*. RFC 8216 §4.1 is
 * the whole of its brief — "each line is a URI, is blank, or starts with the
 * character '#'" — so this splits lines, drops the carriage return a CRLF
 * playlist carries, skips the blank ones, and hands each remaining line to a
 * {@link M3uTokens} handler as either a tag or a url. Which of them opens a
 * channel, which describes the one above it, and which govern the whole
 * document are questions for whoever implements that handler: `M3uIptvReader`
 * answers them the way the IPTV world does, and an HLS reader would answer
 * differently.
 *
 * Shaped like {@link XmltvScanner} in the way that matters — `consume` yields
 * what it finished and **returns what it could not**, so a caller feeding it
 * arbitrary chunks hands the remainder back next time and never has to know
 * where a line ended.
 */

import type { M3uWarning } from './types.js';

/**
 * The one tag RFC 8216 requires of every playlist there is: §4.3.1.1 has it
 * "the first line of every Media Playlist and every Master Playlist". Which
 * makes its absence a structural fact rather than any dialect's opinion, and so
 * the scanner's to report.
 */
const EXTM3U = 'EXTM3U';

const HASH = '#'.charCodeAt(0);
const COLON = ':'.charCodeAt(0);
const CR = '\r'.charCodeAt(0);

const QUOT = '"'.charCodeAt(0);
const COMMA = ','.charCodeAt(0);
const EQ = '='.charCodeAt(0);
const SPACE = ' '.charCodeAt(0);
const TAB = '\t'.charCodeAt(0);
const LF = '\n'.charCodeAt(0);

/**
 * Whitespace, indexed by charcode (ASCII 0–127; anything higher reads
 * `undefined` → falsy, which is correct — a non-ASCII character is an ordinary
 * name or value character).
 */
const WS_TABLE = new Uint8Array(128);
WS_TABLE[SPACE] = WS_TABLE[TAB] = WS_TABLE[CR] = WS_TABLE[LF] = 1;

/**
 * Continues an attribute name. Deliberately wider than RFC 8216 §4.2, which
 * allows only uppercase letters, digits and hyphens: the names the IPTV layer
 * carries are lowercase and hyphenated (`tvg-id`, `group-title`), so a reader
 * written to the letter of the specification would read none of them.
 */
const NAME_TABLE = new Uint8Array(128);

for (let code = 0; code < 128; code++) {
  NAME_TABLE[code] = /[A-Za-z0-9_.-]/.test(String.fromCharCode(code)) ? 1 : 0;
}

/**
 * No separator beyond whitespace. `-1` because `charCodeAt` never returns it,
 * so the comparison it takes part in is simply never true.
 */
const NO_SEPARATOR = -1;

/** What {@link M3uTag.attributes} takes beyond the value it is reading. */
export interface M3uAttributeOptions {
  /**
   * What separates one attribute from the next.
   *
   * `' '` — the default — is the grammar the IPTV layer puts on an `#EXTINF`
   * line. `','` is the one RFC 8216 §4.2 defines, which is what every `#EXT-X-`
   * tag carrying an attribute list uses.
   */
  separator?: ' ' | ',';
  /** Read from here in the value rather than from its start. */
  from?: number;
  /** Stop here rather than at the end of the value. */
  to?: number;
  /**
   * Told where a quote was opened and never closed, as an offset into the
   * value. A caller with warnings to report wants to know; one that only wants
   * the attributes it could read need not ask.
   */
  onUnterminated?: (at: number) => void;
}

/**
 * One `#` line, split into the name and whatever followed the colon or space
 * that ended it: `EXT-X-ENDLIST` and no value, `EXT-X-TARGETDURATION` and `10`,
 * `EXTINF` and `-1 tvg-id="a",Name`.
 *
 * The value arrives **unparsed**, because which grammar it uses is a property
 * of the name and only a reader of a particular dialect knows that:
 * `EXT-X-KEY` carries a comma-separated attribute list, `EXTINF` a
 * space-separated one behind a duration, `EXT-X-TARGETDURATION` a bare number,
 * and `EXTVLCOPT` free text with commas in it. {@link M3uTag.attributes} reads
 * the ones that *are* attribute lists, in whichever grammar the reader says.
 */
export class M3uTag {
  constructor(
    /** The tag name, without its `#`. */
    readonly name: string,
    /** Everything after the character that ended the name. */
    readonly value: string,
    /** 1-based line the tag was on. */
    readonly line: number,
    /**
     * 1-based column where {@link value} begins, so a reader can anchor a
     * warning at something it found inside it.
     */
    readonly col: number,
  ) {}

  /**
   * The value read as an attribute list, in whichever grammar the tag uses.
   *
   * The only way to read one, and deliberately: which grammar applies is a
   * property of the tag, so the reading belongs to the tag rather than to a
   * function anyone could point at any string.
   *
   * Tolerant of what RFC 8216 forbids and this format does anyway: lowercase
   * hyphenated names, and whitespace either side of the `=`. An unquoted value
   * runs to the next space, which is in no specification but is what a playlist
   * written by hand looks like.
   *
   * `separator` is the one thing the two grammars disagree about. The IPTV
   * layer on `#EXTINF` separates attributes with spaces; RFC 8216 §4.2
   * separates them with commas. Everything else is shared — a comma between
   * attributes is already stepped over by the "nothing a name could begin with"
   * branch below — so the whole difference is where an *unquoted* value stops.
   */
  attributes(options?: M3uAttributeOptions): Map<string, string> {
    const into = new Map<string, string>();
    const to = options?.to ?? this.value.length;
    const separator = options?.separator === ',' ? COMMA : NO_SEPARATOR;
    let at = options?.from ?? 0;

    while (at < to) {
      while (at < to && WS_TABLE[this.value.charCodeAt(at)]) {
        at++;
      }

      const nameFrom = at;

      while (at < to && NAME_TABLE[this.value.charCodeAt(at)]) {
        at++;
      }

      if (at === nameFrom) {
        // Nothing a name could begin with — step over it rather than stalling.
        at++;
        continue;
      }

      const name = this.value.slice(nameFrom, at);

      while (at < to && WS_TABLE[this.value.charCodeAt(at)]) {
        at++;
      }

      if (this.value.charCodeAt(at) !== EQ) {
        // A bare word with no this.value. Not an attribute, and not worth a warning
        // in a format where free text begins a few characters later.
        continue;
      }

      at++;

      while (at < to && WS_TABLE[this.value.charCodeAt(at)]) {
        at++;
      }

      if (this.value.charCodeAt(at) === QUOT) {
        const openedAt = at;

        at++;

        const valueFrom = at;

        while (at < to && this.value.charCodeAt(at) !== QUOT) {
          at++;
        }

        into.set(name, this.value.slice(valueFrom, at));

        if (at >= to) {
          // Opened and never closed: what was read is kept, and a caller with
          // warnings to report is told where the quote that opened it was. The
          // loop ends here too, so this happens at most once.
          options?.onUnterminated?.(openedAt);
        } else {
          at++;
        }
      } else {
        const valueFrom = at;

        while (
          at < to &&
          !WS_TABLE[this.value.charCodeAt(at)] &&
          this.value.charCodeAt(at) !== separator
        ) {
          at++;
        }

        into.set(name, this.value.slice(valueFrom, at));
      }
    }

    return into;
  }
}

/**
 * The byte-order mark a playlist saved by a Windows editor begins with.
 *
 * As a charcode, both because the comparison wants one and because the
 * character itself is invisible: written as a string literal it is a line that
 * looks empty in every editor and every diff, which is how such a thing comes
 * to be "tidied away" by someone who cannot see it is there.
 */
const BOM = 0xfeff;

/** See {@link M3uScanOptions.maxLineLength}. */
const DEFAULT_MAX_LINE_LENGTH = 1024 * 1024;

/**
 * What a reader of some dialect of this format provides.
 *
 * The scanner calls one of the first three for every line that carries
 * anything, then drains {@link M3uTokens.events} — which is what keeps a
 * playlist streaming line by line rather than a chunk at a time, however large
 * a chunk the caller passes.
 */
export interface M3uTokens<TEvent> {
  /** A tag line, split as RFC 8216 §4.3 shapes one. See {@link M3uTag}. */
  tag(tag: M3uTag): void;
  /** A line that is neither blank nor a tag, so by §4.1 a URI. */
  uri(text: string, line: number): void;
  /** Something the *scanner* found wrong, which is only ever a line too long. */
  warn(warning: M3uWarning): void;
  /** The playlist is over, so anything left unfinished can be reported. */
  end(): void;
  /**
   * Whatever the line just handed over produced, emptied by the scanner once it
   * has been yielded on.
   */
  readonly events: TEvent[];
}

export interface M3uScanOptions {
  /**
   * The longest line to hold, in characters. **1 MiB** by default; `Infinity`
   * for no bound at all.
   *
   * A line is held until its newline arrives, which is what lets a chunk fall
   * anywhere — and what a body of megabytes with no newline in it would exploit,
   * since a playlist is usually fetched from a url someone else controls. The
   * bound is what keeps "flat in the size of the playlist" true for a response
   * that is not a playlist.
   *
   * The default is chosen to be unreachable by anything real: the longest line
   * in iptv-org's 26,803 is **1,184 characters**, so this leaves roughly 885×
   * headroom. Over it, the line is dropped with a `line-too-long` warning and
   * scanning resumes at the next newline.
   */
  maxLineLength?: number;
}

export class M3uScanner<TEvent> {
  readonly #tokens: M3uTokens<TEvent>;
  readonly #maxLineLength: number;

  /**
   * Inside a line that ran past the bound, waiting for the newline that ends it.
   *
   * What makes the bound a *resync* rather than a stop: the rest of the line is
   * thrown away as it arrives, and the playlist is read again from the line
   * after it.
   */
  #skipping = false;

  /** 1-based, and counted across chunks — a warning is only useful with it. */
  #line = 0;
  /** Whether any line has carried anything yet — see {@link EXTM3U}. */
  #seenAnything = false;

  constructor(tokens: M3uTokens<TEvent>, options: M3uScanOptions = {}) {
    this.#tokens = tokens;
    this.#maxLineLength = options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH;
  }

  /**
   * Read what is complete in `buf` and hand back what is not.
   *
   * With `final`, the remainder is treated as a whole line even without its
   * newline — a playlist whose last line has none is ordinary — and the handler
   * is told the document is over, so it can report anything left unfinished.
   */
  *consume(buf: string, final: boolean): Generator<TEvent, string> {
    let at = 0;

    // Still throwing away a line that ran past the bound. Nothing in it is
    // parsed, including a newline's worth of it that may have been counted
    // already — the line is over when its newline turns up.
    if (this.#skipping) {
      const ends = buf.indexOf('\n');

      if (ends === -1) {
        return '';
      }

      this.#skipping = false;
      this.#line++;
      at = ends + 1;
    }

    while (true) {
      const newline = buf.indexOf('\n', at);

      if (newline === -1) {
        break;
      }

      this.#read(buf, at, newline);
      yield* this.#drain();

      at = newline + 1;
    }

    if (!final) {
      const rest = at === 0 ? buf : buf.slice(at);

      // What is held between chunks is exactly one unfinished line, so this is
      // the one place the buffer can grow without a newline to stop it.
      if (rest.length > this.#maxLineLength) {
        // Against the line it was about to become, which is the one after
        // everything counted so far.
        this.#tokens.warn({
          code: 'line-too-long',
          message: `line is longer than ${this.#maxLineLength} characters and was dropped`,
          line: this.#line + 1,
          col: 1,
        });
        this.#skipping = true;

        yield* this.#drain();

        return '';
      }

      return rest;
    }

    if (at < buf.length) {
      this.#read(buf, at, buf.length);
      yield* this.#drain();
    }

    this.#tokens.end();
    yield* this.#drain();

    return '';
  }

  /** Hand on whatever the last line produced, and start the next one empty. */
  *#drain(): Generator<TEvent> {
    const { events } = this.#tokens;

    if (events.length > 0) {
      yield* events;
      events.length = 0;
    }
  }

  /** One line of `buf`, classified and handed over. */
  #read(buf: string, start: number, end: number): void {
    this.#line++;

    let from = start;
    let to = end;

    // CR from a CRLF playlist — which is what iptv-org and every Windows editor
    // produce — dropped here so nothing downstream has to think about it.
    if (to > from && buf.charCodeAt(to - 1) === CR) {
      to--;
    }

    if (this.#line === 1 && buf.charCodeAt(from) === BOM) {
      from++;
    }

    // "Blank lines are ignored" — RFC 8216 §4. Checked before slicing, so a
    // blank line costs no allocation at all.
    if (this.#blank(buf, from, to)) {
      return;
    }

    // A property of *the line*, not of how the bytes happened to be chunked: a
    // line that arrived whole inside one chunk was never buffered, and would
    // otherwise be read normally while the same line split across two was
    // dropped. Every line reaches here, so this is the one place that is true of.
    if (to - from > this.#maxLineLength) {
      this.#tokens.warn({
        code: 'line-too-long',
        message: `line is longer than ${this.#maxLineLength} characters and was dropped`,
        line: this.#line,
        col: 1,
      });

      return;
    }

    if (buf.charCodeAt(from) === HASH) {
      // The name runs to the colon that introduces a value, or to the space a
      // dialect may put before one on `#EXTM3U`, whichever comes first.
      let at = from + 1;

      while (at < to && buf.charCodeAt(at) !== COLON && !WS_TABLE[buf.charCodeAt(at)]) {
        at++;
      }

      const name = buf.slice(from + 1, at);

      this.#opens(name === EXTM3U, buf, from, to);
      this.#tokens.tag(
        new M3uTag(name, at < to ? buf.slice(at + 1, to) : '', this.#line, at - from + 2),
      );

      return;
    }

    this.#opens(false, buf, from, to);
    this.#tokens.uri(buf.slice(from, to), this.#line);
  }

  /**
   * The first line that carries anything, and whether it was the `#EXTM3U`
   * RFC 8216 requires.
   *
   * Reported here rather than by a reader, so every dialect gets it — and said
   * against the line that should have been the header rather than against line
   * 1, which may be a comment or a blank.
   */
  #opens(isHeader: boolean, buf: string, from: number, to: number): void {
    if (this.#seenAnything) {
      return;
    }

    this.#seenAnything = true;

    if (!isHeader) {
      this.#tokens.warn({
        code: 'missing-header',
        message: `the playlist begins with ${JSON.stringify(buf.slice(from, to))}, not #EXTM3U`,
        line: this.#line,
        col: 1,
      });
    }
  }

  /** Whitespace only, and without allocating the slice to find out. */
  #blank(buf: string, from: number, to: number): boolean {
    for (let at = from; at < to; at++) {
      if (!WS_TABLE[buf.charCodeAt(at)]) {
        return false;
      }
    }

    return true;
  }
}
