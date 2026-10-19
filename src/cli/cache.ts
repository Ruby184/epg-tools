/**
 * `epg cache` — what is in the cache, and pruning it.
 *
 * Since a driver keeps an entry as its codec's bytes, a cache is no longer
 * something to read with `cat` or `sqlite3`: a row holds a blob, and a file
 * holds whatever the driver framed its meta with. So the command reads it
 * through the `CacheManager`, as a run does — whatever the driver underneath —
 * and says what it found.
 *
 * Looking changes nothing. A run removes an entry it cannot vouch for, so the
 * day is grabbed again; this reports one and leaves it, and the next run
 * removes it as it always would.
 */

import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Writable } from 'node:stream';
import { toRecord } from '../cache/codec.js';
import { CACHE_SCHEMA, STATE_SCHEMA, type CacheManager } from '../cache/manager.js';
import type { ChannelDayKey, Inspected, StoredEntryMeta, Unusable } from '../cache/types.js';
import { errorMessage } from '../core/error.js';
import { count } from '../core/count.js';
import { inParallel } from '../core/parallel.js';
import { writeLines } from '../core/streams.js';
import { isRemembered } from '../grabber/remember.js';
import { bagEntriesIn, channelListIn, StateKey } from '../grabber/state.js';
import type { XmltvProgramme } from '../xmltv/types.js';
import { writeXmltvStream } from '../xmltv/serialize.js';
import type { ReportFormat } from './format.js';

/** The subcommands, in the order the usage lists them. */
export const CACHE_COMMANDS = ['show', 'stats', 'state', 'prune'] as const;

export type CacheCommand = (typeof CACHE_COMMANDS)[number];

/** What `show`, `stats` and `state` read a cache with. */
export interface CacheReading {
  /** The config's, so an entry its `invalidate` voids is reported as void. */
  cache: CacheManager;
  format?: ReportFormat;
  stdout: Writable;
  stderr: Writable;
  signal?: AbortSignal;
}

/**
 * How many channels' metas are read at once. A store that answers a channel's
 * window in one question is asked it a few channels at a time, and one that
 * reads a key at a time — a file each — a few files at a time.
 */
const META_CONCURRENCY = 8;

/**
 * Why a run would not use what a look found, as a person reads it — an
 * entry's meta, or a group's envelope, whose schema this version reads.
 */
function why(found: Unusable<unknown>, what: 'meta' | 'envelope'): string {
  switch (found.status) {
    case 'unreadable':
      return `its ${what} is not one this version can read`;
    case 'incompatible':
      return (
        `written as schema ${found.meta.schema}, and this version reads ` +
        String(what === 'meta' ? CACHE_SCHEMA : STATE_SCHEMA)
      );
    case 'invalidated':
      return "the config's invalidate voids it";
    case 'corrupt':
      return `its programmes cannot be read: ${errorMessage(found.error)}`;
  }
}

/**
 * A site's entries, those of one channel and one day where asked, in order. A
 * channel and a day name one key, which is asked about directly rather than
 * found by listing the site.
 */
async function entriesOf(
  cache: CacheManager,
  site: string,
  channelId?: string,
  day?: string,
): Promise<ChannelDayKey[]> {
  if (channelId !== undefined && day !== undefined) {
    return [{ site, channelId, day }];
  }

  const keys: ChannelDayKey[] = [];

  for await (const held of cache.list({
    site,
    kind: 'entry',
    ...(channelId === undefined ? {} : { channelId }),
  })) {
    if (held.kind === 'entry') {
      keys.push(held.key);
    }
  }

  return keys.sort((a, b) => a.channelId.localeCompare(b.channelId) || a.day.localeCompare(b.day));
}

/**
 * `epg cache show <site> [channel] [day]`: the programmes cached for a site, a
 * channel of it or one day of that — as an XMLTV document, or a record per line
 * with `--format json`. 1 where nothing is cached for what was asked, or
 * nothing of it that can be read.
 */
