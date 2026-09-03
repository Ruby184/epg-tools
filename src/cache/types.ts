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

/**
 * What a remembered thing records about itself, which is when and by what.
 *
 * The same care as {@link StoredEntryMeta} and for the same reason — a cache
 * outlives the code that wrote it — but a different set of questions, so a
 * different number. {@link schema} is this envelope's shape and nothing else:
 * what is *inside* a group is between whoever wrote it and whoever reads it, and
 * a group whose contents have moved on is rebuilt by the one that wants it
 * rather than by the cache.
 */
export interface StoredStateMeta {
  /** ISO timestamp of when this group was last written. */
  writtenAt: string;
  /** Version of the envelope — `STATE_SCHEMA` as this code writes it. */
  schema: number;
  /** The package version that wrote it. */
  writtenBy: string;
}

/**
 * One group of a site's state, as a {@link CacheStore} hands it over: whatever
 * was put there, and the envelope the store vouches for.
 *
 * The meta comes along because it answers the question a reader usually has
 * next — how old is this? — so a group needs no timestamp of its own inside it,
 * and the one that decides is stamped by the cache rather than by a caller who
 * might forget.
 */
export interface StateEntry {
  data: unknown;
  meta: StoredStateMeta;
}

export interface CacheStore {
  /** Metadata for an entry, or `undefined` when not cached. */
  getMeta(key: ChannelDayKey): Promise<CacheEntryMeta | undefined>;
  /**
   * The same for several keys at once, in the order they were asked for.
   *
   * What a grab asks a whole channel's window with, so a store that can settle
   * one in a single question does. Whether it can is the *driver's* business —
   * {@link CacheDriver.readMetas} is the optional half of this — and a store
   * answers either way, by asking for each in turn if that is all it can do.
   *
   * One batch is one piece of work, and an implementation must keep it that
   * way: the caller has already decided how many of these to have in flight,
   * and a store that answers a batch of fourteen by starting fourteen reads at
   * once multiplies that bound by fourteen — which for a cache of files is the
   * descriptor storm the bound exists to prevent.
   */
  getMetas(keys: readonly ChannelDayKey[]): Promise<Array<CacheEntryMeta | undefined>>;
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
  /**
   * What a site last remembered under `key`, or `undefined` when it has
   * remembered nothing this code can vouch for.
   *
   * A site's state is not its listings: it is what a site would otherwise have
   * to fetch again to get back to where it was — a channel list it was given
   * once, an `ETag` for a document it has already read, a token, a cursor.
   * Grouped under a key rather than kept as one object per site so that the
   * groups are read, written and dropped independently: whoever wants a channel
   * list should not have to read every url the last grab revalidated, and a run
   * writing one group must not stand on another's.
   */
  getState(site: string, key: string): Promise<StateEntry | undefined>;
  /**
   * Remember `data` for this site under `key`, replacing whatever was there.
   *
   * `writtenAt` is the one thing a caller may say — a run stamps what it
   * remembers with its own "now", the way it does a `grabbedAt` — and the rest
   * of the envelope is a fact about the writing rather than anyone's to choose.
   */
  setState(site: string, key: string, data: unknown, meta?: { writtenAt?: string }): Promise<void>;
  /**
   * Let go of whatever the store holds open. Nothing is asked of it after.
   *
   * Required here, unlike on a driver, because a run closes the cache it opened
   * without knowing what is underneath — and a store with nothing to release
   * says so in one line rather than making every caller ask whether it can.
   */
  close(): Promise<void>;
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
 * A group of a site's state as a driver found it, with the same distinction
 * {@link FoundMeta} draws: `undefined` for a group nothing has ever written, and
 * this — with `meta` undefined — for one that is there and says nothing anybody
 * can read. The second is worth removing, and only the {@link CacheManager}
 * above decides that.
 *
 * A driver reports an unreadable *payload* the same way as an unreadable meta,
 * by leaving the meta out: an envelope is only worth anything if what it wraps
 * survived with it.
 */
export interface FoundState {
  meta: Partial<StoredStateMeta> | undefined;
  data: unknown;
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
  /**
   * The same for several keys at once, in the order they were asked for.
   *
   * A run asks about every channel-day of its window before it fetches
   * anything, so this is the one thing a cache is asked thousands of times in a
   * row. For a store where each answer is a round trip — a database, anything
   * across a network — asking once for a channel's whole window instead of
   * fourteen times is the difference between a fast sweep and a slow one.
   *
   * {@link CacheDriverBase} implements it by asking {@link readMeta} for each
   * key in turn, so a driver only overrides it if its store can do better.
   * Optional here, so a driver written from scratch need not have it: the
   * manager asks one at a time when it is missing.
   */
  readMetas?(keys: readonly ChannelDayKey[]): Promise<Array<FoundMeta | undefined>>;
  read(key: ChannelDayKey): Promise<FoundEntry<TStored> | undefined>;
  write(key: ChannelDayKey, programmes: TStored[], meta: StoredEntryMeta): Promise<void>;
  delete(key: ChannelDayKey): Promise<void>;
  /** Remove entries for days before `before` (`YYYY-MM-DD`). Returns removed count. */
  prune(options: { before: string }): Promise<number>;
  /**
   * The three that keep a site's state — one small blob per `(site, key)`,
   * holding whatever the grabber put there.
   *
   * Opaque on purpose: a driver stores bytes and hands them back, and never
   * learns what a channel list or an `ETag` is. Which is also what leaves the
   * *encoding* to the store — a driver is free to keep a group as an append-log
   * and replay it on read, so long as `readState` answers with what the last
   * `writeState` was given.
   *
   * Required rather than optional, unlike {@link readMetas}: a store that
   * silently cannot remember anything would have every caller asking whether it
   * can, forever. Remembering nothing is a legitimate answer and it is three
   * one-line bodies — `NoCacheDriver` is exactly that.
   *
   * `key` is a short name of the grabber's choosing (`channels`, `validators`),
   * so a driver that puts it in a path or a column must make it safe there the
   * same way it does a site or a channel id.
   */
  readState(site: string, key: string): Promise<FoundState | undefined>;
  writeState(site: string, key: string, data: unknown, meta: StoredStateMeta): Promise<void>;
  deleteState(site: string, key: string): Promise<void>;
  /** Let go of whatever is held open — a database handle, a connection. */
  close?(): Promise<void>;
}

export interface StalenessPolicy {
  /**
   * Refetch every channel-day in the window, whatever the cache holds.
   *
   * What `--refresh` asks for: a guide built from listings fetched now, rather
   * than from whatever was fresh enough to keep. It is the cache's *reading*
   * that is turned off, not its writing — the days still land in it, so the run
   * after this one has them.
   *
   * Ahead of every other field here, including {@link alwaysRefetchDays}, which
   * only reaches forward from today: a window shifted into the past with
   * `--offset -2` is refetched by this and would not be by that.
   */
  refetchAll: boolean;
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
  refetchAll: false,
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
   *
   * Written to admit `undefined` explicitly, as Node's own `Abortable` is: a
   * caller passing on a signal it may not have would otherwise have to spread
   * the option in conditionally, which is a wart to inflict on everyone writing
   * a driver.
   */
  signal?: AbortSignal | undefined;
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
