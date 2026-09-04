/**
 * The M3U scanner: bytes of playlist in, events out, one line at a time.
 *
 * Shaped like {@link XmltvScanner} and for the same reason — `consume` yields
 * what it finished and **returns what it could not**, so a caller feeding it
 * arbitrary chunks hands the remainder back next time and never has to know
 * where a line ended. A playlist is line-oriented, so the state this carries is
 * small: the entry being assembled, and whether a header has been seen.
 *
 * The character work is charcodes and lookup tables rather than regular
 * expressions, as the XMLTV scanner's is, because the two inner loops here run
 * over every character of every `#EXTINF` line in the playlist.
 */

import type {
  M3uDirective,
  M3uEntry,
  M3uParseEvent,
  M3uParseOptions,
  M3uWarning,
} from './types.js';

/** What `#EXTINF:` introduces, and the only tag that opens an entry. */
const EXTINF = '#EXTINF:';

const EXTM3U = '#EXTM3U';

/**
 * Where `#EXTINF:` first differs from anything else beginning `#EXT`.
 *
 * One `charCodeAt` rules the tag out before a `startsWith` walks eight
 * characters, which is worth the indirection on a check every line pays.
 */
const TAG_AT = 4;
const EXTINF_I = 'I'.charCodeAt(0);

const QUOT = '"'.charCodeAt(0);
const COMMA = ','.charCodeAt(0);
const EQ = '='.charCodeAt(0);
const HASH = '#'.charCodeAt(0);
const SPACE = ' '.charCodeAt(0);
const TAB = '\t'.charCodeAt(0);
const CR = '\r'.charCodeAt(0);
const MINUS = '-'.charCodeAt(0);
const ZERO = '0'.charCodeAt(0);
const NINE = '9'.charCodeAt(0);
const LF = '\n'.charCodeAt(0);

/**
 * The byte-order mark a playlist saved by a Windows editor begins with.
 *
 * As a charcode, both because the comparison wants one and because the
 * character itself is invisible: written as a string literal it is a line that
 * looks empty in every editor and every diff, which is how such a thing comes
 * to be "tidied away" by someone who cannot see it is there.
 */
const BOM = 0xfeff;

/**
 * Char-classification tables for the inner loops, indexed by charcode
 * (ASCII 0–127; anything higher reads `undefined` → falsy, which is correct —
 * a non-ASCII character is an ordinary attribute-name or value character).
 */
const WS_TABLE = new Uint8Array(128);
WS_TABLE[SPACE] = WS_TABLE[TAB] = WS_TABLE[CR] = WS_TABLE[LF] = 1;

/**
 * Continues an attribute name. Deliberately wider than RFC 8216 §4.2, which
 * allows only uppercase letters, digits and hyphens: the names this format
 * actually carries are lowercase and hyphenated (`tvg-id`, `group-title`), so a
 * scanner written to the letter of the specification would read none of them.
 */
const NAME_TABLE = new Uint8Array(128);

for (let code = 0; code < 128; code++) {
  NAME_TABLE[code] = /[A-Za-z0-9_.-]/.test(String.fromCharCode(code)) ? 1 : 0;
}

/** Every quote closed — what {@link M3uScanner} reports when the list is sound. */
const CLOSED = -1;

/** See {@link M3uParseOptions.maxLineLength}. */
const DEFAULT_MAX_LINE_LENGTH = 1024 * 1024;

export class M3uScanner {
  readonly #keepUnknown: boolean;
  readonly #maxLineLength: number;

  /**
   * Inside a line that ran past the bound, waiting for the newline that ends it.
   *
   * What makes the bound a *resync* rather than a stop: the rest of the line is
   * thrown away as it arrives, and the playlist is read again from the line
   * after it.
   */
  #skipping = false;

  /**
   * What the line being read has produced so far, drained by {@link consume}.
   *
   * The same shape `XmltvScanner` uses for its own warnings: the methods that
   * read a line are plain and record what they find here, and one small
   * generator hands it on. They are entered once per line and say something
   * only occasionally, so as generators each line paid for a generator object
   * and a `yield*` delegation whether or not it had anything to report.
   *
   * `consume` checks this before draining rather than calling a drain generator
   * unconditionally — that would put back the very allocation this removes, and
   * measured 3.2× the cost. Emptied rather than replaced, so one array serves
   * the whole playlist.
   */
  readonly #events: M3uParseEvent[] = [];

