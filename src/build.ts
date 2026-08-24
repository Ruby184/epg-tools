import path from 'node:path';
import { CacheManager, FsNdjsonCacheDriver, FsXmltvCacheDriver } from './cache/main.js';
import type { CacheDriver } from './cache/main.js';
import { grab, resolveSites } from './grabber/main.js';
import type { GrabSummary } from './grabber/types.js';
import { generateGuide, writeGuide } from './merge/main.js';
import type { BuildGuideOptions } from './merge/types.js';
import { addDays, toDayString } from './core/days.js';
import { GrabberError } from './core/error.js';
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
   * Shift the window by this many days relative to `now` (may be negative).
   * Defaults to 0 — i.e. the window starts today. `now` itself is untouched,
   * so staleness and the `grabbedAt` stamp keep using the real current time.
   */
  offset?: number;
  logger?: (message: string) => void;
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
  const options = {
    dir: config.cache?.dir ?? path.join(process.cwd(), '.epg-cache'),
    ...(signal ? { signal } : {}),
  };
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
  options: { dir: string; signal?: AbortSignal },
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
    case 'sqlite': {
      // Imported here and nowhere else: `node:sqlite` does not exist on every
      // runtime this package supports, so naming it is what loads it.
      const { SqliteCacheDriver } = await import('./cache/sqlite-driver.js');

      return new SqliteCacheDriver(options);
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
 * Run `work` with the cache the config describes, and let go of it after.
 *
 * A driver may hold something open — a database handle, a connection — and a
 * cache belongs to one run, so the run is what closes it. The `finally` is the
 * point: a grab that threw, or one that was cancelled half way, has the same
 * handle to give back as one that finished.
 */
async function withCache<T>(
  config: EpgConfig,
  signal: AbortSignal | undefined,
  work: (cache: CacheManager) => Promise<T>,
): Promise<T> {
  const cache = await createCacheStore(config, signal);

  try {
    return await work(cache);
  } finally {
    await cache.close();
  }
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
  cache: CacheManager,
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
    ...(config.meta ? { meta: config.meta } : {}),
    ...(config.indent !== undefined ? { indent: config.indent } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  };
}

/** Grab all sites into the cache (only stale/missing channel-days are fetched). */
export async function runGrab(
  source: ConfigSource,
  options: RunOptions = {},
): Promise<GrabSummary> {
  const config = await resolveConfigSource(source);
  const now = options.now ?? new Date();
  const startDay = startDayOf(options, now);

  return withCache(config, options.signal, async (cache) => {
    const summary = await grab(config.sites, {
      cache,
      startDay,
      ...(config.days !== undefined ? { days: config.days } : {}),
      ...(config.siteConcurrency !== undefined ? { siteConcurrency: config.siteConcurrency } : {}),
      ...(config.localConcurrency !== undefined
        ? { localConcurrency: config.localConcurrency }
        : {}),
      ...(config.cache?.staleness ? { staleness: config.cache.staleness } : {}),
      now,
      ...(options.logger ? { logger: options.logger } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
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
        options.logger?.(`Pruned ${removed} cached day(s) older than ${before}`);
      }
    }

    return summary;
  });
}

/** Generate the merged XMLTV guide from the cache, without grabbing. */
export async function runMerge(source: ConfigSource, options: RunOptions = {}): Promise<void> {
  const config = await resolveConfigSource(source);

  await withCache(config, options.signal, async (cache) =>
    writeGuide({
      ...guideOptions(config, options, options.now ?? new Date(), cache),
      output: config.output,
    }),
  );
}

/**
 * The merged guide as a stream of XML chunks, without writing a file — for
 * piping to stdout or an HTTP response with constant memory.
 */
export async function* guideStream(
  source: ConfigSource,
  options: RunOptions = {},
): AsyncGenerator<string> {
  const config = await resolveConfigSource(source);
  const cache = await createCacheStore(config, options.signal);

  try {
    yield* generateGuide(guideOptions(config, options, options.now ?? new Date(), cache));
  } finally {
    // Whether the caller read the guide to its end or walked away half way
    // through it: a generator's `finally` runs either way, and a driver holding
    // a handle open is waiting for exactly this.
    await cache.close();
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
export async function build(source: ConfigSource, options: RunOptions = {}): Promise<GrabSummary> {
  // Resolved once and passed on: a factory may read the environment or fetch,
  // and the grab and the merge that follows it must agree on one answer.
  const config = await resolveConfigSource(source);
  const now = options.now ?? new Date();

  // Channel lists too, and for the same reason one level down: a site that
  // fetches its channels would otherwise be asked twice, and a list that
  // changed in between would leave the guide describing channels the grab
  // never went for.
  const resolved: EpgConfig = {
    ...config,
    sites: await resolveSites(config.sites, {
      ...(config.siteConcurrency !== undefined ? { concurrency: config.siteConcurrency } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    }),
  };

  const summary = await runGrab(resolved, { ...options, now });

  if (options.signal?.aborted !== true) {
    await runMerge(resolved, { ...options, now });
  }

  return summary;
}
