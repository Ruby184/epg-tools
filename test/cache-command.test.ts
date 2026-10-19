import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { CacheManager, MemoryCacheDriver, STATE_SCHEMA } from '../src/cache/main.js';
import type {
  CacheManagerOptions,
  ChannelDayKey,
  StoredEntryMeta,
  StoredStateMeta,
} from '../src/cache/main.js';
import { cacheStats, showCache, showState, writeCacheStats } from '../src/cli/cache.js';
import type { CacheReading } from '../src/cli/cache.js';
import type { XmltvProgramme } from '../src/xmltv/types.js';

/** Collects everything written, so stdout and stderr can be asserted on. */
class Sink extends Writable {
  private chunks: string[] = [];

  override _write(chunk: Buffer | string, _encoding: string, done: () => void): void {
    this.chunks.push(String(chunk));
    done();
  }

  get text(): string {
    return this.chunks.join('');
  }
}

function programme(channel: string, title: string): XmltvProgramme {
  return { channel, start: new Date('2026-07-17T18:00:00.000Z'), title: [{ value: title }] };
}

/** A cache with a little of everything in it, and how to read it. */
async function cached(invalidate?: CacheManagerOptions['invalidate']): Promise<{
  driver: MemoryCacheDriver;
  reading: CacheReading & { stdout: Sink; stderr: Sink };
}> {
  const driver = new MemoryCacheDriver();
  const cache = new CacheManager({ driver, ...(invalidate ? { invalidate } : {}) });

  await cache.write(
    { site: 'a.tv', channelId: 'two', day: '2026-07-18' },
    [programme('two', 'Late')],
    {
      grabbedAt: '2026-07-18T03:00:00.000Z',
    },
  );
  await cache.write(
    { site: 'a.tv', channelId: 'one', day: '2026-07-17' },
    [programme('one', 'News'), programme('one', 'Film')],
    { grabbedAt: '2026-07-17T03:00:00.000Z' },
  );
  await cache.write({ site: 'a.tv', channelId: 'one', day: '2026-07-19' }, [], {
    grabbedAt: '2026-07-19T03:00:00.000Z',
  });
  await cache.write(
    { site: 'b.tv', channelId: 'one', day: '2026-07-17' },
    [programme('one', 'B')],
    {
      grabbedAt: '2026-07-17T04:00:00.000Z',
    },
  );
  await cache.setState('a.tv', 'channels', {
    channels: [
      { xmltvId: 'one', siteId: '1' },
      { xmltvId: 'two', siteId: '2' },
    ],
  });
  await cache.setState('a.tv', 'state', [
    ['cursor', 42],
    ['token', 'abc'],
  ]);

  return {
    driver,
    reading: {
      cache,
      stdout: new Sink(),
      stderr: new Sink(),
    },
  };
}

/** Spoil an entry the way an older version, or an editor, would have left it. */
async function spoil(
  driver: MemoryCacheDriver,
  meta: Record<string, unknown>,
  key = { site: 'a.tv', channelId: 'two', day: '2026-07-18' },
): Promise<void> {
  const found = (await driver.read(key))!;

  await driver.write(key, found.body, { ...found.meta, ...meta } as StoredEntryMeta);
}

