/**
 * The channel-list format the community keeps by hand, and what lining two
 * lists up amounts to.
 *
 * `*.channels.xml` is how [iptv-org/epg](https://github.com/iptv-org/epg) and
 * [WebGrab+Plus](https://webgrabplus.com) both record which channel on a source
 * is which channel in a guide. They are the same document — iptv-org writes
 *
 * ```xml
 * <channel site="tvtv.us" site_id="2121" lang="en" xmltv_id="Euronews.fr@SD">Euronews English</channel>
 * ```
 *
 * and WebGrab+Plus the same four attributes plus an `update` of its own — so
 * one reader serves both, and the shape is exactly the split this package
 * already models in `GrabberChannel`: an id the source understands, and an id
 * the guide does.
 *
 * Keeping that mapping right is the whole game. A `tvg-id` that does not match
 * the guide's `<channel id>` is the single most common reason a channel shows
 * no EPG, in every consumer there is, and it fails silently: the playlist
 * loads, the guide loads, and one of them simply has nothing to say about the
 * other. It is not a rare state either — tvtv.us's own curated list carries
 * **69 of its 2,299 channels with `xmltv_id=""`**.
 */

/** One `<channel>` of a `*.channels.xml` document. */
export interface ChannelListEntry {
  /** The id the *source* knows this channel by — `site_id`. */
  siteId: string;
  /**
   * The id the *guide* knows it by — `xmltv_id`.
   *
   * Empty for a channel nobody has mapped yet, which is a state real files are
   * in rather than an error: it is what {@link ChannelMatch} exists to fill.
   */
  xmltvId: string;
  /** The channel's name, as the element's text. */
  name: string;
  /**
   * Which source it belongs to — `site`.
   *
   * May be given once on the `<channels>` root instead of on every channel, and
   * is resolved either way: an entry always carries the site it belongs to,
   * whichever place the file said it in.
   */
  site?: string;
  /** The language the *name* is written in, not the channel's. */
  lang?: string;
  /**
   * WebGrab+Plus's `update` attribute, kept so its files round-trip.
   *
   * It says how much of an already-grabbed channel to refresh, which is that
   * program's business and not this one's — but dropping an attribute on the
   * way through would quietly rewrite somebody's configuration.
   */
  update?: string;
  /** `logo` — a url for the channel's icon. */
  logo?: string;
  /** `url` — the channel's own page, not the stream's. */
  url?: string;
  /**
   * `lcn` — the Logical Channel Number, the position it sits at on a box.
   *
   * A string rather than a number, because it is written as one and some
   * lineups use `101.2` or a leading zero that matters.
   */
  lcn?: string;
}

/** A `*.channels.xml` document. */
export interface ChannelList {
  /**
   * The `site` on the `<channels>` root, when the file gave one there.
   *
   * A shorthand for a file describing a single source: every channel inherits
   * it. Kept so writing the file back puts it where it was rather than
   * repeating it on every line.
   */
  site?: string;
  entries: ChannelListEntry[];
  /** Non-fatal problems; the reader never throws on a malformed file. */
  warnings: ChannelListWarning[];
}

export interface ChannelListWarning {
  code:
    /** A `<channel>` with no `site_id`, which cannot identify anything. */
    | 'missing-site-id'
    /** A `<channel>` with an empty `xmltv_id` — unmapped, and reported as such. */
    | 'unmapped-channel'
    /** Two entries claiming the same `site_id` for one site. */
    | 'duplicate-site-id'
    /** The document is not a `<channels>` list at all. */
    | 'unexpected-document';
  message: string;
  /** 1-based line the element began on. */
  line: number;
}

/** How confident a match is, and why it was made. */
export type ChannelMatchKind =
  /** The ids are the same. Nothing to guess at. */
  | 'id'
  /** The names agree once normalized. */
  | 'name'
  /** Nothing lined up. */
  | 'none';

/** What one channel of a wanted list turned out to line up with. */
export interface ChannelMatch<TSource, TCandidate> {
  /** The channel somebody wants a guide for. */
  source: TSource;
  /** What it lines up with, if anything. */
  matched?: TCandidate;
  kind: ChannelMatchKind;
  /** `1` for an id match, lower for a name. */
  confidence: number;
  /**
   * Everything else that matched equally well.
   *
   * A match with rivals is reported rather than applied: two candidates that
   * normalize the same are exactly the case where guessing writes the wrong id
   * into somebody's configuration and the channel silently shows the wrong
   * schedule — worse than showing none.
   */
  ambiguous?: TCandidate[];
}
