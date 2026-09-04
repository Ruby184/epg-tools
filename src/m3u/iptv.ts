/**
 * The IPTV reading of a playlist: tags and urls in, headers and entries out.
 *
 * Everything the {@link M3uScanner} deliberately has no opinion about lives
 * here — that `#EXTINF` opens a channel and the url below it closes one, that a
 * `#` line describes the channel it sits beside, and that `#EXTM3U` is a header
 * only when it comes first. None of that is in RFC 8216; it is convention the
 * IPTV world settled on, and another dialect of the same format scopes the same
 * lines quite differently. Implement {@link M3uTokens} to read it that way.
 */

import type { M3uScanOptions, M3uTag, M3uTokens, M3uUri } from './scan.js';
import type {
  M3uDirective,
  M3uEntry,
  M3uParseEvent,
  M3uParseOptions,
  M3uWarning,
} from './types.js';

/** What `EXTINF:` introduces, and the only tag that opens an entry. */
const EXTINF = 'EXTINF';

const EXTM3U = 'EXTM3U';

const QUOT = '"'.charCodeAt(0);
const COMMA = ','.charCodeAt(0);
const SPACE = ' '.charCodeAt(0);
const TAB = '\t'.charCodeAt(0);
const MINUS = '-'.charCodeAt(0);
const ZERO = '0'.charCodeAt(0);
const NINE = '9'.charCodeAt(0);

export class M3uIptvReader implements M3uTokens<M3uParseEvent> {
  readonly events: M3uParseEvent[] = [];

  readonly #keepUnknown: boolean;

  /** The line being read, for anchoring a warning. */
  #line = 0;
  /** Where the value the reader was handed starts in the line, 1-based. */
  #col = 1;
  #seenAnything = false;

  /**
   * The entry being assembled: an `#EXTINF` has been read and its url has not.
   *
   * The whole of this reader's state, because an entry is the only thing in
   * this dialect that spans lines.
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
  }

  /** A `#` line, which is the header, an `#EXTINF`, or a directive. */
  tag(tag: M3uTag): void {
    const { name, value } = tag;
    const first = !this.#seenAnything;

    this.#line = tag.line;
    this.#col = tag.col;
    this.#seenAnything = true;

    // Only the first line that carries anything can be the header — RFC 8216
    // has `#EXTM3U` first or not at all — so a later one is a `#` line the
    // format does not define, and falls through to the directive handling
    // below, which is where it belongs. That it is *missing* is the scanner's
    // to report, since every dialect requires it.
    if (first && name === EXTM3U) {
      this.#header(tag);

      return;
    }

    if (name === EXTINF) {
      this.#extinf(tag);

      return;
    }

    this.#directive(name, value);
  }

  /** Anything not beginning with `#`, which closes the entry it follows. */
  uri({ text, line }: M3uUri): void {
    this.#line = line;
    this.#col = 1;
    this.#seenAnything = true;

    const entry = this.#pending;

    if (entry === null) {
      // One url and one only: RFC 8216 gives an `#EXTINF` exactly one URI, and
      // no implementation of this dialect — Kodi, tvheadend,
      // `iptv-playlist-parser` — reads a second line as a backup stream. The
      // proposals that do exist for backups put them in one line (`url|backup`)
      // or behind a tag of their own, so a bare second url really is what this
      // says it is.
      this.#warn(
        'orphan-url',
        `${JSON.stringify(text)} has no #EXTINF before it, and is dropped`,
        0,
      );

      return;
    }

    this.#pending = null;
    entry.url = text.trim();