describe('epg cache stats', () => {
  it('counts each site from what its entries say about themselves', async () => {
    const { reading } = await cached();

    expect(await cacheStats(reading)).toEqual({
      sites: [
        {
          site: 'a.tv',
          channels: 2,
          entries: 3,
          unreadable: 0,
          invalidated: 0,
          failed: 0,
          empty: 1,
          programmes: 3,
          days: { first: '2026-07-17', last: '2026-07-19' },
          grabbed: { first: '2026-07-17T03:00:00.000Z', last: '2026-07-19T03:00:00.000Z' },
          state: ['channels', 'state'],
        },
        expect.objectContaining({
          site: 'b.tv',
          channels: 1,
          entries: 1,
          programmes: 1,
          state: [],
        }),
      ],
      totals: {
        sites: 2,
        channels: 3,
        entries: 4,
        unreadable: 0,
        invalidated: 0,
        failed: 0,
        empty: 1,
        programmes: 4,
      },
    });
    expect((await cacheStats(reading, 'b.tv')).sites.map((site) => site.site)).toEqual(['b.tv']);
  });

  it('counts an entry it cannot vouch for apart, and leaves it', async () => {
    const { driver, reading } = await cached();

    await spoil(driver, { schema: 0 });

    const [site] = (await cacheStats(reading, 'a.tv')).sites;

    expect(site).toMatchObject({ entries: 3, unreadable: 1, programmes: 2 });
    // Still there: looking is not a run.
    expect(
      await driver.readMeta({ site: 'a.tv', channelId: 'two', day: '2026-07-18' }),
    ).toBeDefined();
  });

  it('counts the day of an entry it cannot read among the days held', async () => {
    const { driver, reading } = await cached();

    await spoil(driver, { schema: 0 }, { site: 'a.tv', channelId: 'one', day: '2026-07-19' });

    expect((await cacheStats(reading, 'a.tv')).sites[0]).toMatchObject({
      unreadable: 1,
      empty: 0,
      days: { first: '2026-07-17', last: '2026-07-19' },
      grabbed: { first: '2026-07-17T03:00:00.000Z', last: '2026-07-18T03:00:00.000Z' },
    });
  });

  it("counts what the config's invalidate voids apart from what it cannot read", async () => {
    const { reading } = await cached(
      (meta, key) => key.channelId === 'one' && meta.programmeCount > 0,
    );

    expect((await cacheStats(reading, 'a.tv')).sites[0]).toMatchObject({
      unreadable: 0,
      invalidated: 1,
      programmes: 1,
    });
  });

  /** Make a memory store answer a channel's window in one question, as sqlite does. */
  function batching(driver: MemoryCacheDriver): void {
    Object.assign(driver, {
      readMetas: async (keys: ChannelDayKey[]) =>
        Promise.all(keys.map((key) => driver.readMeta(key))),
    });
  }

  for (const [store, batched, reads] of [
    // Each key once, as the manager would read them anyway.
    ['a key at a time', false, 4],
    // A failed question, and then a key at a time: a channel of one day is
    // not asked about twice.
    ['a channel at a time', true, 6],
  ] as const) {
    it(`counts an entry the store cannot open, says why, and goes on — asked ${store}`, async () => {
      const { driver, reading } = await cached();
      const readMeta = driver.readMeta.bind(driver);
      let read = 0;

      // A file this user may not read: one in a channel of two days, and the
      // one day of another.
      driver.readMeta = async (key) => {
        read++;

        if (
          `${key.site} ${key.channelId} ${key.day}` === 'a.tv one 2026-07-17' ||
          key.channelId === 'two'
        ) {
          throw Object.assign(new Error(`EACCES: permission denied, open '${key.day}'`), {
            code: 'EACCES',
          });
        }

        return readMeta(key);
      };

      if (batched) {
        batching(driver);
      }

      const stats = await cacheStats(reading);

      expect(stats.sites[0]).toMatchObject({
        site: 'a.tv',
        entries: 3,
        failed: 2,
        unreadable: 0,
        empty: 1,
        programmes: 0,
        days: { first: '2026-07-17', last: '2026-07-19' },
      });
      expect(stats.sites[1]).toMatchObject({ site: 'b.tv', failed: 0, programmes: 1 });
      expect(stats.totals.failed).toBe(2);
      expect(reading.stderr.text.split('\n').toSorted()).toEqual([
        '',
        "a.tv one 2026-07-17: could not be read: EACCES: permission denied, open '2026-07-17'",
        "a.tv two 2026-07-18: could not be read: EACCES: permission denied, open '2026-07-18'",
      ]);
      expect(read).toBe(reads);
    });

    it(`stops for a look that was stopped, rather than counting what it could not read — asked ${store}`, async () => {
      const { driver, reading } = await cached();
      const controller = new AbortController();

      if (batched) {
        batching(driver);
      }

      driver.readMeta = async () => {
        controller.abort();

        throw new Error('interrupted');
      };

      await expect(cacheStats({ ...reading, signal: controller.signal })).rejects.toMatchObject({
        name: 'AbortError',
      });

      // A site of one channel of one day, which is asked about once.
      const once = new AbortController();

      driver.readMeta = async () => {
        once.abort();

        throw new Error('interrupted');
      };

      await expect(cacheStats({ ...reading, signal: once.signal }, 'b.tv')).rejects.toMatchObject({
        name: 'AbortError',
      });

      // Stopped while a channel is asked about a day at a time.
      const later = new AbortController();
      const fresh = await cached();
      const readMeta = fresh.driver.readMeta.bind(fresh.driver);
      let asked = 0;

      if (batched) {
        batching(fresh.driver);
      }

      fresh.driver.readMeta = async (key) => {
        if (key.channelId !== 'one') {
          return readMeta(key);
        }

        // Its second day, a key at a time — after a failed question, for a
        // store that is asked one.
        if (++asked > (batched ? 3 : 1)) {
          later.abort();
        }

        throw new Error('EACCES');
      };

      await expect(
        cacheStats({ ...fresh.reading, signal: later.signal }, 'a.tv'),
      ).rejects.toMatchObject({ name: 'AbortError' });
    });
  }

  it('says what of a site it could not use, and why each could not be', async () => {
    const { driver, reading } = await cached((_meta, key) => key.day === '2026-07-19');
    const readMeta = driver.readMeta.bind(driver);

    await spoil(driver, { schema: 0 });
    driver.readMeta = async (key) => {
      if (key.day === '2026-07-17' && key.site === 'a.tv') {
        throw new Error('EACCES');
      }

      return readMeta(key);
    };

    await writeCacheStats(reading, 'a.tv');

    expect(reading.stdout.text).toContain(
      '    1 unreadable · 1 voided by invalidate · 1 could not be read\n',
    );
    // Nothing promised of the next run: a site the config has dropped is not
    // grabbed again.
    expect(reading.stdout.text).not.toContain('next run');
  });

  it('writes a line or two a site, and the totals where there is more than one', async () => {
    const { reading } = await cached();

    await writeCacheStats(reading);

    expect(reading.stdout.text).toBe(
      [
        'a.tv — 2 channels, 3 channel-days from 2026-07-17 to 2026-07-19, 3 programmes',
        '    grabbed 2026-07-17 03:00Z to 2026-07-19 03:00Z · 1 empty day',
        '    remembers: channels, state',
        // One day, and one moment, said as one.
        'b.tv — 1 channel, 1 channel-day on 2026-07-17, 1 programme',
        '    grabbed 2026-07-17 04:00Z',
        '',
        '2 sites, 3 channels, 4 channel-days, 4 programmes',
        '',
      ].join('\n'),
    );
  });

  it('writes no totals for one site', async () => {
    const { reading } = await cached();

    await writeCacheStats(reading, 'b.tv');

    expect(reading.stdout.text).toBe(
      'b.tv — 1 channel, 1 channel-day on 2026-07-17, 1 programme\n    grabbed 2026-07-17 04:00Z\n',
    );
  });

  it('orders when entries were grabbed as instants, whatever offset each was written with', async () => {
    const driver = new MemoryCacheDriver();
    const cache = new CacheManager({ driver });
    const key = { site: 'z.tv', channelId: 'one', day: '2026-07-17' };

    // 10:00 at +02:00 is 08:00Z: earlier than 09:00Z, though it sorts after it
    // as text.
    await cache.write(key, [programme('one', 'A')], { grabbedAt: '2026-07-17T10:00:00+02:00' });
    await cache.write({ ...key, day: '2026-07-18' }, [programme('one', 'B')], {
      grabbedAt: '2026-07-17T09:00:00.000Z',
    });

    const reading = { cache, stdout: new Sink(), stderr: new Sink() };

    expect((await cacheStats(reading)).sites[0]!.grabbed).toEqual({
      first: '2026-07-17T08:00:00.000Z',
      last: '2026-07-17T09:00:00.000Z',
    });

    await writeCacheStats(reading);

    expect(reading.stdout.text).toContain('grabbed 2026-07-17 08:00Z to 2026-07-17 09:00Z');
  });

  it('reads many small sites at once, rather than a site at a time', async () => {
    const driver = new MemoryCacheDriver();
    const cache = new CacheManager({ driver });
    const readMeta = driver.readMeta.bind(driver);
    let reading = 0;
    let most = 0;

    for (let site = 0; site < 20; site++) {
      await cache.write({ site: `s${site}.tv`, channelId: 'one', day: '2026-07-17' }, []);
    }

    driver.readMeta = async (key) => {
      reading++;
      most = Math.max(most, reading);
      await new Promise((resolve) => setTimeout(resolve, 1));
      reading--;

      return readMeta(key);
    };

    const stats = await cacheStats({ cache, stdout: new Sink(), stderr: new Sink() });

    expect(stats.totals).toMatchObject({ sites: 20, channels: 20, entries: 20 });
    expect(stats.sites.map((site) => site.site)).toEqual(
      Array.from({ length: 20 }, (_, site) => `s${site}.tv`).toSorted(),
    );
    expect(most).toBeGreaterThan(1);
  });

  it('reads what it has listed before the listing is done', async () => {
    const { driver, reading } = await cached();
    const list = driver.list.bind(driver);
    const readMeta = driver.readMeta.bind(driver);
    const happened: string[] = [];

    driver.list = async function* (options) {
      for await (const held of list(options)) {
        happened.push('listed');
        yield held;
      }

      happened.push('listing done');
    };
    driver.readMeta = async (key) => {
      happened.push('read');

      return readMeta(key);
    };

    await cacheStats(reading);

    expect(happened.indexOf('read')).toBeLessThan(happened.indexOf('listing done'));
  });

  it('counts a channel the store lists in pieces once, and every day of it', async () => {
    const { driver, reading } = await cached();
    const list = driver.list.bind(driver);

    // A store that answers in whatever order suits it: a channel's days apart.
    driver.list = async function* (options) {
      const held = [];

      for await (const one of list(options)) {
        held.push(one);
      }

      // By day: one 2026-07-17, two 2026-07-18, one 2026-07-19.
      yield* held.toSorted((a, b) =>
        (a.kind === 'entry' ? a.key.day : '').localeCompare(b.kind === 'entry' ? b.key.day : ''),
      );
    };

    expect((await cacheStats(reading, 'a.tv')).sites[0]).toMatchObject({
      channels: 2,
      entries: 3,
      empty: 1,
      programmes: 3,
      days: { first: '2026-07-17', last: '2026-07-19' },
    });
  });

  it("names a site's groups in order, whatever order the store keeps them in", async () => {
    const { reading } = await cached();

    await reading.cache.setState('a.tv', 'remembered', []);
    await reading.cache.setState('a.tv', 'cursor', []);

    expect((await cacheStats(reading, 'a.tv')).sites[0]!.state).toEqual([
      'channels',
      'cursor',
      'remembered',
      'state',
    ]);
  });

  it('says so where nothing is cached', async () => {
    const { reading } = await cached();

    expect(await writeCacheStats(reading, 'c.tv')).toBe(0);
    expect(reading.stdout.text).toBe('Nothing cached for c.tv.\n');
  });
});

