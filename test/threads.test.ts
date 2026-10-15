import { describe, expect, it } from 'vitest';
import { CacheManager, MemoryCacheDriver } from '../src/cache/main.js';
import type { CacheStore } from '../src/cache/types.js';
import type { EpgEventInput } from '../src/core/events.js';
import { grab, StateKey, type AnySiteConfig } from '../src/grabber/main.js';
import { getXmltvOffset } from '../src/xmltv/main.js';
import config from './fixtures/thread.config.js';

// Real worker threads, started on the source by the flags this project runs
// under (`vitest.config.ts`). The conversation itself is `thread.test.ts`;
// what is here is what only a worker that is really somewhere else can show.

const NOW = new Date('2026-07-17T12:00:00.000Z');
const DAY = '2026-07-17';
const CONFIG = new URL('./fixtures/thread.config.ts', import.meta.url);

/** The fixture's sites, by name, in the order given. */
function sites(...names: string[]): AnySiteConfig[] {
  return names.map((name) => config.sites.find((site) => site.site === name)!);
}

/** A grab in threads, and everything it said. */
async function grabbed(
  names: string[],
  options: {
    threads?: number;
    siteConcurrency?: number;
    abortOn?: (event: EpgEventInput) => boolean;
    /** How long a site's state takes to save, as it does in a store across a network. */
    savingMs?: number;
  } = {},
) {
  const cache = new CacheManager({ driver: new MemoryCacheDriver() });
  const store: CacheStore = {
    getMeta: (key) => cache.getMeta(key),
    getMetas: (keys) => cache.getMetas(keys),
    read: (key) => cache.read(key),
    write: (key, programmes, meta) => cache.write(key, programmes, meta),
    delete: (key) => cache.delete(key),
    prune: (prune) => cache.prune(prune),
    getState: (site, key) => cache.getState(site, key),
    setState: async (site, key, data, meta) => {
      await new Promise((resolve) => setTimeout(resolve, options.savingMs ?? 0));

      return cache.setState(site, key, data, meta);
    },
    close: () => cache.close(),
  };
  const events: EpgEventInput[] = [];
  const stop = new AbortController();
  const summary = await grab(sites(...names), {
    cache: store,
    now: NOW,
    startDay: DAY,
    days: 1,
    threads: options.threads ?? 2,
    configModule: CONFIG,
    ...(options.siteConcurrency === undefined ? {} : { siteConcurrency: options.siteConcurrency }),
    signal: stop.signal,
    reporter: (event) => {
      events.push(event);

      if (options.abortOn?.(event)) {
        stop.abort(new Error('run cancelled'));
      }
    },
  });

  return { cache, events, summary };
}

describe('sites in worker threads', () => {
  it('grabs each site in a thread, into the run’s cache', async () => {
    const { cache, summary } = await grabbed(['offset.example', 'circular.example']);

    expect(summary).toMatchObject({ fetched: 2, failed: 0, sitesFailed: 0 });

    const [programme] = (await cache.read({ site: 'offset.example', channelId: 'one', day: DAY }))!;

    expect(getXmltvOffset(programme!.start)).toBe(120);
  });

  it('lets a cancelled site wind down before the run answers', async () => {
    // Cancelled once the quick site has written its day and the slow one is
    // waiting on a request. The slow one then saves its state on the way out,
    // which takes a while: the run must neither kill it mid-way nor read its
    // summary before the site has finished saying what it did.
    const seen = new Set<string>();
    const { cache, events, summary } = await grabbed(['offset.example', 'slow.example'], {
      abortOn: (event) => {
        if (event.type === 'entry:fetched' || event.type === 'request:started') {
          seen.add(`${event.type} ${event.site}`);
        }

        return seen.has('entry:fetched offset.example') && seen.has('request:started slow.example');
      },
      savingMs: 100,
    });

    expect(summary.fetched).toBe(1);
    expect(summary.sitesFailed).toBe(0);
    expect(events.some((event) => event.type === 'site:failed')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'run:cancelled', fetched: 1 });

    // The slow site finished saying what it did before the run said it was
    // over — not in the run's wake, after its summary had been read.
    const done = events.findIndex(
      (event) => event.type === 'site:done' && event.site === 'slow.example',
    );

    expect(done).toBeGreaterThan(-1);
    expect(done).toBeLessThan(events.length - 1);
    // Saved on its way out, through a cache the cancel did not close on it.
    expect(await cache.getState('slow.example', StateKey.SITE)).toMatchObject({
      data: [['asked', true]],
    });
  });

  it('starts a fresh thread for the sites after one dies', async () => {
    // One site at a time, so the next is handed out after the first thread has
    // gone — and must not be handed to it.
    const { events, summary } = await grabbed(['crashing.example', 'offset.example'], {
      threads: 3,
      siteConcurrency: 1,
    });

    expect(summary).toMatchObject({ fetched: 1, sitesFailed: 1 });
    expect(events.find((event) => event.type === 'site:failed')).toMatchObject({
      site: 'crashing.example',
      error: { message: 'stray timer' },
    });
  });

  it('runs more sites than threads, sharing them', async () => {
    const { summary } = await grabbed(['offset.example', 'circular.example', 'channels.example'], {
      threads: 1,
    });

    expect(summary).toMatchObject({ fetched: 3, failed: 0, sitesFailed: 0 });
  });
});
