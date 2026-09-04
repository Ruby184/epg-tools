/**
 * The M3U playlist data model — how the IPTV world exchanges a channel list.
 *
 * Half of the format is specified and half is convention, and keeping the two
 * apart is most of what this model is for.
 *
 * The container is [RFC 8216](https://www.rfc-editor.org/rfc/rfc8216.html):
 * `#EXTM3U` first, then `#EXTINF:<duration>,<title>` with "the remainder of the
 * line following the comma" as the title, blank lines ignored, and every other
 * `#` line a comment. That much is written down.
 *
 * Everything an IPTV playlist actually carries — `tvg-id`, `group-title`, a
 * user agent, a Kodi property — is convention layered on top, and it breaks the
 * RFC in two ways worth knowing: the RFC puts *nothing* between the duration and
 * the comma, and requires attribute names to be uppercase. So this cannot be
 * written to the specification alone, only to its shape.
 *
 * Which is why nothing here is a named field. A playlist is read and written
 * **losslessly**: attributes as they were spelled, in the order they were
 * written, and unrecognized directives kept whole. What the conventional names
 * mean is knowledge for whoever reads the model, not for the parser — the
 * alternative is a fixed list of blessed fields that the real world exceeded
 * long ago.
 */

/** One `#NAME:rest-of-line` between an `#EXTINF` and its url. */
export interface M3uDirective {
  /** The tag without its `#`, e.g. `EXTVLCOPT`. */
  name: string;
  /**
   * Everything after the first colon, verbatim.
   *
   * The first and no further: `#EXTVLCOPT:http-user-agent=Mozilla/5.0 …` has an
   * `=`, spaces and more colons inside its value, and every one of them belongs
   * to the value.
   */
  value: string;
}

/** One channel: what `#EXTINF` said about it, and where its stream is. */
export interface M3uEntry {
  /**
   * The url line that closed the entry.
   *
   * Empty only for an entry the playlist never finished, which is reported as
   * an `incomplete-entry` warning rather than dropped — a caller reading a
   * channel list rather than playing it usually still wants the metadata.
   */
  url: string;
  /**
   * The display name: everything after the first comma that is not inside a
   * quoted attribute value.
   *
   * Not the last comma, and not the first one outright. A name may contain a
   * comma, and so may an attribute — `http-user-agent="… (KHTML, like Gecko)…"`
   * does on one entry in twenty of iptv-org's playlist. A quoted string cannot
   * contain a double quote, which is what makes the boundary decidable.
   */
  name: string;
  /**
   * Seconds, or `-1` where the source does not say — which for a live channel
   * is always, since it does not end.
   */
  duration: number;
  /**
   * Every `key="value"` on the `#EXTINF` line, as spelled and in order.
   *
   * Conventional names, as the Kodi IPTV Simple Client documents them:
   * `tvg-id`, `tvg-name`, `tvg-logo`, `tvg-chno`, `tvg-shift`, `group-title`,
   * `radio`, and the `catchup*` family. Real playlists carry more than that —
   * `http-user-agent` and `http-referrer` are common and documented nowhere —
   * so this is a record rather than a set of fields.
   *
   * `group-title` is a **semi-colon separated list**, not one group, which is
   * the thing most readers of this format get wrong.
   *
   * A `Map` rather than an object, because these names arrive from somebody
   * else's url and an object would have to answer for them. `__proto__` is an
   * ordinary key here instead of something that vanishes into the prototype
   * accessor, a name the playlist never carried reads back `undefined` rather
   * than an inherited `valueOf`, and it is measurably quicker to build and to
   * write out than a record is.
   *
   * The one thing to know: **a `Map` is `{}` under `JSON.stringify`**. To store
   * or log an entry, convert first — `Object.fromEntries(entry.attributes)` —
   * which is what {@link channelsFromM3u} does on the way to a channel.
   */
  attributes: Map<string, string>;
  /** `#EXTGRP`, `#EXTVLCOPT`, `#KODIPROP` and anything else, in order. */
  directives?: M3uDirective[];
}

/**
 * The `#EXTM3U` line: whatever it carried, which is usually where the guide is.
 *
 * `x-tvg-url` and `url-tvg` both appear in the wild for the same thing — the
 * XMLTV document that goes with the playlist.
 */