export async function showCache(
  reading: CacheReading,
  site: string,
  channelId?: string,
  day?: string,
  indent: string | number = 2,
): Promise<number> {
  const { cache, stdout, stderr } = reading;
  const asked = [site, channelId, day].filter(Boolean).join(' ');
  const keys = await entriesOf(cache, site, channelId, day);
  let leftOut = 0;

  // An entry at a time, so a site's fortnight is never all in memory at once —
  // and one this version cannot read is said and left out, as a run would
  // leave it out of a guide.
  async function* readable(): AsyncGenerator<XmltvProgramme[]> {
    for (const key of keys) {
      reading.signal?.throwIfAborted();

      let found;

      try {
        found = await cache.inspect(key);
      } catch (error) {
        // One entry the store could not open — a file this user may not read —
        // is one to say so of, as one this version cannot read is. A look that
        // was stopped is not.
        reading.signal?.throwIfAborted();

        leftOut++;
        await writeLines(
          stderr,
          `${key.channelId} ${key.day}: left out — could not be read: ${errorMessage(error)}`,
        );
        continue;
      }

      // Not there, or gone since it was listed: a run in another process
      // pruned it.
      if (found === undefined) {
        continue;
      }

      if (found.status !== 'readable') {
        leftOut++;
        await writeLines(stderr, `${key.channelId} ${key.day}: left out — ${why(found, 'meta')}`);
        continue;
      }

      yield found.programmes;
    }
  }

  const entries = readable();
  const first = await entries.next();

  // Said, and 1, before a document is begun: nothing cached for what was
  // asked, or nothing of it that can be read, is not an empty guide.
  if (first.done === true) {
    await writeLines(
      stderr,
      leftOut === 0
        ? `Nothing cached for ${asked}.`
        : `Nothing cached for ${asked} that can be read.`,
    );

    return 1;
  }

  // The first entry read, and then the rest as they are.
  async function* all(): AsyncGenerator<XmltvProgramme[]> {
    yield first.value;
    yield* entries;
  }

  if (reading.format === 'json') {
    for await (const list of all()) {
      // An entry's records in one write: it is the write a pipe is waited on.
      await writeLines(stdout, ...list.map((programme) => JSON.stringify(toRecord(programme))));
    }

    return 0;
  }

  async function* programmes(): AsyncGenerator<XmltvProgramme> {
    for await (const list of all()) {
      yield* list;
    }
  }

  await pipeline(
    Readable.from(writeXmltvStream({ channels: [], programmes: programmes() }, { indent })),
    stdout,
    { end: false, ...(reading.signal ? { signal: reading.signal } : {}) },
  );

  return 0;
}

/** What one site has cached, as `epg cache stats` reports it. */
export interface SiteCacheStats {
  site: string;
  channels: number;
  /** Channel-days held, whether or not this version can read them. */
  entries: number;
  /**
   * Of those, the ones this version cannot read — written in a shape it does
   * not read, or with a meta nobody can — left in place here. A run removes
   * one when it next asks about its day.
   */
  unreadable: number;
  /** Of those, the ones the config's `invalidate` voids, as a run would. */
  invalidated: number;
  /**
   * Of those, the ones the store could not be asked about — a file this user
   * may not read — each said on stderr.
   */
  failed: number;
  /** Of the readable ones, those that came back with no programmes. */
  empty: number;
  programmes: number;
  /** The first and last day held. */
  days?: { first: string; last: string };
  /** When the readable entries were grabbed, earliest and latest. */
  grabbed?: { first: string; last: string };
  /** The groups of state the site keeps. */
  state: string[];
}

export interface CacheStats {
  sites: SiteCacheStats[];
  totals: Omit<SiteCacheStats, 'site' | 'days' | 'grabbed' | 'state'> & { sites: number };
}

/** An entry the store could not be asked about, and what it threw. */
interface Failed {
  status: 'failed';
  error: unknown;
}

/**
 * What a channel's entries say about themselves, as {@link
 * CacheManager.inspectMetas} answers — and, where the store could not be asked
 * about one, what it threw, so one entry this user may not read is not taken
 * for its channel.
 *
 * A store that answers a channel's window in one question is asked it, and a
 * key at a time once that has failed. One that is asked a key at a time anyway
 * is asked so from the start: the same reads, and none of them twice.
 */
async function metasOf(
  reading: CacheReading,
  keys: ChannelDayKey[],
): Promise<Array<Inspected<{ meta: StoredEntryMeta }> | Failed | undefined>> {
  if (reading.cache.driver.readMetas !== undefined) {
    try {
      return await reading.cache.inspectMetas(keys);
    } catch (error) {
      reading.signal?.throwIfAborted();

      if (keys.length === 1) {
        return [{ status: 'failed', error }];
      }
    }
  }

  const found: Array<Inspected<{ meta: StoredEntryMeta }> | Failed | undefined> = [];

  for (const key of keys) {
    try {
      found.push((await reading.cache.inspectMetas([key]))[0]);
    } catch (error) {
      reading.signal?.throwIfAborted();

      found.push({ status: 'failed', error });
    }
  }

  return found;
}

