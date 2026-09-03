import { mkdtemp, rm } from 'node:fs/promises';
import { get } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('picks up a channel added by a grab that refreshed nothing else', async () => {
    // The fingerprint is taken over the grid already in hand, so a grab that
    // writes *only* a new channel touches no key it names and the etag does not
    // move. Ageing the resolved list out is what catches it; without that the
    // channel stayed invisible until the day window rolled at midnight.
    const cache = cacheWith({ one: [programme('one', 6)] });
    await cache.seed('2026-09-03T04:00:00.000Z');

    // A fetched list, so that resolving again is what produces a new one — a
    // plain array would be the same object the snapshot already holds, and
    // mutating it would hide the very staleness this is about.
    let lineup = ['one'];
    const config: EpgConfig = {
      ...configFor([]),
      sites: [
        {
          site: 'example.tv',
          channels: () => lineup.map((id) => ({ xmltvId: id, siteId: id, name: id })),
          request: async () => ({}),
          parseDay: () => [],
        },
      ],
    };

    const server = await serve(config, cache, { revalidateMs: 0, sitesMaxAgeMs: 0 });

    expect(await (await fetch(server.url)).text()).not.toContain('<channel id="two">');

    // A targeted grab: the new channel only, nothing rewritten for `one`, so
    // every key the held grid names still has the `grabbedAt` it had.
    lineup = ['one', 'two'];
    await cache.write({ site: 'example.tv', channelId: 'two', day: DAY }, [programme('two', 6)], {
      grabbedAt: '2026-09-03T04:00:00.000Z',
    });

    expect(await (await fetch(server.url)).text()).toContain('<channel id="two">');
  });

  it('picks the channel up at once when told to reload, ceiling or no ceiling', async () => {
    // The ceiling is a guess at how long a new channel may stay invisible; this
    // is the operator saying they know. `sitesMaxAgeMs` is an hour here, so
    // nothing but the reload can be what produced the second channel.
    const cache = cacheWith({ one: [programme('one', 6)] });
    await cache.seed('2026-09-03T04:00:00.000Z');

    let lineup = ['one'];
    const config: EpgConfig = {
      ...configFor([]),
      sites: [
        {
          site: 'example.tv',
          channels: () => lineup.map((id) => ({ xmltvId: id, siteId: id, name: id })),
          request: async () => ({}),
          parseDay: () => [],
        },
      ],
    };

    const reloadOn = new EventTarget();
    const server = await serve(config, cache, {
      revalidateMs: 0,
      sitesMaxAgeMs: 3_600_000,
      reloadOn,
    });

    expect(await (await fetch(server.url)).text()).not.toContain('<channel id="two">');

    lineup = ['one', 'two'];
    await cache.write({ site: 'example.tv', channelId: 'two', day: DAY }, [programme('two', 6)], {
      grabbedAt: '2026-09-03T04:00:00.000Z',
    });

    // Still nothing: the ceiling is an hour away and the fingerprint cannot see
    // a key the grid never named.
    expect(await (await fetch(server.url)).text()).not.toContain('<channel id="two">');

    const event = new Event('reload', { cancelable: true });

    // Cancelled, which is how the bin learns the reload was taken and that
    // SIGHUP should not fall through to ending the process.
    expect(reloadOn.dispatchEvent(event)).toBe(false);
    expect(await (await fetch(server.url)).text()).toContain('<channel id="two">');

    // And the method behind it, which is what the event target drives.
    lineup = ['one', 'two', 'three'];
    await cache.write({ site: 'example.tv', channelId: 'three', day: DAY }, [programme('two', 6)], {
      grabbedAt: '2026-09-03T04:00:00.000Z',
    });
    server.reload();

    expect(await (await fetch(server.url)).text()).toContain('<channel id="three">');
  });

  it('does not re-send a guide for a reload that changed nothing', async () => {
    // A stray signal must not cost every consumer a full guide: reloading asks
    // a question, and an unchanged answer keeps the etag it had.
    const cache = cacheWith({ one: [programme('one', 6)] });
    await cache.seed('2026-09-03T04:00:00.000Z');

    const server = await serve(configFor(['one']), cache, { revalidateMs: 0 });
    const first = await fetch(server.url);

    await first.text();
    server.reload();

    const again = await fetch(server.url, {
      headers: { 'if-none-match': first.headers.get('etag')! },
    });

    expect(again.status).toBe(304);
  });

  it('lets go of a reload target it was given when it closes', async () => {
    // The target is the caller's and may outlive the server — a listener left
    // on one would hold the whole closure, cache and all.
    const cache = cacheWith({});
    const reloadOn = new EventTarget();
    const server = await serve(configFor(['one']), cache, { reloadOn });

    await server.close();

    // Nothing is listening, so nothing cancels it.
    expect(reloadOn.dispatchEvent(new Event('reload', { cancelable: true }))).toBe(true);
  });

  it('calls a consumer hanging up a disconnect rather than a failure', async () => {
    // A reader that has seen enough, a proxy that timed out, a tab that closed.
    // Reported as a 500 it is an alarm about the ordinary — and a dashboard
    // that pages somebody for a browser refresh gets muted, which is worse.
    const ids = Array.from({ length: 2000 }, (_, i) => `c-${i}`);
    const cache = cacheWith(
      Object.fromEntries(
        ids.map((id) => [
          id,
          Array.from({ length: 20 }, (_, h) => ({
            channel: id,
            start: new Date(new Date(`${DAY}T00:00:00.000Z`).getTime() + h * 3600000),
            title: [{ value: `Show ${h} ${'x'.repeat(200)}` }],
          })),
        ]),
      ),
    );
    await cache.seed('2026-09-03T04:00:00.000Z');

    const report = collect();
    const server = await serve(configFor(ids), cache, { reporter: report.reporter });
    const url = new URL(server.url);

    // A raw socket that never reads, cut mid-guide.
    await new Promise<void>((resolve, reject) => {
      const socket = connect(Number(url.port), url.hostname, () => {
        socket.write(`GET ${url.pathname} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
        setTimeout(() => {
          socket.destroy();
          resolve();
        }, 150);
      });

      socket.on('error', reject);
    });

    await vi.waitFor(() => expect(report.of('serve:disconnected')).toHaveLength(1));

    expect(report.of('serve:failed')).toEqual([]);
    // And no 500 pinned on it either.
    expect(report.of('serve:response').map((event) => event.status)).not.toContain(500);
  });

  it('says nothing to a browser unless asked to', async () => {
    // Loopback is not the boundary it looks like: a page open in a browser on
    // this machine can reach 127.0.0.1, so allowing every origin by default
    // would publish the channel list the loopback default declines to.
    const cache = cacheWith({ one: [programme('one', 6)] });
    await cache.seed('2026-09-03T04:00:00.000Z');

    const shut = await serve(configFor(['one']), cache);

    expect((await fetch(shut.url)).headers.get('access-control-allow-origin')).toBeNull();
    expect((await fetch(shut.url, { method: 'OPTIONS' })).status).toBe(405);
  });

  it('lets a browser read the guide, validators and all, when it is', async () => {
    const cache = cacheWith({ one: [programme('one', 6)] });
    await cache.seed('2026-09-03T04:00:00.000Z');

    const server = await serve(configFor(['one']), cache, { cors: true });
    const first = await fetch(server.url);

    await first.text();

    expect(first.headers.get('access-control-allow-origin')).toBe('*');
    // Without this a browser hides the ETag from the page, and the conditional
    // GET this server exists for cannot be made at all.
    expect(first.headers.get('access-control-expose-headers')).toContain('ETag');

    // `If-None-Match` is not a safelisted header, so a conditional GET from a
    // page is preflighted — answered 405 before, which failed the fetch.
    const preflight = await fetch(server.url, { method: 'OPTIONS' });

    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-headers')).toContain('If-None-Match');

    // And the 304 carries it too, or every revalidation reads as a failure.
    const again = await fetch(server.url, {
      headers: { 'if-none-match': first.headers.get('etag')! },
    });

    expect(again.status).toBe(304);
    expect(again.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('names one origin, and varies on it', async () => {
    const cache = cacheWith({ one: [programme('one', 6)] });
    await cache.seed('2026-09-03T04:00:00.000Z');

    const server = await serve(configFor(['one']), cache, { cors: 'https://tv.example' });
    const response = await fetch(server.url);

    await response.text();

    expect(response.headers.get('access-control-allow-origin')).toBe('https://tv.example');
    // The answer now depends on who asked, so a cache between must not hand it
    // to somebody else.
    expect(response.headers.get('vary')).toContain('Origin');
  });

  it('holds an idle connection for as long as it was told to', async () => {
    // The default is above the sixty seconds nginx and Traefik keep, because
    // Node's own five is *below* them — and that ordering is what produces the
    // intermittent 502 nobody can reproduce, when the proxy sends a request
    // down a pooled socket at the moment Node is tearing it down. Asserted
    // through a short one, since waiting out the real default is a minute.
    const cache = cacheWith({ one: [programme('one', 6)] });
    await cache.seed('2026-09-03T04:00:00.000Z');

    const server = await serve(configFor(['one']), cache, { keepAliveMs: 250 });
    const url = new URL(server.url);

    const closedAfter = await new Promise<number>((resolve, reject) => {
      const socket = connect(Number(url.port), url.hostname, () => {
        socket.write(`GET ${url.pathname} HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n`);
      });

      let answered = 0;

      socket.on('data', () => {
        answered ||= Date.now();
      });
      // Held open after the response, then dropped by the server rather than
      // by us — which is the setting doing its work.
      socket.on('close', () => resolve(Date.now() - answered));
      socket.on('error', reject);
    });

    expect(closedAfter).toBeGreaterThanOrEqual(200);
    expect(closedAfter).toBeLessThan(5000);
  });

  it('brackets a literal IPv6 host in the url it advertises', async () => {
    const cache = cacheWith({ one: [programme('one', 6)] });
    await cache.seed('2026-09-03T04:00:00.000Z');

    let server: GuideServer;

    try {
      server = await serve(configFor(['one']), cache, { host: '::1' });
    } catch {
      // A machine with no IPv6 loopback has nothing to say about this.
      return;
    }

    // `http://::1:8080/...` is not a url anything can parse — only `::` used to
    // be bracketed, and every other literal went out bare.
    expect(server.url).toContain('[::1]');
    expect(new URL(server.url).hostname).toBe('[::1]');
    expect((await fetch(server.url)).status).toBe(200);
  });

  it('does not compress for a client that refused it with q=0', async () => {
    const cache = cacheWith({ one: [programme('one', 6)] });
    await cache.seed('2026-09-03T04:00:00.000Z');

    const server = await serve(configFor(['one']), cache);
    // `gzip;q=0` names the format only to refuse it, which the token alone
    // reads as the opposite of what it says.
    const refused = await fetch(server.url, { headers: { 'accept-encoding': 'gzip;q=0' } });

    expect(refused.headers.get('content-encoding')).toBeNull();
    expect(await refused.text()).toContain('<channel id="one">');

    const asked = await fetch(server.url, { headers: { 'accept-encoding': 'gzip;q=1.0' } });

    expect(asked.headers.get('content-encoding')).toBe('gzip');
  });

  it('closes while a consumer is part way through a guide', async () => {
    // Big enough that the body cannot fit in the socket buffers, which on
    // loopback hold megabytes — at 2.5MB the write still completed and the
    // connection went idle, which `close` handles on its own. This is about the
    // one it does not: a write that is still going.
    const ids = Array.from({ length: 2000 }, (_, i) => `c-${i}`);
    const cache = cacheWith(
      Object.fromEntries(
        ids.map((id) => [
          id,
          Array.from({ length: 20 }, (_, h) => ({
            channel: id,
            start: new Date(new Date(`${DAY}T00:00:00.000Z`).getTime() + h * 3600000),
            title: [{ value: `Show ${h} ${'x'.repeat(200)}` }],
          })),
        ]),
      ),
    );
    await cache.seed('2026-09-03T04:00:00.000Z');

    const server = await serve(configFor(ids), cache);

    // A raw socket rather than an http client: nothing here ever reads, so the
    // response is guaranteed to still be in flight. `server.close` calls back
    // only once the last one has ended, so cutting the connections *after*
    // awaiting it meant `close()` never resolved and `epg serve` hung until a
    // second Ctrl-C.
    const socket = connect(server.port, '127.0.0.1');

    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    socket.write(`GET ${new URL(server.url).pathname} HTTP/1.1\r\nHost: localhost\r\n\r\n`);
    // Long enough for the server to have started writing and filled the buffers.
    await new Promise<void>((resolve) => setTimeout(resolve, 300));

    try {
      await expect(
        Promise.race([
          server.close().then(() => 'closed'),
          new Promise((resolve) => setTimeout(() => resolve('hung'), 3000)),
        ]),
      ).resolves.toBe('closed');
    } finally {
      socket.destroy();
    }
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

  it('stops at once for a signal that had already fired', async () => {
    // `addEventListener('abort')` never fires for a signal that has already
    // aborted, so this used to bind a port and serve for good on a run that had
    // been called off. Node's own `listen({ signal })` is not the answer: all
    // it does is `server.close()`, which cuts no connection and releases no
    // cache.
    const cache = cacheWith({ one: [programme('one', 6)] });
    await cache.seed('2026-09-03T04:00:00.000Z');

    const controller = new AbortController();

    controller.abort();

    const report = collect();
    const server = await serve(configFor(['one']), cache, {
      signal: controller.signal,
      reporter: report.reporter,
    });

    // Resolved already, rather than waiting on an event long since gone.
    await expect(server.closed).resolves.toBeUndefined();
    await expect(fetch(server.url)).rejects.toThrow();
    // And said so in the order it happened, rather than stopping before it
    // started.
    expect(report.of('serve:started')).toHaveLength(1);
    expect(report.of('serve:stopped')).toHaveLength(1);
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