export interface M3uHeader {
  /** As {@link M3uEntry.attributes}, and a `Map` for the same reasons. */
  attributes: Map<string, string>;
}

/**
 * A non-fatal problem found while parsing, emitted as a `warning` event.
 * Parsing always continues; nothing here stops a playlist being read.
 *
 * Anchored the same way {@link XmltvWarning} is, with a line *and* a column:
 * an unterminated quote or an unreadable duration is somewhere particular on a
 * long `#EXTINF` line, and "line 4,812" on its own is not much help.
 */
export interface M3uWarning {
  code:
    /** The playlist does not open with `#EXTM3U`, which RFC 8216 requires. */
    | 'missing-header'
    /** An `#EXTINF` reached the next one, or the end, with no url. */
    | 'incomplete-entry'
    /** A url with no `#EXTINF` before it. */
    | 'orphan-url'
    /**
     * A `#` line with no `#EXTINF` before it to belong to, so it is dropped.
     *
     * Legal — RFC 8216 says an unrecognized `#` line "SHOULD be ignored" — but
     * reported all the same, because it is the one thing that stops a playlist
     * round-tripping byte for byte, and silence about that would be a promise
     * this module does not keep.
     */
    | 'orphan-directive'
    /** The duration was not a number; the entry is kept with `-1`. */
    | 'invalid-duration'
    /**
     * A line ran past {@link M3uParseOptions.maxLineLength} and was discarded.
     *
     * The scanner holds a line until its newline arrives, so without a bound an
     * endpoint that answers with megabytes and no newline — broken, hostile, or
     * simply not a playlist — grows the buffer without limit. Parsing resumes at
     * the next newline rather than stopping.
     */
    | 'line-too-long'
    /** A quote was opened and never closed; what parsed is kept. */
    | 'malformed-attributes';
  message: string;
  /** 1-based line of the construct the warning is anchored to. */
  line: number;
  /** 1-based column (in characters) on that line. */
  col: number;
}

/** Event emitted by the streaming parser. */
export type M3uParseEvent =
  | { type: 'header'; value: M3uHeader }
  | { type: 'entry'; value: M3uEntry }
  | { type: 'warning'; value: M3uWarning };

/** Options shared by every parse entry point. */
export interface M3uParseOptions {
  /**
   * Keep going after a `#` line the format does not define, rather than
   * dropping it. On by default.
   *
   * RFC 8216 says such a line "SHOULD be ignored", which is right for a player
   * and wrong for anything that will write the playlist back out: ignoring is
   * what loses a `#KODIPROP` nobody here has heard of. Turn it off for a reader
   * that only plays.
   */
  keepUnknownDirectives?: boolean;
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

/**
 * What a playlist's bytes are encoded in.
 *
 * The encodings an IPTV playlist is actually found in, named so they
 * autocomplete and so a typo is a compile error rather than a `RangeError` on
 * the first chunk. Any other label `TextDecoder` accepts is still allowed —
 * including the aliases these canonicalize from, such as `cp1251` for
 * `windows-1251` and `latin1` for `windows-1252`.
 *
 * Every one of these needs a Node built with full ICU, which is the default.
 */
export type M3uCharset =
  | 'utf-8'
  | 'utf-16le'
  | 'utf-16be'
  // Central and Eastern Europe, where a playlist is least likely to be UTF-8.
  | 'windows-1250'
  | 'windows-1251'
  | 'windows-1252'
  | 'windows-1254'
  | 'windows-1256'
  | 'iso-8859-2'
  | 'iso-8859-5'
  | 'iso-8859-7'
  | 'iso-8859-9'
  | 'koi8-r'
  | 'koi8-u'
  | 'gbk'
  | 'big5'
  | 'shift_jis'
  | 'euc-kr'
  | (string & {});

/** A fully materialized playlist — the whole-document counterpart to the stream. */
export interface M3uPlaylist {
  header: M3uHeader;
  entries: M3uEntry[];
  /** Non-fatal problems encountered while parsing; see {@link M3uWarning}. */
  warnings: M3uWarning[];
}

export type AnyIterable<T> = Iterable<T> | AsyncIterable<T>;
