import type {
  CacheDriver,
  CacheDriverName,
  CacheManagerOptions,
  StalenessPolicy,
} from './cache/types.js';
import {
  createConfigContext,
  defaultsReader,
  envReader,
  type ConfigContext,
  type ConfigReader,
  type StageDefaults,
} from './core/answers.js';
import type { CompressionFormat, CompressionOptions } from './core/output.js';
import type { MissingAllowance } from './grabber/missing.js';
import type { EpgServeConfig } from './serve/config.js';
import type { AnySiteConfig } from './grabber/types.js';
import type { MergeOptions } from './merge/types.js';
import type { SerializeOptions } from './xmltv/serialize.js';
import type { XmltvDocumentMeta } from './xmltv/types.js';
import type { ReporterFactory, ReporterName } from './core/reporters.js';

/**
 * What builds the driver a run keeps its cache in.
 *
 * Given the directory the config settled on and the run's signal — a driver that
 * keeps files needs the first, one that opens a database needs somewhere to put
 * it, one that talks to something else can ignore both. Whatever else a driver
 * of yours takes is in scope where you write the function, which is why there is
 * no options bag here: a config file is TypeScript.
 *
 * It may await, for a connection to open or a schema to make sure of, and the
 * run does so before asking the cache for anything.
 */
export type CacheDriverFactory = (options: {
  dir: string;
  signal?: AbortSignal | undefined;
}) => CacheDriver | Promise<CacheDriver>;

export interface EpgCacheConfig {
  /** Cache directory. Defaults to `.epg-cache` in the working directory. */
  dir?: string;
  /**
   * Where and how cached days are kept. Defaults to `'ndjson'`.
   *
   * A name for a driver this package ships — `'ndjson'` and `'xmltv'` are both
   * files under {@link dir}, one per channel-day — or a
   * {@link CacheDriverFactory} returning one of your own, which is how a cache
   * ends up anywhere else: a database, a bucket, a key-value store two machines
   * share. See [the cache API](../docs/api.md#epg-toolscache).
   */
  driver?: CacheDriverName | CacheDriverFactory;
  staleness?: Partial<StalenessPolicy>;
  /** Remove cached days older than today after a successful grab. Defaults to true. */
  prune?: boolean;
  /**
   * One more reason a cached entry is void, beyond the ones every cache has.
   *
   * The stored shape is already checked, so this is for what that cannot
   * describe: a release whose grabbing changed rather than its storing, a site
   * whose channel ids were renamed, a cache to be emptied gradually. Return
   * `true` and the entry goes, so the day reads as never grabbed.
   */
  invalidate?: CacheManagerOptions['invalidate'];
}

export interface EpgConfig {
  /** Site configs in priority order (first = highest priority on conflicts). */
  sites: AnySiteConfig[];
  /** Number of days to grab and include in the guide. Defaults to 7. */
  days?: number;
  /**
   * Where the guide is written: a path, replaced atomically once complete, or
   * a Unix socket to stream it into — which is how tvheadend's *External
   * XMLTV* module takes one.
   */
  output: string;
  /**
   * Compress the guide.
   *
   * An {@link output} whose name says which — `.gz`, `.br`, `.zst` — already
   * asks for it, so this is for what a name cannot say: a format for a socket,
   * `false` to write a plain document to a compressed-sounding path anyway, and
   * `{ level }` to choose how hard to try, on that format's own scale.
   *
   * See [the output reference](../docs/configuration.md#compressing-the-guide)
   * for what each costs and saves on a real guide.
   */
  compress?: CompressionFormat | false | CompressionOptions;
  cache?: EpgCacheConfig;
  /** How many sites grab in parallel. Defaults to all. */
  siteConcurrency?: number;
  /**
   * How much cache work and parsing runs at once across every site, bounding
   * open files rather than pacing any source. Defaults to 16.
   */
  localConcurrency?: number;
  merge?: MergeOptions;
  /** Attributes for the root `<tv>` element. */
  meta?: XmltvDocumentMeta;
  /**
   * Pretty-print the generated guide with this indentation (a number of
   * spaces or a string like `'\t'`). Omit for compact output — the default.
   */
  indent?: string | number;
  /**
   * Which provider extensions the guide carries. Defaults to all of them.
   *
   * `false` leaves every one out, which is what makes the guide valid against
   * the DTD — one grab, two documents from the same cache: the full one for a
   * consumer that reads extensions, a plain one for everything else. A list
   * keeps only the names it names, and a function decides one at a time. See
   * [the output reference](../docs/configuration.md#provider-extensions).
   *
   * `--extensions` and `--no-extensions` override it, as a flag overrides a
   * config field everywhere else here — but only the first two forms, since a
   * command line cannot pass a function.
   */
  extensions?: SerializeOptions['extensions'];
  /**
   * Where `epg serve` listens, and what it serves — see
   * [serving the guide](../docs/configuration.md#serving-the-guide).
   *
   * Loopback and port 8080 by default. The flags override each field.
   */
  serve?: EpgServeConfig;
  /**
   * How much of the guide may be missing and the run still exit **0**: a number
   * of channel-days, or a share of the ones it accounted for (`'5%'`). Defaults
   * to none — anything missing is a failure.
   *
   * For a nightly build, where one flaky channel out of two thousand is weather
   * and a fortnight of holes is news. A site that answered *nothing* is outside
   * this whatever it says: there is no grid to weigh it against, so it is
   * always a run to look at.
   *
   * `--allow-missing` overrides it.
   */
  allowMissing?: MissingAllowance;
  /**
   * How a run reports what it is doing. Defaults to `'text'`.
   *
   * A name for a reporter this package ships — `'text'`, `'json'`,
   * `'progress'` — or a {@link ReporterFactory} returning one of your own,
   * handed the streams the command was given and the level it was asked for.
   * The same shape as {@link EpgCacheConfig.driver}, and for the same reason: a
   * name covers the usual answers and a function covers the rest.
   *
   * `--reporter` overrides it, as a flag overrides a config field everywhere
   * else here — but only among the names, since a command line cannot pass a
   * function. See [reporting a run](../docs/api.md#reporting-what-a-run-is-doing).
   */
  reporter?: ReporterName | ReporterFactory;
}

