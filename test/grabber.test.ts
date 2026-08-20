import { describe, expect, it } from 'vitest';
import type { CacheEntryMeta, CacheStore, ChannelDayKey } from '../src/cache/types.js';
import type { XmltvProgramme } from '../src/xmltv/types.js';
import { grab } from '../src/grabber/main.js';
import type {
  ChannelsBatching,
  ChannelsDaysBatching,
  DaysBatching,
  GrabberChannel,
  SiteConfig,
} from '../src/grabber/main.js';

const NOW = new Date('2026-07-17T12:00:00.000Z');
const TODAY = '2026-07-17';
const TOMORROW = '2026-07-18';

class MemoryCache implements CacheStore {
  entries = new Map<string, { programmes: XmltvProgramme[]; meta: CacheEntryMeta }>();

  private keyOf(key: ChannelDayKey): string {
    return `${key.site}|${key.channelId}|${key.day}`;
  }

  seed(key: ChannelDayKey, meta: CacheEntryMeta, programmes: XmltvProgramme[] = []): void {
    this.entries.set(this.keyOf(key), { programmes, meta });
  }

  get(key: ChannelDayKey): { programmes: XmltvProgramme[]; meta: CacheEntryMeta } | undefined {
    return this.entries.get(this.keyOf(key));
  }

  async getMeta(key: ChannelDayKey): Promise<CacheEntryMeta | undefined> {
    return this.entries.get(this.keyOf(key))?.meta;
  }

  async read(key: ChannelDayKey): Promise<XmltvProgramme[] | undefined> {
    return this.entries.get(this.keyOf(key))?.programmes;
  }

  async write(key: ChannelDayKey, programmes: XmltvProgramme[], meta?: Partial<CacheEntryMeta>): Promise<void> {
    this.entries.set(this.keyOf(key), {
      programmes,
      meta: {
        grabbedAt: meta?.grabbedAt ?? new Date().toISOString(),
        programmeCount: meta?.programmeCount ?? programmes.length,
      },
    });
  }

  async delete(key: ChannelDayKey): Promise<void> {
    this.entries.delete(this.keyOf(key));
  }

  async prune({ before }: { before: string }): Promise<number> {
    let removed = 0;

    for (const [key] of this.entries) {
      const day = key.split('|')[2];

      if (day !== undefined && day < before) {
        this.entries.delete(key);
        removed++;
      }
    }

    return removed;
  }
}

function programme(start: string, channel = 'raw.source'): XmltvProgramme {
  return { channel, start: new Date(start), title: [{ value: `p-${start}` }] };
}

function channel(id: string): GrabberChannel {
  return { xmltvId: id, siteId: `site-${id}` };
}

function makeConfig(overrides: Partial<SiteConfig<unknown>> = {}): SiteConfig<unknown> {
  return {
    site: 'example.com',
    channels: [channel('one.example')],
    days: 1,
    async request() {
      return { canned: true };
    },
    parseDay({ day }) {
      return [programme(`${day}T06:00:00.000Z`)];
    },
    ...overrides,
  };
}

/** A batched-fetch site: one request returns items for a group of channels. */
interface BatchData {
  items: { id: string }[];
}

type ChannelsConfig = SiteConfig<unknown, ChannelsBatching>;

function makeBatchConfig(overrides: Partial<ChannelsConfig> = {}): ChannelsConfig {
  return {
    site: 'batch.example',
    channels: [channel('a'), channel('b'), channel('c')],
    days: 1,
    batching: { mode: 'channels' },
    async request({ channels }) {
      return { items: channels.map((c) => ({ id: c.siteId })) } satisfies BatchData;
    },
    parseDay({ channel: ch, data, day }) {
      const item = (data as BatchData).items.find((i) => i.id === ch.siteId);
      return item ? [programme(`${day}T06:00:00.000Z`, ch.siteId)] : [];
    },
    ...overrides,
  };
}

type DaysConfig = SiteConfig<unknown, DaysBatching>;

