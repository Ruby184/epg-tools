/**
 * The guide mounted on a server that is not this package's.
 *
 * `serveGuide`'s own suite covers the answering — this covers the seam: that
 * the same answer comes out of a route in somebody's app, that the transports
 * carry it faithfully, and that a handler nobody closes is a handler still
 * holding a cache.
 */

import { createServer, type Server } from 'node:http';
import { createServer as createHttpsServer, get as httpsGet } from 'node:https';
import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { CacheManager, MemoryCacheDriver } from '../src/cache/main.js';
import type { CacheStore } from '../src/cache/types.js';
import type { EpgConfig } from '../src/config.js';
import { createGuideHandler, serveGuide, type GuideHandler } from '../src/serve/main.js';
import type { XmltvProgramme } from '../src/xmltv/types.js';
import { CERT, KEY } from './fixtures/self-signed.js';
import { collect } from './reporting.js';

const NOW = new Date('2026-09-03T05:00:00.000Z');
const DAY = '2026-09-03';

function programme(channel: string, hour: number): XmltvProgramme {
  return {
    channel,
    start: new Date(`${DAY}T0${hour}:00:00.000Z`),
    title: [{ value: 'Show' }],
  };
}

function configFor(channels: string[], serve: EpgConfig['serve'] = {}): EpgConfig {
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
    serve,
  };
}

async function cacheWith(entries: Record<string, XmltvProgramme[]>): Promise<CacheStore> {
  const cache = new CacheManager({ driver: new MemoryCacheDriver() });

  for (const [channelId, programmes] of Object.entries(entries)) {
    await cache.write({ site: 'example.tv', channelId, day: DAY }, programmes, {
      grabbedAt: '2026-09-03T04:00:00.000Z',
    });
  }

  return cache;
}

let handlers: GuideHandler[] = [];
let listening: Server[] = [];