/** Builds the config from whatever answered the questions. */
export type ConfigFactory = (ctx: ConfigContext) => EpgConfig | Promise<EpgConfig>;

export interface DefineConfigOptions<S extends readonly StageDefaults[]> {
  /**
   * The questions `--configure` asks. Carried on the result, so a grabber shim
   * needs one import and the two cannot drift apart, and used here as the last
   * source of answers — a field's `default` is declared once.
   */
  stages?: S;
  /** Prefix for the environment reader, e.g. `TV_GRAB_SK_EXAMPLE_`. */
  env?: string;
  /**
   * The sources, in the order they are asked, given whatever the caller
   * supplied — a grabber hands in a reader over the configuration file it
   * loaded, `epg build` hands in nothing.
   *
   * The default puts those first, then the environment, then stage defaults:
   * `--configure` was an explicit act on this machine, so it outranks a
   * variable that may have been inherited from anywhere. Write
   * `(supplied) => [envReader('X_'), ...supplied]` for a deployment where the
   * environment is the truth and a stale `.conf` is a hazard.
   */
  readers?: (supplied: readonly ConfigReader[]) => ConfigReader[];
}

/**
 * A configuration that still needs its answers: call it to get the `EpgConfig`.
 *
 * The argument is whatever sources the caller can contribute, which is why this
 * stays callable with nothing — `epg build` has none, and the environment
 * answers instead. A plain function of no arguments is one of these too, for a
 * configuration with nothing to answer.
 */
export interface ResolvableConfig<S extends readonly StageDefaults[] = readonly StageDefaults[]> {
  (...supplied: ConfigReader[]): EpgConfig | Promise<EpgConfig>;
  /** The stages it was defined with, for the grabber to configure with. */
  readonly stages?: S;
}

/**
 * A configuration, or something that produces one — what every entry point
 * takes, so which of the two you are holding is never a caller's problem.
 *
 * The callable form is the one to prefer in a `tv_grab_*` shim: it is not
 * called for `--capabilities`, `--description` or `--version`, which must
 * answer without loading a config or touching the network — `tv_find_grabbers`
 * gives a grabber 15 seconds to respond.
 */
export type ConfigSource = EpgConfig | ResolvableConfig;

/**
 * Resolve either shape, offering whatever sources the caller has: the grabber
 * hands in a reader over the configuration file it loaded, `epg build` hands in
 * nothing and the environment answers instead.
 */
export async function resolveConfigSource(
  source: ConfigSource,
  ...supplied: ConfigReader[]
): Promise<EpgConfig> {
  return typeof source === 'function' ? source(...supplied) : source;
}

/** Identity helper for type inference in `epg.config.ts` files. */
export function defineConfig(config: EpgConfig): EpgConfig;
/**
 * The same, for a configuration whose values are answered elsewhere — an
 * account name from `--configure`, a key from the environment. One export then
 * serves both `epg build` and a `tv_grab_*` shim, with the sources deciding
 * which of them is in charge.
 */
export function defineConfig<S extends readonly StageDefaults[]>(
  factory: ConfigFactory,
  options?: DefineConfigOptions<S>,
): ResolvableConfig<S>;
export function defineConfig<S extends readonly StageDefaults[]>(
  config: EpgConfig | ConfigFactory,
  options: DefineConfigOptions<S> = {},
): EpgConfig | ResolvableConfig<S> {
  if (typeof config !== 'function') {
    return config;
  }

  const stages = options.stages ?? ([] as unknown as S);

  const compose =
    options.readers ??
    ((supplied: readonly ConfigReader[]): ConfigReader[] => [
      ...supplied,
      ...(options.env === undefined ? [] : [envReader(options.env)]),
      defaultsReader(stages),
    ]);

  const resolve = async (...supplied: ConfigReader[]): Promise<EpgConfig> =>
    config(createConfigContext(compose(supplied)));

  return Object.assign(resolve, options.stages === undefined ? {} : { stages });
}
