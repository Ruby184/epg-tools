import { describe, expect, it } from 'vitest';
import type { CacheEntryMeta, CacheStore, ChannelDayKey } from '../src/cache/types.js';
import type { XmltvProgramme } from '../src/xmltv/types.js';
import { grab } from '../src/grabber/main.js';
import type { GrabberChannel, SiteConfig } from '../src/grabber/main.js';

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
    async fetchDay() {
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

function makeBatchConfig(overrides: Partial<SiteConfig<unknown>> = {}): SiteConfig<unknown> {
  return {
    site: 'batch.example',
    channels: [channel('a'), channel('b'), channel('c')],
    days: 1,
    async fetchDayBatch({ channels }) {
      return { items: channels.map((c) => ({ id: c.siteId })) } satisfies BatchData;
    },
    parseDay({ channel: ch, data, day }) {
      const item = (data as BatchData).items.find((i) => i.id === ch.siteId);
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
      async fetchDay({ day }) {
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
      async fetchDay({ day }) {
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
      async fetchDay({ channel: ch }) {
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
      async fetchDay() {
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

  it('runs two sites in parallel under the outer queue', async () => {
    const cache = new MemoryCache();
    let inFlight = 0;
    let maxInFlight = 0;

    const fetchDay = async (): Promise<unknown> => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight--;
      return {};
    };

    const siteA = makeConfig({ site: 'a.example', fetchDay });
    const siteB = makeConfig({ site: 'b.example', fetchDay });

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

  it('startDay moves the window', async () => {
    const cache = new MemoryCache();
    const fetchedDays: string[] = [];

    const config = makeConfig({
      days: 2,
      async fetchDay({ day }) {
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
      async fetchDay({ day }) {
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

describe('grab with fetchDayBatch', () => {
  it('fetches a day\'s channels in one request and caches each channel-day', async () => {
    const cache = new MemoryCache();
    const batchCalls: string[][] = [];

    const config = makeBatchConfig({
      async fetchDayBatch({ channels }) {
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
      async fetchDayBatch({ channels }) {
        batchCalls.push(channels.map((c) => c.xmltvId));
        return { items: channels.map((c) => ({ id: c.siteId })) } satisfies BatchData;
      },
    });

    const summary = await grab([config], { cache, now: NOW });

    expect(batchCalls).toEqual([['a', 'c']]); // b was fresh, left out
    expect(summary.fromCache).toBe(1);
    expect(summary.fetched).toBe(2);
  });

  it('caps channels per request at batchSize', async () => {
    const cache = new MemoryCache();
    const batchCalls: string[][] = [];

    const config = makeBatchConfig({
      batchSize: 2,
      async fetchDayBatch({ channels }) {
        batchCalls.push(channels.map((c) => c.xmltvId));
        return { items: channels.map((c) => ({ id: c.siteId })) } satisfies BatchData;
      },
    });

    await grab([config], { cache, now: NOW });

    expect(batchCalls).toEqual([['a', 'b'], ['c']]); // sequential at concurrency 1
  });

  it('fails every channel in a batch when the request throws', async () => {
    const cache = new MemoryCache();
    const boom = new Error('batch down');

    const config = makeBatchConfig({
      channels: [channel('a'), channel('b')],
      async fetchDayBatch(): Promise<BatchData> {
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

  it('rejects a site defining neither fetchDay nor fetchDayBatch', async () => {
    const cache = new MemoryCache();
    const config: SiteConfig<unknown> = {
      site: 'example.com',
      channels: [channel('one.example')],
      days: 1,
      parseDay({ day }) {
        return [programme(`${day}T06:00:00.000Z`)];
      },
    };

    const summary = await grab([config], { cache, now: NOW });

    expect(summary.fetched).toBe(0);
    expect(summary.failed).toHaveLength(1);
    expect(summary.failed[0]!.error).toBeInstanceOf(Error);
    expect((summary.failed[0]!.error as Error).message).toContain('fetchDay or fetchDayBatch');
  });
});
