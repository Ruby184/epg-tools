import type { SerializeOptions } from '../xmltv/serialize.js';
import type { XmltvChannel, XmltvDocumentMeta, XmltvProgramme } from '../xmltv/types.js';
import type { CacheStore } from '../cache/types.js';
import type { AnySiteConfig } from '../grabber/types.js';
import type { Reporter, Says } from '../core/events.js';

/**
 * What to do when multiple sites cover the same xmltv channel id.
 *
 * - `merge-programmes`: one `<channel>` element with metadata merged from
 *   all covering sites (display names unioned by `(lang, value)`, icons by
 *   `src`); programmes are combined per {@link ProgrammeStrategy}. Site
 *   order = priority.
 * - `first-wins`: one `<channel>` element; only the first (highest priority)
 *   covering site contributes programmes.
 * - `keep-all`: no deduplication at all; everything is emitted as-is.
 */
export type ChannelStrategy = 'merge-programmes' | 'first-wins' | 'keep-all';

/**
 * How programmes of one channel from multiple sites are combined
 * (only relevant for `merge-programmes`).
 *
 * - `merge`: programmes with the same start time are merged into one —
 *   multi-language fields (title, desc, category, ...) are unioned by
 *   `(lang, value)`, scalar fields come from the highest-priority site.
 * - `concat`: all programmes are emitted, sorted by start time, without
 *   deduplication.
 */
export type ProgrammeStrategy = 'merge' | 'concat';

/**
 * Whether two programmes describe the same broadcast — the whole of what
 * `merge` decides, for a source pair no rule quite fits.
 *
 * Called with the higher-priority programme first. It must agree with itself:
 * a pair it accepts in one order it has to accept in the other, or which
 * element wins depends on which site was read first.
 */
export type ProgrammeMatcher = (a: XmltvProgramme, b: XmltvProgramme) => boolean;

/**
 * When two programmes from different sources count as the same broadcast.
 *
 * Sources rarely agree to the second — one publishes the schedule on a
 * five-minute grid while another carries the real start — so matching on the
 * instant alone leaves a guide with two elements per programme, which is the
 * one thing merging exists to prevent.
 */
export interface ProgrammeMatch {
  /**
   * How far apart two starts may be and still be one broadcast, in
   * milliseconds. Defaults to `300_000` (five minutes); `0` matches the
   * instant exactly.
   *
   * A window this wide is safe because of what it is paired with: a shifted
   * pair must also agree on its title, and — when both sides say when they end
   * — be closer together than the shorter of the two runs. Programmes that
   * follow one another are separated by exactly the earlier one's duration, so
   * that last rule is what keeps two same-titled three-minute clips apart no
   * matter how wide this is.
   */
  startToleranceMs?: number;
  /**
   * When titles have to agree for a match:
   *
   * - `when-shifted` (the default) — only for starts that differ. Two sources
   *   naming the same instant are describing the same broadcast whatever they
   *   call it, which is how a Slovak title and an English one end up on one
   *   element.
   * - `always` — even on an identical start, for a channel where two sources
   *   disagree about what is on rather than about what it is called.
   * - `never` — the instant and the duration decide alone.
   */
  titles?: 'when-shifted' | 'always' | 'never';
}

/** What a guide-wide {@link MergeOptions.transform} is told about a programme. */
export interface TransformContext extends Says {
  /** The output channel it belongs to. */
  xmltvId: string;
  /**
   * The programme that follows it on this channel, if the guide has one — the
   * same one `fillStop` and `clipOverlaps` used. Read-only: change it when its
   * own turn comes.
   */
  next?: XmltvProgramme;
}

/**
 * A last say over each programme on its way into the guide: return it, a
 * different one, or nothing at all to leave it out.
 *
 * Returning a *new* object is the safe form — the one handed in may be a cache
 * store's own, and a memory-backed store hands out the same object every read.
 */
export type ProgrammeTransform = (
  programme: XmltvProgramme,
  context: TransformContext,
) => XmltvProgramme | undefined | null;

/**
 * How long a programme with no `stop` may be made to run when the next one's
 * start is used as its end.
 *
 * Six hours by default: long enough for any film, short enough that the gap
 * where a channel stops broadcasting for the night does not become a single
 * nine-hour programme.
 */
export interface FillStopOptions {
  maxMs?: number;
}

export interface MergeOptions {
  channelStrategy?: ChannelStrategy;
  programmeStrategy?: ProgrammeStrategy;
  /**
   * How two programmes are recognized as the same broadcast under
   * `programmeStrategy: 'merge'` — see {@link ProgrammeMatch}, or a
   * {@link ProgrammeMatcher} of your own for a source pair the options cannot
   * describe.
   */
  match?: ProgrammeMatch | ProgrammeMatcher;
  /**
   * Give a programme with no `stop` the next one's start, capped at
   * {@link FillStopOptions.maxMs} (six hours). On by default.
   *
   * A programme without an end is what a consumer can do least with — a
   * zero-length event in tvheadend, nothing at all in some players — and the
   * guide knows the answer, since it has the programme that follows.
   */
  fillStop?: boolean | FillStopOptions;
  /**
   * Pull back a `stop` that reaches past the next programme's start. On by
   * default.
   *
   * Sources overrun for dull reasons — a nominal duration, a late schedule
   * change published only for the programme that followed — and a consumer
   * shown two programmes at once has to guess which is on.
   */
  clipOverlaps?: boolean;
  /**
   * Leave out programmes that start outside the guide's own window. Off by
   * default: a source that hands back a few hours past the last day is giving
   * you something, not making a mistake.
   */
  clampToWindow?: boolean;
  /**
   * The last word on every programme, after the rules above have had theirs —
   * a category map, a title cleanup, dropping what a source pads its schedule
   * with. See {@link ProgrammeTransform}.
   *
   * A programme dropped here leaves the gap it occupied: the rules ran before
   * it went. Dropping is `clampToWindow`'s job, or a site's own `transform`,
   * which runs early enough for the rules to close up after it.
   */
  transform?: ProgrammeTransform;
}