/** A day-batched site: one request covers several days of one channel. */
function makeDaysConfig(overrides: Partial<DaysConfig> = {}): DaysConfig {
  return {
    site: 'days.example',
    channels: [channel('a')],
    days: 4,
    batching: { mode: 'days' },
    async request({ days }) {
      return { items: days.map((day) => ({ id: day })) } satisfies BatchData;
    },
    parseDay({ channel: ch, data, day }) {
      const item = (data as BatchData).items.find((i) => i.id === day);
      return item ? [programme(`${day}T06:00:00.000Z`, ch.siteId)] : [];
    },
    ...overrides,
  };
}

describe('grab', () => {
  it('skips fresh cache entries and fetches stale ones', async () => {
    const cache = new MemoryCache();
    const fetchedDays: string[] = [];

    cache.seed(
      { site: 'example.com', channelId: 'one.example', day: TODAY },
      { grabbedAt: NOW.toISOString(), programmeCount: 1 },
    );

    const config = makeConfig({
      days: 2,
      staleness: { alwaysRefetchDays: 0 },
      async request({ day }) {
        fetchedDays.push(day);
        return { canned: true };
      },
    });

    const summary = await grab([config], { cache, now: NOW });

    expect(summary.fromCache).toBe(1);
    expect(summary.fetched).toBe(1);
    expect(summary.failed).toEqual([]);
    expect(fetchedDays).toEqual([TOMORROW]);
  });

  it('alwaysRefetchDays=1 forces a refetch of today even when cached fresh', async () => {
    const cache = new MemoryCache();

    cache.seed(
      { site: 'example.com', channelId: 'one.example', day: TODAY },
      { grabbedAt: NOW.toISOString(), programmeCount: 1 },
    );

    const summary = await grab([makeConfig({ staleness: { alwaysRefetchDays: 1 } })], {
      cache,
      now: NOW,
    });

    expect(summary.fetched).toBe(1);
    expect(summary.fromCache).toBe(0);
  });

  it('maxAgeDays busts an entry grabbed too long ago', async () => {
    const cache = new MemoryCache();

    cache.seed(
      { site: 'example.com', channelId: 'old.example', day: TODAY },
      { grabbedAt: '2026-07-07T12:00:00.000Z', programmeCount: 1 },
    );
    cache.seed(
      { site: 'example.com', channelId: 'new.example', day: TODAY },
      { grabbedAt: '2026-07-16T12:00:00.000Z', programmeCount: 1 },
    );

    const config = makeConfig({
      channels: [channel('old.example'), channel('new.example')],
      staleness: { alwaysRefetchDays: 0, maxAgeDays: 7 },
    });

    const summary = await grab([config], { cache, now: NOW });

    expect(summary.fetched).toBe(1);
    expect(summary.fromCache).toBe(1);
    expect(cache.get({ site: 'example.com', channelId: 'old.example', day: TODAY })?.meta.grabbedAt).toBe(
      NOW.toISOString(),
    );
  });

  it('per-site days override wins over the global option', async () => {
    const cache = new MemoryCache();
    const fetchedDays: string[] = [];

    const config = makeConfig({
      days: 2,
      async request({ day }) {
        fetchedDays.push(day);
        return {};
      },
    });

    await grab([config], { cache, now: NOW, days: 5 });

    expect(fetchedDays.sort()).toEqual([TODAY, TOMORROW]);
  });

  it('normalizes programme channel to xmltvId and sorts by start before writing', async () => {
    const cache = new MemoryCache();

    const config = makeConfig({
      parseDay: () => [
        programme(`${TODAY}T20:00:00.000Z`, 'wrong-id'),
        programme(`${TODAY}T06:00:00.000Z`, 'another-wrong-id'),
        programme(`${TODAY}T12:00:00.000Z`, 'raw.source'),
      ],
    });

    await grab([config], { cache, now: NOW });

    const written = cache.get({ site: 'example.com', channelId: 'one.example', day: TODAY });
    expect(written).toBeDefined();
    expect(written!.programmes.map((p) => p.channel)).toEqual([
      'one.example',
      'one.example',
      'one.example',
    ]);
    expect(written!.programmes.map((p) => p.start.toISOString())).toEqual([
      `${TODAY}T06:00:00.000Z`,
      `${TODAY}T12:00:00.000Z`,
      `${TODAY}T20:00:00.000Z`,
    ]);
    expect(written!.meta.grabbedAt).toBe(NOW.toISOString());
  });

  it('records a failed task without aborting the other tasks', async () => {
    const cache = new MemoryCache();
    const boom = new Error('network down');

    const config = makeConfig({
      channels: [channel('good.example'), channel('bad.example')],
      async request({ channel: ch }) {
        if (ch.xmltvId === 'bad.example') {
          throw boom;
        }

        return {};
      },
    });

    const logs: string[] = [];
    const summary = await grab([config], { cache, now: NOW, logger: (m) => logs.push(m) });

    expect(summary.fetched).toBe(1);
    expect(summary.failed).toEqual([
      { site: 'example.com', channelId: 'bad.example', day: TODAY, error: boom },
    ]);
    expect(cache.get({ site: 'example.com', channelId: 'good.example', day: TODAY })).toBeDefined();
    expect(logs.some((m) => m.includes('network down'))).toBe(true);
  });

  it('runs channel-days sequentially per site when concurrency is 1', async () => {
    const cache = new MemoryCache();
    let inFlight = 0;
    let maxInFlight = 0;

    const config = makeConfig({
      days: 4,
      async request() {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return {};
      },
    });

    const summary = await grab([config], { cache, now: NOW });

    expect(summary.fetched).toBe(4);
    expect(maxInFlight).toBe(1);
  });

  it('paces a fetched channel list in the site queue, like any other request', async () => {
    const cache = new MemoryCache();
    const at: number[] = [];

    const config = makeConfig({
      delayMs: 30,
      channels: () => {
        at.push(Date.now());
        return [channel('one')];
      },
      async request() {
        at.push(Date.now());
        return {};
      },
    });

    await grab([config], { cache, now: NOW });

    // Asking the source for its channels is a request to it too, so the site's
    // own spacing applies between that and the first day fetched.
    expect(at).toHaveLength(2);
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(25);
  });

  it('runs two sites in parallel under the outer queue', async () => {
    const cache = new MemoryCache();
    let inFlight = 0;
    let maxInFlight = 0;

    const request = async (): Promise<unknown> => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight--;
      return {};
    };

    const siteA = makeConfig({ site: 'a.example', request });
    const siteB = makeConfig({ site: 'b.example', request });

    const summary = await grab([siteA, siteB], { cache, now: NOW });

    expect(summary.fetched).toBe(2);
    expect(maxInFlight).toBe(2);
  });

  it('resolves channels from a function', async () => {
    const cache = new MemoryCache();

    const config = makeConfig({
      channels: async () => [channel('fn.example')],
    });

    const summary = await grab([config], { cache, now: NOW });

    expect(summary.fetched).toBe(1);
    expect(cache.get({ site: 'example.com', channelId: 'fn.example', day: TODAY })).toBeDefined();
  });

  it('hands a channels function the site\'s own client, and the same one requests use', async () => {
    const cache = new MemoryCache();
    let listClient: unknown;
    let requestClient: unknown;

    const config = makeConfig({
      ky: { prefix: 'https://api.example.tv' },
      channels: (ctx) => {
        listClient = ctx.http;
        return [channel('fn.example')];
      },
      async request({ http }) {
        requestClient = http;
        return {};
      },
    });

    await grab([config], { cache, now: NOW });

    expect(typeof (listClient as { get?: unknown })?.get).toBe('function');
    expect(listClient).toBe(requestClient); // built once for the site, not per call
  });

  it('carries a channel\'s data through to the request and to parseDay', async () => {
    const cache = new MemoryCache();
    const seen: unknown[] = [];

    const config: SiteConfig<unknown, 'none', { token: string }> = {
      site: 'example.com',
      days: 1,
      channels: () => [{ xmltvId: 'one.example', siteId: 'site-one', data: { token: 't-1' } }],
      async request({ channel }) {
        seen.push(channel.data?.token);
        return {};
      },
      parseDay({ channel, day }) {
        seen.push(channel.data?.token);
        return [programme(`${day}T06:00:00.000Z`, channel.xmltvId)];
      },
    };

    const summary = await grab([config], { cache, now: NOW });

    expect(summary.fetched).toBe(1);
    expect(seen).toEqual(['t-1', 't-1']);
  });

  it('aborts a channels function\'s own requests through the client it was given', async () => {
    const cache = new MemoryCache();
    const controller = new AbortController();
    const boom = new Error('run cancelled');
    controller.abort(boom);

    const config = makeConfig({
      // Nothing here forwards the signal; the instance carries it.
      channels: async ({ http }) => {
        await http.get('http://127.0.0.1:9/channels');
        return [channel('fn.example')];
      },
    });

    const summary = await grab([config], { cache, now: NOW, signal: controller.signal });

    expect(summary.fetched).toBe(0);
    expect(summary.failed).toEqual([
      { site: 'example.com', channelId: '*', day: '*', error: boom },
    ]);
  });

  it('startDay moves the window', async () => {
    const cache = new MemoryCache();
    const fetchedDays: string[] = [];

    const config = makeConfig({
      days: 2,
      async request({ day }) {
        fetchedDays.push(day);
        return { canned: true };
      },
    });

    await grab([config], { cache, now: NOW, startDay: TOMORROW });

    expect(fetchedDays).toEqual([TOMORROW, '2026-07-19']);
  });

  it('startDay does not move the staleness reference, which stays on now', async () => {
    const cache = new MemoryCache();
    const fetchedDays: string[] = [];

    // Both days are cached fresh. With alwaysRefetchDays=1 only *today* is
    // force-refetched — today being a fact about `now`, not about where the
    // window happens to start.
    for (const day of [TODAY, TOMORROW]) {
      cache.seed(
        { site: 'example.com', channelId: 'one.example', day },
        { grabbedAt: NOW.toISOString(), programmeCount: 1 },
      );
    }

    const config = makeConfig({
      days: 2,
      staleness: { alwaysRefetchDays: 1 },
      async request({ day }) {
        fetchedDays.push(day);
        return { canned: true };
      },
    });

    await grab([config], { cache, now: NOW, startDay: TODAY });
    expect(fetchedDays).toEqual([TODAY]);

    fetchedDays.length = 0;

    // Shifting the window forward must not make tomorrow "today": it stays
    // served from cache, and only the uncached day behind it is fetched.
    await grab([config], { cache, now: NOW, startDay: TOMORROW });
    expect(fetchedDays).toEqual(['2026-07-19']);
  });
});