/**
 * How much a cache holds, per site — or for one site — from what each entry
 * says about itself: no programmes are read.
 */
export async function cacheStats(reading: CacheReading, only?: string): Promise<CacheStats> {
  const { cache, stderr } = reading;
  /** Each site's counts so far — and no keys: a cache is read as it is listed. */
  const sites = new Map<
    string,
    {
      counted: SiteCacheStats;
      channels: Set<string>;
      /** When its readable entries were grabbed, as instants: an ISO time may carry any offset. */
      grabbed?: { first: number; last: number };
    }
  >();

  const of = (site: string) => {
    let counting = sites.get(site);

    if (counting === undefined) {
      counting = {
        counted: {
          site,
          channels: 0,
          entries: 0,
          unreadable: 0,
          invalidated: 0,
          failed: 0,
          empty: 0,
          programmes: 0,
          state: [],
        },
        channels: new Set(),
      };
      sites.set(site, counting);
    }

    return counting;
  };

  // A channel's days together, as a run asks about its window. A store lists
  // a channel's keys one after another — sqlite in order, a file store a
  // directory at a time — and one that does not has a channel asked about more
  // than once, which counts the same.
  async function* channelsListed(): AsyncGenerator<ChannelDayKey[]> {
    let keys: ChannelDayKey[] = [];

    for await (const held of cache.list(only === undefined ? {} : { site: only })) {
      if (held.kind === 'state') {
        of(held.site).counted.state.push(held.key);
        continue;
      }

      if (
        keys.length > 0 &&
        (keys[0]!.site !== held.key.site || keys[0]!.channelId !== held.key.channelId)
      ) {
        yield keys;
        keys = [];
      }

      keys.push(held.key);
    }

    if (keys.length > 0) {
      yield keys;
    }
  }

  // Every site's channels in the one pool, so a cache of many small sites is
  // read as many at a time as one large one.
  await inParallel(channelsListed(), META_CONCURRENCY, async (keys) => {
    reading.signal?.throwIfAborted();

    const { site, channelId } = keys[0]!;
    const counting = of(site);
    const { counted } = counting;

    counting.channels.add(channelId);

    const found = await metasOf(reading, keys);

    for (const [index, key] of keys.entries()) {
      const entry = found[index];

      // Gone since it was listed: a run in another process pruned it.
      if (entry === undefined) {
        continue;
      }

      counted.entries++;
      counted.days ??= { first: key.day, last: key.day };

      if (key.day < counted.days.first) {
        counted.days.first = key.day;
      } else if (key.day > counted.days.last) {
        counted.days.last = key.day;
      }

      if (entry.status === 'failed') {
        counted.failed++;
        await writeLines(
          stderr,
          `${site} ${key.channelId} ${key.day}: could not be read: ${errorMessage(entry.error)}`,
        );
        continue;
      }

      if (entry.status === 'invalidated') {
        counted.invalidated++;
        continue;
      }

      if (entry.status !== 'readable') {
        counted.unreadable++;
        continue;
      }

      const { meta } = entry;

      counted.programmes += meta.programmeCount;
      counted.empty += meta.programmeCount === 0 ? 1 : 0;
      const at = Date.parse(meta.grabbedAt);

      if (!Number.isNaN(at)) {
        counting.grabbed = {
          first: Math.min(at, counting.grabbed?.first ?? at),
          last: Math.max(at, counting.grabbed?.last ?? at),
        };
      }
    }
  });

  const stats = [...sites.values()]
    .map(({ counted, channels, grabbed }): SiteCacheStats => ({
      ...counted,
      channels: channels.size,
      state: counted.state.toSorted(),
      ...(grabbed === undefined
        ? {}
        : {
            grabbed: {
              first: new Date(grabbed.first).toISOString(),
              last: new Date(grabbed.last).toISOString(),
            },
          }),
    }))
    .sort((a, b) => (a.site < b.site ? -1 : a.site > b.site ? 1 : 0));

  const sum = (field: keyof CacheStats['totals']): number =>
    stats.reduce((total, site) => total + (field === 'sites' ? 1 : site[field]), 0);

  return {
    sites: stats,
    totals: {
      sites: stats.length,
      channels: sum('channels'),
      entries: sum('entries'),
      unreadable: sum('unreadable'),
      invalidated: sum('invalidated'),
      failed: sum('failed'),
      empty: sum('empty'),
      programmes: sum('programmes'),
    },
  };
}