    this.events.push({ type: 'entry', value: entry });
  }

  /** Whatever the scanner itself found wrong, which is a line too long. */
  warn(warning: M3uWarning): void {
    this.events.push({ type: 'warning', value: warning });
  }

  /** The playlist is over: report the entry, and the directives, left waiting. */
  end(): void {
    this.#flush();

    // Directives that waited for an `#EXTINF` the playlist never got to. Said
    // here rather than where they were read, because until the document stops
    // there is always the chance the entry is simply the next thing in it —
    // the same reason an unfinished entry is reported at the end.
    const waiting = this.#leading;

    if (waiting !== null) {
      this.#leading = null;

      for (const [index, directive] of waiting.entries()) {
        this.events.push({
          type: 'warning',
          value: {
            code: 'orphan-directive',
            message: `#${directive.name} has no #EXTINF to belong to, and is dropped`,
            line: this.#leadingAt[index] ?? this.#line,
            col: 1,
          },
        });
      }

      this.#leadingAt = [];
    }
  }

  /** `#EXTM3U`, with whatever it carries. */
  #header(tag: M3uTag): void {
    const attributes = tag.attributes({
      onUnterminated: (at) =>
        this.#warn('malformed-attributes', 'unterminated quote on the #EXTM3U line', at),
    });

    this.events.push({ type: 'header', value: { attributes } });
  }

  /**
   * `#EXTINF:<duration> <attributes>,<name>`.
   *
   * Where the name begins is the whole difficulty of this dialect, and the rule
   * is decidable rather than a guess: a quoted value cannot contain a double
   * quote (RFC 8216 §4.2), so the first comma **outside** quotes ends the
   * attributes. Taking the first comma outright mangles one entry in twenty of
   * iptv-org's playlist, where a `http-user-agent` says "(KHTML, like Gecko)";
   * taking the last breaks any channel with a comma in its name.
   */
  #extinf(tag: M3uTag): void {
    const text = tag.value;

    // Whatever came before is finished: a new `#EXTINF` is the one thing that
    // can neither add a url to it nor be part of it.
    this.#flush();

    this.#pendingAt = this.#line;

    const comma = this.#nameStart(text, 0);
    const headEnd = comma === -1 ? text.length : comma;
    const name = comma === -1 ? '' : text.slice(comma + 1);

    // The duration runs to the first space or the end of the head; whatever
    // follows it is the attribute list.
    //
    // Read digit by digit rather than sliced and handed to `Number`, because
    // every live channel in every playlist says `-1` and that is a string
    // allocation and a numeric parse per entry for a value already in hand.
    // Anything that is not a plain integer — `212.5`, `1e3`, an empty duration —
    // falls back to exactly what it did before, so only the common case is
    // shortcut and the meaning is unchanged.
    let at = 0;
    let simple = true;
    let value = 0;
    let digits = 0;

    if (text.charCodeAt(0) === MINUS) {
      at++;
    }

    // Space or tab, and no table for it: the scanner has already taken the CR
    // and LF off, so those are the only two whitespace characters a value can
    // still hold, and the duration is one token however it ends.
    while (at < headEnd && text.charCodeAt(at) !== SPACE && text.charCodeAt(at) !== TAB) {
      const code = text.charCodeAt(at);

      if (code >= ZERO && code <= NINE) {
        value = value * 10 + (code - ZERO);
        digits++;
      } else {
        simple = false;
      }

      at++;
    }

    const negative = text.charCodeAt(0) === MINUS;
    // `Number.MAX_SAFE_INTEGER` is 16 digits; past that the accumulator above
    // has lost precision and `Number` is the one that gets it right.
    const exact = simple && digits > 0 && digits < 16;
    const duration = exact ? (negative ? -value : value) : Number(text.slice(0, at));
    const known = exact || (at > 0 && Number.isFinite(duration));

    if (!known) {
      this.#warn(
        'invalid-duration',
        `#EXTINF duration ${JSON.stringify(text.slice(0, at))} is not a number`,
        0,
      );
    }

    // The attributes are the slice between the duration and the comma that
    // begins the name, so the tag is asked for exactly that much of its value.
    const attributes = tag.attributes({
      from: at,
      to: headEnd,
      onUnterminated: (bad) =>
        this.#warn('malformed-attributes', 'unterminated quote on an #EXTINF line', bad),
    });

    if (comma === -1) {
      this.#warn('malformed-attributes', '#EXTINF has no comma, so no name', text.length);
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
   * one to arrive. Only a directive that never finds either, because the
   * playlist ended first, is dropped, and it is *said* to be dropped: it is
   * legal to ignore one (RFC 8216 says such a line "SHOULD be ignored") but it
   * is also the only thing left that stops a playlist round-tripping, and a
   * module whose rule is losslessness should not go quiet about the one case it
   * cannot keep.
   */
  #directive(name: string, value: string): void {
    // Asked for, rather than lost: dropping these is the caller's own choice.
    if (!this.#keepUnknown) {
      return;
    }

    const directive: M3uDirective = { name, value };

    if (this.#pending === null) {
      (this.#leading ??= []).push(directive);
      this.#leadingAt.push(this.#line);

      return;
    }

    (this.#pending.directives ??= []).push(directive);
  }

  /**
   * Where the name begins: the first comma not inside a quoted value, or `-1`.
   *
   * Counting quotes is enough to know which side of one a comma falls on,
   * because a quoted string cannot contain a double quote — there is no escape
   * to unpick and no lookahead needed.
   */
  #nameStart(text: string, from: number): number {
    let quoted = false;

    for (let at = from; at < text.length; at++) {
      const code = text.charCodeAt(at);

      if (code === QUOT) {
        quoted = !quoted;
      } else if (code === COMMA && !quoted) {
        return at;
      }
    }

    return -1;
  }

  /**
   * The entry that never got a url, emitted anyway — if one is open.
   *
   * Reached only from the two places an entry can be cut short: a new `#EXTINF`
   * arriving before the last one's url, and the end of the playlist. An entry
   * that got its url was emitted by {@link uri} and is long gone.
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
    // knows what the entry behind it is before it arrives. It is anchored to the
    // `#EXTINF` rather than to whatever line finally displaced it.
    if (entry.url === '') {
      this.events.push({
        type: 'warning',
        value: {
          code: 'incomplete-entry',
          message: `#EXTINF for ${JSON.stringify(entry.name)} has no url`,
          line: this.#pendingAt,
          col: 1,
        },
      });
    }

    this.events.push({ type: 'entry', value: entry });
  }

  /** `at` is a 0-based offset into the text; a warning carries it 1-based. */
  #warn(code: M3uWarning['code'], message: string, at: number): void {
    this.events.push({
      type: 'warning',
      value: { code, message, line: this.#line, col: this.#col + at },
    });
  }
}

/** What the reader and the scanner each take, since a caller passes one object. */
export type M3uReaderOptions = M3uParseOptions & M3uScanOptions;