describe('grab with batching: channels', () => {
  it('fetches a day\'s channels in one request and caches each channel-day', async () => {
    const cache = new MemoryCache();
    const batchCalls: string[][] = [];

    const config = makeBatchConfig({
      async request({ channels }) {
        batchCalls.push(channels.map((c) => c.xmltvId));
        return { items: channels.map((c) => ({ id: c.siteId })) } satisfies BatchData;
      },
    });

    const summary = await grab([config], { cache, now: NOW });

    expect(batchCalls).toEqual([['a', 'b', 'c']]); // one request, all channels
    expect(summary.fetched).toBe(3); // three channel-days written
    expect(summary.failed).toEqual([]);
    for (const id of ['a', 'b', 'c']) {
      const written = cache.get({ site: 'batch.example', channelId: id, day: TODAY });
      expect(written?.programmes.map((p) => p.channel)).toEqual([id]); // normalized to xmltvId
    }
  });

  it('includes only the stale channels in the batch', async () => {
    const cache = new MemoryCache();
    cache.seed(
      { site: 'batch.example', channelId: 'b', day: TODAY },
      { grabbedAt: NOW.toISOString(), programmeCount: 1 },
    );
    const batchCalls: string[][] = [];

    const config = makeBatchConfig({
      staleness: { alwaysRefetchDays: 0 },
      async request({ channels }) {
        batchCalls.push(channels.map((c) => c.xmltvId));
        return { items: channels.map((c) => ({ id: c.siteId })) } satisfies BatchData;
      },
    });

    const summary = await grab([config], { cache, now: NOW });

    expect(batchCalls).toEqual([['a', 'c']]); // b was fresh, left out
    expect(summary.fromCache).toBe(1);
    expect(summary.fetched).toBe(2);
  });

  it('caps channels per request at channelsPerRequest', async () => {
    const cache = new MemoryCache();
    const batchCalls: string[][] = [];

    const config = makeBatchConfig({
      batching: { mode: 'channels', channelsPerRequest: 2 },
      async request({ channels }) {
        batchCalls.push(channels.map((c) => c.xmltvId));
        return { items: channels.map((c) => ({ id: c.siteId })) } satisfies BatchData;
      },
    });

    await grab([config], { cache, now: NOW });

    expect(batchCalls).toEqual([['a', 'b'], ['c']]); // sequential at concurrency 1
  });

  it('lists the channel-days it is for, matching the channels it covers', async () => {
    const cache = new MemoryCache();
    const wanted: string[][] = [];

    const config = makeBatchConfig({
      async request({ channels, channelDays }) {
        wanted.push(channelDays.map(({ channel: ch, day }) => `${ch.xmltvId} ${day}`));
        return { items: channels.map((c) => ({ id: c.siteId })) } satisfies BatchData;
      },
    });

    await grab([config], { cache, now: NOW });

    expect(wanted).toEqual([[`a ${TODAY}`, `b ${TODAY}`, `c ${TODAY}`]]);
  });

  it('still asks per day, one day at a time', async () => {
    const cache = new MemoryCache();
    const calls: { channels: string[]; day: string }[] = [];

    const config = makeBatchConfig({
      days: 2,
      channels: [channel('a'), channel('b')],
      async request({ channels, day }) {
        calls.push({ channels: channels.map((c) => c.xmltvId), day });
        return { items: channels.map((c) => ({ id: c.siteId })) } satisfies BatchData;
      },
    });

    await grab([config], { cache, now: NOW });

    expect(calls).toEqual([
      { channels: ['a', 'b'], day: TODAY },
      { channels: ['a', 'b'], day: TOMORROW },
    ]);
  });

  it('fails every channel in a batch when the request throws', async () => {
    const cache = new MemoryCache();
    const boom = new Error('batch down');

    const config = makeBatchConfig({
      channels: [channel('a'), channel('b')],
      async request(): Promise<BatchData> {
        throw boom;
      },
    });

    const summary = await grab([config], { cache, now: NOW });

    expect(summary.fetched).toBe(0);
    expect(summary.failed).toEqual([
      { site: 'batch.example', channelId: 'a', day: TODAY, error: boom },
      { site: 'batch.example', channelId: 'b', day: TODAY, error: boom },
    ]);
  });

  it('a per-channel parse failure does not sink the rest of the batch', async () => {
    const cache = new MemoryCache();
    const boom = new Error('bad parse');

    const config = makeBatchConfig({
      channels: [channel('a'), channel('b')],
      parseDay({ channel: ch, day }) {
        if (ch.xmltvId === 'a') {
          throw boom;
        }

        return [programme(`${day}T06:00:00.000Z`, ch.siteId)];
      },
    });

    const summary = await grab([config], { cache, now: NOW });

    expect(summary.fetched).toBe(1);
    expect(summary.failed).toEqual([
      { site: 'batch.example', channelId: 'a', day: TODAY, error: boom },
    ]);
    expect(cache.get({ site: 'batch.example', channelId: 'b', day: TODAY })).toBeDefined();
  });
});

