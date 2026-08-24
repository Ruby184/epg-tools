import type { XmltvProgramme } from '../xmltv/types.js';

/** Identifies one cached unit: programmes of one channel for one UTC day. */
export interface ChannelDayKey {
  site: string;
  channelId: string;
  /** UTC day as `YYYY-MM-DD`. */
  day: string;
}

/**
 * A driver this package ships, by name — what a config can ask for.
 *
 * `'sqlite'` is loaded only when named, since `node:sqlite` is not on every
 * runtime this package supports: Node 22.5 behind `--experimental-sqlite`, and
 * unflagged from Node 24.
 *
 * `'memory'` remembers nothing past the process, which is what a `build` needs
 * it to remember: its grab and its merge share one cache, so the guide is
 * written from what was just grabbed. Two commands cannot share it — `epg grab`
 * and then `epg merge` would find nothing — and neither can two processes.
 */
export const CACHE_DRIVER_NAMES = ['ndjson', 'xmltv', 'sqlite', 'memory'] as const;

export type CacheDriverName = (typeof CACHE_DRIVER_NAMES)[number];

/** What a run needs to know about a cached entry to decide anything about it. */
export interface CacheEntryMeta {
  /** ISO timestamp of when this entry was grabbed. */
  grabbedAt: string;
  programmeCount: number;
}

/**
 * What an entry records about itself, which is that and two versions.
 *
 * A cache outlives the code that wrote it. It survives an upgrade, sits in a
 * container image, gets copied between machines — so an entry has to be able to
 * say what it is, rather than being read on the assumption that whatever wrote
 * it agreed with whatever is reading it. Two fields, because there are two
 * questions with different answers:
 *
 * - {@link schema} is the shape, and it is the one that decides. A mismatch
 *   either way means an entry this code cannot read as it was meant, so it is
 *   void and the day is grabbed again — which is all a cache ever has to do
 *   about it, being by definition something that can be thrown away.
 * - {@link writtenBy} is who wrote it, and decides nothing on its own. It is
 *   what `getMeta` can tell you when you are looking at a cache and wondering,
 *   and what an `invalidate` hook has to judge by when a release turns out to
 *   have changed something the schema number does not describe.
 */
export interface StoredEntryMeta extends CacheEntryMeta {
  /** Version of the stored shape — `CACHE_SCHEMA` as this code writes it. */
  schema: number;
  /** The package version that wrote this entry. */
  writtenBy: string;
}

export interface CacheStore {
  /** Metadata for an entry, or `undefined` when not cached. */
  getMeta(key: ChannelDayKey): Promise<CacheEntryMeta | undefined>;
  /** Cached programmes, or `undefined` when not cached. */
  read(key: ChannelDayKey): Promise<XmltvProgramme[] | undefined>;
  write(
    key: ChannelDayKey,
    programmes: XmltvProgramme[],
    meta?: Partial<CacheEntryMeta>,
  ): Promise<void>;
  delete(key: ChannelDayKey): Promise<void>;
  /** Remove entries for days before `before` (`YYYY-MM-DD`). Returns removed count. */
  prune(options: { before: string }): Promise<number>;
  /** Let go of whatever the store holds open. Nothing is asked of it after. */
  close?(): Promise<void>;
}

/**
 * One programme as a driver that stores JSON keeps it: a plain object whose
 * dates are XMLTV strings rather than `Date`s, so neither the offset the source
 * wrote them in nor how precise it was is lost on the way through
 * `JSON.stringify`. Made and read back by {@link CacheDriverBase}'s record pair.
 */
export type StoredProgramme = Record<string, unknown>;

/**
 * What a driver found where an entry might be: whatever it says about itself.
 *
 * The wrapper is what tells the two kinds of nothing apart. A driver returns
 * `undefined` when there is no entry — a day never grabbed, which is ordinary
 * and costs nothing — and this, with `meta` undefined, when there is one that
 * says nothing anybody can read. Only the second is worth removing, and one of
 * them is by far the common case, so a manager that could not tell would be
 * deleting a thousand entries a run that were never there.
 *
 * The meta is `Partial` because what is in a store is whatever was last written
 * there: by an older version of this package, by a half-finished write, by a
 * person with an editor. A driver reports what it found; deciding whether that
 * is an entry at all belongs to the {@link CacheManager} above it, which is the
 * one place the judgement is made the same way for every driver.
 */