  /** 1-based, and counted across chunks — a warning is only useful with it. */
  #line = 0;
  #seenAnything = false;

  /**
   * The entry being assembled: an `#EXTINF` has been read and its url has not.
   *
   * The whole of the parser's state, because an entry is the only thing in this
   * format that spans lines. `null` rather than `undefined` for the reason the
   * XMLTV scanner's own slots are — it is emptied and refilled as the document
   * goes by, and an explicit empty reads differently from a field never set.
   */
  #pending: M3uEntry | null = null;
  /** The line the pending entry's `#EXTINF` was on, for its warning. */
  #pendingAt = 0;

  /**
   * Directives read before the `#EXTINF` they belong to, waiting for it.
   *
   * A playlist may put `#EXTGRP`, `#KODIPROP` or `#EXTVLCOPT` on either side of
   * the `#EXTINF` — Kodi and tvheadend both accumulate into a pending channel
   * and commit it on the url line, so which side is not something either of
   * them can even notice. Kodi has an issue titled "#EXTGRP before #EXTINF
   * breaks the parsing of playlist", which is how common the leading form is.
   *
   * Held here rather than dropped, so a playlist written that way keeps its
   * groups. Anything still waiting when the playlist ends never found an entry,
   * and *that* is what is finally reported as `orphan-directive`.
   */
  #leading: M3uDirective[] | null = null;
  /** Where each of those was, so a leftover can be reported against its line. */
  #leadingAt: number[] = [];

  constructor(options: M3uParseOptions = {}) {
    this.#keepUnknown = options.keepUnknownDirectives !== false;
    this.#maxLineLength = options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH;
  }

  /**
   * Read what is complete in `buf` and hand back what is not.
   *
   * With `final`, the remainder is treated as a whole line even without its
   * newline — a playlist whose last line has none is ordinary — and an entry
   * still open at the end is reported rather than dropped.
   */
  *consume(buf: string, final: boolean): Generator<M3uParseEvent, string> {
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

      if (this.#events.length > 0) {
        yield* this.#events;
        this.#events.length = 0;
      }

      at = newline + 1;
    }

    if (!final) {
      const rest = at === 0 ? buf : buf.slice(at);

      // What is held between chunks is exactly one unfinished line, so this is
      // the one place the buffer can grow without a newline to stop it.
      if (rest.length > this.#maxLineLength) {
        // Against the line it was about to become, which is the one after
        // everything counted so far.
        yield {
          type: 'warning',
          value: {
            code: 'line-too-long',
            message: `line is longer than ${this.#maxLineLength} characters and was dropped`,
            line: this.#line + 1,
            col: 1,
          },
        };

        this.#skipping = true;

        return '';
      }

      return rest;
    }

    if (at < buf.length) {
      this.#read(buf, at, buf.length);
    }

    this.#flush();

    if (this.#events.length > 0) {
      yield* this.#events;
      this.#events.length = 0;
    }

    // Directives that waited for an `#EXTINF` the playlist never got to. Said
    // here rather than where they were read, because until the document stops
    // there is always the chance the entry is simply the next thing in it —
    // the same reason an unfinished entry is reported at the end.
    const waiting = this.#leading;

    if (waiting !== null) {
      this.#leading = null;

      for (const [index, directive] of waiting.entries()) {
        yield {
          type: 'warning',
          value: {
            code: 'orphan-directive',
            message: `#${directive.name} has no #EXTINF to belong to, and is dropped`,
            line: this.#leadingAt[index] ?? this.#line,
            col: 1,
          },
        };
      }

      this.#leadingAt = [];
    }

