import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import type {
  CacheEntryMeta,
  CacheStore,
  ChannelDayKey,
  StateEntry,
  StoredStateMeta,
} from '../src/cache/types.js';
import type { XmltvProgramme } from '../src/xmltv/types.js';
import { grab, UnchangedError } from '../src/grabber/main.js';
import type {
  ChannelsBatching,
  ChannelsDaysBatching,
  DaysBatching,
  GrabberChannel,
  SiteConfig,
  StreamedChannelDay,
  StreamSiteConfig,
} from '../src/grabber/main.js';

const NOW = new Date('2026-07-17T12:00:00.000Z');
const TODAY = '2026-07-17';
const TOMORROW = '2026-07-18';
const DAY_AFTER = '2026-07-19';

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

  /** What each batch was asked for, so a test can say how many there were. */
  batches: ChannelDayKey[][] = [];

  async getMeta(key: ChannelDayKey): Promise<CacheEntryMeta | undefined> {
    return this.entries.get(this.keyOf(key))?.meta;
  }

  async getMetas(keys: readonly ChannelDayKey[]): Promise<Array<CacheEntryMeta | undefined>> {
    this.batches.push([...keys]);

    // One after another, as a real store does: a batch is one piece of work,
    // and answering it with a `Promise.all` would multiply whatever bound the
    // caller had chosen by the size of the batch.
    const metas: Array<CacheEntryMeta | undefined> = [];

    for (const key of keys) {
      metas.push(await this.getMeta(key));
    }

    return metas;
  }

  /** What each site remembers, by `site|key` — see the state tests below. */
  state = new Map<string, { data: unknown; meta: StoredStateMeta }>();
  /** Which groups were read and written, so a test can say how often. */
  stateReads: string[] = [];
  stateWrites: string[] = [];

  /** Remember a group as an earlier run would have left it. */
  seedState(site: string, key: string, data: unknown, writtenAt: string = NOW.toISOString()): void {
    this.state.set(`${site}|${key}`, { data, meta: { writtenAt, schema: 1, writtenBy: 'test' } });
  }

  async getState(site: string, key: string): Promise<StateEntry | undefined> {
    this.stateReads.push(`${site}|${key}`);

    return this.state.get(`${site}|${key}`);
  }

  async setState(
    site: string,
    key: string,
    data: unknown,
    meta?: { writtenAt?: string },
  ): Promise<void> {
    this.stateWrites.push(`${site}|${key}`);
    this.seedState(site, key, data, meta?.writtenAt ?? NOW.toISOString());
  }

  async read(key: ChannelDayKey): Promise<XmltvProgramme[] | undefined> {
    return this.entries.get(this.keyOf(key))?.programmes;
  }

  async write(
    key: ChannelDayKey,
    programmes: XmltvProgramme[],
    meta?: Partial<CacheEntryMeta>,
  ): Promise<void> {
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

  async close(): Promise<void> {}

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
    parseDay({ channel: ch, payload, day }) {
      const item = (payload as BatchData).items.find((i) => i.id === ch.siteId);
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
    parseDay({ channel: ch, payload, day }) {
      const item = (payload as BatchData).items.find((i) => i.id === day);
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

  it('counts a channel-day that parsed to nothing, without failing it', async () => {
    const cache = new MemoryCache();
    const config = makeConfig({
      days: 2,
      channels: [channel('one.example'), channel('two.example')],
      parseDay({ channel: ch, day }) {
        return ch.xmltvId === 'two.example' ? [] : [programme(`${day}T06:00:00.000Z`)];
      },
    });

    const summary = await grab([config], { cache, now: NOW });

    expect(summary.fetched).toBe(4);
    expect(summary.empty).toBe(2);
    expect(summary.failed).toEqual([]);
    // Cached like any other entry — what makes it come round again is the
    // staleness policy, not the grab.
    expect(
      cache.get({ site: 'example.com', channelId: 'two.example', day: TODAY })?.meta,
    ).toMatchObject({ programmeCount: 0 });
  });

  it('refetches a day cached empty a day ago, and leaves a full one alone', async () => {
    const cache = new MemoryCache();
    const yesterday = new Date(NOW.getTime() - 26 * 3_600_000).toISOString();
    const asked: string[] = [];

    cache.seed(
      { site: 'example.com', channelId: 'empty.example', day: TOMORROW },
      {
        grabbedAt: yesterday,
        programmeCount: 0,
      },
    );
    cache.seed(
      { site: 'example.com', channelId: 'full.example', day: TOMORROW },
      {
        grabbedAt: yesterday,
        programmeCount: 3,
      },
    );

    const config = makeConfig({
      days: 2,
      channels: [channel('empty.example'), channel('full.example')],
      staleness: { alwaysRefetchDays: 0 },
      async request({ channel: ch, day }) {
        asked.push(`${ch.xmltvId} ${day}`);
        return { canned: true };
      },
    });

    await grab([config], { cache, now: NOW });

    expect(asked).toContain(`empty.example ${TOMORROW}`);
    expect(asked).not.toContain(`full.example ${TOMORROW}`);
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
    expect(
      cache.get({ site: 'example.com', channelId: 'old.example', day: TODAY })?.meta.grabbedAt,
    ).toBe(NOW.toISOString());
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

  it('parses with a builder bound to the channel and its language', async () => {
    const cache = new MemoryCache();

    const config = makeConfig({
      channels: [{ xmltvId: 'one.example', siteId: '1', lang: 'sk' }],
      parseDay({ programme, day }) {
        // No channel id anywhere, and no `lang` repeated per element.
        return [
          programme(new Date(`${day}T06:00:00.000Z`), 'Ranné správy')
            .stop(new Date(`${day}T07:00:00.000Z`))
            .desc('Prehľad dňa')
            .category('news')
            .episode(3, 2),
          programme(new Date(`${day}T20:00:00.000Z`), 'Film', { lang: 'en' }).new(),
        ];
      },
    });

    const summary = await grab([config], { cache, now: NOW });

    expect(summary.fetched).toBe(1);
    const written = cache.get({
      site: 'example.com',
      channelId: 'one.example',
      day: TODAY,
    })!.programmes;

    expect(written.map((p) => p.channel)).toEqual(['one.example', 'one.example']);
    expect(written[0]!.title).toEqual([{ value: 'Ranné správy', lang: 'sk' }]);
    expect(written[0]!.desc).toEqual([{ value: 'Prehľad dňa', lang: 'sk' }]);
    expect(written[0]!.category).toEqual([{ value: 'news', lang: 'sk' }]);
    expect(written[0]!.stop?.toISOString()).toBe(`${TODAY}T07:00:00.000Z`);
    // `.episode(3, 2)` is episode 3 of season 2, in both systems the builder emits.
    expect(written[0]!.episodeNum).toEqual([
      { system: 'xmltv_ns', value: '1.2.0/1' },
      { system: 'onscreen', value: 'S02E03' },
    ]);
    // A programme may say its own language over the channel's.
    expect(written[1]!.title).toEqual([{ value: 'Film', lang: 'en' }]);
    expect(written[1]!.new).toBe(true);
  });

  it('takes builders and plain programmes in the same parse', async () => {
    const cache = new MemoryCache();

    const config = makeConfig({
      parseDay({ programme, channel: ch, day }) {
        return [
          programme(new Date(`${day}T06:00:00.000Z`), 'Built'),
          {
            channel: ch.xmltvId,
            start: new Date(`${day}T08:00:00.000Z`),
            title: [{ value: 'Plain' }],
          },
        ];
      },
    });

    await grab([config], { cache, now: NOW });

    const written = cache.get({
      site: 'example.com',
      channelId: 'one.example',
      day: TODAY,
    })!.programmes;
    expect(written.map((p) => p.title[0]?.value)).toEqual(['Built', 'Plain']);
    expect(written.every((p) => p.channel === 'one.example')).toBe(true);
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

  it('stops sending for a site that answers 429, and finishes the run after', async () => {
    // One 429 with a short Retry-After, then normal service.
    let hits = 0;
    const server = createServer((_request, response) => {
      hits++;

      if (hits === 1) {
        response.writeHead(429, { 'retry-after': '0' });
      } else {
        response.writeHead(200, { 'content-type': 'application/json' });
      }

      response.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const cache = new MemoryCache();
      const logs: string[] = [];
      const asked: number[] = [];

      const config = makeConfig({
        days: 3,
        backoff: { fallbackMs: 40, maxMs: 40 },
        async request({ http }) {
          asked.push(Date.now());
          // retry: 0, so the 429 reaches the grabber as a failure rather than
          // being resent inside the request — the hold is the queue's doing,
          // not ky's.
          return http.get(`http://127.0.0.1:${port}/epg`, { retry: 0 }).json();
        },
      });

      const summary = await grab([config], { cache, now: NOW, logger: (m) => logs.push(m) });

      // All three days were attempted — the two behind the 429 were held, not
      // dropped — and only the first failed.
      expect(asked).toHaveLength(3);
      expect(summary.fetched).toBe(2);
      expect(summary.failed).toHaveLength(1);
      expect(logs.some((m) => m.includes('HTTP 429: holding requests'))).toBe(true);
    } finally {
      server.close();
    }
  });

  it('paces a fetched channel list in the site queue, like any other request', async () => {
    const cache = new MemoryCache();
    const at: string[] = [];

    const config = makeConfig({
      days: 3,
      rateLimit: { requests: 1, perMs: 20 },
      channels: () => {
        at.push('channels');
        return [channel('one')];
      },
      async request({ day }) {
        at.push(`request ${day}`);
        return {};
      },
    });

    const startedAt = Date.now();
    await grab([config], { cache, now: NOW });
    const elapsed = Date.now() - startedAt;

    // Asking the source for its channels is a request to it too, so the site's
    // own spacing applies between that and the days that follow.
    expect(at).toEqual([
      'channels',
      `request ${TODAY}`,
      `request ${TOMORROW}`,
      `request ${DAY_AFTER}`,
    ]);

    // The whole run rather than the gap between two of them, which is what
    // makes this a bound and not a race. A rate-limited queue cannot start its
    // nth task before n-1 windows have passed since it opened, and it opened no
    // earlier than `startedAt` — so four requests at one per 20ms take at least
    // 60ms however the event loop behaves. Comparing two adjacent timestamps
    // instead measures zero whenever a stall leaves several windows expired at
    // once and the queue catches up inside one tick.
    expect(elapsed).toBeGreaterThanOrEqual(55);
  });

  describe('a channel list kept between runs', () => {
    /** A site whose list is fetched, counting how often the source is asked. */
    function fetchingSite(
      asked: string[],
      overrides: Partial<SiteConfig<unknown>> = {},
    ): SiteConfig<unknown> {
      return makeConfig({
        channels: () => {
          asked.push('fetched');
          return [channel('one')];
        },
        ...overrides,
      });
    }

    it('is fetched once and read back by the next run', async () => {
      const cache = new MemoryCache();
      const asked: string[] = [];
      const config = fetchingSite(asked, { cacheChannels: true });

      await grab([config], { cache, now: NOW });
      await grab([config], { cache, now: NOW });

      // The second run asks the cache instead of the source — and gets the same
      // channels, so it grabs the same channel-days.
      expect(asked).toEqual(['fetched']);
      expect(cache.state.get('example.com|channels')?.data).toEqual([
        { xmltvId: 'one', siteId: 'site-one' },
      ]);
      expect(cache.stateWrites.filter((key) => key.endsWith('|channels'))).toEqual([
        'example.com|channels',
      ]);
    });

    it('is fetched again once it is older than the site allows', async () => {
      const cache = new MemoryCache();
      const asked: string[] = [];
      const config = fetchingSite(asked, { cacheChannels: { maxAgeDays: 1 } });

      await grab([config], { cache, now: NOW });
      // A day and a minute later, which a one-day list has not survived.
      await grab([config], { cache, now: new Date(NOW.getTime() + 86_460_000) });

      expect(asked).toEqual(['fetched', 'fetched']);
    });

    it('is left alone by a site that never asked for it to be kept', async () => {
      const cache = new MemoryCache();
      const asked: string[] = [];
      const config = fetchingSite(asked);

      await grab([config], { cache, now: NOW });
      await grab([config], { cache, now: NOW });

      // Off unless asked: the group is neither read nor written, and the source
      // answers every run as it did before any of this existed. The site's own
      // bag is still read — `ctx.state` has to be there before the first
      // request — but that is one small read and no write.
      expect(asked).toEqual(['fetched', 'fetched']);
      expect(cache.stateWrites).toEqual([]);
      expect(cache.stateReads.filter((key) => key.endsWith('|channels'))).toEqual([]);
    });

    it('is fetched whatever is cached when the run refetches everything', async () => {
      const cache = new MemoryCache();
      const asked: string[] = [];
      const config = fetchingSite(asked, { cacheChannels: true });

      await grab([config], { cache, now: NOW });
      await grab([config], { cache, now: NOW, staleness: { refetchAll: true } });

      // `--refresh` means ask the source, and a channel list is something the
      // source says.
      expect(asked).toEqual(['fetched', 'fetched']);
    });

    it('is fetched again when what was stored is not a channel list', async () => {
      const cache = new MemoryCache();
      const asked: string[] = [];
      const config = fetchingSite(asked, { cacheChannels: true });

      cache.seedState('example.com', 'channels', [{ nothing: 'like a channel' }]);
      await grab([config], { cache, now: NOW });

      expect(asked).toEqual(['fetched']);
      expect(cache.state.get('example.com|channels')?.data).toEqual([
        { xmltvId: 'one', siteId: 'site-one' },
      ]);
    });
  });

  describe("a site's own state", () => {
    it('reaches every request and parse, and survives to the next run', async () => {
      const cache = new MemoryCache();
      const seen: Array<unknown> = [];
      const config = makeConfig({
        days: 2,
        async request({ state }) {
          seen.push(state.get('token'));
          state.set('token', 'from-the-first-request');

          return {};
        },
        parseDay({ state, day }) {
          // The same Map the request was handed, not a copy of it.
          seen.push(`parse ${day}: ${String(state.get('token'))}`);

          return [];
        },
      });

      await grab([config], { cache, now: NOW });

      expect(cache.state.get('example.com|state')?.data).toEqual([
        ['token', 'from-the-first-request'],
      ]);

      await grab([config], { cache, now: NOW });

      // Nothing on the first request of the first run; by the second run it is
      // whatever the site left behind.
      expect(seen[0]).toBeUndefined();
      expect(seen).toContain('from-the-first-request');
      expect(seen.filter((entry) => entry === undefined)).toHaveLength(1);
    });

    it('is written only when the site changed something', async () => {
      const cache = new MemoryCache();
      const config = makeConfig({
        async request() {
          return {};
        },
      });

      await grab([config], { cache, now: NOW });

      // A site that never touches its bag costs no write — the group is read
      // once per site run and left as it was.
      expect(cache.stateWrites).toEqual([]);
      expect(cache.stateReads).toEqual(['example.com|state']);
    });

    it('is empty for a store that remembers nothing, and still works', async () => {
      const cache = new MemoryCache();
      const config = makeConfig({
        async request({ state }) {
          state.set('cursor', 12);

          return {};
        },
      });

      // A store whose state goes nowhere — `NoCacheDriver`, a read-only
      // filesystem. The site's own code neither knows nor breaks.
      cache.setState = async (): Promise<void> => {};

      const summary = await grab([config], { cache, now: NOW });

      expect(summary.fetched).toBe(1);
      expect(cache.state.size).toBe(0);
    });
  });

  it("hands parseDay the site's client, and the run's signal", async () => {
    const cache = new MemoryCache();
    const controller = new AbortController();
    let seen: { sameClient: boolean; signal: AbortSignal | undefined } | undefined;
    let client: unknown;

    const config = makeConfig({
      ky: { prefix: 'https://example.test' },
      async request({ http }) {
        client = http;
        return {};
      },
      parseDay({ http, signal, day }) {
        seen = { sameClient: http === client, signal };
        return [programme(`${day}T06:00:00.000Z`)];
      },
    });

    await grab([config], { cache, now: NOW, signal: controller.signal });

    // The very instance the request used — same prefix, headers, retry, proxy
    // and baked-in signal — rather than one the site had to build again.
    expect(seen?.sameClient).toBe(true);
    expect(seen?.signal?.aborted).toBe(false);
    controller.abort(new Error('done with it'));
    expect(seen?.signal?.aborted).toBe(true);
  });

  it('paces a request a parse makes in the site queue, like any other', async () => {
    const cache = new MemoryCache();
    const at: string[] = [];

    const config = makeConfig({
      days: 2,
      rateLimit: { requests: 1, perMs: 30 },
      async request({ day }) {
        at.push(`request ${day}`);
        return {};
      },
      async parseDay({ day, paced }) {
        await paced(async () => {
          at.push(`detail ${day}`);
        });

        return [programme(`${day}T06:00:00.000Z`)];
      },
    });

    const summary = await grab([config], { cache, now: NOW });

    expect(summary.fetched).toBe(2);
    // A parse's own request is a request to the same source, so the site's
    // spacing applies to it — and it goes ahead of the next planned day, so a
    // channel-day in hand is finished rather than joined by another.
    expect(at).toEqual([
      `request ${TODAY}`,
      `detail ${TODAY}`,
      `request ${TOMORROW}`,
      `detail ${TOMORROW}`,
    ]);

    // The order is the claim: a parse's request can only land between two
    // planned ones by having gone through the same queue. How far apart they
    // are is not asserted — a stalled event loop leaves several rate-limit
    // windows expired at once, and the queue then catches up within a single
    // tick, so the gap can measure zero without anything being wrong. The
    // spacing itself is p-queue's, and covered where the channel list is
    // fetched.
  });

  it('holds the whole site when a request a parse made is answered with 429', async () => {
    let hits = 0;
    const server = createServer((_request, response) => {
      response.writeHead(++hits === 1 ? 429 : 200, {
        'content-type': 'application/json',
        ...(hits === 1 ? { 'retry-after': '0' } : {}),
      });
      response.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const cache = new MemoryCache();
      const logs: string[] = [];
      const config = makeConfig({
        days: 2,
        backoff: { fallbackMs: 40, maxMs: 40 },
        async parseDay({ day, paced, http }) {
          await paced(({ signal }) =>
            http
              .get(`http://127.0.0.1:${port}/detail`, { retry: 0, ...(signal ? { signal } : {}) })
              .json()
              .catch(() => ({})),
          );

          return [programme(`${day}T06:00:00.000Z`)];
        },
      });

      await grab([config], { cache, now: NOW, logger: (message) => logs.push(message) });

      // The client reports a slow-down to the queue whoever asked for it, so a
      // parse cannot talk a site past a limit its requests are respecting.
      expect(logs.some((message) => message.includes('HTTP 429: holding requests'))).toBe(true);
    } finally {
      server.close();
    }
  });

  it("holds one response at a time per unit of a site's concurrency", async () => {
    const cache = new MemoryCache();
    let inHand = 0;
    let peak = 0;

    const config = makeConfig({
      days: 6,
      async request() {
        return {};
      },
      async parseDay({ day }) {
        inHand++;
        peak = Math.max(peak, inHand);
        // Long enough that a site racing ahead would have fetched the rest.
        await new Promise((resolve) => setTimeout(resolve, 5));
        inHand--;

        return [programme(`${day}T06:00:00.000Z`)];
      },
    });

    const summary = await grab([config], { cache, now: NOW });

    expect(summary.fetched).toBe(6);
    // The request slot no longer spans the parse, so this is what keeps a site
    // from fetching six responses and holding them while one is parsed.
    expect(peak).toBe(1);
  });

  it('drops a request a parse queued when the run is cancelled', async () => {
    const cache = new MemoryCache();
    const controller = new AbortController();
    let details = 0;

    const config = makeConfig({
      days: 4,
      concurrency: 2,
      async parseDay({ day, paced }) {
        controller.abort(new Error('run cancelled'));

        await paced(async () => {
          details++;
        }).catch(() => {});

        return [programme(`${day}T06:00:00.000Z`)];
      },
    });

    const summary = await grab([config], { cache, now: NOW, signal: controller.signal });

    // Queued behind the abort, so it is dropped rather than sent — and the
    // parse sees the rejection rather than hanging on a queue that has stopped.
    expect(details).toBe(0);
    expect(summary.fetched).toBe(0);
  });

  it("asks the cache about a channel's whole window at once", async () => {
    const cache = new MemoryCache();
    const config = makeConfig({ days: 3, channels: [channel('one'), channel('two')] });

    await grab([config], { cache, now: NOW });

    // One question per channel rather than one per channel-day: the answer for a
    // single day is worth almost nothing on its own, and a store that can settle
    // a window in one round trip only gets to if it is asked that way.
    expect(cache.batches.map((batch) => batch.map((key) => `${key.channelId} ${key.day}`))).toEqual(
      [
        [`one ${TODAY}`, `one ${TOMORROW}`, `one ${DAY_AFTER}`],
        [`two ${TODAY}`, `two ${TOMORROW}`, `two ${DAY_AFTER}`],
      ],
    );
  });

  it('still fetches only the days a batched answer says are stale', async () => {
    const cache = new MemoryCache();
    const fetched: string[] = [];
    const config = makeConfig({
      days: 3,
      async request({ day }) {
        fetched.push(day);
        return {};
      },
    });

    // Fresh in the middle of the window, and inside neither the always-refetch
    // window nor the age limit.
    cache.seed(
      { site: 'example.com', channelId: 'one.example', day: TOMORROW },
      { grabbedAt: NOW.toISOString(), programmeCount: 2 },
      [programme(`${TOMORROW}T06:00:00.000Z`)],
    );

    const summary = await grab([config], { cache, now: NOW });

    expect(fetched).toEqual([TODAY, DAY_AFTER]);
    expect(summary.fromCache).toBe(1);
    expect(summary.fetched).toBe(2);
  });

  it('bounds cache work and parsing at localConcurrency, across sites', async () => {
    // A cache whose every operation takes a turn of the event loop, so the
    // overlap is observable rather than instantaneous.
    class SlowCache extends MemoryCache {
      inFlight = 0;
      max = 0;

      private async slow<T>(work: () => T): Promise<T> {
        this.inFlight++;
        this.max = Math.max(this.max, this.inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        this.inFlight--;
        return work();
      }

      override async getMeta(key: ChannelDayKey): Promise<CacheEntryMeta | undefined> {
        return this.slow(() => this.get(key)?.meta);
      }

      override async write(key: ChannelDayKey, programmes: XmltvProgramme[]): Promise<void> {
        return this.slow(() => super.write(key, programmes));
      }
    }

    const cache = new SlowCache();
    const sites = ['a.example', 'b.example'].map((site) =>
      makeConfig({
        site,
        days: 4,
        channels: [channel('one'), channel('two'), channel('three')],
      }),
    );

    // 2 sites × 3 channels × 4 days: six sweeps of four days and 24 writes, all
    // of which the old unbounded Promise.all would have started at once.
    const summary = await grab(sites, { cache, now: NOW, localConcurrency: 3 });

    expect(summary.fetched).toBe(24);
    expect(cache.max).toBe(3);
  });

  it('runs two sites in parallel under the site queue', async () => {
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

  it("hands a channels function the site's own client, and the same one requests use", async () => {
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

  it("carries a channel's data through to the request and to parseDay", async () => {
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

  it("aborts a channels function's own requests through the client it was given", async () => {
    // A server that accepts and never answers, so the request is still in
    // flight when the run is cancelled — the case a queue cannot handle for
    // you, and the reason the signal rides on the client.
    const server = createServer(() => {});
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const cache = new MemoryCache();
      const controller = new AbortController();
      const boom = new Error('run cancelled');

      const config = makeConfig({
        // Nothing here forwards the signal; the instance carries it.
        channels: async ({ http }) => {
          setTimeout(() => controller.abort(boom), 10);
          await http.get(`http://127.0.0.1:${port}/channels`, { retry: 0 });
          return [channel('fn.example')];
        },
      });

      const summary = await grab([config], { cache, now: NOW, signal: controller.signal });

      expect(summary.fetched).toBe(0);
      expect(summary.failed).toEqual([
        { site: 'example.com', channelId: '*', day: '*', error: boom },
      ]);
    } finally {
      server.close();
    }
  });

  it('drops what is still queued when aborted, rather than failing it one by one', async () => {
    const cache = new MemoryCache();
    const controller = new AbortController();
    const boom = new Error('run cancelled');
    let calls = 0;

    const config = makeConfig({
      days: 20,
      async request() {
        calls++;

        if (calls === 2) {
          controller.abort(boom);
        }

        return {};
      },
    });

    const summary = await grab([config], { cache, now: NOW, signal: controller.signal });

    // The 18 channel-days still waiting are removed from the queue, not
    // dequeued only to notice and report themselves failed.
    expect(calls).toBe(2);
    expect(summary.fetched).toBe(1);
    expect(summary.failed).toEqual([
      { site: 'example.com', channelId: 'one.example', day: TOMORROW, error: boom },
    ]);
  });

  it('does nothing at all for a signal that is already aborted', async () => {
    const cache = new MemoryCache();
    const controller = new AbortController();
    let calls = 0;
    controller.abort(new Error('cancelled before it began'));

    const config = makeConfig({
      days: 20,
      async request() {
        calls++;
        return {};
      },
    });

    const summary = await grab([config], { cache, now: NOW, signal: controller.signal });

    expect(calls).toBe(0);
    expect(summary).toEqual({ fetched: 0, empty: 0, fromCache: 0, unchanged: 0, failed: [] });
  });

  it('leaves nothing unhandled when the abort lands after the run is over', async () => {
    // The run holds one rejection for the whole of itself, raced against every
    // queued task. A cancel that arrives once there is nothing left to race
    // must not surface as an unhandled rejection.
    const cache = new MemoryCache();
    const controller = new AbortController();
    const unhandled: unknown[] = [];
    const record = (error: unknown): void => void unhandled.push(error);

    process.on('unhandledRejection', record);

    try {
      const summary = await grab([makeConfig()], { cache, now: NOW, signal: controller.signal });

      controller.abort(new Error('cancelled too late'));

      // An unhandled rejection is reported a turn of the loop after the fact.
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(summary.fetched).toBe(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', record);
    }
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
  it("fetches a day's channels in one request and caches each channel-day", async () => {
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

  it('hands out a Date of its own for every day in a context', async () => {
    const cache = new MemoryCache();
    let same = true;
    let parsedDate: Date | undefined;
    let contextDate: Date | undefined;

    const config: SiteConfig<unknown, DaysBatching> = {
      site: 'days.example',
      channels: [channel('a')],
      days: 2,
      batching: { mode: 'days' },
      async request({ days, dates, from, to, channelDays }) {
        // A site shifting `from` to widen its query must not quietly move the
        // days it is about to parse: these all describe the same day and used
        // to be the same object.
        same = from === dates[0] || to === dates[1] || channelDays[0]!.date === dates[0];
        from.setUTCHours(6);
        contextDate = dates[0]!;
        return { days };
      },
      parseDay({ day, date }) {
        if (day === TODAY) {
          parsedDate = date;
        }

        return [];
      },
    };

    await grab([config], { cache, now: NOW });

    expect(same).toBe(false);
    expect(contextDate?.toISOString()).toBe(`${TODAY}T00:00:00.000Z`);
    expect(parsedDate?.toISOString()).toBe(`${TODAY}T00:00:00.000Z`);
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
  it("fetches a channel's whole window in one request and caches each day", async () => {
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

    expect(calls).toEqual([
      {
        channel: 'a',
        days: [TODAY, TOMORROW, '2026-07-19', '2026-07-20'],
        from: `${TODAY}T00:00:00.000Z`,
        to: '2026-07-20T00:00:00.000Z',
      },
    ]);
    expect(summary.fetched).toBe(4); // one request, four channel-days written
    expect(summary.failed).toEqual([]);
    for (const day of [TODAY, TOMORROW, '2026-07-19', '2026-07-20']) {
      const written = cache.get({ site: 'days.example', channelId: 'a', day });
      expect(written?.programmes.map((p) => p.start.toISOString())).toEqual([
        `${day}T06:00:00.000Z`,
      ]);
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
        wanted = channelDays.map(
          ({ channel: ch, day, date }) => `${ch.xmltvId} ${day} ${date.toISOString()}`,
        );
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
    expect(cache.get({ site: 'grid.example', channelId: 'b', day: TOMORROW })?.programmes).toEqual([
      programme(`${TOMORROW}T20:00:00.000Z`, 'b'),
    ]);
  });
});

describe('grab over a grid too big to plan by scanning', () => {
  const CHANNELS = 120;
  const DAYS = 14;
  const all = Array.from({ length: CHANNELS }, (_, index) =>
    channel(`c${String(index).padStart(3, '0')}`),
  );
  const window = Array.from({ length: DAYS }, (_, index) => {
    const date = new Date(NOW);
    date.setUTCDate(date.getUTCDate() + index);
    return date.toISOString().slice(0, 10);
  });

  it("asks once per channel-day, a day at a time in the site's channel order", async () => {
    const cache = new MemoryCache();
    const asked: string[] = [];

    const config = makeConfig({
      channels: all,
      days: DAYS,
      async request({ channel: ch, day }) {
        asked.push(`${ch.xmltvId} ${day}`);
        return {};
      },
      parseDay: () => [],
    });

    await grab([config], { cache, now: NOW, siteConcurrency: 1 });

    expect(asked).toHaveLength(CHANNELS * DAYS);
    // Requests are grouped by day first — a day group is what gets cut into
    // channel groups, whether or not the mode batches either axis.
    expect(asked).toEqual(window.flatMap((day) => all.map((ch) => `${ch.xmltvId} ${day}`)));
  });

  it('cuts the same grid into batches without losing a channel-day', async () => {
    const cache = new MemoryCache();
    // Half the channels are fresh on the first day, so the plan has to trim
    // that day out of the groups that no longer need it.
    for (const ch of all.slice(0, CHANNELS / 2)) {
      cache.seed(
        { site: 'grid.example', channelId: ch.xmltvId, day: window[0]! },
        { grabbedAt: NOW.toISOString(), programmeCount: 1 },
      );
    }

    const covered: string[] = [];

    const config: SiteConfig<unknown, ChannelsDaysBatching> = {
      site: 'grid.example',
      channels: all,
      days: DAYS,
      batching: { mode: 'both', channelsPerRequest: 25, daysPerRequest: 5 },
      staleness: { alwaysRefetchDays: 0 },
      async request({ channelDays }) {
        covered.push(...channelDays.map(({ channel: ch, day }) => `${ch.xmltvId} ${day}`));
        return {};
      },
      parseDay: () => [],
    };

    const summary = await grab([config], { cache, now: NOW });

    const expected = all.flatMap((ch) =>
      window
        .filter((day) => !(day === window[0] && all.indexOf(ch) < CHANNELS / 2))
        .map((day) => `${ch.xmltvId} ${day}`),
    );

    expect(covered.slice().sort()).toEqual(expected.slice().sort());
    expect(summary.fetched).toBe(expected.length);
    expect(summary.fromCache).toBe(CHANNELS / 2);
    expect(summary.failed).toEqual([]);
  });
});

describe('grab with a site that is missing a mandatory member', () => {
  /** What the site failed with, for a config the types would have caught. */
  async function failure(config: Partial<SiteConfig<unknown>>): Promise<string> {
    const cache = new MemoryCache();
    const summary = await grab([config as SiteConfig<unknown>], { cache, now: NOW });

    expect(summary.fetched).toBe(0);
    expect(cache.entries.size).toBe(0);
    expect(summary.failed).toHaveLength(1);
    expect(summary.failed[0]!.error).toBeInstanceOf(TypeError);

    return (summary.failed[0]!.error as Error).message;
  }

  /** A site that would work, less the one member the case is about. */
  function without(missing: keyof SiteConfig<unknown>): Partial<SiteConfig<unknown>> {
    const config: Partial<SiteConfig<unknown>> = {
      site: 'example.com',
      channels: [channel('one.example')],
      days: 1,
      async request() {
        return { canned: true };
      },
      parseDay({ day }) {
        return [programme(`${day}T06:00:00.000Z`)];
      },
    };

    delete config[missing];

    return config;
  }

  it('names the cache namespace a site without one would have shared', async () => {
    expect(await failure(without('site'))).toContain('A site must define site');
  });

  it('fails the site rather than dying on the channel list', async () => {
    expect(await failure(without('channels'))).toContain('Site "example.com" must define channels');
  });

  // The two halves of a site: both are checked before the first request goes
  // out, rather than each where it is called.
  it('fails the site rather than silently grabbing nothing', async () => {
    expect(await failure(without('request'))).toContain('Site "example.com" must define request');
  });

  it('fails the site rather than once per channel-day it fetched', async () => {
    expect(await failure(without('parseDay'))).toContain('Site "example.com" must define parseDay');
  });

  it('says what arrived when the member is there but is not a function', async () => {
    const config = { ...without('parseDay'), parseDay: 'parseDay' as unknown as never };

    expect(await failure(config)).toContain("channel-day's programmes (got a string)");
  });
});

describe('a site that streams its whole window', () => {
  /** A streaming site over three channels and two days, yielding what it is told to. */
  function streamSite(
    emissions: (channels: GrabberChannel[], days: string[]) => StreamedChannelDay[],
    overrides: Partial<StreamSiteConfig> = {},
  ): StreamSiteConfig {
    return {
      site: 'stream.example',
      channels: [channel('a'), channel('b')],
      days: 2,
      // eslint-disable-next-line require-yield
      async *stream({ channels, days }) {
        yield* emissions(channels, days);
      },
      ...overrides,
    };
  }

  /** One programme, so an entry can be told from an empty one. */
  function some(day: string, channel: GrabberChannel): StreamedChannelDay {
    return { channel, day, programmes: [programme(`${day}T06:00:00.000Z`, channel.siteId)] };
  }

  it('writes every channel-day it yields, and counts them as fetched', async () => {
    const cache = new MemoryCache();
    const summary = await grab(
      [streamSite((channels, days) => days.flatMap((day) => channels.map((ch) => some(day, ch))))],
      { cache, now: NOW },
    );

    expect(summary.fetched).toBe(4);
    expect(summary.empty).toBe(0);
    expect(summary.failed).toEqual([]);
    expect(cache.entries.size).toBe(4);
    // The programmes are the site's, with the channel normalized to the output id.
    expect(cache.get({ site: 'stream.example', channelId: 'a', day: TODAY })?.programmes).toEqual([
      expect.objectContaining({ channel: 'a' }),
    ]);
  });

  it('is asked once, for every stale channel-day at once', async () => {
    const cache = new MemoryCache();
    const asked: Array<{ channels: string[]; days: string[]; pairs: number }> = [];

    cache.seed(
      { site: 'stream.example', channelId: 'a', day: TOMORROW },
      { grabbedAt: NOW.toISOString(), programmeCount: 3 },
    );

    await grab(
      [
        {
          ...streamSite(() => []),
          staleness: { alwaysRefetchDays: 0 },
          async *stream({ channels, days, channelDays, from, to }) {
            asked.push({
              channels: channels.map((ch) => ch.xmltvId),
              days,
              pairs: channelDays.length,
            });
            expect(from.toISOString()).toBe(`${TODAY}T00:00:00.000Z`);
            expect(to.toISOString()).toBe(`${TOMORROW}T00:00:00.000Z`);

            yield* channelDays.map(({ channel: ch, day }) => some(day, ch));
          },
        },
      ],
      { cache, now: NOW },
    );

    // One pass over the lot — and the channel-day already fresh in the cache is
    // not among the pairs it is asked for, though its day still is.
    expect(asked).toEqual([{ channels: ['a', 'b'], days: [TODAY, TOMORROW], pairs: 3 }]);
  });

  it('caches empty every channel-day the document never mentioned', async () => {
    const cache = new MemoryCache();
    const messages: string[] = [];
    const summary = await grab([streamSite((channels, days) => [some(days[0]!, channels[0]!)])], {
      cache,
      now: NOW,
      logger: (message) => messages.push(message),
    });

    // The stream ended cleanly, so silence about a channel-day means nothing on
    // — the same as a `parseDay` returning []. Cached, so the staleness policy
    // decides when to ask again rather than every run asking.
    expect(summary.fetched).toBe(4);
    expect(summary.empty).toBe(3);
    expect(summary.failed).toEqual([]);
    expect(
      cache.get({ site: 'stream.example', channelId: 'b', day: TOMORROW })?.programmes,
    ).toEqual([]);
    expect(messages).toContain(
      '[stream.example] 3 channel-day(s) not in the document: caching them empty',
    );
  });

  it('adds to a channel-day it yields a second time', async () => {
    const cache = new MemoryCache();
    const summary = await grab(
      [
        streamSite((channels, days) => {
          const [day] = days;
          const [a] = channels;

          return [
            { channel: a!, day: day!, programmes: [programme(`${day}T06:00:00.000Z`, 'a')] },
            // The same channel-day again, as a document ordered by time rather
            // than grouped by channel would give it.
            { channel: a!, day: day!, programmes: [programme(`${day}T05:00:00.000Z`, 'a')] },
          ];
        }),
      ],
      { cache, now: NOW },
    );

    const entry = cache.get({ site: 'stream.example', channelId: 'a', day: TODAY });

    // Both lots, in order — not the second in place of the first.
    expect(entry?.programmes.map((p) => p.start.toISOString())).toEqual([
      `${TODAY}T05:00:00.000Z`,
      `${TODAY}T06:00:00.000Z`,
    ]);
    // And counted once, however often it was mentioned.
    expect(summary.fetched).toBe(4);
  });

  it('stops counting a channel-day empty once a later emission fills it', async () => {
    const cache = new MemoryCache();
    const summary = await grab(
      [
        streamSite((channels, days) => [
          { channel: channels[0]!, day: days[0]!, programmes: [] },
          some(days[0]!, channels[0]!),
        ]),
      ],
      { cache, now: NOW },
    );

    // Empty when it was all there was of it, and not once it was not.
    expect(summary.empty).toBe(3);
    expect(
      cache.get({ site: 'stream.example', channelId: 'a', day: TODAY })?.programmes,
    ).toHaveLength(1);
  });

  it('ignores a channel-day it was not asked for, saying how many', async () => {
    const cache = new MemoryCache();
    const messages: string[] = [];

    cache.seed(
      { site: 'stream.example', channelId: 'a', day: TOMORROW },
      { grabbedAt: NOW.toISOString(), programmeCount: 2 },
      [programme(`${TOMORROW}T20:00:00.000Z`, 'a')],
    );

    const summary = await grab(
      [
        {
          ...streamSite(() => []),
          staleness: { alwaysRefetchDays: 0 },
          async *stream({ channels, days }) {
            // Everything the document holds, including the channel-day already
            // fresh in the cache and a channel nobody asked about.
            yield* days.flatMap((day) => channels.map((ch) => some(day, ch)));
            yield some(days[0]!, channel('unknown'));
          },
        },
      ],
      { cache, now: NOW, logger: (message) => messages.push(message) },
    );

    // A fresh entry is not rewritten, and its grabbedAt stands.
    expect(cache.get({ site: 'stream.example', channelId: 'a', day: TOMORROW })?.meta).toEqual({
      grabbedAt: NOW.toISOString(),
      programmeCount: 2,
    });
    expect(summary.fetched).toBe(3);
    expect(messages).toContain('[stream.example] ignored 2 channel-day(s) it was not asked for');
  });

  it('fails what it never reached when the stream throws', async () => {
    const cache = new MemoryCache();
    const summary = await grab(
      [
        {
          ...streamSite(() => []),
          async *stream({ channels, days }) {
            yield some(days[0]!, channels[0]!);
            throw new Error('the connection went away');
          },
        },
      ],
      { cache, now: NOW },
    );

    // What arrived is kept; what the document never reached is short rather than
    // empty, which is the whole reason a stream must throw rather than end.
    expect(summary.fetched).toBe(1);
    expect(summary.empty).toBe(0);
    expect(summary.failed).toHaveLength(3);
    expect(summary.failed.map((failure) => `${failure.channelId} ${failure.day}`).sort()).toEqual([
      `a ${TOMORROW}`,
      `b ${TODAY}`,
      `b ${TOMORROW}`,
    ]);
    expect(cache.entries.size).toBe(1);
  });

  it('carries the run to a stop when it is cancelled mid-document', async () => {
    const cache = new MemoryCache();
    const controller = new AbortController();
    let yielded = 0;

    const summary = await grab(
      [
        {
          ...streamSite(() => []),
          channels: [channel('a'), channel('b'), channel('c')],
          days: 4,
          async *stream({ channelDays }) {
            for (const { channel: ch, day } of channelDays) {
              yielded++;

              if (yielded === 2) {
                controller.abort();
              }

              yield some(day, ch);
            }
          },
        },
      ],
      { cache, now: NOW, signal: controller.signal },
    );

    // Stopped where it was told to rather than reading out the rest of a
    // document nobody is waiting for: the emission that fired the abort is the
    // last one pulled out of the generator, of twelve it had to give.
    expect(yielded).toBe(2);
    expect(summary.fetched).toBeLessThan(12);
    // And nothing was cached empty on the way out: the pass did not finish, so
    // silence about a channel-day says nothing about what is on it.
    expect([...cache.entries.values()].every((entry) => entry.programmes.length > 0)).toBe(true);
  });

  it('keeps writing while it splits, without running ahead of the cache', async () => {
    const cache = new MemoryCache();
    let alive = 0;
    let mostAlive = 0;

    // A store slow enough that the split would outrun it, and one that says how
    // many writes are in flight at once.
    const slow = new MemoryCache();

    slow.write = async (key, programmes, meta): Promise<void> => {
      alive++;
      mostAlive = Math.max(mostAlive, alive);
      await new Promise((resolve) => setTimeout(resolve, 1));
      await MemoryCache.prototype.write.call(cache, key, programmes, meta);
      alive--;
    };

    const summary = await grab(
      [
        {
          ...streamSite(() => []),
          channels: Array.from({ length: 20 }, (_, index) => channel(`c${index}`)),
          days: 5,
          async *stream({ channelDays }) {
            yield* channelDays.map(({ channel: ch, day }) => some(day, ch));
          },
        },
      ],
      { cache: slow, now: NOW, localConcurrency: 4 },
    );

    // A hundred channel-days through a queue four wide: all of them written, and
    // never more than four writes at once — the split is held back by the queue
    // rather than filling it.
    expect(summary.fetched).toBe(100);
    expect(summary.failed).toEqual([]);
    expect(cache.entries.size).toBe(100);
    expect(mostAlive).toBeLessThanOrEqual(4);
  });

  it('gets the site state and the client every other site gets', async () => {
    const cache = new MemoryCache();
    let seen: { sameState: boolean; hasHttp: boolean; logged: string[] } | undefined;
    const messages: string[] = [];

    await grab(
      [
        {
          ...streamSite(() => []),
          async *stream({ channelDays, http, state, log }) {
            state.set('passes', 1);
            log('one pass, and here is a warning');
            seen = {
              sameState: state instanceof Map,
              hasHttp: typeof http.get === 'function',
              logged: messages,
            };

            yield* channelDays.map(({ channel: ch, day }) => some(day, ch));
          },
        },
      ],
      { cache, now: NOW, logger: (message) => messages.push(message) },
    );

    expect(seen?.sameState).toBe(true);
    expect(seen?.hasHttp).toBe(true);
    // A stream's own messages go where the run's do, prefixed with the site.
    expect(messages).toContain('[stream.example] one pass, and here is a warning');
    // And what it remembered is kept, as any site's is.
    expect(cache.state.get('stream.example|state')?.data).toEqual([['passes', 1]]);
  });

  it('is refused without a stream or a request, and named either way', async () => {
    const cache = new MemoryCache();
    const summary = await grab(
      [
        {
          site: 'stream.example',
          channels: [channel('a')],
          days: 1,
        } as unknown as StreamSiteConfig,
      ],
      { cache, now: NOW },
    );

    expect(summary.failed).toHaveLength(1);
    expect((summary.failed[0]!.error as Error).message).toContain(
      'must define request: a function fetching one request',
    );
    expect((summary.failed[0]!.error as Error).message).toContain('or stream');
  });
});

describe('asking whether anything has changed', () => {
  /** A site whose requests go to a real server, so ky's hooks are in play. */
  async function server(
    handler: (request: IncomingMessage, response: ServerResponse) => void,
  ): Promise<{ url: string; close: () => Promise<void>; asked: IncomingMessage[] }> {
    const asked: IncomingMessage[] = [];
    const instance = createServer((request, response) => {
      asked.push(request);
      handler(request, response);
    });

    await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', resolve));

    return {
      asked,
      url: `http://127.0.0.1:${(instance.address() as AddressInfo).port}/`,
      close: () => new Promise<void>((resolve) => instance.close(() => resolve())),
    };
  }

  /** A site that fetches one channel-day, from `url`, and says what it got. */
  function conditional(url: string, overrides: Partial<SiteConfig<unknown>> = {}) {
    return makeConfig({
      conditionalGet: true,
      // Today is stale every run (`alwaysRefetchDays`) and cached after the
      // first — which is exactly the position a conditional request is for.
      staleness: { maxAgeDays: 7 },
      ky: { prefix: url, retry: 0 },
      async request({ http }) {
        return http.get('guide').json();
      },
      parseDay({ day }) {
        return [programme(`${day}T06:00:00.000Z`)];
      },
      ...overrides,
    });
  }

  /** A cache holding yesterday's entry for the one channel-day under test. */
  function cacheWithEntry(grabbedAt = NOW.toISOString()): MemoryCache {
    const cache = new MemoryCache();

    cache.seed(
      { site: 'example.com', channelId: 'one.example', day: TODAY },
      {
        grabbedAt,
        programmeCount: 3,
      },
      [programme(`${TODAY}T20:00:00.000Z`, 'one.example')],
    );

    return cache;
  }

  it('asks outright the first time, and conditionally once it has an ETag', async () => {
    const source = await server((request, response) => {
      if (request.headers['if-none-match'] === 'W/"v1"') {
        response.writeHead(304, { etag: 'W/"v1"' });
        response.end();
        return;
      }

      response.writeHead(200, { etag: 'W/"v1"', 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });

    try {
      const cache = new MemoryCache();
      const config = conditional(source.url);

      // Nothing cached, so nothing to keep: asked outright, whatever is stored.
      const first = await grab([config], { cache, now: NOW });

      expect(first.fetched).toBe(1);
      expect(first.unchanged).toBe(0);
      expect(source.asked[0]!.headers['if-none-match']).toBeUndefined();

      // Now there is an entry and an ETag, so the second run asks conditionally
      // — and keeps what it has when the answer is 304.
      const second = await grab([config], { cache, now: NOW });

      expect(source.asked[1]!.headers['if-none-match']).toBe('W/"v1"');
      expect(second.unchanged).toBe(1);
      expect(second.fetched).toBe(0);
      expect(second.failed).toEqual([]);
    } finally {
      await source.close();
    }
  });

  it('leaves the entry and its grabbedAt exactly as they were', async () => {
    const source = await server((request, response) => {
      response.writeHead(304, { etag: 'W/"v1"' });
      response.end();
    });

    try {
      const grabbedAt = '2026-07-16T09:00:00.000Z';
      const cache = cacheWithEntry(grabbedAt);

      cache.seedState('example.com', 'validators', [
        ['url', { etag: 'W/"v1"', seenAt: grabbedAt, lastDay: TODAY }],
      ]);

      const summary = await grab([conditional(source.url)], { cache, now: NOW });

      expect(summary.unchanged).toBe(1);
      // Untouched: the same programmes, and the same grabbedAt, so it ages as it
      // was already ageing and the next run asks the same cheap question.
      expect(
        cache.get({ site: 'example.com', channelId: 'one.example', day: TODAY }),
      ).toMatchObject({ meta: { grabbedAt, programmeCount: 3 } });
    } finally {
      await source.close();
    }
  });

  it('sends nothing when a channel-day it covers has nothing cached', async () => {
    const source = await server((request, response) => {
      response.writeHead(200, { etag: 'W/"v1"', 'content-type': 'application/json' });
      response.end('{}');
    });

    try {
      // Two days in one request, one of them never grabbed: a 304 would leave a
      // hole in the guide, so it goes out unconditionally.
      const cache = cacheWithEntry();

      cache.seedState('example.com', 'validators', [
        [`${source.url}guide`, { etag: 'W/"v1"', seenAt: NOW.toISOString(), lastDay: TOMORROW }],
      ]);

      const spanning: SiteConfig<unknown, DaysBatching> = {
        site: 'example.com',
        channels: [channel('one.example')],
        days: 2,
        batching: { mode: 'days' },
        conditionalGet: true,
        staleness: { maxAgeDays: 7 },
        ky: { prefix: source.url, retry: 0 },
        async request({ http }) {
          return http.get('guide').json();
        },
        parseDay: ({ day }) => [programme(`${day}T06:00:00.000Z`)],
      };

      await grab([spanning], { cache, now: NOW });

      expect(source.asked[0]!.headers['if-none-match']).toBeUndefined();
      expect(source.asked[0]!.headers['if-modified-since']).toBeUndefined();
    } finally {
      await source.close();
    }
  });

  it('sends nothing for an entry already past maxAgeDays', async () => {
    const source = await server((request, response) => {
      response.writeHead(200, { etag: 'W/"v1"', 'content-type': 'application/json' });
      response.end('{}');
    });

    try {
      // Eight days old under a seven-day policy: it is stale on age, and a source
      // with a lying Last-Modified must not be able to keep it for ever.
      const cache = cacheWithEntry(new Date(NOW.getTime() - 8 * 86_400_000).toISOString());

      await grab([conditional(source.url)], { cache, now: NOW });

      expect(source.asked[0]!.headers['if-modified-since']).toBeUndefined();
    } finally {
      await source.close();
    }
  });

  it('sends nothing under --refresh, however fresh the entry', async () => {
    const source = await server((request, response) => {
      response.writeHead(200, { etag: 'W/"v1"', 'content-type': 'application/json' });
      response.end('{}');
    });

    try {
      const cache = cacheWithEntry();

      await grab([conditional(source.url)], {
        cache,
        now: NOW,
        staleness: { refetchAll: true },
      });

      // Asking the source is what the flag means.
      expect(source.asked[0]!.headers['if-none-match']).toBeUndefined();
      expect(source.asked[0]!.headers['if-modified-since']).toBeUndefined();
    } finally {
      await source.close();
    }
  });

  it("asks with the entry's own grabbedAt when nothing is stored about the url", async () => {
    const source = await server((request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });

    try {
      const grabbedAt = '2026-07-16T09:00:00.000Z';

      await grab([conditional(source.url)], { cache: cacheWithEntry(grabbedAt), now: NOW });

      // No ETag was ever offered, but the entries themselves say when they were
      // known to be right — which is a fair thing to ask "changed since?" with.
      expect(source.asked[0]!.headers['if-modified-since']).toBe(new Date(grabbedAt).toUTCString());
    } finally {
      await source.close();
    }
  });

  it('keeps asking conditionally through a run of 304s', async () => {
    const source = await server((request, response) => {
      if (request.headers['if-none-match'] === 'W/"v1"') {
        response.writeHead(304);
        response.end();
        return;
      }

      response.writeHead(200, { etag: 'W/"v1"', 'content-type': 'application/json' });
      response.end('{}');
    });

    try {
      const cache = new MemoryCache();
      const config = conditional(source.url);

      await grab([config], { cache, now: NOW });

      // Three runs of 304s. A url that is never modified only ever gets them, so
      // if a 304 did not touch what is stored, the record would age out of the
      // window and earn a full download for a document nothing changed in.
      for (let run = 0; run < 3; run++) {
        const summary = await grab([config], { cache, now: NOW });

        expect(summary.unchanged).toBe(1);
      }

      expect(source.asked.slice(1).every((request) => request.headers['if-none-match'])).toBe(true);
      expect(source.asked).toHaveLength(4);
    } finally {
      await source.close();
    }
  });

  it('forgets a validator whose download did not finish', async () => {
    let version = 'W/"v1"';
    const source = await server((request, response) => {
      response.writeHead(200, { etag: version, 'content-type': 'application/json' });

      if (version === 'W/"v1"') {
        response.end('{"ok":true}');
        return;
      }

      // Headers and an ETag arrive — so the hook remembers v2 — and then the
      // body stops half way.
      response.write('{"ok":');
      response.destroy();
    });

    try {
      const cache = new MemoryCache();
      const config = conditional(source.url);

      await grab([config], { cache, now: NOW });
      expect(cache.state.get('example.com|validators')?.data).toMatchObject([
        [expect.any(String), { etag: 'W/"v1"' }],
      ]);

      // The entries still hold what v1 said, because v2 never arrived in full.
      // Remembering v2 would earn a 304 next run and keep v1's programmes for
      // ever under a name that says they are v2's.
      version = 'W/"v2"';
      const summary = await grab([config], { cache, now: NOW });

      expect(summary.failed).toHaveLength(1);
      expect(cache.state.get('example.com|validators')?.data).toMatchObject([
        [expect.any(String), { etag: 'W/"v1"' }],
      ]);
    } finally {
      await source.close();
    }
  });

  it('is off unless the site asks, and adds no headers when it has not', async () => {
    const source = await server((request, response) => {
      response.writeHead(200, { etag: 'W/"v1"', 'content-type': 'application/json' });
      response.end('{}');
    });

    try {
      const cache = cacheWithEntry();
      const config = conditional(source.url, { conditionalGet: false });

      await grab([config], { cache, now: NOW });
      await grab([config], { cache, now: NOW });

      expect(source.asked.every((request) => !request.headers['if-none-match'])).toBe(true);
      expect(source.asked.every((request) => !request.headers['if-modified-since'])).toBe(true);
      // Nothing remembered either: the group is never even read.
      expect(cache.state.get('example.com|validators')).toBeUndefined();
    } finally {
      await source.close();
    }
  });

  it('never revalidates a request made from inside parseDay', async () => {
    const source = await server((request, response) => {
      response.writeHead(200, { etag: 'W/"v1"', 'content-type': 'application/json' });
      response.end('{}');
    });

    try {
      const cache = cacheWithEntry();

      cache.seedState('example.com', 'validators', [
        [`${source.url}detail`, { etag: 'W/"d1"', seenAt: NOW.toISOString(), lastDay: TODAY }],
      ]);

      await grab(
        [
          conditional(source.url, {
            async parseDay({ http, paced, day }) {
              await paced(({ signal }) =>
                http.get('detail', { ...(signal ? { signal } : {}) }).json(),
              );

              return [programme(`${day}T06:00:00.000Z`)];
            },
          }),
        ],
        { cache, now: NOW },
      );

      // A 304 on a detail page could not mean "keep this channel-day" — the
      // channel-day itself was just refetched — so the store never reaches it.
      const detail = source.asked.find((request) => request.url === '/detail');

      expect(detail).toBeDefined();
      expect(detail!.headers['if-none-match']).toBeUndefined();
    } finally {
      await source.close();
    }
  });

  it('lets one request opt out while the site is asking on the rest', async () => {
    const source = await server((request, response) => {
      response.writeHead(200, { etag: 'W/"v1"', 'content-type': 'application/json' });
      response.end('{}');
    });

    try {
      const cache = cacheWithEntry();

      cache.seedState('example.com', 'validators', [
        [`${source.url}guide`, { etag: 'W/"v1"', seenAt: NOW.toISOString(), lastDay: TODAY }],
      ]);

      await grab(
        [
          conditional(source.url, {
            async request({ http }) {
              // A page after the first, a lookup that is not the listings: a 304
              // on one of these says nothing about the channel-day.
              return http.get('guide', { context: { revalidate: false } }).json();
            },
          }),
        ],
        { cache, now: NOW },
      );

      expect(source.asked[0]!.headers['if-none-match']).toBeUndefined();
    } finally {
      await source.close();
    }
  });
});

describe('a stream that says nothing has changed', () => {
  function site(
    stream: StreamSiteConfig['stream'],
    overrides: Partial<StreamSiteConfig> = {},
  ): StreamSiteConfig {
    return {
      site: 'stream.example',
      channels: [channel('a'), channel('b')],
      days: 1,
      stream,
      ...overrides,
    };
  }

  /** A cache holding an entry for each of the site's channel-days. */
  function cacheWithBoth(): MemoryCache {
    const cache = new MemoryCache();

    for (const channelId of ['a', 'b']) {
      cache.seed(
        { site: 'stream.example', channelId, day: TODAY },
        { grabbedAt: '2026-07-16T09:00:00.000Z', programmeCount: 2 },
        [programme(`${TODAY}T20:00:00.000Z`, channelId)],
      );
    }

    return cache;
  }

  it('keeps a channel-day it says is unchanged, and writes nothing', async () => {
    const cache = cacheWithBoth();
    const summary = await grab(
      [
        site(async function* ({ channelDays }) {
          for (const { channel: ch, day } of channelDays) {
            yield { channel: ch, day, unchanged: true };
          }
        }),
      ],
      { cache, now: NOW },
    );

    expect(summary.unchanged).toBe(2);
    expect(summary.fetched).toBe(0);
    expect(summary.empty).toBe(0);
    expect(summary.failed).toEqual([]);
    // Untouched, grabbedAt and all — so it ages as it was already ageing.
    expect(cache.get({ site: 'stream.example', channelId: 'a', day: TODAY })?.meta).toEqual({
      grabbedAt: '2026-07-16T09:00:00.000Z',
      programmeCount: 2,
    });
  });

  it('mixes kept and written channel-days in one pass', async () => {
    const cache = cacheWithBoth();
    const summary = await grab(
      [
        site(async function* ({ channelDays }) {
          const [first, second] = channelDays;

          yield { channel: first!.channel, day: first!.day, unchanged: true };
          yield {
            channel: second!.channel,
            day: second!.day,
            programmes: [programme(`${TODAY}T06:00:00.000Z`, second!.channel.siteId)],
          };
        }),
      ],
      { cache, now: NOW },
    );

    expect(summary.unchanged).toBe(1);
    expect(summary.fetched).toBe(1);
    expect(
      cache.get({ site: 'stream.example', channelId: 'a', day: TODAY })?.meta.programmeCount,
    ).toBe(2);
    expect(
      cache.get({ site: 'stream.example', channelId: 'b', day: TODAY })?.meta.programmeCount,
    ).toBe(1);
  });

  it('refuses to keep a channel-day with nothing cached', async () => {
    // Nothing seeded: "unchanged" cannot mean anything here, and quietly
    // agreeing would leave a hole in the guide that nothing else would report.
    const cache = new MemoryCache();
    const summary = await grab(
      [
        site(async function* ({ channelDays }) {
          for (const { channel: ch, day } of channelDays) {
            yield { channel: ch, day, unchanged: true };
          }
        }),
      ],
      { cache, now: NOW },
    );

    expect(summary.unchanged).toBe(0);
    expect(summary.failed).toHaveLength(2);
    expect((summary.failed[0]!.error as Error).message).toContain('nothing is cached for it');
  });

  it('keeps everything when the whole document is unchanged', async () => {
    const cache = cacheWithBoth();
    const summary = await grab(
      [
        site(
          // eslint-disable-next-line require-yield
          async function* () {
            // What the hooks do on a 304, and what a site may do itself: one
            // throw for a pass that covers the lot.
            throw new UnchangedError('https://example.test/guide.xml');
          },
        ),
      ],
      { cache, now: NOW },
    );

    expect(summary.unchanged).toBe(2);
    expect(summary.failed).toEqual([]);
    expect(cache.get({ site: 'stream.example', channelId: 'b', day: TODAY })?.meta).toMatchObject({
      grabbedAt: '2026-07-16T09:00:00.000Z',
    });
  });

  it('keeps what a broken pass had already vouched for', async () => {
    const cache = cacheWithBoth();
    const summary = await grab(
      [
        site(async function* ({ channelDays }) {
          yield { channel: channelDays[0]!.channel, day: channelDays[0]!.day, unchanged: true };

          throw new Error('the connection went away');
        }),
      ],
      { cache, now: NOW },
    );

    // The one it vouched for is still cached and still counted; the one it never
    // reached is short rather than empty.
    expect(summary.unchanged).toBe(1);
    expect(summary.failed).toHaveLength(1);
    expect(summary.failed[0]!.channelId).toBe('b');
    expect(
      cache.get({ site: 'stream.example', channelId: 'b', day: TODAY })?.programmes,
    ).toHaveLength(1);
  });
});
