import type { XmltvDocumentMeta } from '../xmltv/types.js';
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

export interface MergeOptions {
  channelStrategy?: ChannelStrategy;
  programmeStrategy?: ProgrammeStrategy;
}

export interface BuildGuideOptions {
  /** Site configs in priority order (first = highest). */
  sites: AnySiteConfig[];
  cache: CacheStore;
  /** Days to include, starting at {@link startDay}. Defaults to 7. */
  days?: number;
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
