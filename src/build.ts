import path from 'node:path';
import {
  CacheManager,
  FsNdjsonCacheDriver,
  FsXmltvCacheDriver,
  MemoryCacheDriver,
} from './cache/main.js';
import type { CacheDriver, CacheStore } from './cache/main.js';
import { covered, coverageOf, grab, resolveSites } from './grabber/main.js';
import { threadCount } from './grabber/thread.js';
import type { AnySiteConfig, GrabberChannel, GrabSummary } from './grabber/types.js';
import { generateGuide, writeGuide } from './merge/main.js';
import { channelSelection, configured, unmatched, unmatchedMessage } from './merge/select.js';
import type { BuildGuideOptions, DerivedChannel } from './merge/types.js';
import { outputOptions } from './xmltv/serialize.js';
import { addDays, toDayString } from './core/days.js';
import { GrabberError } from './core/error.js';
import type { Emit, Reporter, Says } from './core/events.js';
import { emitter, reportingTo } from './core/events.js';
import {
  resolveConfigSource,
  type ConfigSource,
  type EpgCacheConfig,
  type EpgConfig,
} from './config.js';

export interface RunOptions {
  now?: Date;
  /**
   * Cancel the run.
   *
   * A grab stops asking for anything more and resolves with the partial summary
   * rather than rejecting: what reached the cache is in it, and only what was
   * actually interrupted counts as failed. A merge stops between channel-days
   * and rejects with the abort reason, so the guide it was part-way through
   * writing is discarded rather than replacing a complete one — the output is
   * written beside the file it is for and renamed only when the document is
   * finished.
   */
  signal?: AbortSignal;
  /**
   * The cache to use, rather than the one the config describes.
   *
   * For a caller that has one already — a test, a long-lived process running
   * several builds, anything that would rather open a database once than once
   * per run. It is the caller's: nothing here closes what it did not open.
   *
   * A {@link build} sets this for itself, which is what makes its grab and its
   * merge share one store instead of asking the config twice.
   */
  cache?: CacheStore;
  /**
   * Shift the window by this many days relative to `now` (may be negative).
   * Defaults to 0 — i.e. the window starts today. `now` itself is untouched,
   * so staleness and the `grabbedAt` stamp keep using the real current time.
   */
  offset?: number;
  /**
   * Where this run's events go — see {@link Reporter}.
   *
   * A function told what happened as it happens, which is what both halves of a
   * run and every site in it report through. `textReporter` and `jsonReporter`
   * are the ones this package ships.
   */
  reporter?: Reporter;
  /**
   * The module the config came from — a path or a URL whose default export is
   * it — which a config with `threads: true` needs: each site's worker imports
   * it to find that site. The `epg` command fills it in with the file it
   * loaded. A module of its own, never the program calling this, which every
   * worker would otherwise run again.
   */
  configModule?: string | URL;
}

/**
 * The cache the config describes. Takes a resolved {@link EpgConfig} rather
 * than a {@link ConfigSource}: it is the one entry point that returns
 * synchronously, and resolving may have to await.
 */
export async function createCacheStore(
  config: EpgConfig,
  signal?: AbortSignal,
): Promise<CacheManager> {
  const options = { dir: config.cache?.dir ?? path.join(process.cwd(), '.epg-cache'), signal };
  const driver = config.cache?.driver;

  return new CacheManager({
    driver: await driverFor(options, driver),
    ...(config.cache?.invalidate ? { invalidate: config.cache.invalidate } : {}),
  });
}

/**
 * A name is one of ours; anything else is a factory, and it is handed the same
 * two things a driver of ours gets — where the cache lives and when to give up —
 * since whatever else it needs is in scope where it was written.
 */