/**
 * A channel that is another channel, shifted — a `+1`.
 *
 * The same schedule an hour later is not a second source to grab, it is
 * arithmetic on one already in the cache. So a derived channel costs no
 * requests: the guide reads its source's cached days again and moves every
 * programme along.
 *
 * `epg channels` is where these usually come from. Given a playlist wanting
 * `Sky One +1`, it declines to map it onto `skyone.uk` — an hour-wrong schedule
 * is worse than none — and reports instead that it *looks like* a shift of it.
 * This is how that report gets answered.
 */
export interface DerivedChannel {
  /**
   * The new channel's id, as the guide will publish it.
   *
   * Must be a channel nothing else produces: colliding with a real channel, or
   * with another derivation, is a declaration that cannot be honoured and fails
   * the run rather than emitting the id twice.
   */
  xmltvId: string;
  /**
   * The `xmltvId` this one shifts — a channel any site covers, or another
   * derived channel. A chain is resolved to its root with the offsets summed.
   */
  from: string;
  /**
   * How far along, in minutes. `60` is a `+1` channel; a negative value shifts
   * earlier.
   *
   * Minutes because that is what {@link timeshiftOf} reads out of a name, and
   * whole minutes because a broadcast schedule has no finer idea of an offset.
   * Under a day: a full day's shift is the same schedule again, and going that
   * far spends the margin the merge keeps for sources whose day runs 06:00 to
   * 06:00 — see the guide's own note on what it holds back.
   */
  offset: number;
  /**
   * What to call it. Defaults to the source's display name with the shift
   * appended — `Sky One` becomes `Sky One +1` — which is the name a playlist
   * uses, so the channel matches by name as well as by id.
   *
   * Only when the offset is a whole number of hours. Otherwise the source's name
   * is inherited unchanged and the merge warns, since two channels with one
   * display name is how a consumer maps the wrong one.
   */
  name?: string;
  /** An icon of its own. Defaults to the source's. */
  logo?: string;
  /** The `lang` of {@link name}. Defaults to the source's first display name's. */
  lang?: string;
  /**
   * The last word on the `<channel>` element, given the one this would have
   * emitted — id, display name and icon already settled, and the source's
   * channel-level extensions already dropped.
   */
  channelInfo?: (element: XmltvChannel) => XmltvChannel;
}

export interface BuildGuideOptions {
  /** Site configs in priority order (first = highest). */
  sites: AnySiteConfig[];
  cache: CacheStore;
  /** Days to include, starting at {@link startDay}. Defaults to 7. */
  days?: number;
  /**
   * How many sites resolve their channel lists in parallel. Defaults to all —
   * pass the run's `siteConcurrency` to hold a merge to the same bound the grab
   * itself uses. Only sites whose `channels` is a function make a request here.
   */
  siteConcurrency?: number;
  /**
   * How many channel-days are read from the cache ahead of the writer.
   * Defaults to 16.
   *
   * A merge otherwise reads one channel-day, writes it, reads the next — and
   * since writing is quick and reading is not, a large guide spends its time on
   * round trips taken one at a time. Reading ahead overlaps them; the window is
   * what bounds the memory, so this is also how many programme lists may be
   * alive at once (a channel-day is one read per covering site, and a
   * {@link DerivedChannel} reads its source's again). `1` is the old
   * strictly-serial behaviour.
   */
  readAhead?: number;
  /**
   * Cancel the merge. Checked as each channel-day comes out of the cache, and
   * carried into the channel-list requests a site's `channels` function makes.
   *
   * The generator rejects with the abort reason rather than stopping quietly:
   * half a document is not a guide, and whoever is writing it needs to know not
   * to keep it — which is what makes `writeGuide` discard the file it was
   * building instead of moving it into place.
   */
  signal?: AbortSignal;
  now?: Date;
  /**
   * First day of the guide window as `YYYY-MM-DD`. Defaults to `now`'s day.
   * Pass the same value used for the grab so both cover the same days.
   */
  startDay?: string;
  merge?: MergeOptions;
  /**
   * Channels that are other channels shifted — see {@link DerivedChannel}. They
   * cost no requests: each reads its source's cached days again.
   */
  derived?: DerivedChannel[];
  /**
   * Keep only these channels, by `xmltvId` — see `EpgConfig.channels`.
   *
   * Applied where the channel lists are resolved, so a site is never asked for
   * a day of a channel this leaves out. Anything named here that no site
   * produces is reported once, as a `merge:warning`.
   */
  channels?: readonly string[];
  meta?: XmltvDocumentMeta;
  /**
   * Where this merge's events go — see {@link Reporter}.
   */
  reporter?: Reporter;
  /**
   * Pretty-print the guide with this indentation (a number of spaces or a
   * string like `'\t'`). Omit for compact output — the default.
   */
  indent?: string | number;
  /**
   * Which provider extensions the guide carries — all of them by default,
   * `false` for none (a DTD-valid document), a list of names, or a filter. See
   * {@link SerializeOptions.extensions}.
   */
  extensions?: SerializeOptions['extensions'];
}
