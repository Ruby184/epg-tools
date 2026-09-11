/**
 * `epg grab --dry-run` — what a run would fetch, without fetching it.
 *
 * Adding a site to a config that already has forty of them means running it to
 * find out what happens. This says instead: how many channels each site has,
 * how much of its window is already cached, and how many requests the rest
 * comes to.
 *
 * **It is not "makes no requests", and says so.** {@link planRequests} is pure,
 * but two of the three things it needs are not free. The cache sweep reads
 * metadata — and is not even read-only, since a `CacheManager` deletes entries
 * whose metadata is unreadable or that `invalidate` rejects. And a site whose
 * `channels` is a function has to be *asked*, once, unless `cacheChannels` has a
 * list still fresh. A report whose channel counts read "unknown" for most sites
 * would be worth nothing, so resolving is the trade, and the report names which
 * of the three each count came from.
 *
 * A document about something that exists, rather than a run that reports as it
 * goes — the line `src/cli/format.ts` draws between `--format` and
 * `--reporter`. So no new event type: `site:started` carries the per-site line
 * but has no run-level total and no provenance, and `render()` ends in
 * `default: return undefined`, which makes a forgotten case a silence rather
 * than an error.
 */

import type { Writable } from 'node:stream';
import { isStale } from '../cache/main.js';
import type { CacheStore, StalenessPolicy } from '../cache/types.js';
import { resolveConfigSource, type ConfigSource, type EpgConfig } from '../config.js';
import { addDays, toDayString } from '../core/days.js';
import { writeLines } from '../core/streams.js';
import { resolveChannels } from '../grabber/channels.js';
import { planRequests } from '../grabber/planner.js';
import { resolveSite } from '../grabber/site.js';
import { SiteStateHandle } from '../grabber/state.js';
import type { AnySiteConfig, GrabberChannel } from '../grabber/types.js';
import type { ReportFormat } from './format.js';

/** Where a site's channel list came from, which is what it cost to know it. */
export type ChannelsFrom = 'config' | 'cache' | 'fetched';

export interface PlanSite {
  site: string;
  channels: { count: number; from: ChannelsFrom };
  /** Channel-days in this site's window — always `fresh + stale`. */
  entries: number;
  /** Cached and recent enough that a run would not ask again. */
  fresh: number;
  /** What a run would fetch. */
  stale: number;
  /** How many requests the stale ones come to, under this site's batching. */
  requests: number;
  /** The resolved rule, so a surprising request count explains itself. */
  batching: string;
}

export interface PlanReport {
  window: { startDay: string; days: number };
  totals: {
    channels: number;
    entries: number;
    fresh: number;
    stale: number;
    requests: number;
  };
  sites: PlanSite[];
}

export interface PlanOptions {
  now?: Date;
  offset?: number;
  signal?: AbortSignal;
  /** Keep only these channels — `EpgConfig.channels` and `--channels`. */
  select?: ReadonlySet<string>;
}

/** How wide a request may be, as the words the config would have used. */
function batchingOf(maxChannels: number, maxDays: number): string {
  const axis = (cap: number, one: string, many: string): string =>
    cap === 1 ? `1 ${one}` : Number.isFinite(cap) ? `${cap} ${many}` : `every ${one}`;

  return `${axis(maxChannels, 'channel', 'channels')} × ${axis(maxDays, 'day', 'days')}`;
}

/**
 * One site's share of the report.
 *
 * The state handle is opened and **never saved**, which is the whole of what
 * makes this dry: `resolveChannels` reads a fresh `cacheChannels` list through
 * it, and a list it had to fetch is set on the in-memory group and dropped when
 * this returns. Saving would persist a list this command fetched and make the
 * next real run skip a fetch it would otherwise have made.
 */
