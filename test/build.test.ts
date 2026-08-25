import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { build, createCacheStore, guideStream, runGrab, runMerge } from '../src/build.js';
import { CacheManager, FsNdjsonCacheDriver } from '../src/cache/main.js';
import type { ChannelDayKey, StoredEntryMeta } from '../src/cache/main.js';
import { defineConfig, type EpgConfig } from '../src/config.js';
import type { SiteConfig } from '../src/grabber/types.js';
import type { XmltvProgramme } from '../src/xmltv/types.js';

/**
 * Whether this runtime has `node:sqlite` at all: it arrived in Node 22.5 behind
 * a flag, and the driver named `'sqlite'` is loaded only when asked for, so the
 * one test that asks has to be skipped where asking would fail.
 */
const hasSqlite = await import('node:sqlite').then(
  () => true,
  () => false,
);

const NOW = new Date('2026-07-17T12:00:00.000Z');
const TODAY = '2026-07-17';
const TOMORROW = '2026-07-18';
const YESTERDAY = '2026-07-16';

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'epg-build-test-'));
}

/** A site that records which days it was asked for and returns one programme each. */
function site(fetchedDays: string[]): SiteConfig<unknown> {
  return {
    site: 'example.com',
    channels: [{ xmltvId: 'one.example', siteId: '1', name: 'One' }],
    async request({ day }) {
      fetchedDays.push(day);
      return { day };
    },
    parseDay({ day }): XmltvProgramme[] {
      return [
        {
          channel: 'one.example',
          start: new Date(`${day}T06:00:00.000Z`),
          title: [{ value: `p-${day}` }],
        },
      ];
    },
  };
}

function config(dir: string, overrides: Partial<EpgConfig> = {}): EpgConfig {
  return {
    sites: [site([])],
    days: 1,
    output: join(dir, 'guide.xml'),
    cache: { dir: join(dir, 'cache') },
    ...overrides,
  };
}

async function collect(chunks: AsyncGenerator<string>): Promise<string> {
  let out = '';

  for await (const chunk of chunks) {
    out += chunk;
  }

  return out;
}

describe('offset', () => {
  it('moves the grab window without moving "now"', async () => {
    const dir = await tempDir();
    const fetchedDays: string[] = [];

    await runGrab(config(dir, { sites: [site(fetchedDays)], days: 2 }), { now: NOW, offset: 1 });

    expect(fetchedDays).toEqual([TOMORROW, '2026-07-19']);
  });

  it('defaults to a window starting today', async () => {
    const dir = await tempDir();
    const fetchedDays: string[] = [];

    await runGrab(config(dir, { sites: [site(fetchedDays)], days: 2 }), { now: NOW });

    expect(fetchedDays).toEqual([TODAY, TOMORROW]);
  });

  it('accepts a negative offset and does not prune the days it just grabbed', async () => {
    const dir = await tempDir();
    const fetchedDays: string[] = [];
    const epgConfig = config(dir, { sites: [site(fetchedDays)], days: 2 });

    await runGrab(epgConfig, { now: NOW, offset: -1 });

    expect(fetchedDays).toEqual([YESTERDAY, TODAY]);

    // Yesterday is inside the window, so the post-grab prune must spare it —
    // and it must still be readable back out of the cache.
    const xml = await collect(guideStream(epgConfig, { now: NOW, offset: -1 }));

    expect(xml).toContain(`start="20260716060000`);
    expect(xml).toContain(`start="20260717060000`);
  });

  it('still prunes days before the window', async () => {
    const dir = await tempDir();
    const epgConfig = config(dir, { days: 1 });

    // Seed a stale day well behind the window, then grab.
    await runGrab(config(dir, { sites: [site([])], days: 1 }), {
      now: new Date('2026-07-10T12:00:00.000Z'),
    });
    await runGrab(epgConfig, { now: NOW });

    const xml = await collect(guideStream(config(dir, { days: 30 }), { now: NOW, offset: -10 }));

    expect(xml).not.toContain('start="20260710');
  });

  it('applies the same window to the grab and the merge', async () => {
    const dir = await tempDir();
    const fetchedDays: string[] = [];
    const epgConfig = config(dir, { sites: [site(fetchedDays)], days: 1 });

    await build(epgConfig, { now: NOW, offset: 2 });

    const xml = await readFile(epgConfig.output, 'utf8');

    expect(fetchedDays).toEqual(['2026-07-19']);
    expect(xml).toContain('start="20260719060000');
    expect(xml).not.toContain('start="20260717');
  });
});

