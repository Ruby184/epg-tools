import { describe, expect, it } from 'vitest';
import { CacheManager, MemoryCacheDriver } from '../src/cache/main.js';
import type { CacheStore } from '../src/cache/types.js';
import type { EpgEventInput } from '../src/core/events.js';
import { grab, ReporterError, StateKey, type AnySiteConfig } from '../src/grabber/main.js';
import { grabWith } from '../src/grabber/grab.js';
import { openSession } from '../src/grabber/session.js';
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
    /** The kinds the run's reporter wants — every kind, where left out. */
    wants?: (type: EpgEventInput['type']) => boolean;
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
    // The manager itself, so a thread encodes for its store; a store wrapped
    // to save slowly is not one, and is sent lines — both ways are covered.
    cache: options.savingMs === undefined ? cache : store,
    now: NOW,
    startDay: DAY,
    days: 1,
    threads: options.threads ?? 2,
    configModule: CONFIG,
    ...(options.siteConcurrency === undefined ? {} : { siteConcurrency: options.siteConcurrency }),
    signal: stop.signal,
    reporter: Object.assign(
      (event: EpgEventInput) => {
        events.push(event);

        if (options.abortOn?.(event)) {
          stop.abort(new Error('run cancelled'));
        }
      },
      options.wants === undefined ? {} : { wants: options.wants },
    ),
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

  it('neither makes nor sends what the run’s reporter does not want', async () => {
    const unwanted = new Set(['site:note', 'request:started', 'request:done', 'entry:fetched']);
    const kinds = async (wants?: (type: string) => boolean): Promise<string[]> =>
      (await grabbed(['offset.example'], wants === undefined ? {} : { wants })).events.map(
        (event) => event.type,
      );

    // Each of them made, where it is wanted — the site logs as it parses.
    const all = new Set(await kinds());

    expect([...unwanted].filter((type) => !all.has(type))).toEqual([]);

    const some = await kinds((type) => !unwanted.has(type));

    expect(some.filter((type) => unwanted.has(type))).toEqual([]);
    expect(some).toContain('site:done');
  });

  it("counts each site's requests by kind over there, and sums them here", async () => {
    const { events } = await grabbed(['offset.example', 'failing.example']);

    const failing = events.find(
      (event) => event.type === 'site:done' && event.site === 'failing.example',
    ) as Extract<EpgEventInput, { type: 'site:done' }>;

    expect(failing.requestsBy).toEqual({
      request: {
        requests: 1,
        requestMs: expect.any(Number),
        waitedMs: expect.any(Number),
        failed: { network: 1 },
      },
    });
    // Read from what a thread said as each site finished.
    expect(events.at(-1)).toMatchObject({ type: 'grab:done' });
    expect((events.at(-1) as Extract<EpgEventInput, { type: 'grab:done' }>).requestsBy).toEqual({
      request: {
        requests: 2,
        requestMs: expect.any(Number),
        waitedMs: expect.any(Number),
        failed: { network: 1 },
      },
    });
  });

  it('says what a list settled on this thread cost, beside what the thread asked', async () => {
    const cache = new CacheManager({ driver: new MemoryCacheDriver() });
    const [found] = sites('channels.example');
    // As `build` leaves a site it settled: the list fetched through a session
    // of this thread, and the site handed on with the list it came to.
    const session = openSession(found!, cache);

    await session.send(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));

        return [{ xmltvId: 'own', siteId: 'own' }];
      },
      { label: 'channels' },
    );

    const events: EpgEventInput[] = [];

    try {
      await grabWith(
        [{ ...found!, channels: [{ xmltvId: 'own', siteId: 'own' }] } as AnySiteConfig],
        {
          cache,
          now: NOW,
          startDay: DAY,
          days: 1,
          threads: 1,
          configModule: CONFIG,
          reporter: (event) => events.push(event),
        },
        new Map([['channels.example', session]]),
      );
    } finally {
      session.pacing.dispose();
    }

    const counted = {
      channels: {
        requests: 1,
        requestMs: expect.any(Number),
        waitedMs: expect.any(Number),
        failed: {},
      },
      request: {
        requests: 1,
        requestMs: expect.any(Number),
        waitedMs: expect.any(Number),
        failed: {},
      },
    };
    const done = events.find((event) => event.type === 'site:done') as Extract<
      EpgEventInput,
      { type: 'site:done' }
    >;

    expect(done).toMatchObject({ requests: 2 });
    // Its list's time its own too, as in a run on one thread — and where it
    // went: the list out to the source here, beside what the thread measured.
    expect(done.ms).toBeGreaterThanOrEqual(50);
    expect(done.ms).toBeGreaterThanOrEqual(done.requestMs - 5);
    expect(done.msBy.source).toBeGreaterThanOrEqual(50);
    expect(Object.values(done.msBy).reduce((sum, ms) => sum + ms, 0)).toBe(done.ms);
    expect(done.requestsBy).toEqual(counted);
    expect(Object.keys(done.requestsBy)).toEqual(['channels', 'request']);
    expect((events.at(-1) as Extract<EpgEventInput, { type: 'grab:done' }>).requestsBy).toEqual(
      counted,
    );
  });

  it('says what a site its thread never ran cost, as a site on this thread would', async () => {
    class Zone {}

    const cache = new CacheManager({ driver: new MemoryCacheDriver() });
    // A list settled here, holding what no thread can be handed.
    const refused = {
      ...sites('offset.example')[0]!,
      channels: [{ xmltvId: 'one', siteId: '1', data: { zone: new Zone() } }],
    } as AnySiteConfig;
    const session = openSession(refused, cache);

    await session.send(async () => [], { label: 'channels' });

    const events: EpgEventInput[] = [];

    try {
      await grabWith(
        [refused],
        {
          cache,
          now: NOW,
          startDay: DAY,
          days: 1,
          threads: 1,
          configModule: CONFIG,
          reporter: (event) => events.push(event),
        },
        new Map([['offset.example', session]]),
      );
    } finally {
      session.pacing.dispose();
    }

    const ofSite = events.filter(
      (event) => event.type === 'site:failed' || event.type === 'site:done',
    );

    expect(ofSite.map((event) => event.type)).toEqual(['site:failed', 'site:done']);
    // What refused it, as it is — as a site on this thread says it, unwrapped.
    expect(ofSite[0]).toMatchObject({
      error: expect.objectContaining({
        name: 'TypeError',
        message: expect.stringContaining('an instance of Zone'),
      }),
    });
    expect(ofSite[1]).toMatchObject({
      sitesFailed: 1,
      requests: 1,
      requestsBy: { channels: { requests: 1, failed: {} } },
    });
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

  it('says a lost thread’s site, and rejects, though the reporter throws at it', async () => {
    const fellOver = new Error('the reporter fell over');
    const events: EpgEventInput[] = [];

    // Said from the thread's listener as it goes, where a throw that got out
    // would end the process rather than the run.
    const rejected = await grab(sites('crashing.example', 'offset.example'), {
      cache: new CacheManager({ driver: new MemoryCacheDriver() }),
      now: NOW,
      startDay: DAY,
      days: 1,
      threads: 2,
      configModule: CONFIG,
      reporter: (event) => {
        events.push(event);

        if (event.type === 'site:failed') {
          throw fellOver;
        }
      },
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(rejected).toBeInstanceOf(ReporterError);
    expect((rejected as ReporterError).thrown).toEqual([
      { error: fellOver, times: 1, at: { 'site:failed': 1 } },
    ]);
    expect(
      events
        .filter((event) => event.type === 'site:failed' || event.type === 'site:done')
        .map((event) => `${event.type} ${(event as { site: string }).site}`)
        .sort(),
    ).toEqual([
      'site:done crashing.example',
      'site:done offset.example',
      'site:failed crashing.example',
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'grab:done', fetched: 1, sitesFailed: 1 });
  });

  it('fails a site whose thread threw what is no error, with an error', async () => {
    const { events, summary } = await grabbed(['crashing-quietly.example', 'offset.example'], {
      threads: 3,
      siteConcurrency: 1,
    });

    // Its thread counted as gone, though nothing said why: the next site is
    // run elsewhere, and this one fails with an error that says so.
    expect(summary).toMatchObject({ fetched: 1, sitesFailed: 1 });
    expect(events.find((event) => event.type === 'site:failed')).toMatchObject({
      site: 'crashing-quietly.example',
      error: { message: expect.stringContaining('threw undefined') },
    });
  });

  it('says what a thread threw that is no error, an object’s fields and all', async () => {
    const { events } = await grabbed(['crashing-plainly.example'], { threads: 1 });

    expect(events.find((event) => event.type === 'site:failed')).toMatchObject({
      site: 'crashing-plainly.example',
      error: { message: "A site's thread threw { reason: 'out of cheese' }" },
    });
  });

  it('runs more sites than threads, sharing them', async () => {
    const { summary } = await grabbed(['offset.example', 'circular.example', 'channels.example'], {
      threads: 1,
    });

    expect(summary).toMatchObject({ fetched: 3, failed: 0, sitesFailed: 0 });
  });
});