describe('epg cache show', () => {
  it('shows a site a channel at a time, a day at a time, in order', async () => {
    const { reading } = await cached();

    await showCache({ ...reading, format: 'json' }, 'a.tv');

    expect(
      reading.stdout.text
        .trim()
        .split('\n')
        .map((line) => (JSON.parse(line) as { title: Array<{ value: string }> }).title[0]!.value),
    ).toEqual(['News', 'Film', 'Late']);
    // Records, as the cache keeps them: a date in XMLTV form.
    expect(JSON.parse(reading.stdout.text.split('\n')[0]!)).toMatchObject({
      start: '20260717180000',
    });
  });

  it('says why it leaves an entry out', async () => {
    const { driver, reading } = await cached();

    await spoil(driver, { schema: 0 });

    // Nothing left to show: said, and 1, with no document begun.
    expect(await showCache(reading, 'a.tv', 'two')).toBe(1);
    expect(reading.stderr.text).toBe(
      'two 2026-07-18: left out — written as schema 0, and this version reads 1\n' +
        'Nothing cached for a.tv two that can be read.\n',
    );
    expect(reading.stdout.text).toBe('');
  });

  it('writes an entry a line a programme, in one write', async () => {
    const { reading } = await cached();
    const writes: string[] = [];
    const write = reading.stdout.write.bind(reading.stdout);

    reading.stdout.write = ((chunk: string, ...rest: never[]) => {
      writes.push(chunk);

      return write(chunk, ...rest);
    }) as typeof reading.stdout.write;

    await showCache({ ...reading, format: 'json' }, 'a.tv');

    // Two entries with programmes, and the empty one writes nothing.
    expect(writes.filter((chunk) => chunk !== '')).toHaveLength(2);
  });

  it('goes on past an entry whose programmes cannot be read, saying why', async () => {
    const { driver, reading } = await cached();
    const key = { site: 'a.tv', channelId: 'two', day: '2026-07-18' };
    const found = (await driver.read(key))!;

    await driver.write(key, new TextEncoder().encode('not json'), found.meta as StoredEntryMeta);

    expect(await showCache({ ...reading, format: 'json' }, 'a.tv')).toBe(0);
    // What the codec said, which is JSON.parse's own words.
    expect(reading.stderr.text).toMatch(
      /^two 2026-07-18: left out — its programmes cannot be read: .+\n$/,
    );
    expect(reading.stdout.text.trim().split('\n')).toHaveLength(2);
  });

  it('goes on past an entry the store cannot open, saying why', async () => {
    const { driver, reading } = await cached();
    const read = driver.read.bind(driver);

    driver.read = async (key) => {
      if (key.channelId === 'two') {
        throw new Error("EACCES: permission denied, open '2026-07-18.ndjson'");
      }

      return read(key);
    };

    expect(await showCache({ ...reading, format: 'json' }, 'a.tv')).toBe(0);
    expect(reading.stderr.text).toBe(
      "two 2026-07-18: left out — could not be read: EACCES: permission denied, open '2026-07-18.ndjson'\n",
    );
    expect(reading.stdout.text.trim().split('\n')).toHaveLength(2);

    // And nothing else to show is said as such, with 1.
    const alone = await cached();

    alone.driver.read = driver.read;

    expect(await showCache(alone.reading, 'a.tv', 'two')).toBe(1);
    expect(alone.reading.stderr.text).toContain('Nothing cached for a.tv two that can be read.');
  });

  it('stops a show that was stopped, rather than leaving out what it could not read', async () => {
    const { driver, reading } = await cached();
    const controller = new AbortController();

    driver.read = async () => {
      controller.abort();

      throw new Error('interrupted');
    };

    await expect(
      showCache({ ...reading, format: 'json', signal: controller.signal }, 'a.tv'),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(reading.stderr.text).toBe('');
  });

  it("says so for a meta it cannot read, and for one the config's invalidate voids", async () => {
    const unreadable = await cached();

    await spoil(unreadable.driver, { grabbedAt: undefined });
    await showCache(unreadable.reading, 'a.tv', 'two');

    expect(unreadable.reading.stderr.text).toContain('its meta is not one this version can read');

    const voided = await cached(() => true);

    await showCache(voided.reading, 'b.tv');

    expect(voided.reading.stderr.text).toContain(
      "one 2026-07-17: left out — the config's invalidate voids it",
    );
  });
});

describe('what epg cache asks a store for', () => {
  /** A memory store that says what it was asked to list. */
  async function recorded(): Promise<{
    asked: unknown[];
    reading: CacheReading & { stdout: Sink; stderr: Sink };
  }> {
    const { driver, reading } = await cached();
    const asked: unknown[] = [];
    const list = driver.list.bind(driver);

    driver.list = (options) => {
      asked.push(options);

      return list(options);
    };

    return { asked, reading };
  }

  it('reads a channel-day it is named by, and lists nothing', async () => {
    const { asked, reading } = await recorded();

    expect(await showCache(reading, 'a.tv', 'one', '2026-07-17')).toBe(0);
    expect(asked).toEqual([]);
    expect(reading.stdout.text.match(/<programme /g)).toHaveLength(2);
  });

  it("lists one channel's entries, and a site's groups, and no more", async () => {
    const { asked, reading } = await recorded();

    await showCache(reading, 'a.tv', 'one');
    await showState(reading, 'a.tv');

    expect(asked).toEqual([
      { site: 'a.tv', kind: 'entry', channelId: 'one' },
      { site: 'a.tv', kind: 'state' },
    ]);
  });
});

describe('epg cache state', () => {
  it('lists the groups, saying what each holds', async () => {
    const { reading } = await cached();

    expect(await showState(reading, 'a.tv')).toBe(0);
    expect(reading.stdout.text).toMatch(
      /^channels {2}2 channels, written .+ by .+\nstate {5}2 keys, written /,
    );
  });

  it('lists a channel list by its channels, and a bag by its keys', async () => {
    const channels = await cached();
    const bag = await cached();

    await showState(channels.reading, 'a.tv', 'channels', true);
    await showState(bag.reading, 'a.tv', 'state', true);

    expect(channels.reading.stdout.text).toBe('one\ntwo\n');
    expect(bag.reading.stdout.text).toBe('cursor\ntoken\n');
  });

  it('counts a group as a run would read it, and lists the keys a run reads', async () => {
    const { reading } = await cached();

    await reading.cache.setState('a.tv', 'custom', { a: 1, b: 2 });
    await reading.cache.setState('a.tv', 'list', [1, 2, 3]);
    await reading.cache.setState('a.tv', 'mixed', [
      ['cursor', 1],
      [2, 3],
    ]);
    await showState(reading, 'a.tv');

    // A bag is a list of pairs with string keys, and a run keeps those alone.
    expect(reading.stdout.text).toMatch(/^custom {4}no keys a run can read, written /m);
    expect(reading.stdout.text).toMatch(/^list {6}0 keys, and 3 unreadable, written /m);
    expect(reading.stdout.text).toMatch(/^mixed {5}1 key, and 1 unreadable, written /m);

    const mixed = await cached();

    await mixed.reading.cache.setState('a.tv', 'mixed', [
      ['cursor', 1],
      [2, 3],
    ]);

    expect(await showState(mixed.reading, 'a.tv', 'mixed', true)).toBe(0);
    expect(mixed.reading.stdout.text).toBe('cursor\n');
    expect(await showState(reading, 'a.tv', 'custom', true)).toBe(1);
    expect(reading.stderr.text).toContain('a.tv custom holds no keys to list.');
  });

  it('reads a channel list all or not at all, as a run does', async () => {
    const { reading } = await cached();

    await reading.cache.setState('a.tv', 'channels', { channels: [{ xmltvId: 'one' }, null] });
    await showState(reading, 'a.tv');

    expect(reading.stdout.text).toMatch(/^channels {2}no channel list a run can read, written /m);
    expect(await showState(reading, 'a.tv', 'channels', true)).toBe(1);
    expect(reading.stderr.text).toContain('a.tv channels holds no keys to list.');
  });

  it('lists more keys than a call could take as arguments', async () => {
    const { reading } = await cached();
    const many = Array.from({ length: 200_000 }, (_, i) => [`k${i}`, i]);

    await reading.cache.setState('a.tv', 'many', many);

    expect(await showState(reading, 'a.tv', 'many', true)).toBe(0);
    expect(reading.stdout.text.split('\n')).toHaveLength(200_001);
  });

  it('counts what a site remembered and has since forgotten as expired', async () => {
    const { reading } = await cached();
    const now = Date.now();

    await reading.cache.setState('a.tv', 'remembered', [
      ['kept', { until: now + 3_600_000, value: 1 }],
      ['gone', { until: now - 3_600_000, value: 2 }],
      ['torn', { value: 3 }],
      [4, { until: now + 3_600_000, value: 4 }],
    ]);
    await showState(reading, 'a.tv');

    expect(reading.stdout.text).toMatch(
      /^remembered {2}1 key, and 2 expired and 1 unreadable, written /m,
    );

    const keys = await cached();

    await keys.reading.cache.setState('a.tv', 'remembered', [
      ['kept', { until: now + 3_600_000, value: 1 }],
      ['gone', { until: now - 3_600_000, value: 2 }],
    ]);
    await showState(keys.reading, 'a.tv', 'remembered', true);

    expect(keys.reading.stdout.text).toBe('kept\n');
  });

  it("claims nothing of the keys a run drops by rules of its own, as a validator's day", async () => {
    const { reading } = await cached();

    // A run keeps the validators of its window alone; a look has no window.
    await reading.cache.setState('a.tv', 'validators', [
      ['2020-01-01 one', { etag: '"a"' }],
      ['2999-01-01 one', { etag: '"b"' }],
    ]);
    await showState(reading, 'a.tv');

    expect(reading.stdout.text).toMatch(/^validators {2}2 keys, written /m);
  });

  it('describes a group the store cannot open, and goes on to the rest', async () => {
    const { driver, reading } = await cached();
    const readState = driver.readState.bind(driver);

    driver.readState = async (site, key) => {
      if (key === 'state') {
        throw new Error('EACCES: permission denied');
      }

      return readState(site, key);
    };

    expect(await showState(reading, 'a.tv')).toBe(0);
    expect(reading.stdout.text).toMatch(/^channels {2}2 channels, written /m);
    expect(reading.stdout.text).toMatch(
      /^state {5}could not be read: EACCES: permission denied\n/m,
    );

    const json = await cached();

    json.driver.readState = driver.readState;

    await showState({ ...json.reading, format: 'json' }, 'a.tv');

    expect(JSON.parse(json.reading.stdout.text)).toContainEqual({
      group: 'state',
      status: 'failed',
      why: 'could not be read: EACCES: permission denied',
    });
  });

  it('says when a group was written as an instant, whatever offset it was written with', async () => {
    const { driver, reading } = await cached();

    await driver.writeState('c.tv', 'state', [], {
      writtenAt: '2026-07-17T10:00:00+02:00',
      schema: STATE_SCHEMA,
      writtenBy: '0.9.0',
    });
    await showState(reading, 'c.tv');

    expect(reading.stdout.text).toContain('written 2026-07-17 08:00Z by 0.9.0');
  });

  it('says nothing is remembered where every group went since it was listed', async () => {
    const { driver, reading } = await cached();

    // A run in another process removing them between the listing and the look.
    driver.list = async function* () {
      yield { kind: 'state', site: 'a.tv', key: 'gone' };
    };

    expect(await showState(reading, 'a.tv')).toBe(1);
    expect(reading.stderr.text).toBe('Nothing remembered for a.tv.\n');
  });

  it('exits 1 for a site none of whose groups it can read, and still describes them', async () => {
    const { driver, reading } = await cached();

    await driver.writeState('c.tv', 'state', [], {
      writtenAt: '2026-07-17T00:00:00.000Z',
      schema: STATE_SCHEMA + 1,
      writtenBy: '9.9.9',
    });

    expect(await showState(reading, 'c.tv')).toBe(1);
    expect(reading.stdout.text).toContain('state  written as schema 2, and this version reads 1');
  });

  it('writes a group written empty as JSON null', async () => {
    const { reading } = await cached();

    await reading.cache.setState('a.tv', 'empty', undefined);
    await showState(reading, 'a.tv', 'empty');

    expect(reading.stdout.text).toBe('null\n');
  });

  it('lists the groups as JSON, one it cannot read among them', async () => {
    const { driver, reading } = await cached();

    await driver.writeState('a.tv', 'state', [], {
      writtenAt: '2026-07-17T00:00:00.000Z',
      schema: STATE_SCHEMA + 1,
      writtenBy: '9.9.9',
    });
    await showState({ ...reading, format: 'json' }, 'a.tv');

    expect(JSON.parse(reading.stdout.text)).toEqual([
      expect.objectContaining({ group: 'channels', status: 'readable', holds: '2 channels' }),
      {
        group: 'state',
        status: 'incompatible',
        why: 'written as schema 2, and this version reads 1',
      },
    ]);

    const text = await cached();

    await text.driver.writeState('a.tv', 'state', [], {
      writtenAt: '2026-07-17T00:00:00.000Z',
      schema: STATE_SCHEMA + 1,
      writtenBy: '9.9.9',
    });
    await showState(text.reading, 'a.tv');

    expect(text.reading.stdout.text).toMatch(
      /^state {5}written as schema 2, and this version reads 1 — fetched again when next wanted$/m,
    );
  });

  it('says so for a group whose envelope says nothing it can read', async () => {
    const { driver, reading } = await cached();

    await driver.writeState('a.tv', 'state', [], {
      schema: STATE_SCHEMA,
      writtenBy: '9.9.9',
    } as StoredStateMeta);

    expect(await showState(reading, 'a.tv', 'state')).toBe(1);
    expect(reading.stderr.text).toBe(
      'a.tv state: its envelope is not one this version can read — fetched again when next wanted\n',
    );
  });

  it('says so for a group it cannot read, and exits 1', async () => {
    const { driver, reading } = await cached();

    await driver.writeState('a.tv', 'state', [], {
      writtenAt: '2026-07-17T00:00:00.000Z',
      schema: STATE_SCHEMA + 1,
      writtenBy: '9.9.9',
    });

    expect(await showState(reading, 'a.tv', 'state')).toBe(1);
    expect(reading.stderr.text).toContain(
      'a.tv state: written as schema 2, and this version reads 1 — fetched again when next wanted',
    );
  });
});

const sqlite = await import('../src/cache/sqlite-driver.js').catch(() => undefined);

describe.skipIf(sqlite === undefined)(
  'epg cache stats over a store that reads a window at once',
  () => {
    it('counts the same as one read a key at a time', async () => {
      const driver = new sqlite!.SqliteCacheDriver({ dir: '', file: ':memory:' });
      const cache = new CacheManager({ driver });

      try {
        await cache.write(
          { site: 'a.tv', channelId: 'one', day: '2026-07-17' },
          [programme('one', 'A')],
          {
            grabbedAt: '2026-07-17T03:00:00.000Z',
          },
        );
        await cache.write({ site: 'a.tv', channelId: 'one', day: '2026-07-18' }, [], {
          grabbedAt: '2026-07-18T03:00:00.000Z',
        });

        expect(await cacheStats({ cache, stdout: new Sink(), stderr: new Sink() })).toMatchObject({
          sites: [{ site: 'a.tv', channels: 1, entries: 2, empty: 1, programmes: 1 }],
        });
      } finally {
        await cache.close();
      }
    });
  },
);