describe('grab with batching: days', () => {
  it('fetches a channel\'s whole window in one request and caches each day', async () => {
    const cache = new MemoryCache();
    const calls: { channel: string; days: string[]; from: string; to: string }[] = [];

    const config = makeDaysConfig({
      async request({ channel: ch, days, from, to }) {
        calls.push({
          channel: ch.xmltvId,
          days,
          from: from.toISOString(),
          to: to.toISOString(),
        });
        return { items: days.map((day) => ({ id: day })) } satisfies BatchData;
      },
    });

    const summary = await grab([config], { cache, now: NOW });

    expect(calls).toEqual([{
      channel: 'a',
      days: [TODAY, TOMORROW, '2026-07-19', '2026-07-20'],
      from: `${TODAY}T00:00:00.000Z`,
      to: '2026-07-20T00:00:00.000Z',
    }]);
    expect(summary.fetched).toBe(4); // one request, four channel-days written
    expect(summary.failed).toEqual([]);
    for (const day of [TODAY, TOMORROW, '2026-07-19', '2026-07-20']) {
      const written = cache.get({ site: 'days.example', channelId: 'a', day });
      expect(written?.programmes.map((p) => p.start.toISOString())).toEqual([`${day}T06:00:00.000Z`]);
    }
  });

  it('includes only the stale days, leaving gaps where the cache is fresh', async () => {
    const cache = new MemoryCache();
    cache.seed(
      { site: 'days.example', channelId: 'a', day: TOMORROW },
      { grabbedAt: NOW.toISOString(), programmeCount: 1 },
    );
    const calls: string[][] = [];

    const config = makeDaysConfig({
      staleness: { alwaysRefetchDays: 0 },
      async request({ days }) {
        calls.push(days);
        return { items: days.map((day) => ({ id: day })) } satisfies BatchData;
      },
    });

    const summary = await grab([config], { cache, now: NOW });

    expect(calls).toEqual([[TODAY, '2026-07-19', '2026-07-20']]); // tomorrow was fresh
    expect(summary.fromCache).toBe(1);
    expect(summary.fetched).toBe(3);
  });

  it('caps days per request at daysPerRequest', async () => {
    const cache = new MemoryCache();
    const calls: string[][] = [];

    const config = makeDaysConfig({
      batching: { mode: 'days', daysPerRequest: 3 },
      async request({ days }) {
        calls.push(days);
        return { items: days.map((day) => ({ id: day })) } satisfies BatchData;
      },
    });

    await grab([config], { cache, now: NOW });

    expect(calls).toEqual([[TODAY, TOMORROW, '2026-07-19'], ['2026-07-20']]);
  });

  it('asks once per channel, each with its own days', async () => {
    const cache = new MemoryCache();
    const calls: { channel: string; days: string[] }[] = [];

    const config = makeDaysConfig({
      days: 2,
      channels: [channel('a'), channel('b')],
      async request({ channel: ch, days }) {
        calls.push({ channel: ch.xmltvId, days });
        return { items: days.map((day) => ({ id: day })) } satisfies BatchData;
      },
    });

    const summary = await grab([config], { cache, now: NOW });

    expect(calls).toEqual([
      { channel: 'a', days: [TODAY, TOMORROW] },
      { channel: 'b', days: [TODAY, TOMORROW] },
    ]);
    expect(summary.fetched).toBe(4);
  });

  it('fails every day the request covered when it throws', async () => {
    const cache = new MemoryCache();
    const boom = new Error('range down');

    const config = makeDaysConfig({
      days: 2,
      async request(): Promise<BatchData> {
        throw boom;
      },
    });

    const summary = await grab([config], { cache, now: NOW });

    expect(summary.fetched).toBe(0);
    expect(summary.failed).toEqual([
      { site: 'days.example', channelId: 'a', day: TODAY, error: boom },
      { site: 'days.example', channelId: 'a', day: TOMORROW, error: boom },
    ]);
  });

  it('a per-day parse failure does not sink the other days', async () => {
    const cache = new MemoryCache();
    const boom = new Error('bad day');

    const config = makeDaysConfig({
      days: 2,
      parseDay({ channel: ch, day }) {
        if (day === TODAY) {
          throw boom;
        }

        return [programme(`${day}T06:00:00.000Z`, ch.siteId)];
      },
    });

    const summary = await grab([config], { cache, now: NOW });

    expect(summary.fetched).toBe(1);
    expect(summary.failed).toEqual([
      { site: 'days.example', channelId: 'a', day: TODAY, error: boom },
    ]);
    expect(cache.get({ site: 'days.example', channelId: 'a', day: TOMORROW })).toBeDefined();
  });
});

