/**
 * Reading a site config: which of the two shapes it is, and what it settles to
 * once the run's defaults are folded in.
 *
 * Every default a site can leave to the run is resolved here, in one pass, so
 * nothing downstream spells one out again — and every member a site must bring is
 * checked here, before a queue exists or a request goes out.
 */

import { DEFAULT_STALENESS } from '../cache/main.js';
import type { StalenessPolicy } from '../cache/types.js';
import { dayRange } from '../core/days.js';
import { resolveBatching, type ResolvedBatching } from './planner.js';
import type {
  AnySiteConfig,
  BatchingOption,
  GrabOptions,
  SiteConfig,
  StreamSiteConfig,
} from './types.js';

/** How many days a run covers when neither the site nor the run says. */
const DEFAULT_DAYS = 7;

/**
 * A site's settings as the run needs them: checked, and with the run's defaults
 * and the site's own overrides already folded in.
 *
 * Settings *and* the config, narrowed — which is the point of the two shapes
 * below. Deciding which one a site is happens here, once, and what comes out
 * says so in a way the compiler follows: nothing downstream has to assert what
 * kind of config it is holding, and neither pipeline can be handed the wrong
 * one. The config itself is passed through rather than picked apart, so a site
 * written with `this` keeps it.
 */
interface ResolvedSiteBase {
  /** Cache namespace and log prefix. */
  site: string;
  /** The days this run covers for this site, ascending. */
  window: string[];
  /** How wide a request may be along each axis, and the context shape it gets. */
  batching: ResolvedBatching;
  /** When a cached day counts as stale: run policy under site override. */
  staleness: StalenessPolicy;
}

/** A site that fetches a request at a time and parses each channel-day out of it. */
export interface ResolvedFetchSite extends ResolvedSiteBase {
  isStreaming: false;
  config: SiteConfig<any, BatchingOption, any>;
}

/** A site that answers its whole window in one pass. */
export interface ResolvedStreamSite extends ResolvedSiteBase {
  isStreaming: true;
  config: StreamSiteConfig<any>;
}

export type ResolvedSite = ResolvedFetchSite | ResolvedStreamSite;

/**
 * Whether this config is the streaming shape, by the one member that says so.
 *
 * The cast inside is the only one either shape needs: a runtime check is exactly
 * what establishes the type, and everything downstream is narrowed rather than
 * asserted.
 */
export function isStreamSite(config: AnySiteConfig): config is StreamSiteConfig<any> {
  return typeof (config as StreamSiteConfig).stream === 'function';
}

/** What arrived instead, so a message about a mandatory member can name it. */
function received(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  if (Array.isArray(value)) {
    return 'an array';
  }

  const kind = typeof value;

  return kind === 'undefined' ? 'undefined' : `${kind === 'object' ? 'an' : 'a'} ${kind}`;
}

/**
 * Resolve one site against the run: check what it must bring, then settle every
 * default in one pass.
 *
 * The types make every one of these mandatory, so the checks are for configs
 * that arrive without having been held to them — plain JS, or a config file the
 * CLI imported and this package never saw compiled. Each would otherwise surface
 * a long way from its cause: `parseDay` once per channel-day, and only after
 * every request had already gone out; `channels` as a missing `flatMap`; and
 * `site` not at all, quietly filing this site's cached days under `undefined`, in
 * with those of every other site that left it out.
 *
 * Each message says what the member is *for*, because at this point the mistake
 * is usually a misspelling or a shape that has moved on, not ignorance that it
 * exists.
 *
 * It is also where the two shapes are told apart, by the one member that says
 * so: a site with `stream` answers its whole window in one pass and is asked for
 * neither `request` nor `parseDay`.
 */
export function resolveSite(
  config: AnySiteConfig,
  defaults: Pick<GrabOptions, 'days' | 'staleness'>,
  startDay: string,
): ResolvedSite {
  if (typeof config.site !== 'string' || config.site === '') {
    throw new TypeError(
      `A site must define site: a non-empty string, unique to it, naming its cache namespace ` +
        `(got ${received(config.site)})`,
    );
  }

  if (typeof config.channels !== 'function' && !Array.isArray(config.channels)) {
    throw new TypeError(
      `Site "${config.site}" must define channels: an array of channels, or a function ` +
        `returning one (got ${received(config.channels)})`,
    );
  }

  const common = {
    site: config.site,
    window: [...dayRange(startDay, config.days ?? defaults.days ?? DEFAULT_DAYS)],
    staleness: { ...DEFAULT_STALENESS, ...defaults.staleness, ...config.staleness },
  };

  // Before the two shapes are told apart, because a config with both has not
  // said which it is: `isStreamSite` would pick `stream` and its `request` would
  // never be called, silently.
  //
  // Checked rather than made impossible in the types. `request?: never` on
  // `StreamSiteConfig` does give a compile error, and it also turns `request`
  // into a discriminant — which makes the two checks below provably dead code,
  // narrows `config` to `never` inside them, and needs a cast to write at all.
  // Those checks are the whole defence for a config written in JavaScript, and
  // this one catches that config too.
  if (isStreamSite(config) && typeof (config as { request?: unknown }).request === 'function') {
    throw new TypeError(
      `Site "${config.site}" defines both stream and request, so it has not said which shape ` +
        `it is: stream answers the whole window in one pass, request answers one at a time. ` +
        `Keep one.`,
    );
  }

  if (isStreamSite(config)) {
    return {
      ...common,
      // A site that streams is asked about its whole window at once, which is
      // what `both` with no caps already plans: one request over every stale
      // channel-day. So the planner needs no idea that this site is different.
      batching: resolveBatching({ mode: 'both' }),
      isStreaming: true,
      config,
    };
  }

  // The types promise both of these, so these checks are for a config that was
  // never held to them — and `typeof` is the only thing that can tell.
  if (typeof config.request !== 'function') {
    throw new TypeError(
      `Site "${config.site}" must define request: a function fetching one request's raw data ` +
        `— or stream, a function yielding one channel-day at a time out of a whole document ` +
        `(got ${received(config.request)})`,
    );
  }

  if (typeof config.parseDay !== 'function') {
    throw new TypeError(
      `Site "${config.site}" must define parseDay: a function turning a response into one ` +
        `channel-day's programmes (got ${received(config.parseDay)})`,
    );
  }

  return {
    ...common,
    batching: resolveBatching(config.batching),
    isStreaming: false,
    config,
  };
}
