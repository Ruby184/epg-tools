import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { tryChannelDay } from '../src/cli/try.js';
import type { EpgConfig } from '../src/config.js';
import { defineSiteConfig, defineStreamSiteConfig } from '../src/grabber/types.js';
import type { AnySiteConfig, SiteConfig } from '../src/grabber/types.js';

const DAY = '2026-09-03';

class Sink extends Writable {
  text = '';

  override _write(chunk: Buffer | string, _encoding: string, done: () => void): void {
    this.text += String(chunk);
    done();
  }
}

let servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  servers = [];
});

/** A source that answers whatever `body` says. */
async function source(body: unknown): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  });

  servers.push(server);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));

  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/**
 * Sites are written through `defineSiteConfig` here, as a real config writes
 * them: it is what infers the context shape from the site's own `batching`, so
 * a test asserting that `days` really is `days` is asserting against the type a
 * site author would have seen.
 */
function configWith(site: AnySiteConfig): EpgConfig {
  return { sites: [site], days: 1, output: 'guide.xml' };
}

async function run(
  config: EpgConfig,
  site: string,
  channel: string,
  options: Parameters<typeof tryChannelDay>[4] = {},
): Promise<{ code: number; out: string }> {
  const stdout = new Sink();
  const code = await tryChannelDay(config, site, channel, stdout, { day: DAY, ...options });

  return { code, out: stdout.text };
}