export interface FoundMeta {
  meta: Partial<StoredEntryMeta> | undefined;
}

/** An entry as a driver found it: what it says about itself, and its programmes. */
export interface FoundEntry<T> extends FoundMeta {
  programmes: T[];
}

/**
 * Where cached programmes actually live.
 *
 * A driver answers for one store — a directory of files, a database, a bucket —
 * and nothing else: it holds no policy, decides nothing about freshness, and is
 * not asked to stamp or check an entry's meta. All of that belongs to the
 * {@link CacheManager} it is given to, which is what makes writing one of these
 * a small job.
 *
 * A driver reads and writes programmes in whatever form it keeps them —
 * `TStored`, which only it knows about — and says how one is made and read back
 * with {@link toStored} and {@link fromStored}. The manager is what calls those,
 * at the two moments they are needed, so no driver has to remember to. What they
 * do is a driver's own business, and {@link CacheDriverBase} — where a new
 * driver should start — has already answered it: JSON with the dates in XMLTV
 * form, so the offset and the precision they came with survive.
 */
export interface CacheDriver<TStored = unknown> {
  /** One programme as this driver keeps it. */
  toStored(programme: XmltvProgramme): TStored;
  /** The programme one stored thing stands for. */
  fromStored(stored: TStored): XmltvProgramme;
  /**
   * What one entry says about itself, without its programmes.
   *
   * The hot path: a run asks this for every channel-day it is considering and
   * then mostly leaves the entry alone, so a driver should answer it without
   * reading what it does not need.
   */
  readMeta(key: ChannelDayKey): Promise<FoundMeta | undefined>;
  read(key: ChannelDayKey): Promise<FoundEntry<TStored> | undefined>;
  write(key: ChannelDayKey, programmes: TStored[], meta: StoredEntryMeta): Promise<void>;
  delete(key: ChannelDayKey): Promise<void>;
  /** Remove entries for days before `before` (`YYYY-MM-DD`). Returns removed count. */
  prune(options: { before: string }): Promise<number>;
  /** Let go of whatever is held open — a database handle, a connection. */
  close?(): Promise<void>;
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
  /**
   * {@link maxAgeDays} for an entry that came back with no programmes at all.
   * Defaults to `1`, so a source that was briefly broken is asked again the
   * next day rather than leaving a hole in the guide for a week — while a
   * channel that legitimately has no listings costs one request a day rather
   * than one per run.
   *
   * `0` refetches an empty day on any later run (an entry written during the
   * current run is not yet a day old, so nothing loops); a large value ages
   * empty entries out exactly as full ones.
   */
  emptyMaxAgeDays: number;
}

export const DEFAULT_STALENESS: StalenessPolicy = {
  alwaysRefetchDays: 1,
  maxAgeDays: 7,
  emptyMaxAgeDays: 1,
};

export interface FsCacheDriverOptions {
  /** Root directory of the cache. */
  dir: string;
  /**
   * Give up on the reads and writes this driver is asked for.
   *
   * A driver belongs to one run, so it is said once here rather than on every
   * call — which is also what keeps {@link CacheDriver} something anyone can
   * implement with three arguments and no ceremony. A write is stopped before
   * its rename, never during it, so an entry is either there in full or not
   * there at all; a prune stops between days.
   */
  signal?: AbortSignal;
}

export interface CacheManagerOptions {
  /** Where the entries live. */
  driver: CacheDriver;
  /**
   * One more reason an entry is void, beyond the ones every cache has.
   *
   * The shape is already checked, and a {@link StoredEntryMeta.schema} this code
   * does not write is already refused — that covers a stored form that changed.
   * This is for everything else: a release whose grabbing changed rather than
   * its storing, so entries {@link StoredEntryMeta.writtenBy | written by}
   * anything before it are worth dropping; a site whose ids were renamed; a
   * cache to be emptied gradually rather than at once.
   *
   * Returning `true` removes the entry, and the day then reads as never
   * grabbed, so the next run fetches it. Called for every entry a run looks at,
   * which is thousands of times — so it should decide from the meta it is given
   * and nothing further.
   */
  invalidate?: (meta: StoredEntryMeta, key: ChannelDayKey) => boolean;
}
