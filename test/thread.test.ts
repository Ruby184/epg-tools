import { availableParallelism } from 'node:os';
import { MessageChannel } from 'node:worker_threads';
import PQueue from 'p-queue';
import { describe, expect, it } from 'vitest';
import { CacheManager, MemoryCacheDriver } from '../src/cache/main.js';
import type { CacheStore } from '../src/cache/types.js';
import type { EpgEventInput } from '../src/core/events.js';
import { build } from '../src/build.js';
import { grab, StateKey } from '../src/grabber/main.js';
import type { Run } from '../src/grabber/site-run.js';
import {
  hostSite,
  SiteThreads,
  threadCount,
  workSite,
  type SiteThreadData,
} from '../src/grabber/thread.js';
import { getXmltvOffset } from '../src/xmltv/main.js';

// Both halves of a site in a thread, talking over a `MessageChannel` in this
// one: everything a worker adds is only that it runs somewhere else. Starting
// real ones — a pool, a cancel, a thread that dies — is `threads.test.ts`,
// which runs under the flags a worker needs to load the source.

const NOW = new Date('2026-07-17T12:00:00.000Z');
const DAY = '2026-07-17';
const CONFIG = new URL('./fixtures/thread.config.ts', import.meta.url).href;

/** The run's side: a real store, and every event it is told. */
function hosting(cache: CacheStore, signal?: AbortSignal): { run: Run; events: EpgEventInput[] } {
  const events: EpgEventInput[] = [];
  const run: Run = {
    defaults: { days: 1 },
    cache,
    now: NOW,
    grabbedAt: NOW.toISOString(),
    startDay: DAY,
    emit: (event) => {
      events.push(event);
    },
    ...(signal ? { signal } : {}),
    localWork: new PQueue({ concurrency: 4 }),
    enqueue: (queue, task, options = {}) =>
      queue.add(task, { ...options, ...(signal ? { signal } : {}) }),
    tally: { fetched: 0, empty: 0, fromCache: 0, unchanged: 0, failed: 0, sitesFailed: 0 },
  };

  return { run, events };
}

function started(site: string, extra: Partial<SiteThreadData> = {}): SiteThreadData {
  return {
    module: CONFIG,
    site,
    now: NOW.toISOString(),
    grabbedAt: NOW.toISOString(),
    startDay: DAY,
    defaults: { days: 1 },
    localConcurrency: 4,
    ...extra,
  };
}

/** Hold the conversation to its end, and let go of the channel either way. */
async function converse(run: Run, data: SiteThreadData): Promise<void> {
  const { port1, port2 } = new MessageChannel();

  try {
    await Promise.all([hostSite(port1, run), workSite(port2, data)]);
  } finally {
    port1.close();
    port2.close();
  }
}