/** An ISO instant to the minute, which is all a person looking at a cache wants of one. */
function minute(iso: string): string {
  const at = Date.parse(iso);

  return Number.isNaN(at) ? iso : `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')}Z`;
}

/** `epg cache stats [site]`: the report, as text or JSON. */
export async function writeCacheStats(reading: CacheReading, only?: string): Promise<number> {
  const stats = await cacheStats(reading, only);

  if (reading.format === 'json') {
    await writeLines(reading.stdout, JSON.stringify(stats, undefined, 2));

    return 0;
  }

  if (stats.sites.length === 0) {
    await writeLines(
      reading.stdout,
      only === undefined ? 'Nothing cached.' : `Nothing cached for ${only}.`,
    );

    return 0;
  }

  const lines: string[] = [];

  for (const site of stats.sites) {
    lines.push(
      `${site.site} — ${count(site.channels, 'channel')}, ${count(site.entries, 'channel-day')}` +
        (site.days === undefined
          ? ''
          : site.days.first === site.days.last
            ? ` on ${site.days.first}`
            : ` from ${site.days.first} to ${site.days.last}`) +
        `, ${count(site.programmes, 'programme')}`,
    );

    const details = [
      ...(site.grabbed === undefined
        ? []
        : minute(site.grabbed.first) === minute(site.grabbed.last)
          ? [`grabbed ${minute(site.grabbed.first)}`]
          : [`grabbed ${minute(site.grabbed.first)} to ${minute(site.grabbed.last)}`]),
      ...(site.empty > 0 ? [`${count(site.empty, 'empty day')}`] : []),
      ...(site.unreadable > 0 ? [`${site.unreadable} unreadable`] : []),
      ...(site.invalidated > 0 ? [`${site.invalidated} voided by invalidate`] : []),
      ...(site.failed > 0 ? [`${site.failed} could not be read`] : []),
    ];

    if (details.length > 0) {
      lines.push(`    ${details.join(' · ')}`);
    }

    if (site.state.length > 0) {
      lines.push(`    remembers: ${site.state.join(', ')}`);
    }
  }

  const { totals } = stats;

  if (totals.sites > 1) {
    lines.push(
      '',
      `${count(totals.sites, 'site')}, ${count(totals.channels, 'channel')}, ` +
        `${count(totals.entries, 'channel-day')}, ${count(totals.programmes, 'programme')}`,
    );
  }

  await writeLines(reading.stdout, ...lines);

  return 0;
}

/**
 * How much a group holds, as a run would read it: a channel list's channels,
 * all or none, and a bag's keys — every other group is a bag — besides what of
 * it a run cannot read, and what a site's `remember` kept that has expired.
 *
 * No more than that: a run drops other keys by rules of its own, as it drops
 * the validators of days before its window, and a look has no window.
 */
function itemsIn(group: string, data: unknown, now: number): string {
  if (group === StateKey.CHANNELS) {
    const list = channelListIn(data);

    return list === undefined ? 'no channel list a run can read' : count(list.length, 'channel');
  }

  if (!Array.isArray(data)) {
    return 'no keys a run can read';
  }

  const pairs = bagEntriesIn(data).length;
  const kept = keptIn(group, data, now).length;
  const besides = [
    ...(pairs > kept ? [`${pairs - kept} expired`] : []),
    ...(data.length > pairs ? [`${data.length - pairs} unreadable`] : []),
  ];

  return count(kept, 'key') + (besides.length > 0 ? `, and ${besides.join(' and ')}` : '');
}

/**
 * The pairs of a bag a run keeps: those with a key — and, of what a site's
 * `remember` kept, those whose `until` is still ahead.
 */
function keptIn(group: string, data: unknown, now: number): Array<[string, unknown]> {
  const entries = bagEntriesIn(data);

  return group === StateKey.REMEMBERED
    ? entries.filter(([, value]) => isRemembered(value, now))
    : entries;
}

