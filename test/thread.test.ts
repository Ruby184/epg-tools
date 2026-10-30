import { getEventListeners } from 'node:events';
import { availableParallelism } from 'node:os';
import { MessageChannel } from 'node:worker_threads';
import PQueue from 'p-queue';
import { describe, expect, it, vi } from 'vitest';
import { CacheManager, MemoryCacheDriver } from '../src/cache/main.js';
import type { CacheStore } from '../src/cache/types.js';
import { EVENT_TYPES, type EpgEventInput, type RequestCounts } from '../src/core/events.js';
import { build } from '../src/build.js';
import { grab, StateKey } from '../src/grabber/main.js';
import type { Run } from '../src/grabber/site-run.js';
import {
  hostSite,
  RemoteCache,
  SiteNotRunError,
  SiteThreads,
  threadCount,
  workSite,
  type SiteThreadData,
} from '../src/grabber/thread.js';
import { addRequests, openSession, requestsObject } from '../src/grabber/session.js';
import { SiteClock } from '../src/grabber/clock.js';
import { CountReader, CountWriter, sharedCounts } from '../src/grabber/shared-counts.js';
import { getXmltvOffset } from '../src/xmltv/main.js';

// Both halves of a site in a thread, talking over a `MessageChannel` in this
// one: everything a worker adds is only that it runs somewhere else. Starting
// real ones — a pool, a cancel, a thread that dies — is `threads.test.ts`,
// which runs under the flags a worker needs to load the source.

const NOW = new Date('2026-07-17T12:00:00.000Z');
const DAY = '2026-07-17';
const CONFIG = new URL('./fixtures/thread.config.ts', import.meta.url).href;

/** The run's side: a real store, and every event it is told. */
function hosting(
  cache: CacheStore,
  signal?: AbortSignal,
): { run: Run; events: EpgEventInput[]; requested: Array<[string, RequestCounts]> } {
  const events: EpgEventInput[] = [];
  const requested: Array<[string, RequestCounts]> = [];
  const run: Run = {
    defaults: { days: 1 },
    cache,
    now: NOW,
    grabbedAt: NOW.toISOString(),
    startDay: DAY,
    timeZone: 'UTC',
    emit: Object.assign(
      (event: EpgEventInput) => {
        events.push(event);
      },
      { hears: new Set(EVENT_TYPES) },
    ),
    ...(signal ? { signal } : {}),
    localWork: new PQueue({ concurrency: 4 }),
    enqueue: (queue, task, options = {}) =>
      queue.add(task, { ...options, ...(signal ? { signal } : {}) }),
    tally: { fetched: 0, empty: 0, fromCache: 0, unchanged: 0, failed: 0, sitesFailed: 0 },
    requested: (label, done) => {
      requested.push([label, done]);
    },
    spent: undefined,
  };

  return { run, events, requested };
}

function started(site: string, extra: Partial<SiteThreadData> = {}): SiteThreadData {
  return {
    module: CONFIG,
    site,
    now: NOW.toISOString(),
    grabbedAt: NOW.toISOString(),
    startDay: DAY,
    timeZone: 'UTC',
    defaults: { days: 1 },
    localConcurrency: 4,
    counts: sharedCounts(),
    hears: EVENT_TYPES,
    ...extra,
  };
}

/**
 * Hold the conversation to its end, hang up as the run would once every site
 * is done, and let go of the channel either way — handing `heard` every
 * message the thread sends the run.
 */
async function converse(
  run: Run,
  data: SiteThreadData,
  heard?: (message: { kind: string }) => void,
): Promise<void> {
  const { port1, port2 } = new MessageChannel();

  if (heard !== undefined) {
    port1.on('message', heard);
  }

  try {
    const [hangUp] = await Promise.all([
      hostSite(port1, run, { site: data.site, counts: new CountReader(data.counts) }),
      workSite(port2, data),
    ]);

    hangUp();
  } finally {
    port1.close();
    port2.close();
  }
}

/** The run's end of a conversation the test holds the thread's end of. */
function hostOnly(
  run: Run,
  options: { whenLost?: (lose: (error: unknown) => void) => () => void } = {},
): {
  hosted: Promise<() => void>;
  reader: CountReader;
  writer: CountWriter;
  /** The thread's end, and the run's. */
  port: MessagePort;
  host: MessagePort;
  close: () => void;
} {
  const { port1, port2 } = new MessageChannel();
  const reader = new CountReader();
  const hosted = hostSite(port1, run, { site: 'lost.example', counts: reader, ...options });
  // As the thread would name each slot.
  const writer = new CountWriter(reader.buffer, (index, slot) => {
    port2.postMessage({ kind: 'slot', index, slot });
  });

  return {
    hosted,
    reader,
    writer,
    port: port2,
    host: port1,
    close: () => {
      port1.close();
      port2.close();
    },
  };
}

/** What the run was told, label by label, in the order each was first told. */
function toldOf(requested: Array<[string, RequestCounts]>): Record<string, RequestCounts> {
  const told = new Map<string, RequestCounts>();

  for (const [label, done] of requested) {
    addRequests(told, label, done);
  }

  return requestsObject(told);
}