describe('a site in a thread', () => {
  it('runs the site its module has, into the run’s cache, offsets and all', async () => {
    const cache = new CacheManager({ driver: new MemoryCacheDriver() });
    const { run, events } = hosting(cache);

    await converse(run, started('offset.example'));

    const [programme] = (await cache.read({ site: 'offset.example', channelId: 'one', day: DAY }))!;

    // Crossed as the store keeps it, so the source's offset survives: a `Date`
    // copied to another thread arrives with neither offset nor precision.
    expect(getXmltvOffset(programme!.start)).toBe(120);
    expect(run.tally).toMatchObject({ fetched: 1, failed: 0, sitesFailed: 0 });
    expect(events.map((event) => event.type)).toContain('entry:fetched');
    // What the site remembered went through the same store.
    expect(await cache.getState('offset.example', StateKey.SITE)).toMatchObject({
      data: [['last', DAY]],
    });
  });

  it('says what a site said, even with data no thread can be handed', async () => {
    const cache = new CacheManager({ driver: new MemoryCacheDriver() });
    const { run, events } = hosting(cache);

    await converse(run, started('offset.example'));

    expect(events.find((event) => event.type === 'site:note')).toMatchObject({
      message: 'parsed',
      data: { day: DAY },
    });
  });

  it('grabs the channels the run settled rather than its own', async () => {
    const cache = new CacheManager({ driver: new MemoryCacheDriver() });
    const { run } = hosting(cache);

    await converse(
      run,
      started('channels.example', { channels: [{ xmltvId: 'settled', siteId: 'settled' }] }),
    );

    expect(
      await cache.read({ site: 'channels.example', channelId: 'settled', day: DAY }),
    ).toHaveLength(1);
    expect(
      await cache.read({ site: 'channels.example', channelId: 'own', day: DAY }),
    ).toBeUndefined();
  });

  it('carries an error across with its name, its code and what caused it', async () => {
    const cache = new CacheManager({ driver: new MemoryCacheDriver() });
    const { run, events } = hosting(cache);

    await converse(run, started('failing.example'));

    const failed = events.find((event) => event.type === 'request:failed') as
      | { error: Error & { code?: string } }
      | undefined;

    expect(failed?.error).toBeInstanceOf(Error);
    expect(failed?.error).toMatchObject({
      name: 'HTTPError',
      message: 'Request failed with status code 503',
      code: 'E_TEST',
    });
    expect(failed?.error.cause).toMatchObject({ name: 'TypeError', message: 'fetch failed' });
    expect(run.tally.failed).toBe(1);
  });

  it('fails the site when its module does not have it', async () => {
    const cache = new CacheManager({ driver: new MemoryCacheDriver() });
    const { run } = hosting(cache);

    await expect(converse(run, started('missing.example'))).rejects.toThrow(
      'has no site "missing.example"',
    );
  });

  it('stops when the run is cancelled', async () => {
    const cache = new CacheManager({ driver: new MemoryCacheDriver() });
    const controller = new AbortController();
    const { run, events } = hosting(cache, controller.signal);
    const said = run.emit;

    run.emit = (event) => {
      said(event);

      // Once the request is waiting, which it does until it is told to stop.
      if (event.type === 'request:started') {
        controller.abort(new Error('run cancelled'));
      }
    };

    await converse(run, started('slow.example'));

    expect(run.tally.fetched).toBe(0);
    expect(events.map((event) => event.type)).toContain('site:done');
  });

  it('sizes the pool from what `threads` says', () => {
    expect(threadCount(undefined, CONFIG)).toBe(0);
    expect(threadCount(false, CONFIG)).toBe(0);
    expect(threadCount(0, CONFIG)).toBe(0);
    expect(threadCount(3, CONFIG)).toBe(3);
    expect(threadCount(true, CONFIG)).toBe(availableParallelism());
    expect(() => threadCount(1.5, CONFIG)).toThrow('whole number of threads');
    expect(() => threadCount(-1, CONFIG)).toThrow('whole number of threads');
    // Nothing to start, so nothing to start them on.
    expect(threadCount(false, undefined)).toBe(0);
    expect(() => threadCount(2, undefined)).toThrow('pass configModule');
  });

  it('refuses threads it has no module to start them on', async () => {
    const cache = new CacheManager({ driver: new MemoryCacheDriver() });

    await expect(grab([], { cache, threads: true })).rejects.toThrow('pass configModule');
  });

  it('refuses them before a build asks any site for its channels', async () => {
    let asked = 0;
    const config = {
      output: 'guide.xml',
      threads: 2,
      sites: [
        {
          site: 'listed.example',
          channels: () => {
            asked++;

            return [{ xmltvId: 'one', siteId: '1' }];
          },
          request: async () => ({}),
          parseDay: () => [],
        },
      ],
    };

    await expect(
      build(config, { cache: new CacheManager({ driver: new MemoryCacheDriver() }) }),
    ).rejects.toThrow('pass configModule');
    // Said first, rather than after every site's list had been fetched.
    expect(asked).toBe(0);
  });

  it('names what a note held that could not cross, rather than failing the parse', async () => {
    const cache = new CacheManager({ driver: new MemoryCacheDriver() });
    const { run, events } = hosting(cache);

    await converse(run, started('circular.example'));

    // As the JSON reporter would have it: in place of its value, not a throw
    // into the site's own `parseDay` that would fail the channel-day.
    expect(run.tally).toMatchObject({ fetched: 1, failed: 0 });
    expect(events.find((event) => event.type === 'site:note')).toMatchObject({
      message: 'circular',
      data: '[unserializable]',
    });
  });

  it('counts as it goes, so a site that never says it is done has still counted', async () => {
    const cache = new CacheManager({ driver: new MemoryCacheDriver() });
    const { run, events } = hosting(cache);
    const counted: number[] = [];

    run.emit = (event) => {
      events.push(event);

      if (event.type === 'entry:fetched') {
        counted.push(run.tally.fetched);
      }
    };

    await converse(run, started('offset.example'));

    // Already counted when the entry was said, rather than on `site:done`.
    expect(counted).toEqual([1]);
  });

  it('refuses a channel list a thread would be handed as something else', async () => {
    class Zone {
      offset(): number {
        return 60;
      }
    }

    const cache = new CacheManager({ driver: new MemoryCacheDriver() });
    const { run } = hosting(cache);
    const pool = SiteThreads.for(1, CONFIG);
    const site = {
      site: 'offset.example',
      channels: [{ xmltvId: 'one', siteId: '1', data: { zone: new Zone() } }],
      request: async () => ({}),
      parseDay: () => [],
    };

    // Before a thread is asked for: in one, the zone would arrive as `{}` and
    // every parse calling `offset()` would fail without saying why.
    await expect(pool.run(site, run)).rejects.toThrow('an instance of Zone');
  });
});