afterEach(async () => {
  await Promise.all(
    listening.map(
      async (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  await Promise.all(handlers.map((handler) => handler.close()));
  handlers = [];
  listening = [];
});

async function handlerFor(
  config: EpgConfig,
  cache: CacheStore,
  options: Parameters<typeof createGuideHandler>[1] = {},
): Promise<GuideHandler> {
  const handler = await createGuideHandler(config, { now: NOW, cache, ...options });

  handlers.push(handler);

  return handler;
}

/** An app of somebody's own: a few routes, one of which is the guide. */
async function mount(handler: GuideHandler, routes: (handler: GuideHandler) => Server) {
  const server = routes(handler);

  listening.push(server);

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('createGuideHandler', () => {
  it('answers a route of an app’s own with the guide, and leaves its other routes alone', async () => {
    const handler = await handlerFor(
      configFor(['one']),
      await cacheWith({ one: [programme('one', 6)] }),
    );
    const guideRoute = handler.node('guide');
    const healthRoute = handler.node('health');
    const url = await mount(handler, () =>
      createServer((request, response) => {
        if (request.url === '/epg.xml') {
          void guideRoute(request, response);

          return;
        }

        if (request.url === '/healthz') {
          void healthRoute(request, response);

          return;
        }

        response.writeHead(200, { 'content-type': 'text/plain' }).end('mine\n');
      }),
    );

    const guide = await fetch(`${url}/epg.xml`);

    expect(guide.status).toBe(200);
    expect(await guide.text()).toContain('<channel id="one">');
    // The same validators as the server's: it is the same answer.
    expect(guide.headers.get('etag')).toMatch(/^W\//);

    // Named `route`, so the path is the app's business rather than the
    // config's — `/healthz` is nowhere in `serve.health`.
    const health = await fetch(`${url}/healthz`);

    expect(health.status).toBe(200);
    expect(((await health.json()) as { ok: boolean }).ok).toBe(true);

    // And nothing of the app's was swallowed.
    expect(await (await fetch(`${url}/whatever`)).text()).toBe('mine\n');
  });

  it('routes for itself when nobody says which answer they want', async () => {
    const handler = await handlerFor(
      configFor(['one'], { path: '/g.xml', health: '/h' }),
      await cacheWith({ one: [programme('one', 6)] }),
    );
    const url = await mount(handler, ({ node }) => createServer(node()));

    expect(handler.guidePath).toBe('/g.xml');
    expect(handler.healthPath).toBe('/h');
    expect(await (await fetch(`${url}/g.xml`)).text()).toContain('<channel id="one">');
    expect((await fetch(`${url}/h`)).status).toBe(200);
    // Which is the half that makes it a whole server, and the half that makes
    // `app.use(handler.node())` wrong for an app with routes of its own.
    expect((await fetch(`${url}/anything`)).status).toBe(404);
  });

  it('reads a path out of a request target or a whole url, and routes nothing else', async () => {
    const handler = await handlerFor(
      configFor(['one']),
      await cacheWith({ one: [programme('one', 6)] }),
    );

    const statusOf = async (url: string | undefined): Promise<number> =>
      (await handler.answer({ headers: {}, ...(url === undefined ? {} : { url }) })).status;

    // What Node and fastify hand over, and what a `Request` carries.
    expect(await statusOf('/guide.xml?days=3')).toBe(200);
    expect(await statusOf('https://pi.local/guide.xml')).toBe(200);
    expect(await statusOf('/health')).toBe(200);
    expect(await statusOf('/nope')).toBe(404);
    expect(await statusOf(undefined)).toBe(404);
    // A target nothing can parse routes nowhere — and does not throw where
    // every answer is decided, which would be a 500 anyone could ask for.
    expect(await statusOf('http://[')).toBe(404);
  });

  it('answers a conditional poll out of the answer itself, with no transport in it', async () => {
    const handler = await handlerFor(
      configFor(['one']),
      await cacheWith({ one: [programme('one', 6)] }),
    );

    const first = await handler.answer({ headers: {}, route: 'guide' });

    expect(first.status).toBe(200);
    expect(typeof first.body).not.toBe('string');

    const etag = first.headers.etag!;
    let bytes = 0;

    for await (const chunk of first.body as AsyncIterable<Uint8Array>) {
      bytes += chunk.length;
    }

    expect(bytes).toBeGreaterThan(0);

    const again = await handler.answer({
      headers: { 'if-none-match': etag },
      route: 'guide',
    });

    expect(again.status).toBe(304);
    expect(again.body).toBeUndefined();
  });

  it('serves the same guide through a fetch-style app', async () => {
    const handler = await handlerFor(
      configFor(['one']),
      await cacheWith({ one: [programme('one', 6)] }),
    );

    const answered = await handler.fetch()(new Request('https://pi.local/guide.xml'));

    expect(answered.status).toBe(200);
    expect(answered.headers.get('content-type')).toBe('application/xml; charset=utf-8');
    expect(await answered.text()).toContain('<channel id="one">');

    // The path it routes by is the url's, as it is anywhere else.
    expect((await handler.fetch()(new Request('https://pi.local/nope'))).status).toBe(404);
    // And a `route` overrides it here too.
    expect((await handler.fetch('health')(new Request('https://pi.local/nope'))).status).toBe(200);
  });

  it('reads the base off a request whichever transport it arrived on', async () => {
    // `baseUrl: true` wants the scheme, and no header can say it truthfully —
    // so a fetch-style request answers from its own url rather than guessing.
    const handler = await handlerFor(
      configFor(['one'], { baseUrl: true }),
      await cacheWith({ one: [programme('one', 6)] }),
    );

    const config = configFor(['one'], { baseUrl: true });

    config.sites[0]!.channels = [
      { xmltvId: 'one', siteId: 'one', name: 'One', logo: '/logos/one.png' },
    ];

    const withLogo = await handlerFor(config, await cacheWith({ one: [programme('one', 6)] }));
    const answered = await withLogo.fetch()(new Request('https://pi.local/guide.xml'));

    expect(await answered.text()).toContain('<icon src="https://pi.local/logos/one.png"/>');
    expect(handler.guidePath).toBe('/guide.xml');
  });

  it('stops once, however many ways the stopping arrives', async () => {
    // The shape that caught this: `shutdown` is where a server of one's own
    // stops listening, and what it stops may abort the very signal this
    // handler is closing for. A second `close` arriving inside the first used
    // to find nothing published yet and stop everything twice — two
    // `serve:stopped`, two `cache.close()`.
    const report = collect();
    const stopping = new AbortController();
    const handler = await createGuideHandler(configFor(['one']), {
      now: NOW,
      cache: await cacheWith({ one: [programme('one', 6)] }),
      signal: stopping.signal,
      reporter: report.reporter,
      shutdown: () => stopping.abort(),
    });

    await handler.close();
    await handler.close();

    expect(report.of('serve:stopped')).toHaveLength(1);
  });
});

describe('on fastify', () => {
  it('writes through the reply, so the app’s hooks see the guide', async () => {
    // The reason this exists rather than a `reply.hijack()` recipe: a hijacked
    // reply runs none of fastify's `onSend`/`onResponse` hooks, so a plugin
    // that logs, times or counts responses stops seeing the guide at all.
    const handler = await handlerFor(
      configFor(['one']),
      await cacheWith({ one: [programme('one', 6)] }),
    );
    const seen: { status: number; url: string }[] = [];
    const app = Fastify();

    app.addHook('onResponse', async (request, reply) => {
      seen.push({ status: reply.statusCode, url: request.url });
    });
    app.get('/epg.xml', handler.fastify('guide'));
    app.get('/healthz', handler.fastify('health'));

    await app.listen({ port: 0, host: '127.0.0.1' });

    try {
      const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
      const guide = await fetch(`${url}/epg.xml`);
      const body = await guide.text();

      expect(guide.status).toBe(200);
      expect(guide.headers.get('content-type')).toBe('application/xml; charset=utf-8');
      expect(guide.headers.get('etag')).toMatch(/^W\//);
      expect(body).toContain('<channel id="one">');

      // A conditional poll is answered as a conditional poll, through fastify.
      const again = await fetch(`${url}/epg.xml`, {
        headers: { 'if-none-match': guide.headers.get('etag')! },
      });

      expect(again.status).toBe(304);
      expect(await again.text()).toBe('');

      expect((await fetch(`${url}/healthz`)).status).toBe(200);

      // Which is the assertion this test is for.
      expect(seen).toEqual([
        { status: 200, url: '/epg.xml' },
        { status: 304, url: '/epg.xml' },
        { status: 200, url: '/healthz' },
      ]);
    } finally {
      await app.close();
    }
  });
});

describe('serve.server', () => {
  it('runs a close of its own, before the cache it serves from goes', async () => {
    // What fastify needs: `app.close()` is where its `onClose` hooks run, and
    // closing the socket underneath it would skip every one of them. It has to
    // happen while the cache is still there, too — a hook that answers one last
    // request is answering it from somewhere.
    const said: string[] = [];
    const driver = new MemoryCacheDriver();
    const seeded = new CacheManager({ driver });

    await seeded.write({ site: 'example.tv', channelId: 'one', day: DAY }, [programme('one', 6)], {
      grabbedAt: '2026-09-03T04:00:00.000Z',
    });

    const watched = new Proxy(driver, {
      get(store, name) {
        if (name === 'close') {
          return async () => {
            said.push('cache closed');
          };
        }

        const held = Reflect.get(store, name, store) as unknown;

        return typeof held === 'function' ? held.bind(store) : held;
      },
    });

    const config: EpgConfig = {
      ...configFor(['one'], {
        server: ({ node }, where) => {
          const app = createServer(node());

          app.listen(where.port, where.host);

          // A method that wants its own object, which is what a framework's
          // close is: lifted off the listener, its `this` would be gone.
          const listener = {
            server: app,
            name: 'app',
            close() {
              said.push(`${this.name} closed`);
            },
          };

          return listener;
        },
      }),
      // Opened by the server rather than handed to it, so that closing it is
      // this server's to do and the order is observable.
      cache: { driver: () => watched },
    };

    const server = await serveGuide(config, { port: 0, host: '127.0.0.1', now: NOW });

    expect(await (await fetch(server.url)).text()).toContain('<channel id="one">');

    await server.close();

    expect(said).toEqual(['app closed', 'cache closed']);
  });

  it('listens over TLS, and writes https urls without being told', async () => {
    // The seam is the whole answer to "can it serve HTTPS": this package does
    // not manage certificates, and an `https.Server` is a server like any
    // other — except that it is not `instanceof http.Server`, which is why the
    // listener is taken by what it has rather than by what it is.
    const cache = await cacheWith({ one: [programme('one', 6)] });
    const config = configFor(['one'], {
      baseUrl: true,
      server: ({ node }, where) =>
        createHttpsServer({ key: KEY, cert: CERT }, node()).listen(where.port, where.host),
    });

    config.sites[0]!.channels = [
      { xmltvId: 'one', siteId: 'one', name: 'One', logo: '/logos/one.png' },
    ];

    const server = await serveGuide(config, {
      port: 0,
      host: '127.0.0.1',
      now: NOW,
      cache,
    });

    try {
      expect(server.port).toBeGreaterThan(0);

      // `https.get` rather than `fetch`, which has no way to be told that a
      // self-signed certificate is the point of the test rather than a problem.
      const answered = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        httpsGet(
          `https://localhost:${server.port}/guide.xml`,
          { rejectUnauthorized: false },
          (response) => {
            const parts: Buffer[] = [];

            response.on('data', (part: Buffer) => parts.push(part));
            response.on('end', () =>
              resolve({
                status: response.statusCode ?? 0,
                body: Buffer.concat(parts).toString('utf8'),
              }),
            );
          },
        ).on('error', reject);
      });

      expect(answered.status).toBe(200);
      // `https` off the connection itself, which is the one thing
      // `X-Forwarded-Proto` cannot be trusted about.
      expect(answered.body).toContain(
        `<icon src="https://localhost:${server.port}/logos/one.png"/>`,
      );
    } finally {
      await server.close();
    }
  });

  it('lets the config hand `epg serve` a server of its own', async () => {
    const cache = await cacheWith({ one: [programme('one', 6)] });
    let given: { port: number; host: string } | undefined;

    const config = configFor(['one'], {
      server: ({ node, guidePath }, where) => {
        given = where;

        const guide = node('guide');
        const app = createServer((request, response) => {
          if (request.url === guidePath) {
            void guide(request, response);

            return;
          }

          response.writeHead(200).end('mine\n');
        });

        // Listening already, which is the contract: `app.listen()` returns the
        // server it is listening on, and this is what that returns.
        return app.listen(where.port, where.host);
      },
    });

    const server = await serveGuide(config, { port: 0, host: '127.0.0.1', now: NOW, cache });

    try {
      // Where the command was told to listen, which is what keeps `--port`
      // meaning something when the listening is somebody else's.
      expect(given).toEqual({ port: 0, host: '127.0.0.1' });
      // And the url it reports is the port that was actually bound.
      expect(server.port).toBeGreaterThan(0);
      expect(server.url).toContain('/guide.xml');

      expect(await (await fetch(server.url)).text()).toContain('<channel id="one">');
      expect(await (await fetch(`http://127.0.0.1:${server.port}/mine`)).text()).toBe('mine\n');
    } finally {
      await server.close();
    }

    // Stopped means stopped, whoever was listening.
    await expect(fetch(server.url)).rejects.toThrow();
  });
});
