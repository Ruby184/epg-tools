import type { CacheFormat, StalenessPolicy } from './cache/types.js';
import {
  createConfigContext,
  defaultsReader,
  envReader,
  type ConfigContext,
  type ConfigReader,
  type StageDefaults,
} from './core/answers.js';
import type { AnySiteConfig } from './grabber/types.js';
import type { MergeOptions } from './merge/types.js';
import type { XmltvDocumentMeta } from './xmltv/types.js';

export interface EpgCacheConfig {
  /** Cache directory. Defaults to `.epg-cache` in the working directory. */
  dir?: string;
  /** Format for newly written entries. Defaults to `ndjson`. */
  format?: CacheFormat;
  staleness?: Partial<StalenessPolicy>;
  /** Remove cached days older than today after a successful grab. Defaults to true. */
  prune?: boolean;
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
  cache?: EpgCacheConfig;
  /** How many sites grab in parallel. Defaults to all. */
  siteConcurrency?: number;
  merge?: MergeOptions;
  /** Attributes for the root `<tv>` element. */
  meta?: XmltvDocumentMeta;
  /**
   * Pretty-print the generated guide with this indentation (a number of
   * spaces or a string like `'\t'`). Omit for compact output — the default.
   */
  indent?: string | number;
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

  const compose = options.readers ?? ((supplied: readonly ConfigReader[]): ConfigReader[] => [
    ...supplied,
    ...(options.env === undefined ? [] : [envReader(options.env)]),
    defaultsReader(stages),
  ]);

  const resolve = async (...supplied: ConfigReader[]): Promise<EpgConfig> =>
    config(createConfigContext(compose(supplied)));

  return Object.assign(resolve, options.stages === undefined ? {} : { stages });
}
