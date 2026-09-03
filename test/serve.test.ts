import { mkdtemp, rm } from 'node:fs/promises';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { CacheManager, MemoryCacheDriver } from '../src/cache/main.js';
import type { CacheStore } from '../src/cache/types.js';
import type { EpgConfig } from '../src/config.js';
import { serveGuide, type GuideServer } from '../src/serve/main.js';
import type { XmltvProgramme } from '../src/xmltv/types.js';
import { collect } from './reporting.js';

const NOW = new Date('2026-09-03T05:00:00.000Z');
const DAY = '2026-09-03';

function programme(channel: string, hour: number, title = 'Show'): XmltvProgramme {
  return {
    channel,
    start: new Date(`${DAY}T0${hour}:00:00.000Z`),
    title: [{ value: title }],
  };
}

/** A config over a cache held in memory, so a test needs nothing on disk. */
function configFor(channels: string[]): EpgConfig {
  return {
    sites: [
      {
        site: 'example.tv',
        channels: channels.map((id) => ({ xmltvId: id, siteId: id, name: id })),
        request: async () => ({}),
        parseDay: () => [],
      },
    ],
    days: 1,
    output: 'guide.xml',
  };
}

let servers: GuideServer[] = [];
let dirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.map((server) => server.close()));
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  servers = [];
  dirs = [];
});

async function serve(
  config: EpgConfig,
  cache: CacheStore,
  options: Parameters<typeof serveGuide>[1] = {},
): Promise<GuideServer> {
  // Port 0: the OS picks a free one, so tests never collide.
  const server = await serveGuide(config, { port: 0, now: NOW, cache, ...options });

  servers.push(server);

  return server;
}

type SeededCache = CacheManager & { seed: (grabbedAt: string) => Promise<void> };

function cacheWith(entries: Record<string, XmltvProgramme[]>): SeededCache {
  const cache = new CacheManager({ driver: new MemoryCacheDriver() });

  return Object.assign(cache, {
    seed: async (grabbedAt: string) => {
      for (const [channelId, programmes] of Object.entries(entries)) {
        await cache.write({ site: 'example.tv', channelId, day: DAY }, programmes, { grabbedAt });
      }
    },
  });
}