/** A `site:done` as a thread sends it, saying `fetched` channel-days. */
function siteDoneOf(fetched: number): EpgEventInput {
  return {
    type: 'site:done',
    site: 'lost.example',
    requests: 0,
    ms: 5,
    requestMs: 0,
    msBy: { source: 0, held: 0, rateLimit: 0, working: 0, queued: 0, other: 5 },
    requestsBy: {},
    fetched,
    empty: 0,
    fromCache: 0,
    unchanged: 0,
    failed: 0,
    sitesFailed: 0,
  };
}

/** Listen for the thread going, handing the test what says it went. */
function losing(): {
  whenLost: (lose: (error: unknown) => void) => () => void;
  lose: (error: unknown) => void;
} {
  let told: (error: unknown) => void = () => {};

  return {
    whenLost: (lose) => {
      told = lose;

      return () => {};
    },
    lose: (error) => told(error),
  };
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

  it('sends a channel-day encoded for a store that names its codec', async () => {
    const cache = new CacheManager({ driver: new MemoryCacheDriver() });
    const { run } = hosting(cache);

    await converse(run, started('offset.example', { codec: 'json' }));

    const [programme] = (await cache.read({ site: 'offset.example', channelId: 'one', day: DAY }))!;

    expect(getXmltvOffset(programme!.start)).toBe(120);
    expect(
      (await cache.getMeta({ site: 'offset.example', channelId: 'one', day: DAY }))?.programmeCount,
    ).toBe(1);
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

    run.emit = Object.assign(
      (event: EpgEventInput) => {
        said(event);

        // Once the request is waiting, which it does until it is told to stop.
        if (event.type === 'request:started') {
          controller.abort(new Error('run cancelled'));
        }
      },
      { hears: said.hears },
    );

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

  it('counts in memory the run reads, rather than in a message a count', async () => {
    const cache = new CacheManager({ driver: new MemoryCacheDriver() });
    const { run } = hosting(cache);
    const kinds: string[] = [];
    const data = started('offset.example');

    await converse(run, data, (message) => kinds.push(message.kind));

    // In the run's tally once the run hung up — and no count crossed.
    expect(run.tally).toMatchObject({ fetched: 1, failed: 0 });
    expect(kinds).not.toContain('count');
    // Nor that it began: that is in memory too.
    expect(new CountReader(data.counts).began()).toBeGreaterThan(0);
  });

  it('lets go of the port its cache was asked through once the site is done', async () => {
    const cache = new CacheManager({ driver: new MemoryCacheDriver() });
    const { run } = hosting(cache);
    const { port1, port2 } = new MessageChannel();
    const data = started('offset.example');

    try {
      const [hangUp] = await Promise.all([
        hostSite(port1, run, { site: data.site, counts: new CountReader(data.counts) }),
        workSite(port2, data),
      ]);

      // The cache's listeners gone with it, and only the one for a cancel left,
      // for a request the site did not wait for — until the run hangs up.
      expect(port2.listenerCount('message')).toBe(1);
      expect(port2.listenerCount('close')).toBe(1);
      hangUp();

      const closing = new Promise((resolve) => port2.once('close', resolve));

      port1.close();
      await closing;

      // And that one let go of too, once it has.
      expect(port2.listenerCount('message')).toBe(0);
      expect(port2.listenerCount('close')).toBe(0);
    } finally {
      port1.close();
      port2.close();
    }
  });

  it('lets what its site left asking finish, so the thread’s parsing is not short a slot', async () => {
    for (const end of ['answered', 'hung up'] as const) {
      const { port1, port2 } = new MessageChannel();
      const localWork = new PQueue({ concurrency: 4 });
      const held: number[] = [];
      let metas = 0;
      let said: string | undefined;

      // The run's side, by hand: the first channel's read fails, and the
      // other's is held — so the site fails with a call still out.
      port1.on('message', (message: { kind: string; id?: number; op?: string }) => {
        if (message.kind === 'done' || message.kind === 'failed') {
          said = message.kind;
        }

        if (message.kind !== 'cache') {
          return;
        }

        if (message.op === 'getMetas' && metas++ === 0) {
          port1.postMessage({
            kind: 'answer',
            id: message.id,
            error: { kind: 'error', name: 'Error', message: 'the store fell over' },
          });
        } else if (message.op === 'getMetas') {
          held.push(message.id!);
        } else {
          port1.postMessage({ kind: 'answer', id: message.id, value: undefined });
        }
      });

      let finished = false;
      const working = workSite(
        port2,
        started('offset.example', {
          channels: [
            { xmltvId: 'one', siteId: '1' },
            { xmltvId: 'two', siteId: '2' },
          ],
        }),
        localWork,
      ).then(() => {
        finished = true;
      });

      try {
        await vi.waitFor(() => expect(said).toBe('done'));
        await new Promise((resolve) => setImmediate(resolve));

        // Done, and still waiting on what it asked.
        expect(held.length).toBeGreaterThan(0);
        expect(finished).toBe(false);

        if (end === 'answered') {
          for (const id of held) {
            port1.postMessage({ kind: 'answer', id, value: [] });
          }
        } else {
          port1.close();
        }

        await working;

        // Every slot of the thread's parsing let go, for the sites after —
        // once what held them has finished, which is a few turns on.
        await vi.waitFor(() => expect(localWork.pending).toBe(0));
        expect(localWork.size).toBe(0);
      } finally {
        port1.close();
        port2.close();
      }
    }
  });

  it('answers what is asked of the cache until it is closed, and refuses what is asked after', async () => {
    const { port1, port2 } = new MessageChannel();
    const asked: number[] = [];

    port1.on('message', (message: { kind: string; id: number }) => {
      if (message.kind === 'cache') {
        asked.push(message.id);
      }
    });

    const cache = new RemoteCache(port2, undefined);

    try {
      const first = cache.getState('a.tv', 'one');

      await vi.waitFor(() => expect(asked).toHaveLength(1));

      let closed = false;
      const closing = cache.close().then(() => {
        closed = true;
      });
      // Asked while it closes, as what waits on the first may as it finishes.
      const second = cache.getState('a.tv', 'two');

      port1.postMessage({ kind: 'answer', id: asked[0], value: 'one' });
      await expect(first).resolves.toBe('one');
      await vi.waitFor(() => expect(asked).toHaveLength(2));
      expect(closed).toBe(false);

      port1.postMessage({ kind: 'answer', id: asked[1], value: 'two' });
      await expect(second).resolves.toBe('two');
      await closing;

      // After: refused at once, rather than sent and never answered.
      await expect(cache.getState('a.tv', 'three')).rejects.toThrow(
        'asked after the site was done with it',
      );
      expect(asked).toHaveLength(2);
      expect(port2.listenerCount('message')).toBe(0);
      expect(port2.listenerCount('close')).toBe(0);
    } finally {
      port1.close();
      port2.close();
    }
  });

  it('lets go of a call no thread could be handed, as of one answered', async () => {
    const { port1, port2 } = new MessageChannel();
    const cache = new RemoteCache(port2, undefined);

    try {
      // What a site keeps, holding what no thread can be handed.
      await expect(
        cache.setState('a.tv', 'state', { data: [['retry', () => {}]] } as never),
      ).rejects.toThrow();
      // Nothing left asking, so closing is done at once.
      await cache.close();
    } finally {
      port1.close();
      port2.close();
    }
  });

  it('waits, as it closes, for what an answer lets its caller go on to ask', async () => {
    const { port1, port2 } = new MessageChannel();

    // The run's side, answering at once.
    port1.on('message', (message: { kind: string; id: number; op: string }) => {
      if (message.kind === 'cache') {
        port1.postMessage({
          kind: 'answer',
          id: message.id,
          value: message.op === 'read' ? [] : undefined,
        });
      }
    });

    const cache = new RemoteCache(port2, undefined);
    const key = { site: 'a.tv', channelId: 'one', day: DAY };

    try {
      // As a channel-day is added to: read, then the write it was for.
      const appending = (async () => {
        await cache.read(key);
        await cache.write(key, [], {});

        return 'written';
      })();

      await new Promise((resolve) => setImmediate(resolve));

      const closing = cache.close();

      await expect(appending).resolves.toBe('written');
      await closing;
    } finally {
      port1.close();
      port2.close();
    }
  });

  it('refuses what is asked of the cache once the run has hung up', async () => {
    const { port1, port2 } = new MessageChannel();
    const cache = new RemoteCache(port2, undefined);
    const closing = new Promise((resolve) => port2.once('close', resolve));

    port1.close();
    await closing;

    // Sent to nobody, it would wait for ever — and so would closing the cache.
    await expect(cache.getState('a.tv', 'one')).rejects.toThrow(
      'asked after the site was done with it',
    );
    await cache.close();
  });

  it('tells the run what the site asked, from the memory its thread counted it in', async () => {
    const cache = new CacheManager({ driver: new MemoryCacheDriver() });
    const { run, requested } = hosting(cache);
    const kinds: string[] = [];

    // Every message the thread sends the run, by kind.
    await converse(run, started('offset.example'), (message) => kinds.push(message.kind));

    expect(toldOf(requested)).toEqual({
      request: {
        requests: 1,
        requestMs: expect.any(Number),
        waitedMs: expect.any(Number),
        failed: {},
      },
    });
    // One name, for the label's two counts — and no message for the request
    // itself.
    expect(kinds.filter((kind) => kind === 'slot')).toHaveLength(1);
    expect(kinds).not.toContain('requested');
  });

  it('says an error whose cause no thread can be handed, rather than failing the site', async () => {
    const cache = new CacheManager({ driver: new MemoryCacheDriver() });
    const { run, events } = hosting(cache);

    await converse(run, started('odd-cause.example'));

    // As JSON keeps it, and the site's turn said to its end.
    expect(events.find((event) => event.type === 'request:failed')).toMatchObject({
      error: { message: 'the source said no', cause: { status: 'busy' } },
    });
    expect(events.at(-1)).toMatchObject({ type: 'site:done', failed: 1, sitesFailed: 0 });
  });

  it('says a site failed for what cannot be read, as what can be said of it', async () => {
    const cache = new CacheManager({ driver: new MemoryCacheDriver() });
    const { run, events } = hosting(cache);

    await converse(run, started('unreadable.example'));

    // Said as a site whose list failed — not as one that threw after it was done.
    expect(events.filter((event) => event.type === 'site:warning')).toEqual([]);
    expect(events.find((event) => event.type === 'site:failed')).toMatchObject({
      error: { message: 'no lineup' },
    });
    expect(events.at(-1)).toMatchObject({ type: 'site:done', sitesFailed: 1 });
  });

  it('tells the run what a request that failed cost, though the site wrote nothing', async () => {
    const cache = new CacheManager({ driver: new MemoryCacheDriver() });
    const { run, requested } = hosting(cache);

    // One request, which fails — the error made plain to cross, its cause
    // with it — and leaves nothing to write.
    await converse(run, started('failing.example'));

    expect(toldOf(requested)).toEqual({
      request: {
        requests: 1,
        requestMs: expect.any(Number),
        waitedMs: expect.any(Number),
        failed: { network: 1 },
      },
    });
  });

  it('says a site it never began on never ran', async () => {
    const cache = new CacheManager({ driver: new MemoryCacheDriver() });
    const { run } = hosting(cache);

    // Not in the module its thread reads: refused before anything of it ran.
    const refused = await converse(run, started('nowhere.example')).catch(
      (error: unknown) => error,
    );

    expect(refused).toBeInstanceOf(SiteNotRunError);
    expect((refused as SiteNotRunError).cause).toMatchObject({
      message: expect.stringContaining('has no site "nowhere.example"'),
    });
  });

  it('says a site that threw out of its turn failed, once it had begun', async () => {
    const cache = new CacheManager({ driver: new MemoryCacheDriver() });
    const { run, events } = hosting(cache);
    const { hosted, writer, port, close } = hostOnly(run);

    try {
      writer.begin();
      writer.count('fetched', 1);
      port.postMessage({
        kind: 'failed',
        error: { kind: 'error', name: 'Error', message: 'boom' },
      });

      // Said here rather than rejected, for the run to say again.
      (await hosted)();

      expect(events.map((event) => event.type)).toEqual(['site:failed', 'site:done']);
      expect(events[0]).toMatchObject({ error: { message: 'boom' } });
      expect(events[1]).toMatchObject({ fetched: 1, sitesFailed: 1 });
      expect(run.tally).toMatchObject({ fetched: 1, sitesFailed: 1 });
    } finally {
      close();
    }
  });

  it('says what a site threw, once, before or after it was done — not that its thread went', async () => {
    const boom = { kind: 'failed', error: { kind: 'error', name: 'Error', message: 'boom' } };
    const cache = new CacheManager({ driver: new MemoryCacheDriver() });
    const before = hosting(cache);
    const after = hosting(cache);
    const failing = hostOnly(before.run);
    const finished = hostOnly(after.run);

    try {
      // Counted itself failed, then threw before its `site:done`.
      failing.writer.begin();
      failing.writer.count('sitesFailed', 1);
      failing.port.postMessage(boom);
      (await failing.hosted)();

      expect(before.events.map((event) => event.type)).toEqual(['site:warning', 'site:done']);
      expect(before.events[0]).toMatchObject({ message: 'it threw before it was done: boom' });
      expect(before.run.tally.sitesFailed).toBe(1);

      // All of it said, then threw.
      finished.writer.begin();
      finished.port.postMessage({ kind: 'event', event: siteDoneOf(1) });
      finished.port.postMessage(boom);
      (await finished.hosted)();

      expect(after.events.map((event) => event.type)).toEqual(['site:done', 'site:warning']);
      expect(after.events[1]).toMatchObject({ message: 'it threw after it was done: boom' });
      expect(after.run.tally.sitesFailed).toBe(0);
    } finally {
      failing.close();
      finished.close();
    }
  });

  it('says a site never ran whose thread was lost before it began on it', async () => {
    const cache = new CacheManager({ driver: new MemoryCacheDriver() });
    const { run, events } = hosting(cache);
    const { whenLost, lose } = losing();
    const { hosted, port, close } = hostOnly(run, { whenLost });

    try {
      const failed = hosted.catch((error: unknown) => error);

      lose(new Error('the thread exited'));
      port.close();

      expect(await failed).toBeInstanceOf(SiteNotRunError);
      expect(await failed).toMatchObject({ cause: { message: 'the thread exited' } });
      // Left to the run, which says it as a site that never ran.
      expect(events).toEqual([]);
    } finally {
      close();
    }
  });

  it('says why a site never ran, though its thread went for another site straight after', async () => {
    const cache = new CacheManager({ driver: new MemoryCacheDriver() });
    const { run, events } = hosting(cache);
    const { whenLost, lose } = losing();
    const { hosted, port, close } = hostOnly(run, { whenLost });

    try {
      const failed = hosted.catch((error: unknown) => error);

      // Said by the thread, and then the thread gone — word of which may be
      // heard first.
      port.postMessage({
        kind: 'event',
        event: { type: 'site:warning', site: 'lost.example', message: 'first' },
      });
      port.postMessage({
        kind: 'failed',
        error: { kind: 'error', name: 'TypeError', message: 'no request for it' },
      });
      lose(new Error('another site crashed the thread'));
      port.close();

      // Its own reason, and what it said before it.
      expect(await failed).toMatchObject({ cause: { message: 'no request for it' } });
      expect(events).toEqual([expect.objectContaining({ type: 'site:warning', message: 'first' })]);
    } finally {
      close();
    }
  });

  it('says a site its thread lost part way failed, with all it had counted', async () => {
    const cache = new CacheManager({ driver: new MemoryCacheDriver() });
    const { run, events, requested } = hosting(cache);
    const { whenLost, lose } = losing();
    const { hosted, writer, port, close } = hostOnly(run, { whenLost });

    try {
      // As the thread would: begun, a channel-day counted, two requests in
      // memory — the last of them counted just before the thread went.
      writer.begin(Date.now() - 50);
      writer.count('fetched', 1);
      writer.add('request', { requests: 1, requestMs: 30, waitedMs: 6, failed: {} });
      writer.add('request', { requests: 1, requestMs: 10, waitedMs: 0, failed: { 404: 1 } });
      // And where its time went, as its clock said it.
      writer.spend('source', 30.4);
      writer.spend('working', 9.6);
      lose(new Error('the thread exited'));
      port.close();

      // Said here, as the site would have said it.
      const hangUp = await hosted;

      expect(events.map((event) => event.type)).toEqual(['site:failed', 'site:done']);
      expect(events[0]).toMatchObject({ error: { message: 'the thread exited' } });
      expect(events[1]).toMatchObject({
        site: 'lost.example',
        fetched: 1,
        sitesFailed: 1,
        requests: 2,
        requestMs: 40,
        requestsBy: { request: { requests: 2, requestMs: 40, waitedMs: 6, failed: { 404: 1 } } },
      });

      const { ms, msBy } = events[1] as Extract<EpgEventInput, { type: 'site:done' }>;

      // From when it began — and what of it the thread had measured, the rest
      // of it other.
      expect(ms).toBeGreaterThanOrEqual(50);
      expect(msBy).toEqual({
        source: 30,
        held: 0,
        rateLimit: 0,
        working: 10,
        queued: 0,
        other: ms - 40,
      });
      // Its channel-days at once, as its turn ended, and its label's place —
      // what it asked once the run hangs up.
      expect(run.tally).toMatchObject({ fetched: 1, sitesFailed: 1 });
      expect(toldOf(requested)).toEqual({
        request: { requests: 0, requestMs: 0, waitedMs: 0, failed: {} },
      });

      hangUp();

      expect(toldOf(requested)).toEqual({
        request: { requests: 2, requestMs: 40, waitedMs: 6, failed: { 404: 1 } },
      });
      expect(run.tally).toMatchObject({ fetched: 1, sitesFailed: 1 });
    } finally {
      close();
    }
  });

  it('decides a site whose thread went, should its port never say it closed, a while after', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const cache = new CacheManager({ driver: new MemoryCacheDriver() });
    const { run, events } = hosting(cache);
    const { whenLost, lose } = losing();
    const { hosted, writer, port, close } = hostOnly(run, { whenLost });

    try {
      writer.begin();
      writer.count('fetched', 1);
      lose(new Error('the thread exited'));

      // Waiting on its port, which here never closes.
      await vi.advanceTimersByTimeAsync(4_000);
      expect(events).toEqual([]);

      await vi.advanceTimersByTimeAsync(1_000);

      const hangUp = await hosted;

      expect(events.map((event) => event.type)).toEqual(['site:failed', 'site:done']);

      // Its own `site:done`, should it arrive after all — before the run hangs
      // up — is not said twice.
      port.postMessage({ kind: 'event', event: siteDoneOf(1) });
      await new Promise((resolve) => setImmediate(resolve));
      expect(events.map((event) => event.type)).toEqual(['site:failed', 'site:done']);
      hangUp();
    } finally {
      vi.useRealTimers();
      close();
    }
  });

  it('tells the run what its site counted once, however often it is hung up on', async () => {
    const cache = new CacheManager({ driver: new MemoryCacheDriver() });
    const { run, requested } = hosting(cache);
    const { hosted, writer, port, close } = hostOnly(run);

    try {
      writer.begin();
      writer.add('request', { requests: 1, requestMs: 5, waitedMs: 0, failed: {} });
      port.postMessage({ kind: 'done' });

      const hangUp = await hosted;

      hangUp();
      hangUp();

      expect(toldOf(requested)).toEqual({
        request: { requests: 1, requestMs: 5, waitedMs: 0, failed: {} },
      });
    } finally {
      close();
    }
  });

  it('decides a site whose port closed with no word of its thread, a while after', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const cache = new CacheManager({ driver: new MemoryCacheDriver() });
    const { run, events } = hosting(cache);
    // Nothing to say its thread went: a host with no thread, here.
    const { hosted, writer, port, host, close } = hostOnly(run);

    try {
      writer.begin();

      const closing = new Promise((resolve) => host.once('close', resolve));

      port.close();
      await closing;
      await vi.advanceTimersByTimeAsync(5_000);
      (await hosted)();

      expect(events.map((event) => event.type)).toEqual(['site:failed', 'site:done']);
      expect(events[0]).toMatchObject({
        error: { message: "The site's thread hung up without a word" },
      });
    } finally {
      vi.useRealTimers();
      close();
    }
  });

  it('asks a config that failed to be read again, for the next site', async () => {
    const cache = new CacheManager({ driver: new MemoryCacheDriver() });
    const { run } = hosting(cache);
    const module = new URL('./fixtures/thread-flaky.config.ts', import.meta.url).href;

    const first = await converse(run, started('flaky.example', { module })).catch(
      (error: unknown) => error,
    );

    expect(first).toMatchObject({ cause: { message: 'the token service did not answer' } });

    // Answered this time, rather than the failure kept for good.
    await expect(converse(run, started('flaky.example', { module }))).resolves.toBeUndefined();
  });

  it('says once that a site failed, should its thread go after it said so itself', async () => {
    const cache = new CacheManager({ driver: new MemoryCacheDriver() });
    const { run, events } = hosting(cache);
    const { whenLost, lose } = losing();
    const { hosted, writer, port, close } = hostOnly(run, { whenLost });

    try {
      // Its list failed, which it counted and said — and its thread went as it
      // saved what it remembered, before its `site:done`.
      writer.begin();
      writer.count('sitesFailed', 1);
      lose(new Error('the thread exited'));
      port.close();
      (await hosted)();

      expect(events.map((event) => event.type)).toEqual(['site:warning', 'site:done']);
      expect(events[0]).toMatchObject({
        message: 'its thread went before it was done: the thread exited',
      });
      expect(events[1]).toMatchObject({ sitesFailed: 1 });
      expect(run.tally.sitesFailed).toBe(1);
    } finally {
      close();
    }
  });

  it('hears all a thread sent before it went, and makes up no `site:done` it sent', async () => {
    const cache = new CacheManager({ driver: new MemoryCacheDriver() });
    const { run, events } = hosting(cache);
    const { whenLost, lose } = losing();
    const { hosted, writer, port, close } = hostOnly(run, { whenLost });
    let settled = false;

    void hosted.then(() => {
      settled = true;
    });

    try {
      // Its `site:done` sent as it went — in no order Node promises against
      // word that it went.
      writer.begin();
      writer.count('fetched', 1);
      lose(new Error('the thread exited'));
      port.postMessage({ kind: 'event', event: siteDoneOf(1) });
      await new Promise((resolve) => setImmediate(resolve));

      // Not decided while its port is open: what it sent may be on its way.
      expect(settled).toBe(false);

      port.close();
      (await hosted)();

      expect(events.map((event) => event.type)).toEqual(['site:done']);
      expect(run.tally).toMatchObject({ fetched: 1, sitesFailed: 0 });
    } finally {
      close();
    }
  });

  it('tells the run what a thread had no slot for, said instead', async () => {
    const cache = new CacheManager({ driver: new MemoryCacheDriver() });
    const { run, requested } = hosting(cache);
    const { hosted, port, close } = hostOnly(run);

    try {
      port.postMessage({
        kind: 'requested',
        label: 'more',
        done: { requests: 1, requestMs: 4, waitedMs: 0, failed: {} },
      });
      port.postMessage({ kind: 'done' });

      const hangUp = await hosted;

      // As it was said, not once the run hangs up — and once.
      expect(requested).toEqual([['more', { requests: 1, requestMs: 4, waitedMs: 0, failed: {} }]]);
      hangUp();
      expect(toldOf(requested)).toEqual({
        more: { requests: 1, requestMs: 4, waitedMs: 0, failed: {} },
      });
    } finally {
      close();
    }
  });

  it('counts what its site asked after it was done, until the run hangs up', async () => {
    const cache = new CacheManager({ driver: new MemoryCacheDriver() });
    const { run, requested } = hosting(cache);
    const { hosted, writer, port, close } = hostOnly(run);

    try {
      writer.begin();
      writer.add('request', { requests: 1, requestMs: 5, waitedMs: 0, failed: {} });
      port.postMessage({ kind: 'done' });

      const hangUp = await hosted;

      // A request a parse did not wait for, answered after its site was done —
      // and under a label, and a failure, first named then.
      writer.add('detail', { requests: 1, requestMs: 0, waitedMs: 0, failed: {} });
      writer.add('detail', { requests: 0, requestMs: 7, waitedMs: 0, failed: { 503: 1 } });
      await new Promise((resolve) => setImmediate(resolve));

      // Each label in its place among the run's as it was first sent.
      expect(Object.keys(toldOf(requested))).toEqual(['request', 'detail']);

      hangUp();

      expect(toldOf(requested)).toEqual({
        request: { requests: 1, requestMs: 5, waitedMs: 0, failed: {} },
        detail: { requests: 1, requestMs: 7, waitedMs: 0, failed: { 503: 1 } },
      });
    } finally {
      close();
    }
  });

  it('leaves nothing listening to the run for a site its thread was gone before it began', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const cache = new CacheManager({ driver: new MemoryCacheDriver() });
    const controller = new AbortController();
    const { run } = hosting(cache, controller.signal);
    // Gone already when the site is handed it — whose port, handed to a
    // thread already gone, never says it closed.
    const { hosted, close } = hostOnly(run, {
      whenLost: (lose) => {
        lose(new Error('the thread exited'));

        return () => {};
      },
    });

    try {
      const failed = hosted.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(5_000);

      expect(await failed).toBeInstanceOf(SiteNotRunError);
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
      close();
    }
  });

  it('answers a call with an error, where what the store answered no thread can be handed', async () => {
    const cache = new CacheManager({ driver: new MemoryCacheDriver() });
    const { run } = hosting(cache);

    run.cache = { ...cache, getMeta: async () => ({ grabbedAt: NOW, retry() {} }) } as never;

    const { hosted, port, close } = hostOnly(run);

    try {
      const answered = new Promise<unknown>((resolve) => {
        port.on('message', (message: { kind: string }) => {
          if (message.kind === 'answer') {
            resolve(message);
          }
        });
      });

      port.postMessage({ kind: 'cache', id: 1, op: 'getMeta', args: [{}] });

      // Rather than an answer never sent, and a rejection nobody handles.
      expect(await answered).toMatchObject({
        id: 1,
        error: { message: "The run's cache answered with what no thread can be handed" },
      });

      port.postMessage({ kind: 'done' });
      (await hosted)();
    } finally {
      close();
    }
  });

  it('answers a channel-day written ahead of a sweep, encoded or not', async () => {
    const cache = new CacheManager({ driver: new MemoryCacheDriver() });
    const { run } = hosting(cache);

    // One slot, taken, so what is asked waits for it in turn.
    run.localWork = new PQueue({ concurrency: 1 });

    let unblock = (): void => {};

    void run.localWork.add(() => new Promise<void>((resolve) => (unblock = resolve)));

    const { hosted, port, close } = hostOnly(run);
    const key = { site: 'lost.example', channelId: 'one', day: DAY };

    try {
      const answered: number[] = [];
      const both = new Promise<void>((resolve) => {
        port.on('message', (message: { kind: string; id: number }) => {
          if (message.kind === 'answer' && answered.push(message.id) === 2) {
            resolve();
          }
        });
      });

      port.postMessage({ kind: 'cache', id: 1, op: 'getMetas', args: [[key]] });
      port.postMessage({
        kind: 'cache',
        id: 2,
        op: 'writeEncoded',
        args: [key, new TextEncoder().encode('[]'), 0, {}],
      });
      // Both waiting for the slot, before it is let go of.
      await vi.waitFor(() => expect(run.localWork.size).toBe(2));
      unblock();
      await both;

      // The write first, though asked for second.
      expect(answered).toEqual([2, 1]);

      port.postMessage({ kind: 'done' });
      (await hosted)();
    } finally {
      close();
    }
  });

  it('says how long a call waited for a slot, and nothing of one that never asks for one', async () => {
    const cache = new CacheManager({ driver: new MemoryCacheDriver() });
    const { run } = hosting(cache);

    run.localWork = new PQueue({ concurrency: 1 });

    let unblock = (): void => {};

    void run.localWork.add(() => new Promise<void>((resolve) => (unblock = resolve)));

    const { hosted, port, close } = hostOnly(run);

    try {
      const answers = new Map<number, { queuedMs?: number }>();
      const both = new Promise<void>((resolve) => {
        port.on('message', (message: { kind: string; id: number; queuedMs?: number }) => {
          if (message.kind === 'answer' && answers.set(message.id, message).size === 2) {
            resolve();
          }
        });
      });

      port.postMessage({ kind: 'cache', id: 1, op: 'getMeta', args: [{}] });
      port.postMessage({ kind: 'cache', id: 2, op: 'getState', args: ['lost.example', 'one'] });
      await vi.waitFor(() => expect(run.localWork.size).toBe(1));
      await new Promise((resolve) => setTimeout(resolve, 40));
      unblock();
      await both;

      expect(answers.get(1)!.queuedMs).toBeGreaterThanOrEqual(35);
      expect(answers.get(2)).not.toHaveProperty('queuedMs');

      port.postMessage({ kind: 'done' });
      (await hosted)();
    } finally {
      close();
    }
  });

  it('tells the site’s clock what a call waited for a slot on the run’s thread', async () => {
    const { port1, port2 } = new MessageChannel();

    // The run's side, answering after 40ms, 25 of them spent waiting for a slot.
    port1.on('message', (message: { kind: string; id: number }) => {
      if (message.kind === 'cache') {
        setTimeout(() => {
          port1.postMessage({ kind: 'answer', id: message.id, value: undefined, queuedMs: 25 });
        }, 40);
      }
    });

    const cache = new RemoteCache(port2, undefined);
    const clock = new SiteClock();

    try {
      cache.timeWith(clock);
      clock.turn(true);
      clock.queued();
      clock.started();
      await cache.getMeta({ site: 'a.tv', channelId: 'one', day: DAY });

      // Its work's time, less the 25 it waited — which is now waiting for a slot.
      expect(clock.spent().queued).toBeCloseTo(25, 1);
      expect(clock.spent().working).toBeGreaterThanOrEqual(10);

      // And a state call, answered on the run's thread with no slot: nothing
      // of it is waiting elsewhere.
      const before = clock.spent();

      await cache.getState('a.tv', 'one');
      expect(clock.spent().queued).toBe(before.queued);

      await cache.close();
    } finally {
      port1.close();
      port2.close();
    }
  });

  it('answers with an error whose cause no thread can be handed', async () => {
    const cache = new CacheManager({ driver: new MemoryCacheDriver() });
    const { run } = hosting(cache);

    run.cache = {
      ...cache,
      getMeta: () => Promise.reject(new Error('the store fell over', { cause: { retry() {} } })),
    } as never;

    const { hosted, port, close } = hostOnly(run);

    try {
      const answered = new Promise<unknown>((resolve) => {
        port.on('message', (message: { kind: string }) => {
          if (message.kind === 'answer') {
            resolve(message);
          }
        });
      });

      port.postMessage({ kind: 'cache', id: 1, op: 'getMeta', args: [{}] });

      // As JSON keeps its cause, rather than a throw on this side.
      expect(await answered).toMatchObject({
        id: 1,
        error: { kind: 'error', message: 'the store fell over', cause: {} },
      });

      port.postMessage({ kind: 'done' });
      (await hosted)();
    } finally {
      close();
    }
  });

  it('says why a config could not be read, with what no thread can be handed', async () => {
    const cache = new CacheManager({ driver: new MemoryCacheDriver() });
    const { run } = hosting(cache);
    const module = new URL('./fixtures/thread-unreadable.config.ts', import.meta.url).href;

    const refused = await converse(run, started('any.example', { module })).catch(
      (error: unknown) => error,
    );

    // As JSON keeps its cause, rather than a thread that went for it.
    expect(refused).toBeInstanceOf(SiteNotRunError);
    expect((refused as SiteNotRunError).cause).toMatchObject({
      message: 'the config could not be read',
      cause: { why: 'busy' },
    });
  });

  it('tells a thread the run was cancelled, with what no thread can be handed', async () => {
    const cache = new CacheManager({ driver: new MemoryCacheDriver() });
    const controller = new AbortController();
    const { run } = hosting(cache, controller.signal);
    const { hosted, port, close } = hostOnly(run);

    try {
      const told = new Promise<unknown>((resolve) => {
        port.on('message', (message: { kind: string }) => {
          if (message.kind === 'abort') {
            resolve(message);
          }
        });
      });

      controller.abort({ why: 'shutting down', retry() {} });

      expect(await told).toEqual({ kind: 'abort', reason: { why: 'shutting down' } });

      port.postMessage({ kind: 'done' });
      (await hosted)();
    } finally {
      close();
    }
  });

  it('adds what its list cost on this thread to its `site:done`, keeping all else it said', async () => {
    const cache = new CacheManager({ driver: new MemoryCacheDriver() });
    const { run, events } = hosting(cache);
    const settled = openSession({ site: 'lost.example' } as never, cache);

    await settled.send(async () => [], { label: 'channels' });

    const { port1, port2 } = new MessageChannel();
    const hosted = hostSite(port1, run, {
      site: 'lost.example',
      counts: new CountReader(),
      settled,
    });

    try {
      // With a field `site:done` does not have today, as a later one might.
      port2.postMessage({ kind: 'event', event: { ...siteDoneOf(1), later: 'kept' } });
      port2.postMessage({ kind: 'done' });
      (await hosted)();

      expect(events).toEqual([
        expect.objectContaining({
          type: 'site:done',
          later: 'kept',
          fetched: 1,
          requests: 1,
          requestsBy: { channels: expect.objectContaining({ requests: 1 }) },
        }),
      ]);
    } finally {
      settled.pacing.dispose();
      port1.close();
      port2.close();
    }
  });

  it('listens for its thread going only while its site runs', async () => {
    const cache = new CacheManager({ driver: new MemoryCacheDriver() });
    const { run } = hosting(cache);
    const listening = new Set<(error: unknown) => void>();
    const { hosted, port, close } = hostOnly(run, {
      whenLost: (lose) => {
        listening.add(lose);

        return () => listening.delete(lose);
      },
    });

    try {
      expect(listening.size).toBe(1);
      port.postMessage({ kind: 'done' });
      await hosted;

      // A thread outlives the run: nothing of this site is left listening.
      expect(listening.size).toBe(0);
    } finally {
      close();
    }
  });

  it('says a site it could not hand a thread never ran', async () => {
    const cache = new CacheManager({ driver: new MemoryCacheDriver() });
    const { run } = hosting(cache);
    const pool = SiteThreads.for(1, CONFIG);
    // A run default no thread can be handed.
    const unsendable = { ...run, defaults: { staleness: { refetchAll: () => true } as never } };

    await expect(
      pool.run(
        { site: 'offset.example', channels: [], request: async () => ({}), parseDay: () => [] },
        unsendable,
      ),
    ).rejects.toBeInstanceOf(SiteNotRunError);
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
    // As a site that never ran, since it never did.
    await expect(pool.run(site, run)).rejects.toThrow('an instance of Zone');
    await expect(pool.run(site, run)).rejects.toBeInstanceOf(SiteNotRunError);
  });
});
