import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import ky from 'ky';
import { describe, expect, it } from 'vitest';
import { siteHttp } from '../src/grabber/channels.js';
import { siteDispatcher, type UndiciSource } from '../src/grabber/connection.js';
import type { AnySiteConfig } from '../src/grabber/types.js';

/** A site config with just enough on it for a client to be built from. */
function site(overrides: Partial<AnySiteConfig> = {}): AnySiteConfig {
  return {
    site: 'example.tv',
    channels: [],
    async request() {
      return {};
    },
    parseDay: () => [],
    ...overrides,
  } as AnySiteConfig;
}

/** What each constructor was handed, which is all this has to check. */
interface Built {
  agent: string;
  options: Record<string, unknown>;
}

/**
 * An undici that builds nothing.
 *
 * The real one is an optional peer and is usually not installed — and when it
 * is, it is whichever version that machine's Node happens to bundle. What this
 * package decides is which agent to construct and what to hand it, so that is
 * what the fake records.
 */
function fakeUndici(options: { version?: string | undefined; env?: boolean } = {}): {
  built: Built[];
  load: () => Promise<UndiciSource>;
} {
  const built: Built[] = [];
  const agent = (name: string) =>
    class {
      constructor(given: Record<string, unknown>) {
        built.push({ agent: name, options: given });
      }
    };

  return {
    built,
    load: async () => ({
      module: {
        Agent: agent('Agent'),
        ProxyAgent: agent('ProxyAgent'),
        ...(options.env === false ? {} : { EnvHttpProxyAgent: agent('EnvHttpProxyAgent') }),
      },
      version: 'version' in options ? options.version : process.versions.undici,
    }),
  };
}

/** Whether this machine has undici installed, which two tests turn on. */
function undiciInstalled(): boolean {
  try {
    createRequire(import.meta.url).resolve('undici');

    return true;
  } catch {
    return false;
  }
}

describe('a site’s connection settings', () => {
  it('asks for no dispatcher where a site has named nothing', () => {
    expect(siteDispatcher(undefined)).toBeUndefined();
    expect(siteDispatcher({})).toBeUndefined();
    expect(siteDispatcher({ proxy: false })).toBeUndefined();
  });

  it('sends a named proxy through a ProxyAgent, with the TLS options for the source', async () => {
    const undici = fakeUndici();
    const dispatcher = siteDispatcher(
      { proxy: 'http://user:pass@proxy.local:3128', tls: { ciphers: 'DEFAULT:@SECLEVEL=0' } },
      undici.load,
    );

    await dispatcher!();

    expect(undici.built).toEqual([
      {
        agent: 'ProxyAgent',
        options: {
          uri: 'http://user:pass@proxy.local:3128',
          // `requestTls`, not `connect`: the handshake these options are for is
          // the one with the source, made inside the tunnel.
          requestTls: { ciphers: 'DEFAULT:@SECLEVEL=0' },
        },
      },
    ]);
  });

  it('reads the environment only when asked to, and through the agent that knows NO_PROXY', async () => {
    const undici = fakeUndici();

    await siteDispatcher({ proxy: true, tls: { servername: 'a.example.tv' } }, undici.load)!();

    expect(undici.built).toEqual([
      {
        agent: 'EnvHttpProxyAgent',
        options: {
          // Both, because this one agent covers both: through the proxy, and
          // direct for a host NO_PROXY exempts.
          requestTls: { servername: 'a.example.tv' },
          connect: { servername: 'a.example.tv' },
        },
      },
    ]);
  });

  it('is a plain Agent where only the TLS is unusual', async () => {
    const undici = fakeUndici();

    await siteDispatcher({ tls: { ciphers: 'DEFAULT:@SECLEVEL=0' } }, undici.load)!();

    expect(undici.built).toEqual([
      { agent: 'Agent', options: { connect: { ciphers: 'DEFAULT:@SECLEVEL=0' } } },
    ]);
  });

  it('builds it once, however many requests ask for it', async () => {
    const undici = fakeUndici();
    const dispatcher = siteDispatcher({ proxy: 'http://proxy.local:3128' }, undici.load)!;
    const [first, second] = await Promise.all([dispatcher(), dispatcher()]);

    await dispatcher();

    expect(undici.built).toHaveLength(1);
    expect(first).toBe(second);
  });

  it('refuses an undici that cannot drive this Node’s fetch, and says which to install', async () => {
    const major = Number.parseInt(process.versions.undici ?? '0', 10);
    const undici = fakeUndici({ version: `${major + 1}.0.0` });
    const dispatcher = siteDispatcher({ proxy: 'http://proxy.local:3128' }, undici.load)!;

    await expect(dispatcher()).rejects.toThrow(`npm install undici@${process.versions.undici}`);
    // The one the consumer has, the one Node has, and the error they would
    // otherwise have met instead.
    await expect(dispatcher()).rejects.toThrow(`undici ${major + 1}.0.0`);
    await expect(dispatcher()).rejects.toThrow('invalid onRequestStart method');
    expect(undici.built).toHaveLength(0);
  });

  it('accepts one that differs below the major, which is where the interface changes', async () => {
    const major = Number.parseInt(process.versions.undici ?? '0', 10);
    const undici = fakeUndici({ version: `${major}.999.999` });

    await siteDispatcher({ proxy: 'http://proxy.local:3128' }, undici.load)!();

    expect(undici.built).toHaveLength(1);
  });

  it('says what `proxy: true` needs of an undici too old to have it', async () => {
    const undici = fakeUndici({ env: false });

    await expect(siteDispatcher({ proxy: true }, undici.load)!()).rejects.toThrow(
      /EnvHttpProxyAgent.*6\.19/s,
    );
  });

  it.skipIf(undiciInstalled())(
    'reaches a request, and asks for undici by name when it is not installed',
    async () => {
      const http = siteHttp(site({ connection: { proxy: 'http://proxy.local:3128' } }));

      // Nothing is sent: the dispatcher is wanted before the request is, which
      // is the whole proof that the client goes through it.
      await expect(http.get('http://127.0.0.1:1/').text()).rejects.toThrow(
        /`connection` settings need the `undici` package/,
      );
    },
  );
});

