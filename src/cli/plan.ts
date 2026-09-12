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
import { DEFAULT_DAYS, resolveSite } from '../grabber/site.js';
import { SiteStateHandle } from '../grabber/state.js';
import type { AnySiteConfig, GrabberChannel } from '../grabber/types.js';
import type { ReportFormat } from './format.js';

/** Where a site's channel list came from, which is what it cost to know it. */
export type ChannelsFrom = 'config' | 'cache' | 'fetched' | 'failed';

export interface PlanSite {
  site: string;
  /**
   * Why this site could not be planned, when it could not be.
   *
   * Every count below is then zero, and the row is still here — a run reports a
   * site that answered nothing and grabs the rest, so a report that threw on
   * the first unreachable source would be useless on exactly the config this
   * command is for.
   */
  error?: string;
  channels: { count: number; from: ChannelsFrom };
  /** This site's own window, which it may have shortened. */
  days: number;
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
    /** Sites that could not be planned at all — see {@link PlanSite.error}. */
    failed: number;
  };
  sites: PlanSite[];
}

export interface PlanOptions {
  now?: Date;
  offset?: number;
  signal?: AbortSignal;
  /**
   * Keep only these channels.
   *
   * Handed in rather than read off `config.channels`, because the two commands
   * that take `--dry-run` do different things with it: `build` selects before
   * it grabs, and `grab` does not select at all. A report that decided for
   * itself would be describing neither.
   */
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
    /** The run's window, or absent to let `resolveSite` use its own default. */
    days?: number;
    /** The run's policy, under which a site's own override still wins. */
    staleness?: Partial<StalenessPolicy>;
  } & PlanOptions,
): Promise<PlanSite> {
  const resolved = resolveSite(
    config,
    {
      // Spread rather than defaulted: `resolveSite` falls back to its own
      // `DEFAULT_DAYS`, and a number passed here would *override* that — which
      // is how a report came to describe one day of a run that covers seven.
      ...(options.days === undefined ? {} : { days: options.days }),
      // The same policy the run assembles, or a report would call fresh what a
      // run is about to refetch — `--refresh` above all, which makes everything
      // stale.
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
    days: window.length,
    entries: channels.length * window.length,
    fresh: channels.length * window.length - stale.length,
    stale: stale.length,
    requests: requests.length,
    batching: batchingOf(batching.maxChannels, batching.maxDays),
  };
}

/**
 * A site that could not be planned, as a row rather than a thrown report.
 *
 * `resolveSite` refuses a config it cannot read and `resolveChannels` fails
 * with whatever the source did — and either would otherwise take the whole
 * document with it. A run does not work that way: it reports the site and
 * grabs the other thirty-nine.
 */
function unplannable(config: AnySiteConfig, error: unknown): PlanSite {
  return {
    // Straight off the config, since the failure may be `resolveSite` refusing
    // the very field this reads. Only a string can be a heading.
    site: typeof config.site === 'string' && config.site !== '' ? config.site : '(unnamed site)',
    error: error instanceof Error ? error.message : String(error),
    channels: { count: 0, from: 'failed' },
    days: 0,
    entries: 0,
    fresh: 0,
    stale: 0,
    requests: 0,
    batching: '—',
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

  const sites: PlanSite[] = [];

  for (const site of config.sites) {
    try {
      sites.push(
        await planSite(site, {
          cache,
          startDay,
          now,
          ...(config.days === undefined ? {} : { days: config.days }),
          ...(config.cache?.staleness ? { staleness: config.cache.staleness } : {}),
          ...(options.offset === undefined ? {} : { offset: options.offset }),
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.select ? { select: options.select } : {}),
        }),
      );
    } catch (error) {
      sites.push(unplannable(site, error));
    }
  }

  const total = (of: (site: PlanSite) => number): number =>
    sites.reduce((sum, site) => sum + of(site), 0);

  return {
    // The run's own window — `DEFAULT_DAYS` when the config is silent, which is
    // what a run would use. A site that shortened it says so in its own row.
    window: { startDay, days: config.days ?? DEFAULT_DAYS },
    totals: {
      channels: total((site) => site.channels.count),
      entries: total((site) => site.entries),
      fresh: total((site) => site.fresh),
      stale: total((site) => site.stale),
      requests: total((site) => site.requests),
      failed: sites.filter((site) => site.error !== undefined).length,
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
  failed: 'could not be read',
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
    if (site.error !== undefined) {
      lines.push(`  ${site.site} — could not be planned: ${site.error}`);
      continue;
    }

    lines.push(
      `  ${site.site} — ${count(site.channels.count, 'channel')} (${FROM[site.channels.from]})` +
        // Only when it differs, since repeating the heading on every row would
        // bury the one site that shortened its window.
        (site.days === window.days ? '' : `, over its own ${count(site.days, 'day')}`),
      `      ${count(site.entries, 'channel-day')}: ${site.fresh} cached, ` +
        `${site.stale} to fetch in ${count(site.requests, 'request')} (${site.batching})`,
    );
  }

  lines.push(
    '',
    `  ${totals.stale} of ${count(totals.entries, 'channel-day')} to fetch, ` +
      `in ${count(totals.requests, 'request')}`,
  );

  if (totals.failed > 0) {
    // What a run would say too: the sites that answered nothing are counted
    // apart from the channel-days, because they are not a share of anything.
    lines.push(`  ${count(totals.failed, 'site')} could not be planned`);
  }

  lines.push(
    // Said plainly, because "dry" does not mean what it looks like it means and
    // a report that let somebody believe it did would be the worse failure.
    '',
    'Nothing was fetched except channel lists, and nothing was written.',
  );

  return writeLines(out, ...lines);
}