    return '';
  }

  /** One line of `buf`, whatever it turns out to be. */
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

    // Here rather than only where the buffer grows, so the bound is a property
    // of *the line* and not of how the bytes happened to be chunked — a line
    // that arrived whole inside one chunk was never buffered, and would
    // otherwise be read normally while the same line split across two was
    // dropped. Every line reaches this method, so this is the one place that is
    // true of.
    if (to - from > this.#maxLineLength) {
      this.#warn(
        'line-too-long',
        `line is longer than ${this.#maxLineLength} characters and was dropped`,
        0,
      );

      return;
    }

    // "Blank lines are ignored" — RFC 8216 §4. Checked before slicing, so a
    // blank line costs no allocation at all.
    if (this.#blank(buf, from, to)) {
      return;
    }

    const line = buf.slice(from, to);

    // Only the first line that carries anything can be the header — RFC 8216
    // has `#EXTM3U` first or not at all — so this is asked once per playlist
    // rather than of all 26,803 lines, and a later one falls through to the
    // ordinary `#` handling below, which is where it belongs.
    //
    // The tag and nothing more, too: `#EXTM3UPLUS` is a `#` line the format
    // does not define. Reading it as a header would swallow the directive *and*
    // fill the header slot, so a playlist with no real `#EXTM3U` would never be
    // told it was missing one.
    if (!this.#seenAnything && line.startsWith(EXTM3U) && this.#endsTag(line, EXTM3U.length)) {
      this.#header(line);

      return;
    }

    // The first line that carries anything, and it is not the header RFC 8216
    // requires. Said here rather than at the end, so a caller reading events in
    // order learns it before the entries it applies to — and said against the
    // line that should have been the header rather than against line 1, which
    // may be a comment or a blank.
    if (!this.#seenAnything) {
      this.#warn(
        'missing-header',
        `the playlist begins with ${JSON.stringify(line)}, not #EXTM3U`,
        0,
      );
    }

    this.#seenAnything = true;

    if (line.charCodeAt(TAG_AT) === EXTINF_I && line.startsWith(EXTINF)) {
      this.#extinf(line);

      return;
    }

    if (line.charCodeAt(0) === HASH) {
      this.#directive(line);

      return;
    }

    this.#url(line);
  }

  /**
   * `#EXTM3U`, with whatever it carries.
   *
   * Reached only for the first line of the playlist that carries anything: a
   * later `#EXTM3U` is not a header but a `#` line the format does not define,
   * and {@link #read} leaves it to the directive handling for that reason.
   */
  #header(line: string): void {
    this.#seenAnything = true;

    const attributes = new Map<string, string>();
    const opened = this.#attributes(line, EXTM3U.length, line.length, attributes);

    if (opened !== CLOSED) {
      this.#warn('malformed-attributes', 'unterminated quote on the #EXTM3U line', opened);
    }

    this.#emit({ type: 'header', value: { attributes } });
  }

  /**
   * `#EXTINF:<duration> <attributes>,<name>`.
   *
   * Where the name begins is the whole difficulty of this format, and the rule
   * is decidable rather than a guess: a quoted value cannot contain a double
   * quote (RFC 8216 §4.2), so the first comma **outside** quotes ends the
   * attributes. Taking the first comma outright mangles one entry in twenty of
   * iptv-org's playlist, where a `http-user-agent` says "(KHTML, like Gecko)";
   * taking the last breaks any channel with a comma in its name.
   */
  #extinf(line: string): void {
    // Whatever came before is finished: a new `#EXTINF` is the one thing that
    // can neither add a url to it nor be part of it.
    this.#flush();

    this.#pendingAt = this.#line;

    const comma = this.#nameStart(line, EXTINF.length);
    const headEnd = comma === -1 ? line.length : comma;
    const name = comma === -1 ? '' : line.slice(comma + 1);

    // The duration runs to the first space or the end of the head; whatever
    // follows it is the attribute list.
    //
    // Read digit by digit rather than sliced and handed to `Number`, because
    // every live channel in every playlist says `-1` and that is a string
    // allocation and a numeric parse per entry for a value already in hand.
    // Anything that is not a plain integer — `212.5`, `1e3`, an empty duration —
    // falls back to exactly what it did before, so only the common case is
    // shortcut and the meaning is unchanged.
    let at = EXTINF.length;
    let simple = true;
    let value = 0;
    let digits = 0;

    if (line.charCodeAt(at) === MINUS) {
      at++;
    }

    while (at < headEnd && !WS_TABLE[line.charCodeAt(at)]) {
      const code = line.charCodeAt(at);

      if (code >= ZERO && code <= NINE) {
        value = value * 10 + (code - ZERO);
        digits++;
      } else {
        simple = false;
      }

      at++;
    }

    const negative = line.charCodeAt(EXTINF.length) === MINUS;
    // `Number.MAX_SAFE_INTEGER` is 16 digits; past that the accumulator above
    // has lost precision and `Number` is the one that gets it right.
    const exact = simple && digits > 0 && digits < 16;
    const duration = exact ? (negative ? -value : value) : Number(line.slice(EXTINF.length, at));
    const known = exact || (at > EXTINF.length && Number.isFinite(duration));

    if (!known) {
      this.#warn(
        'invalid-duration',
        `#EXTINF duration ${JSON.stringify(line.slice(EXTINF.length, at))} is not a number`,
        EXTINF.length,
      );
    }

    const attributes = new Map<string, string>();
    const opened = this.#attributes(line, at, headEnd, attributes);

    if (opened !== CLOSED) {
      this.#warn('malformed-attributes', 'unterminated quote on an #EXTINF line', opened);
    }

    if (comma === -1) {
      this.#warn('malformed-attributes', '#EXTINF has no comma, so no name', line.length);
    }

    // Whatever was waiting for an `#EXTINF` was waiting for this one, and it
    // goes on first — the order the playlist wrote them in.
    const waiting = this.#leading;

    this.#leading = null;
    this.#leadingAt = [];

    // A plain literal and then an assignment, rather than a conditional spread:
    // spreading builds the object through a slower path in V8 and this runs once
    // per entry — measured at 2.3× the cost for a shape the great majority of
    // entries (94% of iptv-org's) never use.
    const entry: M3uEntry = { url: '', name, duration: known ? duration : -1, attributes };

    if (waiting !== null) {
      entry.directives = waiting;
    }

    this.#pending = entry;
  }

  /**
   * A `#` line the format does not define, kept with the entry it belongs to.
   *
   * Which is the entry being assembled if there is one, and otherwise the next
   * one to arrive — see {@link #leading}. Only a directive that never finds
   * either, because the playlist ended first, is dropped, and it is *said* to be
   * dropped: it is legal to ignore one (RFC 8216 says such a line "SHOULD be
   * ignored") but it is also the only thing left that stops a playlist
   * round-tripping, and a module whose rule is losslessness should not go quiet
   * about the one case it cannot keep.
   */
  #directive(line: string): void {
    // Asked for, rather than lost: dropping these is the caller's own choice.
    if (!this.#keepUnknown) {
      return;
    }

    // The first colon and no further: `#EXTVLCOPT:http-user-agent=Mozilla/5.0…`
    // has an `=`, spaces and more colons inside its value, every one of which
    // belongs to the value.
    const colon = line.indexOf(':');
    const directive: M3uDirective =
      colon === -1
        ? { name: line.slice(1), value: '' }
        : { name: line.slice(1, colon), value: line.slice(colon + 1) };

    if (this.#pending === null) {
      (this.#leading ??= []).push(directive);
      this.#leadingAt.push(this.#line);

      return;
    }

    (this.#pending.directives ??= []).push(directive);
  }

  /**
   * Anything not beginning with `#`, which closes the entry it follows.
   *
   * One url and one only: RFC 8216 gives an `#EXTINF` exactly one URI, and no
   * implementation surveyed — Kodi, tvheadend, `iptv-playlist-parser` — reads a
   * second line as a backup stream for the same channel. The proposals that do
   * exist for backups put them in one line (`url|backup`) or behind a tag of
   * their own, so a bare second url really is what the warning says it is.
   */
  #url(line: string): void {
    const entry = this.#pending;

    if (entry === null) {
      this.#warn(
        'orphan-url',
        `${JSON.stringify(line)} has no #EXTINF before it, and is dropped`,
        0,
      );

      return;
    }

    this.#pending = null;
    entry.url = line.trim();

    this.#emit({ type: 'entry', value: entry });
  }

  /**
   * Where the name begins: the first comma not inside a quoted value, or `-1`.
   *
   * Counting quotes is enough to know which side of one a comma falls on,
   * because a quoted string cannot contain a double quote — there is no escape
   * to unpick and no lookahead needed.
   */
  #nameStart(line: string, from: number): number {
    let quoted = false;

    for (let at = from; at < line.length; at++) {
      const code = line.charCodeAt(at);

      if (code === QUOT) {
        quoted = !quoted;
      } else if (code === COMMA && !quoted) {
        return at;
      }
    }

    return -1;
  }

  /**
   * Every `key="value"` between `from` and `to`, as spelled and in order.
   * Returns where a quote was opened and never closed, or {@link CLOSED}.
   *
   * Tolerant of what RFC 8216 forbids and this format does anyway: lowercase
   * hyphenated names, and whitespace either side of the `=`. An unquoted value
   * runs to the next space, which is in no specification but is what a playlist
   * written by hand looks like.
   */
  #attributes(line: string, from: number, to: number, into: Map<string, string>): number {
    let at = from;
    let unterminated = CLOSED;

    while (at < to) {
      while (at < to && WS_TABLE[line.charCodeAt(at)]) {
        at++;
      }

      const nameFrom = at;

      while (at < to && NAME_TABLE[line.charCodeAt(at)]) {
        at++;
      }

      if (at === nameFrom) {
        // Nothing a name could begin with — step over it rather than stalling.
        at++;
        continue;
      }

      const name = line.slice(nameFrom, at);

      while (at < to && WS_TABLE[line.charCodeAt(at)]) {
        at++;
      }

      if (line.charCodeAt(at) !== EQ) {
        // A bare word with no value. Not an attribute, and not worth a warning
        // in a format where free text begins a few characters later.
        continue;
      }

      at++;

      while (at < to && WS_TABLE[line.charCodeAt(at)]) {
        at++;
      }

      if (line.charCodeAt(at) === QUOT) {
        const openedAt = at;

        at++;

        const valueFrom = at;

        while (at < to && line.charCodeAt(at) !== QUOT) {
          at++;
        }

        into.set(name, line.slice(valueFrom, at));

        if (at >= to) {
          // Opened and never closed: what was read is kept, and the caller told
          // where the quote that opened it was.
          unterminated = openedAt;
        } else {
          at++;
        }
      } else {
        const valueFrom = at;

        while (at < to && !WS_TABLE[line.charCodeAt(at)]) {
          at++;
        }

        into.set(name, line.slice(valueFrom, at));
      }
    }

    return unterminated;
  }

  /** Whether a tag ends at `at`: the line stops there, or whitespace does. */
  #endsTag(line: string, at: number): boolean {
    return at >= line.length || WS_TABLE[line.charCodeAt(at)] === 1;
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

  /**
   * The entry that never got a url, emitted anyway — if one is open.
   *
   * Reached only from the two places an entry can be cut short: a new `#EXTINF`
   * arriving before the last one's url, and the end of the playlist. An entry
   * that got its url was emitted by {@link #url} and is long gone.
   */
  #flush(): void {
    const entry = this.#pending;

    if (entry === null) {
      return;
    }

    this.#pending = null;

    // An `#EXTINF` that never met a url. Kept rather than dropped because most
    // readers of a playlist want the channel list rather than the streams, and
    // a metadata line with nothing to play is still a channel. The warning is
    // what says so, and it comes first, so a caller reading events in order
    // knows what the entry behind it is before it arrives. It is anchored to
    // the `#EXTINF` rather than to whatever line finally displaced it.
    if (entry.url === '') {
      this.#emit({
        type: 'warning',
        value: {
          code: 'incomplete-entry',
          message: `#EXTINF for ${JSON.stringify(entry.name)} has no url`,
          line: this.#pendingAt,
          col: 1,
        },
      });
    }

    this.#emit({ type: 'entry', value: entry });
  }

  /** `at` is a 0-based offset into the line; a warning carries it 1-based. */
  #warn(code: M3uWarning['code'], message: string, at: number): void {
    this.#events.push({ type: 'warning', value: { code, message, line: this.#line, col: at + 1 } });
  }

  /** The header or entry a line turned out to be, in the order it produced them. */
  #emit(event: M3uParseEvent): void {
    this.#events.push(event);
  }
}