/**
 * The keys of a group, as a run would read it: a channel list's channel ids,
 * or a bag's keys. Nothing for a group a run reads none from.
 */
function keysOf(group: string, data: unknown, now: number): string[] | undefined {
  if (group === StateKey.CHANNELS) {
    return channelListIn(data)?.map((channel) => channel.xmltvId);
  }

  return Array.isArray(data) ? keptIn(group, data, now).map(([key]) => key) : undefined;
}

/**
 * `epg cache state <site> [group] [--keys]`: the groups a site remembers, or
 * what one of them holds — or only its keys. 1 where there is nothing of the
 * kind, or nothing this version can read.
 */
export async function showState(
  reading: CacheReading,
  site: string,
  group?: string,
  keysOnly = false,
): Promise<number> {
  const { cache, stdout, stderr } = reading;

  if (group === undefined) {
    const groups: string[] = [];

    // Only the groups: the site's entries are not looked at.
    for await (const held of cache.list({ site, kind: 'state' })) {
      if (held.kind === 'state') {
        groups.push(held.key);
      }
    }

    if (groups.length === 0) {
      await writeLines(stderr, `Nothing remembered for ${site}.`);

      return 1;
    }

    const now = Date.now();
    const described = [];

    for (const key of groups.sort()) {
      let found;

      try {
        found = await cache.inspectState(site, key);
      } catch (error) {
        // One group the store could not open is one to describe, as one this
        // version cannot read is.
        reading.signal?.throwIfAborted();

        described.push({
          group: key,
          status: 'failed' as const,
          why: `could not be read: ${errorMessage(error)}`,
        });
        continue;
      }

      // Gone since it was listed.
      if (found === undefined) {
        continue;
      }

      described.push(
        found.status === 'readable'
          ? {
              group: key,
              ...found.meta,
              status: found.status,
              holds: itemsIn(key, found.data, now),
            }
          : { group: key, status: found.status, why: why(found, 'envelope') },
      );
    }

    // Every group gone since it was listed: a run in another process removed
    // them, and there is nothing to describe.
    if (described.length === 0) {
      await writeLines(stderr, `Nothing remembered for ${site}.`);

      return 1;
    }

    // 1 where nothing of it can be read, as `show` answers — though what could
    // not be is still described.
    const code = described.some((one) => one.status === 'readable') ? 0 : 1;

    if (reading.format === 'json') {
      await writeLines(stdout, JSON.stringify(described, undefined, 2));

      return code;
    }

    const width = Math.max(...described.map((one) => one.group.length));

    await writeLines(
      stdout,
      ...described.map(
        (one) =>
          `${one.group.padEnd(width)}  ` +
          (one.status === 'readable'
            ? `${one.holds}, written ${minute(one.writtenAt)} by ${one.writtenBy}`
            : one.status === 'failed'
              ? one.why
              : `${one.why} — fetched again when next wanted`),
      ),
    );

    return code;
  }

  const inspected = await cache.inspectState(site, group);

  if (inspected === undefined) {
    await writeLines(stderr, `Nothing remembered for ${site} under ${group}.`);

    return 1;
  }

  if (inspected.status !== 'readable') {
    await writeLines(
      stderr,
      `${site} ${group}: ${why(inspected, 'envelope')} — fetched again when next wanted`,
    );

    return 1;
  }

  const { data, meta } = inspected;

  if (keysOnly) {
    const keys = keysOf(group, data, Date.now());

    if (keys === undefined) {
      await writeLines(stderr, `${site} ${group} holds no keys to list.`);

      return 1;
    }

    // One write, of however many: a group can hold more keys than a call can
    // take arguments.
    if (reading.format === 'json') {
      await writeLines(stdout, JSON.stringify(keys));
    } else if (keys.length > 0) {
      await writeLines(stdout, keys.join('\n'));
    }

    return 0;
  }

  // The data alone as text, for a pipe into `jq`; with what the store vouches
  // for it as JSON.
  // `null` for a group written empty, which a store keeps as no data at all:
  // `undefined` is not JSON, and the text would be read as such.
  await writeLines(
    stdout,
    JSON.stringify(
      reading.format === 'json' ? { meta, data: data ?? null } : (data ?? null),
      undefined,
      2,
    ),
  );

  return 0;
}