describe('serveGuide', () => {
  it('answers a poll that has the guide already with 304 and no body', async () => {
    const cache = cacheWith({ one: [programme('one', 6)] });
    await cache.seed('2026-09-03T04:00:00.000Z');

    const server = await serve(configFor(['one']), cache);
    const first = await fetch(server.url);
    const body = await first.text();

    expect(first.status).toBe(200);
    expect(body).toContain('<channel id="one">');
    expect(first.headers.get('etag')).toMatch(/^W\//);

    const again = await fetch(server.url, {
      headers: { 'if-none-match': first.headers.get('etag')! },
    });

    expect(again.status).toBe(304);
    expect(await again.text()).toBe('');
    // A 304 sends no body, so nothing may describe one.
    expect(again.headers.get('content-type')).toBeNull();
    // But it does carry the validators, which is how the next poll asks again.
    expect(again.headers.get('etag')).toBe(first.headers.get('etag'));
  });

  it('serves a guide with its channels in it on the poll right after a grab', async () => {
    // The regression this exists for: the fingerprint and the resolved channel
    // lists were once separate, and invalidating the lists on a changed
    // fingerprint left *this* request serving an empty document — once, right
    // after every grab, which is when a consumer is most likely to be asking.
    const cache = cacheWith({ one: [programme('one', 6)] });
    await cache.seed('2026-09-03T04:00:00.000Z');

    const server = await serve(configFor(['one']), cache, { revalidateMs: 0 });
    const before = await fetch(server.url);

    expect(await before.text()).toContain('<programme');

    // A grab lands: newer entries, so a new fingerprint.
    await cache.write({ site: 'example.tv', channelId: 'one', day: DAY }, [
      programme('one', 6),
      programme('one', 7, 'Later'),
    ]);

    const after = await fetch(server.url);
    const body = await after.text();

    expect(after.status).toBe(200);
    expect(after.headers.get('etag')).not.toBe(before.headers.get('etag'));
    expect(body).toContain('<channel id="one">');
    expect(body.match(/<programme/g)).toHaveLength(2);

    // And the one after it, which is the request that used to be fine.
    expect(await (await fetch(server.url)).text()).toBe(body);
  });

  it('tells a consumer holding an old validator to take the guide again', async () => {
    const cache = cacheWith({ one: [programme('one', 6)] });
    await cache.seed('2026-09-03T04:00:00.000Z');

    const server = await serve(configFor(['one']), cache, { revalidateMs: 0 });
    const first = await fetch(server.url);
    const stale = first.headers.get('etag')!;

    await cache.write({ site: 'example.tv', channelId: 'one', day: DAY }, [programme('one', 8)]);

    const asked = await fetch(server.url, { headers: { 'if-none-match': stale } });

    expect(asked.status).toBe(200);
    // XMLTV's own date form, which is what a guide carries.
    expect(await asked.text()).toContain('start="20260903080000');
  });

  it('answers If-Modified-Since as well, to the second', async () => {
    const cache = cacheWith({ one: [programme('one', 6)] });
    await cache.seed('2026-09-03T04:00:00.000Z');

    const server = await serve(configFor(['one']), cache);
    const first = await fetch(server.url);
    const lastModified = first.headers.get('last-modified')!;

    expect(
      (await fetch(server.url, { headers: { 'if-modified-since': lastModified } })).status,
    ).toBe(304);
    expect(
      (
        await fetch(server.url, {
          headers: { 'if-modified-since': 'Thu, 01 Jan 2026 00:00:00 GMT' },
        })
      ).status,
    ).toBe(200);
  });

  it('compresses when the client says it can, and not otherwise', async () => {
    const cache = cacheWith({ one: [programme('one', 6)] });
    await cache.seed('2026-09-03T04:00:00.000Z');

    const server = await serve(configFor(['one']), cache);

    // `fetch` decodes gzip itself, which is the assertion worth making: a real
    // client is handed a guide, and the header it did that on says gzip.
    const gzipped = await fetch(server.url, { headers: { 'accept-encoding': 'gzip' } });

    expect(gzipped.headers.get('content-encoding')).toBe('gzip');
    expect(await gzipped.text()).toContain('<programme');

    // And that the bytes on the wire really were compressed, which a decoding
    // client cannot show: read them without one.
    const raw = await new Promise<Buffer>((resolve, reject) => {
      get(server.url, { headers: { 'accept-encoding': 'gzip' } }, (response) => {
        const parts: Buffer[] = [];

        response.on('data', (part: Buffer) => parts.push(part));
        response.on('end', () => resolve(Buffer.concat(parts)));
        response.on('error', reject);
      }).on('error', reject);
    });

    expect(gunzipSync(raw).toString('utf8')).toContain('<programme');

    const plain = await fetch(server.url, { headers: { 'accept-encoding': 'identity' } });

    expect(plain.headers.get('content-encoding')).toBeNull();
    expect(await plain.text()).toContain('<programme');
  });

  it('answers HEAD with the headers and no guide', async () => {
    const cache = cacheWith({ one: [programme('one', 6)] });
    await cache.seed('2026-09-03T04:00:00.000Z');

    const server = await serve(configFor(['one']), cache);
    const head = await fetch(server.url, { method: 'HEAD' });

    expect(head.status).toBe(200);
    expect(head.headers.get('etag')).toMatch(/^W\//);
    expect(await head.text()).toBe('');
  });

  it('refuses another method and another path, saying which are allowed', async () => {
    const cache = cacheWith({});
    const server = await serve(configFor(['one']), cache);

    const posted = await fetch(server.url, { method: 'POST' });

    expect(posted.status).toBe(405);
    expect(posted.headers.get('allow')).toBe('GET, HEAD');

    const elsewhere = await fetch(new URL('/somewhere', server.url));

    expect(elsewhere.status).toBe(404);
  });

  it('serves a path of its own when asked for one', async () => {
    const cache = cacheWith({});
    const server = await serve(configFor(['one']), cache, { path: '/xmltv' });

    expect(server.url.endsWith('/xmltv')).toBe(true);
    expect((await fetch(server.url)).status).toBe(200);
    expect((await fetch(new URL('/guide.xml', server.url))).status).toBe(404);
  });

  it('says what it answered, and tells a 304 from a 200 in the saying', async () => {
    const cache = cacheWith({ one: [programme('one', 6)] });
    await cache.seed('2026-09-03T04:00:00.000Z');

    const report = collect();
    const server = await serve(configFor(['one']), cache, { reporter: report.reporter });
    const first = await fetch(server.url);

    await first.text();
    await fetch(server.url, { headers: { 'if-none-match': first.headers.get('etag')! } });

    expect(report.of('serve:started')[0]).toMatchObject({ url: server.url });
    expect(report.of('serve:response').map((event) => event.status)).toEqual([200, 304]);
  });

  it('stops when its signal fires, and again is not an error', async () => {
    const cache = cacheWith({});
    const controller = new AbortController();
    const server = await serve(configFor(['one']), cache, { signal: controller.signal });

    controller.abort();
    await server.closed;

    // Closing a closed server is what a caller does when it is not sure, and
    // must not be a second thing to handle.
    await expect(server.close()).resolves.toBeUndefined();
    await expect(fetch(server.url)).rejects.toThrow();
  });

  it('leaves a cache it was handed open, and closes the one it opened', async () => {
    const cache = cacheWith({});
    const server = await serve(configFor(['one']), cache);

    await server.close();

    // Still usable: it was the caller's, and nothing here closes what it did
    // not open — the same rule a run keeps.
    await expect(
      cache.write({ site: 'example.tv', channelId: 'one', day: DAY }, [programme('one', 6)]),
    ).resolves.toBeUndefined();
  });

  it('reads the cache once for a burst of polls', async () => {
    const cache = cacheWith({ one: [programme('one', 6)] });
    await cache.seed('2026-09-03T04:00:00.000Z');

    let sweeps = 0;
    // Written out rather than spread: a `CacheManager`'s methods live on its
    // prototype, so `{ ...cache }` would copy none of them — which typechecking
    // says and a test exercising only two of them would not.
    const counted: CacheStore = {
      getMeta: (key) => cache.getMeta(key),
      getMetas: async (keys) => {
        sweeps++;

        return cache.getMetas(keys);
      },
      read: (key) => cache.read(key),
      write: (key, programmes, meta) => cache.write(key, programmes, meta),
      delete: (key) => cache.delete(key),
      prune: (options) => cache.prune(options),
      getState: (site, key) => cache.getState(site, key),
      setState: (site, key, data, meta) => cache.setState(site, key, data, meta),
      close: () => cache.close(),
    };

    const server = await serve(configFor(['one']), counted, { revalidateMs: 10_000 });

    await Promise.all(Array.from({ length: 8 }, async () => (await fetch(server.url)).text()));

    // One sweep, not eight: what the polls arriving together would each have
    // started is the storm the in-flight promise exists to prevent.
    expect(sweeps).toBe(1);
  });
});

describe('serveGuide over a cache on disk', () => {
  it('opens and closes a cache of its own when handed none', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'epg-serve-'));

    dirs.push(dir);

    const config: EpgConfig = { ...configFor(['one']), cache: { dir: join(dir, 'cache') } };
    const server = await serveGuide(config, { port: 0, now: NOW });

    servers.push(server);

    const response = await fetch(server.url);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<channel id="one">');
  });
});