async function driverFor(
  options: { dir: string; signal?: AbortSignal | undefined },
  driver: EpgCacheConfig['driver'] = 'ndjson',
): Promise<CacheDriver> {
  if (typeof driver === 'function') {
    return driver(options);
  }

  switch (driver) {
    case 'ndjson':
      return new FsNdjsonCacheDriver(options);
    case 'xmltv':
      return new FsXmltvCacheDriver(options);
    case 'memory':
      return new MemoryCacheDriver();
    case 'sqlite': {
      // Imported here and nowhere else: `node:sqlite` does not exist on every
      // runtime this package supports, so naming it is what loads it — and what
      // fails, on a Node that has never heard of it. Which is worth saying in
      // terms of the choice that led here rather than leaving Node to say "No
      // such built-in module" about something the config never mentioned.
      try {
        const { SqliteCacheDriver } = await import('./cache/sqlite-driver.js');

        return new SqliteCacheDriver(options);
      } catch (error) {
        throw new GrabberError(
          `The sqlite cache driver needs Node 24 or newer (22.5 with --experimental-sqlite): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    default: {
      // Unreachable from TypeScript, which is what the `never` says: every name
      // has a case above, and adding one to `CacheDriverName` without a case
      // here fails to compile. A config written in JavaScript can still ask for
      // a driver that does not exist, and is told so rather than quietly given
      // the default — a cache in the wrong shape is a run's worth of requests.
      const named: never = driver;

      throw new GrabberError(`Unknown cache driver: ${String(named)}`);
    }
  }
}

/**
 * The cache for a run, and what to do with it when the run is over.
 *
 * A driver may hold something open — a database handle, a connection — and a
 * cache made for one run is that run's to close. One handed in through
 * {@link RunOptions.cache} is not: the caller opened it and may well use it
 * again, which is exactly how a `build` gives its grab and its merge the same
 * store.
 */
async function cacheFor(
  config: EpgConfig,
  options: RunOptions,
): Promise<{ cache: CacheStore; release: () => Promise<void> }> {
  if (options.cache !== undefined) {
    return { cache: options.cache, release: async () => {} };
  }

  const cache = await createCacheStore(config, options.signal);

  return { cache, release: () => cache.close() };
}

/**
 * Run `work` with the run's cache, and let go of it after.
 *
 * The `finally` is the point: a grab that threw, or one cancelled half way, has
 * the same handle to give back as one that finished.
 */
async function withCache<T>(
  config: EpgConfig,
  options: RunOptions,
  work: (cache: CacheStore) => Promise<T>,
): Promise<T> {
  const { cache, release } = await cacheFor(config, options);

  try {
    return await work(cache);
  } finally {
    await release();
  }
}

/**
 * Whether `cover` can take a channel away from a site.
 *
 * Read off the config rather than passed around: the grab has to know it as
 * much as the merge does, and they have to read it the same way or a run
 * fetches what the guide then leaves out. It also says whether the channel
 * lists are worth resolving early — a coverage that takes nothing away gives a
 * run nothing to compare them for.
 */
const narrowed = (config: EpgConfig): boolean => coverageOf(config.merge?.cover) !== undefined;

/** Where a `cover` rule's own words go, which is where a merge's do. */
const saysOf = (emit: Emit): Says => ({
  log: (message, data) => emit({ type: 'merge:note', message, ...(data ? { data } : {}) }),
  warn: (message, data) => emit({ type: 'merge:warning', message, ...(data ? { data } : {}) }),
});

/** Said once per site that lost channels to another, with how many. */
const droppedBy =
  (emit: Emit) =>
  (site: string, count: number): void => {
    emit({
      type: 'site:note',
      site,
      message: `${String(count)} channel(s) left to another site by \`cover\``,
    });
  };

/** What {@link settled} leaves a run to grab, and a build to merge. */
interface Settled {
  /** Every site whose list resolved, narrowed by the selection and by `cover`. */
  sites: AnySiteConfig[];
  /**
   * The sites whose list could not be resolved, and why — for the grab and not
   * the merge: the grab says so and counts each as a site that answered
   * nothing, as it does for a list that fails in its own hands.
   */
  failures: { site: string; error: unknown }[];
  /** What `derived` declared about these lists, as the selection left it. */
  derived: DerivedChannel[] | undefined;
}

/**
 * The channel lists a run goes by, settled before any site is asked for a day:
 * resolved once, `derived` asked about them, the selection applied, and
 * `cover`'s choices made.
 *
 * Before the grab, which is the point of each: a channel the selection leaves
 * out is never fetched, and one `cover` leaves to another site is never asked
 * of this one. And once, for a build — a site that fetches its channels would
 * otherwise be asked by both halves, and a list that changed in between would
 * leave the guide describing channels the grab never went for.
 */
async function settled(
  config: EpgConfig,
  cache: CacheStore,
  options: RunOptions,
  now: Date,
  emit: Emit,
): Promise<Settled> {
  const failures: Settled['failures'] = [];
  const sites = await resolveSites(config.sites, {
    ...(config.siteConcurrency !== undefined ? { concurrency: config.siteConcurrency } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    // What a site says while fetching its list, which happens here rather than
    // inside the grab — so without this it would be said nowhere.
    emit,
    store: cache,
    // `--refresh` means ask the source, and a channel list is something the
    // source says.
    ...(config.cache?.staleness?.refetchAll === true ? { refresh: true } : {}),
    now,
    // One source down is not every source down: the rest are settled and
    // grabbed, and this one is counted.
    failed: (site, error) => {
      failures.push({ site: site.site, error });

      return undefined;
    },
  });

  // After the lists, because a `derived` function is a function *of* them. The
  // selection then narrows what was resolved, which is the same answer as
  // narrowing on the way out of each site: what a site stores is its whole list
  // either way.
  const declarations = await configured(config.derived, {
    channels: sites.flatMap((site) => site.channels as GrabberChannel[]),
    now,
    ...saysOf(emit),
  });
  // Only the two fields a selection reads, so a `derived` that is still a
  // function never reaches it.
  const selection = channelSelection({
    ...(config.channels ? { channels: config.channels } : {}),
    ...(declarations ? { derived: declarations } : {}),
  });
  const selected = selection
    ? sites.map((site) => ({
        ...site,
        channels: (site.channels as GrabberChannel[]).filter((channel) =>
          selection.select.has(channel.xmltvId),
        ),
      }))
    : sites;
  const kept = narrowed(config)
    ? await covered(selected, config.merge?.cover, { now, ...saysOf(emit) }, droppedBy(emit))
    : selected;

  // Here, before the grab: a mistyped id should cost a sentence, not every
  // request of a run that was always going to come up short.
  const missing = unmatched(
    selection,
    kept.flatMap((site) => (site.channels as GrabberChannel[]).map((channel) => channel.xmltvId)),
  );

  if (missing.length > 0) {
    emit({
      type: 'merge:warning',
      message: unmatchedMessage(missing, selection?.select.size ?? 0),
    });
  }

  return { sites: kept, failures, derived: selection?.derived ?? declarations };
}

/** First day of the window implied by `now` + `offset`. */
function startDayOf(options: RunOptions, now: Date): string {
  const today = toDayString(now);
  return options.offset ? addDays(today, options.offset) : today;
}

/** Shared option assembly for the two merge entry points. */
function guideOptions(
  config: EpgConfig,
  options: RunOptions,
  now: Date,
  cache: CacheStore,
): BuildGuideOptions {
  return {
    sites: config.sites,
    cache,
    startDay: startDayOf(options, now),
    now,
    ...(config.days !== undefined ? { days: config.days } : {}),
    ...(config.siteConcurrency !== undefined ? { siteConcurrency: config.siteConcurrency } : {}),
    // The same bound the grab gives its own local work, for the same resource:
    // how many cache entries are open at once, and how many programme lists
    // are alive while one is being written.
    ...(config.localConcurrency !== undefined ? { readAhead: config.localConcurrency } : {}),
    ...(config.merge ? { merge: config.merge } : {}),
    ...(config.derived ? { derived: config.derived } : {}),
    ...(config.channels ? { channels: config.channels } : {}),
    ...(config.meta ? { meta: config.meta } : {}),
    ...outputOptions(config),
    ...reported(options),
    ...(options.signal ? { signal: options.signal } : {}),
  };
}

/**
 * The sink, passed on as it was.
 *
 * Not resolved to an `Emit` here: each half builds its own from the same
 * function, so a run's two halves report through one reporter without either
 * knowing about the other.
 */
function reported(options: RunOptions): Pick<RunOptions, 'reporter'> {
  return options.reporter ? { reporter: options.reporter } : {};
}

/**
 * The grab half of a run, over sites ready to grab — and the prune after it.
 *
 * Handed options that already report where the config says, rather than a
 * config to work that out from: `build` adds the config's `events` once, for
 * both halves, and a grab that added them again would say everything twice.
 */
async function grabInto(
  config: EpgConfig,
  sites: AnySiteConfig[],
  failedSites: Settled['failures'],
  cache: CacheStore,
  options: RunOptions,
  now: Date,
): Promise<GrabSummary> {
  const startDay = startDayOf(options, now);
  const summary = await grab(sites, {
    cache,
    startDay,
    ...(config.days !== undefined ? { days: config.days } : {}),
    ...(config.siteConcurrency !== undefined ? { siteConcurrency: config.siteConcurrency } : {}),
    ...(config.localConcurrency !== undefined ? { localConcurrency: config.localConcurrency } : {}),
    ...(config.cache?.staleness ? { staleness: config.cache.staleness } : {}),
    now,
    ...reported(options),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(config.threads === undefined ? {} : { threads: config.threads }),
    ...(options.configModule === undefined ? {} : { configModule: options.configModule }),
    ...(failedSites.length > 0 ? { failedSites } : {}),
  });

  // Nothing more is asked of the cache once the run is off: pruning a window
  // the grab never finished filling would take days it might still have
  // wanted.
  if (config.cache?.prune !== false && options.signal?.aborted !== true) {
    // Never prune inside the window we just grabbed: a negative offset puts
    // the window start before today, and those days must survive.
    const today = toDayString(now);
    const before = startDay < today ? startDay : today;
    const removed = await cache.prune({ before });

    if (removed > 0) {
      emitter(options)({ type: 'prune:done', removed, before });
    }
  }

  return summary;
}

/** Grab all sites into the cache (only stale/missing channel-days are fetched). */
export async function runGrab(source: ConfigSource, given: RunOptions = {}): Promise<GrabSummary> {
  const config = await resolveConfigSource(source);
  const options = reportingTo(given, config.events);

  // Before a channel list is fetched: a run that cannot start its threads says
  // so first, rather than after every site has been asked for one.
  threadCount(config.threads, options.configModule);
  const now = options.now ?? new Date();

  return withCache(config, options, async (cache) => {
    // Settled here only when there is something to narrow — a `cover` that
    // takes channels away. Every site resolves its own list anyway, so this is
    // the same work done early enough to act on, and a `cacheChannels` site
    // answers from the cache both times.
    if (!narrowed(config)) {
      return grabInto(config, config.sites, [], cache, options, now);
    }

    const settling = await settled(config, cache, options, now, emitter(options));

    return grabInto(config, settling.sites, settling.failures, cache, options, now);
  });
}

/** Generate the merged XMLTV guide from the cache, without grabbing. */
export async function runMerge(source: ConfigSource, given: RunOptions = {}): Promise<void> {
  const config = await resolveConfigSource(source);
  const options = reportingTo(given, config.events);

  await withCache(config, options, async (cache) =>
    writeGuide({
      ...guideOptions(config, options, options.now ?? new Date(), cache),
      output: config.output,
      ...(config.compress !== undefined ? { compress: config.compress } : {}),
    }),
  );
}

/**
 * The merged guide as a stream of XML chunks, without writing a file — for
 * piping to stdout or an HTTP response with constant memory.
 */
export async function* guideStream(
  source: ConfigSource,
  given: RunOptions = {},
): AsyncGenerator<string> {
  const config = await resolveConfigSource(source);
  const options = reportingTo(given, config.events);
  const { cache, release } = await cacheFor(config, options);

  try {
    yield* generateGuide(guideOptions(config, options, options.now ?? new Date(), cache));
  } finally {
    // Whether the caller read the guide to its end or walked away half way
    // through it: a generator's `finally` runs either way, and a driver holding
    // a handle open is waiting for exactly this.
    await release();
  }
}

/**
 * Grab into the cache, then generate the merged guide.
 *
 * A cancelled run stops after the grab: the summary says what reached the
 * cache, and no guide is written. Half a window is not what the guide in place
 * should be replaced with, and the next run continues from what this one
 * cached.
 */
export async function build(source: ConfigSource, given: RunOptions = {}): Promise<GrabSummary> {
  // Resolved once and passed on: a factory may read the environment or fetch,
  // and the grab and the merge that follows it must agree on one answer.
  const config = await resolveConfigSource(source);
  const options = reportingTo(given, config.events);
  const now = options.now ?? new Date();

  // As `runGrab` does, and for the same reason: before the lists below.
  threadCount(config.threads, options.configModule);

  // One cache for both halves, rather than each of them asking the config for
  // its own: a driver that opens a database opens it once, and one that keeps
  // entries in memory is still holding them when the merge comes to read.
  //
  // Opened before the channel lists are resolved, rather than after, because
  // that is where a site's cached list lives — a `cacheChannels` site then makes
  // no request for a list this cache already has.
  return withCache(config, options, async (cache) => {
    // Settled once for both halves, which have to agree about what exists.
    const settling = await settled(config, cache, options, now, emitter(options));
    // Without the selection, which the lists already went through, and without
    // `events`, which `options` already reports to: a half handed either would
    // act on it a second time — the same warning about the same missing
    // channels, every event twice.
    const { channels: _applied, events: _reported, ...rest } = config;
    const resolved: EpgConfig = {
      ...rest,
      ...(settling.derived ? { derived: settling.derived } : {}),
      sites: settling.sites,
    };
    const summary = await grabInto(
      resolved,
      settling.sites,
      settling.failures,
      cache,
      options,
      now,
    );

    if (options.signal?.aborted !== true) {
      await runMerge(resolved, { ...options, now, cache });
    }

    return summary;
  });
}