async function planSite(
  config: AnySiteConfig,
  options: {
    cache: CacheStore;
    startDay: string;
    now: Date;
    days: number;
    /** The run's policy, under which a site's own override still wins. */
    staleness?: Partial<StalenessPolicy>;
  } & PlanOptions,
): Promise<PlanSite> {
  const resolved = resolveSite(
    config,
    {
      days: options.days,
      // The same two the run assembles, or a report would call fresh what a run
      // is about to refetch — `--refresh` above all, which makes everything stale.
      ...(options.staleness ? { staleness: options.staleness } : {}),
    },
    options.startDay,
  );
  const { window, staleness, batching } = resolved;

  // Counted rather than worked out from the site's `cacheChannels` and the age
  // of what is stored: whether the source was asked is exactly whether this
  // wrapper ran, and nothing here has to agree with the rules that decided it.
  let asked = 0;
  const watched =
    typeof config.channels === 'function'
      ? ({
          ...config,
          channels: (context: Parameters<typeof config.channels>[0]) => {
            asked++;

            return (config.channels as (c: unknown) => unknown)(context);
          },
        } as AnySiteConfig)
      : config;

  const channels = (await resolveChannels(watched, {
    state: SiteStateHandle.open(options.cache, resolved.site),
    now: options.now,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.select ? { select: options.select } : {}),
  })) as GrabberChannel[];

  const from: ChannelsFrom =
    typeof config.channels !== 'function' ? 'config' : asked > 0 ? 'fetched' : 'cache';

  const stale: Array<{ channel: GrabberChannel; day: string }> = [];

  for (const channel of channels) {
    const metas = await options.cache.getMetas(
      window.map((day) => ({ site: resolved.site, channelId: channel.xmltvId, day })),
    );

    for (const [index, day] of window.entries()) {
      if (isStale(day, metas[index], staleness, options.now)) {
        stale.push({ channel, day });
      }
    }
  }

  const requests = planRequests({ channels, window, stale, batching });

  return {
    site: resolved.site,
    channels: { count: channels.length, from },
    entries: channels.length * window.length,
    fresh: channels.length * window.length - stale.length,
    stale: stale.length,
    requests: requests.length,
    batching: batchingOf(batching.maxChannels, batching.maxDays),
  };
}

/**
 * What a run over this config would fetch.
 *
 * The sites are walked in order rather than at once. A dry run is a document
 * somebody is reading, not a race — and the one request it may make per site is
 * better spread out than fired at every source in the config simultaneously.
 */
export async function planRun(
  source: ConfigSource,
  cache: CacheStore,
  options: PlanOptions = {},
): Promise<PlanReport> {
  const config: EpgConfig = await resolveConfigSource(source);
  const now = options.now ?? new Date();
  const startDay = options.offset ? addDays(toDayString(now), options.offset) : toDayString(now);
  const select =
    options.select ??
    (Array.isArray(config.channels) ? new Set<string>(config.channels) : undefined);

  const sites: PlanSite[] = [];

  for (const site of config.sites) {
    sites.push(
      await planSite(site, {
        cache,
        startDay,
        now,
        days: config.days ?? 1,
        ...(config.cache?.staleness ? { staleness: config.cache.staleness } : {}),
        ...(options.offset === undefined ? {} : { offset: options.offset }),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(select ? { select } : {}),
      }),
    );
  }

  const total = (of: (site: PlanSite) => number): number =>
    sites.reduce((sum, site) => sum + of(site), 0);

  return {
    // The window as the run would see it, which is the config's `days` — a site
    // that overrides it says so in its own row's `entries`.
    window: { startDay, days: config.days ?? 1 },
    totals: {
      channels: total((site) => site.channels.count),
      entries: total((site) => site.entries),
      fresh: total((site) => site.fresh),
      stale: total((site) => site.stale),
      requests: total((site) => site.requests),
    },
    sites,
  };
}

/** `1 day`, `3 days` — because a report that says "1 channels" reads as a bug. */
function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** What each provenance costs, said once rather than per row. */
const FROM: Record<ChannelsFrom, string> = {
  config: 'in the config',
  cache: 'from the cache',
  fetched: 'fetched just now',
};

export async function writePlanReport(
  report: PlanReport,
  out: Writable,
  format: ReportFormat = 'text',
): Promise<void> {
  if (format === 'json') {
    return writeLines(out, JSON.stringify(report, undefined, 2));
  }

  const { window, totals } = report;
  const lines = [
    `${count(window.days, 'day')} from ${window.startDay} — ` +
      `${count(report.sites.length, 'site')}, ${count(totals.channels, 'channel')}`,
    '',
  ];

  for (const site of report.sites) {
    lines.push(
      `  ${site.site} — ${count(site.channels.count, 'channel')} (${FROM[site.channels.from]})`,
      `      ${count(site.entries, 'channel-day')}: ${site.fresh} cached, ` +
        `${site.stale} to fetch in ${count(site.requests, 'request')} (${site.batching})`,
    );
  }

  lines.push(
    '',
    `  ${totals.stale} of ${count(totals.entries, 'channel-day')} to fetch, ` +
      `in ${count(totals.requests, 'request')}`,
    // Said plainly, because "dry" does not mean what it looks like it means and
    // a report that let somebody believe it did would be the worse failure.
    '',
    'Nothing was fetched except channel lists, and nothing was written.',
  );

  return writeLines(out, ...lines);
}
