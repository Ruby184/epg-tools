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
  BaseSiteConfig,
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
 * Settings only — whichever of `request`, `parseDay` and `stream` the site
 * brought are still called on the config itself, so a site written with `this`
 * keeps it.
 */
export interface ResolvedSite {
  /** Cache namespace and log prefix. */
  site: string;
  /** The days this run covers for this site, ascending. */
  window: string[];
  /** How wide a request may be along each axis, and the context shape it gets. */
  batching: ResolvedBatching;
  /** When a cached day counts as stale: run policy under site override. */
  staleness: StalenessPolicy;
  /** Which of the two shapes this site is: one pass, or a request at a time. */
  isStreaming: boolean;
}

/**
 * A config as it actually arrived: the members of either shape, none of them
 * promised.
 *
 * What {@link resolveSite} checks against, because that is the situation it is
 * for — a config that was never held to the type at all. Narrowing the union
 * would be describing a config that has already been vouched for.
 */
type UncheckedSiteConfig = BaseSiteConfig<any> &
  Partial<Pick<SiteConfig<any, BatchingOption, any>, 'batching' | 'request' | 'parseDay'>> &
  Partial<Pick<StreamSiteConfig<any>, 'stream'>>;

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
  options: GrabOptions,
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

  const unchecked = config as UncheckedSiteConfig;
  const isStreaming = typeof unchecked.stream === 'function';

  if (!isStreaming) {
    if (typeof unchecked.request !== 'function') {
      throw new TypeError(
        `Site "${config.site}" must define request: a function fetching one request's raw data ` +
          `— or stream, a function yielding one channel-day at a time out of a whole document ` +
          `(got ${received(unchecked.request)})`,
      );
    }

    if (typeof unchecked.parseDay !== 'function') {
      throw new TypeError(
        `Site "${config.site}" must define parseDay: a function turning a response into one ` +
          `channel-day's programmes (got ${received(unchecked.parseDay)})`,
      );
    }
  }

  return {
    site: config.site,
    window: [...dayRange(startDay, config.days ?? options.days ?? DEFAULT_DAYS)],
    // A site that streams is asked about its whole window at once, which is what
    // `both` with no caps already plans: one request over every stale
    // channel-day. So the planner needs no idea that this site is different.
    batching: resolveBatching(isStreaming ? { mode: 'both' } : unchecked.batching),
    staleness: { ...DEFAULT_STALENESS, ...options.staleness, ...config.staleness },
    isStreaming,
  };
}