describe('epg try', () => {
  it('shows the request, the payload and the programmes it parsed to', async () => {
    const url = await source({ items: [{ at: '06:00', title: 'Breakfast' }] });
    const config = configWith(
      defineSiteConfig<{ items: { at: string; title: string }[] }>({
        site: 'example.tv',
        channels: [{ xmltvId: 'one.example.tv', siteId: '1', name: 'One', lang: 'en' }],
        request: ({ channel, day, http }) =>
          http.get(`${url}/api?ch=${channel.siteId}&d=${day}`).json(),
        parseDay: ({ payload, day, programme }) =>
          payload.items.map((item) => programme(new Date(`${day}T${item.at}:00.000Z`), item.title)),
      }),
    );

    const { code, out } = await run(config, 'example.tv', 'one.example.tv');

    expect(code).toBe(0);
    // The url, which is the one thing a grab cannot show — a site builds it
    // inside its own `request`, so only the client ever sees one.
    expect(out).toContain(`GET ${url}/api?ch=1&d=${DAY}`);
    expect(out).toMatch(/→ 200, \d+ms, \d+ B, application\/json/);
    // The bytes it came back with.
    expect(out).toContain('"title": "Breakfast"');
    // And what they became, in the form the guide would carry.
    expect(out).toContain('1 programme in');
    expect(out).toContain('<programme start="20260903060000 +0000" channel="one.example.tv">');
    expect(out).toContain('<title lang="en">Breakfast</title>');
  });

  it('takes the channel by either of its ids', async () => {
    const url = await source({});
    const config = configWith(
      defineSiteConfig({
        site: 'example.tv',
        channels: [{ xmltvId: 'one.example.tv', siteId: 'ch-1' }],
        request: ({ http }) => http.get(url).json(),
        parseDay: () => [],
      }),
    );

    // A site author holds both and should not have to remember which is wanted.
    expect((await run(config, 'example.tv', 'one.example.tv')).out).toContain('one.example.tv on');
    expect((await run(config, 'example.tv', 'ch-1')).out).toContain('one.example.tv on');
  });

  it('names what there is when a site or a channel is not one of them', async () => {
    const config = configWith(
      defineSiteConfig({
        site: 'example.tv',
        channels: [{ xmltvId: 'one.example.tv', siteId: '1' }],
        request: async () => ({}),
        parseDay: () => [],
      }),
    );

    await expect(run(config, 'nope.tv', 'one.example.tv')).rejects.toThrow(
      /No site "nope\.tv" .*it has: example\.tv/,
    );
    await expect(run(config, 'example.tv', 'nope')).rejects.toThrow(
      /No channel "nope".*1 known: one\.example\.tv/,
    );
  });

  it('passes on what the site said with log and warn, where it said it', async () => {
    const url = await source({});
    const config = configWith(
      defineSiteConfig({
        site: 'example.tv',
        channels: [{ xmltvId: 'one', siteId: '1' }],
        request: ({ http, log }) => {
          log('asking the api');

          return http.get(url).json();
        },
        parseDay: ({ warn }) => {
          warn('the schedule looked short');

          return [];
        },
      }),
    );

    const { out } = await run(config, 'example.tv', 'one');

    expect(out).toContain('[log]  asking the api');
    expect(out).toContain('[warn] the schedule looked short');
  });

  it('truncates a long payload, and does not with --raw', async () => {
    const long = 'x'.repeat(5000);
    const url = await source({ blob: long });
    const config = configWith(
      defineSiteConfig({
        site: 'example.tv',
        channels: [{ xmltvId: 'one', siteId: '1' }],
        request: ({ http }) => http.get(url).json(),
        parseDay: () => [],
      }),
    );

    const short = await run(config, 'example.tv', 'one');

    expect(short.out).toContain('more characters (--raw for all of it)');
    expect(short.out.length).toBeLessThan(long.length);

    const whole = await run(config, 'example.tv', 'one', { raw: true });

    expect(whole.out).not.toContain('--raw for all of it');
    expect(whole.out).toContain(long);
  });

  it('exits 1 for a channel-day that parsed to nothing', async () => {
    // Not an error — a channel with nothing on is an answer — but it is the
    // commonest thing a site author is here to look at, and a shell loop over
    // channels should be able to tell.
    const config = configWith(
      defineSiteConfig({
        site: 'example.tv',
        channels: [{ xmltvId: 'one', siteId: '1' }],
        request: async () => ({}),
        parseDay: () => [],
      }),
    );

    const { code, out } = await run(config, 'example.tv', 'one');

    expect(code).toBe(1);
    expect(out).toContain('0 programmes in');
    // A site that asked for nothing said so, rather than leaving a blank.
    expect(out).toContain('(no request was made)');
  });

  it('gives a batched site the context its mode declares', async () => {
    let seen: string[] = [];
    const url = await source({});
    const site: SiteConfig<unknown, 'days'> = defineSiteConfig<unknown, 'days'>({
      site: 'example.tv',
      channels: [{ xmltvId: 'one', siteId: '1' }],
      batching: 'days',
      request: ({ days, from, to, http }) => {
        // `days`/`from`/`to` rather than `day`/`date`, which is what makes this
        // the same shape a run would hand it — a try that flattened every site
        // to one day would be trying something the run never does.
        seen = [...days, from.toISOString(), to.toISOString()];

        return http.get(url).json();
      },
      parseDay: () => [],
    });

    await run(configWith(site), 'example.tv', 'one');

    expect(seen).toEqual([DAY, `${DAY}T00:00:00.000Z`, `${DAY}T00:00:00.000Z`]);
  });

  it('puts a stream site through its own path', async () => {
    const config = configWith(
      defineStreamSiteConfig({
        site: 'stream.example',
        channels: [
          { xmltvId: 'one', siteId: '1' },
          { xmltvId: 'two', siteId: '2' },
        ],
        // A stream context is a `both`-batched request context: every channel
        // and every day at once, and no `programme` builder — a whole-document
        // pass builds its own.
        async *stream({ channels, days }) {
          for (const channel of channels) {
            for (const day of days) {
              yield {
                channel,
                day,
                programmes: [
                  {
                    channel: channel.xmltvId,
                    start: new Date(`${day}T06:00:00.000Z`),
                    title: [{ value: `On ${channel.xmltvId}` }],
                  },
                ],
              };
            }
          }
        },
      }),
    );

    const { code, out } = await run(config, 'stream.example', 'two');

    expect(code).toBe(0);
    // Only the channel asked about, out of everything the pass emitted.
    expect(out).toContain('On two');
    expect(out).not.toContain('On one');
    expect(out).toContain('a stream site');
  });

  it('refuses a site a run would refuse, in the same words', async () => {
    const config = configWith({
      site: 'example.tv',
      channels: [{ xmltvId: 'one', siteId: '1' }],
    } as unknown as AnySiteConfig);

    await expect(run(config, 'example.tv', 'one')).rejects.toThrow(/must define request/);
  });
});
