import type { XmltvDocumentMeta, XmltvProgramme } from '../xmltv/types.js';
import type { CacheStore } from '../cache/types.js';
import type { AnySiteConfig } from '../grabber/types.js';

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
  now?: Date;
  /**
   * First day of the guide window as `YYYY-MM-DD`. Defaults to `now`'s day.
   * Pass the same value used for the grab so both cover the same days.
   */
  startDay?: string;
  merge?: MergeOptions;
  meta?: XmltvDocumentMeta;
  logger?: (message: string) => void;
  /**
   * Pretty-print the guide with this indentation (a number of spaces or a
   * string like `'\t'`). Omit for compact output — the default.
   */
  indent?: string | number;
}