describe('grab with batching: both', () => {
  it('covers many channels over many days in one request', async () => {
    const cache = new MemoryCache();
    const calls: { channels: string[]; days: string[] }[] = [];

    const config: SiteConfig<unknown, ChannelsDaysBatching> = {
      site: 'grid.example',
      channels: [channel('a'), channel('b'), channel('c')],
      days: 2,
      batching: { mode: 'both' },
      async request({ channels, days }) {
        calls.push({ channels: channels.map((c) => c.xmltvId), days });
        return {};
      },
      parseDay({ channel: ch, day }) {
        return [programme(`${day}T06:00:00.000Z`, ch.siteId)];
      },
    };

    const summary = await grab([config], { cache, now: NOW });

    expect(calls).toEqual([{ channels: ['a', 'b', 'c'], days: [TODAY, TOMORROW] }]);
    expect(summary.fetched).toBe(6); // one request, the whole 3 × 2 grid
  });

  it('cuts the grid along both caps at once', async () => {
    const cache = new MemoryCache();
    const calls: { channels: string[]; days: string[] }[] = [];

    const config: SiteConfig<unknown, ChannelsDaysBatching> = {
      site: 'grid.example',
      channels: [channel('a'), channel('b'), channel('c')],
      days: 3,
      batching: { mode: 'both', channelsPerRequest: 2, daysPerRequest: 2 },
      async request({ channels, days }) {
        calls.push({ channels: channels.map((c) => c.xmltvId), days });
        return {};
      },
      parseDay: () => [],
    };

    await grab([config], { cache, now: NOW });

    // Days are cut first, then each run's channels: 2 day-runs × 2 channel-groups.
    expect(calls).toEqual([
      { channels: ['a', 'b'], days: [TODAY, TOMORROW] },
      { channels: ['c'], days: [TODAY, TOMORROW] },
      { channels: ['a', 'b'], days: ['2026-07-19'] },
      { channels: ['c'], days: ['2026-07-19'] },
    ]);
  });

  it('keeps a fresh channel-day caught inside a request out of the cache write', async () => {
    const cache = new MemoryCache();
    cache.seed(
      { site: 'grid.example', channelId: 'b', day: TOMORROW },
      { grabbedAt: NOW.toISOString(), programmeCount: 1 },
      [programme(`${TOMORROW}T20:00:00.000Z`, 'b')],
    );
    const parsed: string[] = [];
    let covered: { channels: string[]; days: string[] } | undefined;
    let wanted: string[] | undefined;

    const config: SiteConfig<unknown, ChannelsDaysBatching> = {
      site: 'grid.example',
      channels: [channel('a'), channel('b')],
      days: 2,
      batching: { mode: 'both' },
      staleness: { alwaysRefetchDays: 0 },
      async request({ channels, days, channelDays }) {
        covered = { channels: channels.map((c) => c.xmltvId), days };
        wanted = channelDays.map(({ channel: ch, day, date }) => `${ch.xmltvId} ${day} ${date.toISOString()}`);
        return {};
      },
      parseDay({ channel: ch, day }) {
        parsed.push(`${ch.xmltvId} ${day}`);
        return [programme(`${day}T06:00:00.000Z`, ch.siteId)];
      },
    };

    const summary = await grab([config], { cache, now: NOW });

    // b/tomorrow is inside the rectangle the request covered, but it was fresh:
    // channelDays leaves it out, and it is neither parsed nor rewritten.
    expect(covered).toEqual({ channels: ['a', 'b'], days: [TODAY, TOMORROW] });
    expect(wanted).toEqual([
      `a ${TODAY} ${TODAY}T00:00:00.000Z`,
      `a ${TOMORROW} ${TOMORROW}T00:00:00.000Z`,
      `b ${TODAY} ${TODAY}T00:00:00.000Z`,
    ]);
    expect(parsed.sort()).toEqual([`a ${TODAY}`, `a ${TOMORROW}`, `b ${TODAY}`]);
    expect(summary.fromCache).toBe(1);
    expect(summary.fetched).toBe(3);
    expect(cache.get({ site: 'grid.example', channelId: 'b', day: TOMORROW })?.programmes)
      .toEqual([programme(`${TOMORROW}T20:00:00.000Z`, 'b')]);
  });
});

describe('grab without a fetch', () => {
  it('fails the site rather than silently grabbing nothing', async () => {
    const cache = new MemoryCache();
    const config = {
      site: 'example.com',
      channels: [channel('one.example')],
      days: 1,
      parseDay({ day }: { day: string }) {
        return [programme(`${day}T06:00:00.000Z`)];
      },
    } as unknown as SiteConfig<unknown>;

    const summary = await grab([config], { cache, now: NOW });

    expect(summary.fetched).toBe(0);
    expect(summary.failed).toHaveLength(1);
    expect(summary.failed[0]!.error).toBeInstanceOf(Error);
    expect((summary.failed[0]!.error as Error).message).toContain('must define request');
  });
});
