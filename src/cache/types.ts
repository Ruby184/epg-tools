import type { XmltvProgramme } from '../xmltv/types.js';

/** Identifies one cached unit: programmes of one channel for one UTC day. */
export interface ChannelDayKey {
  site: string;
  channelId: string;
  /** UTC day as `YYYY-MM-DD`. */
  day: string;
}

/** On-disk representation of cached programmes. */
export type CacheFormat = 'ndjson' | 'xmltv';

export interface CacheEntryMeta {
  /** ISO timestamp of when this entry was grabbed. */
  grabbedAt: string;
  programmeCount: number;
}

export interface CacheStore {
  /** Metadata for an entry, or `undefined` when not cached. */
  getMeta(key: ChannelDayKey): Promise<CacheEntryMeta | undefined>;
  /** Cached programmes, or `undefined` when not cached. */
  read(key: ChannelDayKey): Promise<XmltvProgramme[] | undefined>;
  write(key: ChannelDayKey, programmes: XmltvProgramme[], meta?: Partial<CacheEntryMeta>): Promise<void>;
  delete(key: ChannelDayKey): Promise<void>;
  /** Remove entries for days before `before` (`YYYY-MM-DD`). Returns removed count. */
  prune(options: { before: string }): Promise<number>;
}

export interface StalenessPolicy {
  /**
   * Number of days from "today" (inclusive) that are always refetched,
   * regardless of cache state. `1` = refetch today only, `2` = today and
   * tomorrow, `0` = never force-refetch.
   */
  alwaysRefetchDays: number;
  /** Bust any cached entry grabbed more than this many days ago. */
  maxAgeDays: number;
}

export const DEFAULT_STALENESS: StalenessPolicy = {
  alwaysRefetchDays: 1,
  maxAgeDays: 7,
};

export interface FsCacheStoreOptions {
  /** Root directory of the cache. */
  dir: string;
  /** Format used for newly written entries. Defaults to `ndjson`. */
  format?: CacheFormat;
}