/** A server that records what reached it. */
async function recording(): Promise<{
  url: string;
  seen: IncomingMessage[];
  close(): void;
}> {
  const seen: IncomingMessage[] = [];
  const server: Server = createServer((request, response) => {
    seen.push(request);
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('ok');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const { port } = server.address() as AddressInfo;

  return { url: `http://127.0.0.1:${port}`, seen, close: () => server.close() };
}

describe('a site that brought its own ky instance', () => {
  it('keeps what the instance carries, and adds what the site needs on top', async () => {
    const server = await recording();

    try {
      const brought = ky.create({
        prefix: server.url,
        headers: { 'x-token': 'from-the-instance' },
        hooks: {
          beforeRequest: [({ request }) => request.headers.set('x-hook', 'ran')],
        },
      });

      await siteHttp(site({ ky: brought }))
        .get('listings')
        .text();

      expect(server.seen).toHaveLength(1);
      expect(server.seen[0]!.url).toBe('/listings');
      expect(server.seen[0]!.headers['x-token']).toBe('from-the-instance');
      expect(server.seen[0]!.headers['x-hook']).toBe('ran');
    } finally {
      server.close();
    }
  });

  it('bakes the run’s signal into it, as it does for options', async () => {
    const server = await recording();
    const run = new AbortController();

    try {
      const http = siteHttp(site({ ky: ky.create({ prefix: server.url }) }), run.signal);

      run.abort();

      await expect(http.get('listings').text()).rejects.toThrow(/abort/i);
      expect(server.seen).toHaveLength(0);
    } finally {
      server.close();
    }
  });

  it('does not run the instance’s hooks twice', async () => {
    const server = await recording();
    let ran = 0;

    try {
      const brought = ky.create({
        prefix: server.url,
        hooks: { beforeRequest: [() => void ran++] },
      });

      // `conditionalGet` is the case that composes hooks onto what is already
      // there — the one where ky's own merge would append a second copy.
      await siteHttp(site({ ky: brought, conditionalGet: true }))
        .get('listings')
        .text();

      expect(ran).toBe(1);
    } finally {
      server.close();
    }
  });
});