describe('cancellation', () => {
  it('writes no guide when the grab was cancelled, and keeps what it cached', async () => {
    const dir = await tempDir();
    const controller = new AbortController();
    const fetched: string[] = [];
    const cancelling: SiteConfig<unknown> = {
      ...site(fetched),
      channels: [
        { xmltvId: 'one.example', siteId: '1', name: 'One' },
        { xmltvId: 'two.example', siteId: '2', name: 'Two' },
      ],
      async request({ channel, day }) {
        fetched.push(channel.xmltvId);
        controller.abort(new Error('cancelled'));
        return { day };
      },
    };
    const epgConfig = config(dir, { sites: [cancelling], days: 1 });

    const summary = await build(epgConfig, { now: NOW, signal: controller.signal });

    // The channel-day in flight when the cancel landed is reported, and the one
    // still queued was never asked for.
    expect(fetched).toEqual(['one.example']);
    expect(summary.failed).toHaveLength(1);
    // Half a window is not what the guide in place should be replaced with.
    expect(existsSync(epgConfig.output)).toBe(false);
  });

  it('stops a merge between channel-days rather than writing half a guide', async () => {
    const dir = await tempDir();
    const controller = new AbortController();
    const epgConfig = config(dir, { days: 1 });

    await runGrab(epgConfig, { now: NOW });
    expect(existsSync(join(dir, 'cache'))).toBe(true);

    controller.abort(new Error('cancelled'));

    // Node's own convention for an aborted operation, which is what the
    // output pipeline raises: an AbortError carrying the reason as its cause.
    await expect(
      runMerge(epgConfig, { now: NOW, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError', cause: { message: 'cancelled' } });

    // The document is written beside its file and renamed only when finished,
    // so an abandoned one leaves nothing at all.
    expect(existsSync(epgConfig.output)).toBe(false);
    expect((await readdir(dir)).filter((name) => name.startsWith('guide.xml'))).toEqual([]);
  });

  it('leaves the cache unpruned when a run is cancelled', async () => {
    const dir = await tempDir();
    const controller = new AbortController();
    const cache = new CacheManager({
      driver: new FsNdjsonCacheDriver({ dir: join(dir, 'cache') }),
    });
    const stale = { site: 'example.com', channelId: 'one.example', day: YESTERDAY };

    await cache.write(stale, [
      {
        channel: 'one.example',
        start: new Date(`${YESTERDAY}T06:00:00.000Z`),
        title: [{ value: 'old' }],
      },
    ]);

    const cancelling: SiteConfig<unknown> = {
      ...site([]),
      async request({ day }) {
        controller.abort(new Error('cancelled'));
        return { day };
      },
    };

    await runGrab(config(dir, { sites: [cancelling], days: 1 }), {
      now: NOW,
      signal: controller.signal,
    });

    // Pruning a window the grab never finished filling would take days it might
    // still have wanted.
    expect(await cache.getMeta(stale)).toBeDefined();
  });
});

describe('guideStream', () => {
  it('yields the same document runMerge writes', async () => {
    const dir = await tempDir();
    const epgConfig = config(dir, { days: 1 });

    await runGrab(epgConfig, { now: NOW });
    await runMerge(epgConfig, { now: NOW });

    const written = await readFile(epgConfig.output, 'utf8');
    const streamed = await collect(guideStream(epgConfig, { now: NOW }));

    expect(streamed).toBe(written);
  });

  it('starts a well-formed XMLTV document', async () => {
    const dir = await tempDir();
    const epgConfig = config(dir, { days: 1 });

    await runGrab(epgConfig, { now: NOW });

    const xml = await collect(guideStream(epgConfig, { now: NOW }));

    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<!DOCTYPE tv SYSTEM "xmltv.dtd">');
    expect(xml.trimEnd().endsWith('</tv>')).toBe(true);
    expect(xml.indexOf('<channel')).toBeLessThan(xml.indexOf('<programme'));
  });
});

describe('a configuration that still needs its answers', () => {
  it('is resolved by every entry point, not just the CLI', async () => {
    const dir = await tempDir();
    const fetched: string[] = [];
    const source = defineConfig(
      (ctx) => ({
        ...config(dir, { sites: [site(fetched)] }),
        meta: { sourceInfoName: ctx.require('label') },
      }),
      { env: 'EPG_TEST_' },
    );

    vi.stubEnv('EPG_TEST_LABEL', 'from-env');

    try {
      // Each of these took an EpgConfig only, so a factory config had to be
      // called by hand before use — while the CLI called it for you.
      const summary = await build(source, { now: NOW });
      expect(summary.fetched).toBe(1);
      expect(await readFile(join(dir, 'guide.xml'), 'utf8')).toContain(
        'source-info-name="from-env"',
      );

      // Today is always refetched, so this is a grab and not a cache hit.
      expect((await runGrab(source, { now: NOW })).fetched).toBe(1);
      expect(await collect(guideStream(source, { now: NOW }))).toContain(
        'source-info-name="from-env"',
      );

      await runMerge(source, { now: NOW });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('is resolved once for a build, so the grab and the merge agree', async () => {
    const dir = await tempDir();
    let calls = 0;

    const source = defineConfig(() => {
      calls++;
      return config(dir);
    });

    await build(source, { now: NOW });

    // A factory may read the environment or fetch; the merge must not get a
    // second, possibly different answer.
    expect(calls).toBe(1);
  });

  it('resolves a fetched channel list once for a build, not once per pass', async () => {
    const dir = await tempDir();
    let calls = 0;

    const lazy: SiteConfig<unknown> = {
      ...site([]),
      channels: () => {
        calls++;
        return [{ xmltvId: 'one.example', siteId: '1', name: 'One' }];
      },
    };

    await build(config(dir, { sites: [lazy] }), { now: NOW });

    // The grab and the merge that reads what it wrote must not each ask the
    // source what its channels are: the answer can change in between.
    expect(calls).toBe(1);
    expect(await readFile(join(dir, 'guide.xml'), 'utf8')).toContain('one.example');
  });

  it('asks every site for its channels at once when a merge has to ask', async () => {
    const dir = await tempDir();
    let waiting = 0;
    let both: (() => void) | undefined;
    // Nobody resolves until both sites are inside their channels function, so
    // this only settles if the merge asks them in parallel.
    const together = new Promise<void>((resolve) => {
      both = resolve;
    });

    const lazy = (id: string): SiteConfig<unknown> => ({
      ...site([]),
      site: id,
      channels: async () => {
        if (++waiting === 2) {
          both?.();
        }

        await together;

        return [{ xmltvId: id, siteId: '1', name: id }];
      },
    });

    // Only the merge runs, so the pre-resolved lists a build hands down are not
    // what is being measured here.
    await runMerge(config(dir, { sites: [lazy('a.example'), lazy('b.example')] }), { now: NOW });

    const guide = await readFile(join(dir, 'guide.xml'), 'utf8');

    expect(guide).toContain('a.example');
    expect(guide).toContain('b.example');
  });

  it('holds a merge to siteConcurrency when it is set', async () => {
    const dir = await tempDir();
    let inFlight = 0;
    let peak = 0;

    const lazy = (id: string): SiteConfig<unknown> => ({
      ...site([]),
      site: id,
      channels: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;

        return [{ xmltvId: id, siteId: '1', name: id }];
      },
    });

    await runMerge(
      config(dir, {
        sites: [lazy('a.example'), lazy('b.example'), lazy('c.example')],
        siteConcurrency: 1,
      }),
      { now: NOW },
    );

    expect(peak).toBe(1);
  });
});

describe('the cache a config describes', () => {
  /** A driver that counts what a run asked of it, and whether it was let go of. */
  class CountingDriver extends FsNdjsonCacheDriver {
    writes = 0;
    closed = 0;

    override async write(
      key: ChannelDayKey,
      programmes: string[],
      meta: StoredEntryMeta,
    ): Promise<void> {
      this.writes++;
      await super.write(key, programmes, meta);
    }

    async close(): Promise<void> {
      this.closed++;
    }
  }

  it('builds the driver a factory returns, and tells it where and when', async () => {
    const dir = await tempDir();
    const seen: Array<{ dir: string; signal?: AbortSignal | undefined }> = [];
    const controller = new AbortController();
    const driver = new CountingDriver({ dir: join(dir, 'elsewhere') });

    await runGrab(
      config(dir, {
        cache: {
          dir: join(dir, 'cache'),
          // Whatever else a driver of yours takes is in scope where the function
          // is written, which is why nothing here is passed through for it.
          driver: (options) => {
            seen.push(options);

            return driver;
          },
        },
      }),
      { now: NOW, signal: controller.signal },
    );

    expect(seen).toEqual([{ dir: join(dir, 'cache'), signal: controller.signal }]);
    expect(driver.writes).toBe(1);
    // Entries went where the driver put them, not where the config said.
    expect(await readdir(join(dir, 'elsewhere'))).toEqual(['example.com']);
  });

  it('lets go of the cache however the run ended', async () => {
    const dir = await tempDir();
    const drivers: CountingDriver[] = [];
    const withDriver = (overrides: Partial<EpgConfig> = {}): EpgConfig =>
      config(dir, {
        ...overrides,
        cache: {
          dir: join(dir, 'cache'),
          driver: (options) => {
            const driver = new CountingDriver(options);
            drivers.push(driver);

            return driver;
          },
        },
      });

    await runGrab(withDriver(), { now: NOW });
    await runMerge(withDriver(), { now: NOW });
    await collect(guideStream(withDriver(), { now: NOW }));

    // A grab, a merge, and a stream read to its end: three caches, each given
    // back — a driver holding a database handle is waiting for exactly this.
    expect(drivers.map((driver) => driver.closed)).toEqual([1, 1, 1]);

    // And a run that threw: the `finally` is the whole point.
    const failing = withDriver({
      sites: [
        {
          ...site([]),
          channels: () => {
            throw new Error('no channel list');
          },
        },
      ],
    });

    await expect(runMerge(failing, { now: NOW })).rejects.toThrow('no channel list');
    expect(drivers).toHaveLength(4);
    expect(drivers.at(-1)!.closed).toBe(1);
  });

  it('closes a guide stream that was walked away from half way', async () => {
    const dir = await tempDir();
    let driver: CountingDriver | undefined;
    const epgConfig = config(dir, {
      days: 2,
      cache: {
        dir: join(dir, 'cache'),
        driver: ({ dir: cacheDir }) => (driver = new CountingDriver({ dir: cacheDir })),
      },
    });

    await runGrab(epgConfig, { now: NOW });

    const stream = guideStream(epgConfig, { now: NOW });
    await stream.next();
    await stream.return(undefined);

    expect(driver!.closed).toBe(1);
  });

  it('asks the config invalidate about a cached entry', async () => {
    const dir = await tempDir();
    const fetchedDays: string[] = [];
    const epgConfig = config(dir, { sites: [site(fetchedDays)] });

    // Tomorrow rather than today, since today is inside `alwaysRefetchDays` and
    // would be fetched again whatever the cache holds.
    const run = { now: NOW, offset: 1 };

    await runGrab(epgConfig, run);
    expect(fetchedDays).toEqual([TOMORROW]);

    // Fresh, so a second run serves it from the cache — until something says the
    // entry is void.
    await runGrab(epgConfig, run);
    expect(fetchedDays).toEqual([TOMORROW]);

    await runGrab(
      {
        ...epgConfig,
        cache: { ...epgConfig.cache, invalidate: (meta) => meta.writtenBy === __PKG_VERSION__ },
      },
      run,
    );

    expect(fetchedDays).toEqual([TOMORROW, TOMORROW]);
  });

  it('is a resource `await using` can hold', async () => {
    const dir = await tempDir();
    let driver: CountingDriver | undefined;
    const epgConfig = config(dir, {
      cache: {
        dir: join(dir, 'cache'),
        driver: ({ dir: cacheDir }) => (driver = new CountingDriver({ dir: cacheDir })),
      },
    });

    {
      await using cache = await createCacheStore(epgConfig);

      expect(await cache.prune({ before: TODAY })).toBe(0);
      expect(driver!.closed).toBe(0);
    }

    expect(driver!.closed).toBe(1);
  });
});

describe('a cache handed to a run', () => {
  it("is used instead of the config's, and left open for its owner", async () => {
    const dir = await tempDir();
    const driver = new FsNdjsonCacheDriver({ dir: join(dir, 'mine') });
    let closed = 0;
    const cache = new CacheManager({ driver });
    cache.close = async (): Promise<void> => {
      closed++;
    };

    const epgConfig = config(dir, { cache: { dir: join(dir, 'ignored') } });

    await runGrab(epgConfig, { now: NOW, cache });
    await runMerge(epgConfig, { now: NOW, cache });
    await collect(guideStream(epgConfig, { now: NOW, cache }));

    // The config's own directory was never touched, and nothing closed a cache
    // it did not open — a caller that opened a database may want it again.
    await expect(readdir(join(dir, 'ignored'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(join(dir, 'mine'))).toEqual(['example.com']);
    expect(closed).toBe(0);
  });

  it('is asked for once by a build, and shared by its grab and its merge', async () => {
    const dir = await tempDir();
    let asked = 0;
    const epgConfig = config(dir, {
      days: 2,
      cache: {
        dir: join(dir, 'cache'),
        driver: ({ dir: cacheDir }) => {
          asked++;

          return new FsNdjsonCacheDriver({ dir: cacheDir });
        },
      },
    });

    await build(epgConfig, { now: NOW });

    expect(asked).toBe(1);
    expect(await readFile(epgConfig.output, 'utf8')).toContain(`p-${TODAY}`);
  });

  it('builds a whole guide through a cache that only lives in memory', async () => {
    const dir = await tempDir();
    const fetchedDays: string[] = [];
    const epgConfig = config(dir, {
      days: 2,
      sites: [site(fetchedDays)],
      cache: { dir: join(dir, 'cache'), driver: 'memory' },
    });

    await build(epgConfig, { now: NOW });

    // The merge read what the grab had just written, because a build shares one
    // cache — and nothing was left on disk to read it from again.
    const guide = await readFile(epgConfig.output, 'utf8');

    expect(guide).toContain(`p-${TODAY}`);
    expect(guide).toContain(`p-${TOMORROW}`);
    expect(fetchedDays).toEqual([TODAY, TOMORROW]);
    expect(existsSync(join(dir, 'cache'))).toBe(false);

    // And a second build grabs the lot again, since nothing remembers it.
    await build(epgConfig, { now: NOW });
    expect(fetchedDays).toEqual([TODAY, TOMORROW, TODAY, TOMORROW]);
  });
});

describe('naming a driver a config does not have', () => {
  it('fails rather than quietly using the default', async () => {
    const dir = await tempDir();
    const epgConfig = config(dir, {
      // A config written in JavaScript can say this; TypeScript cannot.
      cache: { dir: join(dir, 'cache'), driver: 'postgres' as 'ndjson' },
    });

    await expect(createCacheStore(epgConfig)).rejects.toThrow('Unknown cache driver: postgres');
  });

  it.skipIf(hasSqlite)('says what the sqlite driver needs when the runtime lacks it', async () => {
    const dir = await tempDir();
    const epgConfig = config(dir, { cache: { dir: join(dir, 'cache'), driver: 'sqlite' } });

    // Node's own message names a module the config never mentioned, so the
    // choice that led here is named instead — with Node's reason kept.
    await expect(createCacheStore(epgConfig)).rejects.toThrow(
      /sqlite cache driver needs Node 24 or newer.*node:sqlite/s,
    );
  });

  it.skipIf(!hasSqlite)('keeps its entries in one SQLite file when asked for by name', async () => {
    const dir = await tempDir();
    const fetchedDays: string[] = [];
    const epgConfig = config(dir, {
      sites: [site(fetchedDays)],
      cache: { dir: join(dir, 'cache'), driver: 'sqlite' },
    });

    await runGrab(epgConfig, { now: NOW });
    await runMerge(epgConfig, { now: NOW });

    // One file for the whole cache, rather than a directory per channel.
    expect((await readdir(join(dir, 'cache'))).filter((name) => !name.includes('-'))).toEqual([
      'cache.sqlite',
    ]);
    expect(await readFile(epgConfig.output, 'utf8')).toContain('p-2026-07-17');
    expect(fetchedDays).toEqual([TODAY]);

    // And the guide comes from the cache on a second merge, with no grab.
    await runMerge(epgConfig, { now: NOW });
    expect(fetchedDays).toEqual([TODAY]);
  });
});
