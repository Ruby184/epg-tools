import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { CacheManager, MemoryCacheDriver } from '../src/cache/main.js';
import type { CacheStore } from '../src/cache/main.js';
import { defineXmltvSite, grab, resolveChannels } from '../src/grabber/main.js';
import type { GrabberChannel } from '../src/grabber/main.js';
import type { XmltvChannel } from '../src/xmltv/types.js';
import { collect } from './reporting.js';

const NOW = new Date('2026-08-29T12:00:00.000Z');
const TODAY = '2026-08-29';
const TOMORROW = '2026-08-30';

/** A `<programme>` on `channel`, at `time` in the offset the document writes. */
function programme(channel: string, time: string, offset = '+0000'): string {
  return (
    `<programme channel="${channel}" start="${time} ${offset}">` +
    `<title>${channel} at ${time}</title></programme>`
  );
}

function document(body: string, channels = ['a', 'b']): string {
  return (
    '<?xml version="1.0"?><tv>' +
    channels
      .map(
        (id) =>
          `<channel id="${id}"><display-name lang="en">Channel ${id}</display-name>` +
          `<icon src="https://example.test/${id}.png" /><url>https://example.test/${id}</url>` +
          `</channel>`,
      )
      .join('') +
    body +
    '</tv>'
  );
}

/** Two channels over two days, grouped by channel as a published guide is. */
const GROUPED = document(
  ['a', 'b']
    .flatMap((id) => [
      programme(id, `${TODAY.replaceAll('-', '')}060000`),
      programme(id, `${TOMORROW.replaceAll('-', '')}060000`),
    ])
    .join(''),
);

let running: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => running?.close(() => resolve()));
  running = undefined;
});

/** Serve one body, and say what was asked for. */
async function serve(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ url: string; asked: IncomingMessage[]; bytesWritten: () => number }> {
  const asked: IncomingMessage[] = [];
  let written = 0;
  const server = createServer((request, response) => {
    asked.push(request);
    const write = response.write.bind(response);

    response.write = ((chunk: string | Uint8Array, ...rest: never[]) => {
      written += chunk.length;
      return write(chunk as never, ...rest);
    }) as typeof response.write;

    handler(request, response);
  });

  running = server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    asked,
    bytesWritten: () => written,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
  };
}

/** Serve this document, gzipped as a `.xml.gz` is: no `Content-Encoding`. */
async function serveGzip(xml = GROUPED): Promise<Awaited<ReturnType<typeof serve>>> {
  const body = gzipSync(xml);

  return serve((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/gzip', etag: 'W/"g1"' });
    response.end(body);
  });
}

function store(): CacheStore {
  return new CacheManager({ driver: new MemoryCacheDriver() });
}

function entries(cache: CacheStore, channelId: string, day: string) {
  return cache.read({ site: 'published.example', channelId, day });
}

describe('defineXmltvSite', () => {
  it('grabs a published guide with nothing written down', async () => {
    const source = await serveGzip();
    const cache = store();

    const summary = await grab([defineXmltvSite({ site: 'published.example', url: source.url })], {
      cache,
      now: NOW,
      days: 2,
    });

    // Two channels the config never mentioned, over two days, from one document.
    expect(summary.fetched).toBe(4);
    expect(summary.empty).toBe(0);
    expect(summary.failed).toBe(0);
    expect(await entries(cache, 'a', TODAY)).toHaveLength(1);
    expect(await entries(cache, 'b', TOMORROW)).toHaveLength(1);
  });

  it('takes its channels from the head of the document, and stops there', async () => {
    // A guide whose channels are followed by a great many programmes: reading it
    // out to find the channel list would be the whole download.
    const heavy = document(
      Array.from({ length: 20_000 }, (_, index) =>
        programme(index % 2 === 0 ? 'a' : 'b', `${TODAY.replaceAll('-', '')}060000`),
      ).join(''),
    );
    const source = await serveGzip(heavy);

    const channels = await resolveChannels(
      defineXmltvSite({ site: 'published.example', url: source.url }),
    );

    expect(channels.map((channel) => channel.xmltvId)).toEqual(['a', 'b']);
    // The whole document is far larger than what the server got to write before
    // the client went away.
    expect(source.bytesWritten()).toBeLessThan(gzipSync(heavy).length);
  });

  it('keeps what the document said about a channel, under the output id', async () => {
    const source = await serveGzip();
    const site = defineXmltvSite({ site: 'published.example', url: source.url });
    const [channel] = await resolveChannels(site);

    expect(channel).toMatchObject({ xmltvId: 'a', siteId: 'a', name: 'Channel a' });

    const element = site.channelInfo!(channel as GrabberChannel<XmltvChannel>, () => {
      throw new Error('should not need the default element');
    });

    // Every display name, icon and url the document carried — not the three
    // fields a default `<channel>` holds.
    expect(element).toMatchObject({
      id: 'a',
      displayName: [{ value: 'Channel a', lang: 'en' }],
      icon: [{ src: 'https://example.test/a.png' }],
      url: ['https://example.test/a'],
    });
  });

  it('takes only the channels a list asks for, under the ids it gives them', async () => {
    const source = await serveGzip();
    const cache = store();

    const summary = await grab(
      [
        defineXmltvSite({
          site: 'published.example',
          url: source.url,
          channels: [{ xmltvId: 'b.mine', siteId: 'b' }],
        }),
      ],
      { cache, now: NOW, days: 1 },
    );

    expect(summary.fetched).toBe(1);
    expect(await entries(cache, 'b.mine', TODAY)).toHaveLength(1);
    // `a` was in the document and nobody asked for it.
    expect(await entries(cache, 'a', TODAY)).toBeUndefined();
  });

  it('files a programme under the day the document wrote it in', async () => {
    // Half past midnight in +0200 is still the previous evening's listings — and
    // 22:30 the day before in UTC.
    const source = await serveGzip(document(programme('a', '20260830003000', '+0200'), ['a']));
    const cache = store();

    await grab(
      [defineXmltvSite({ site: 'published.example', url: source.url, dayZone: 'source' })],
      { cache, now: NOW, days: 2 },
    );

    expect(await entries(cache, 'a', TOMORROW)).toHaveLength(1);
    expect(await entries(cache, 'a', TODAY)).toHaveLength(0);
  });

  it('files it by UTC instead when told to', async () => {
    const source = await serveGzip(document(programme('a', '20260830003000', '+0200'), ['a']));
    const cache = store();

    await grab([defineXmltvSite({ site: 'published.example', url: source.url, dayZone: 'utc' })], {
      cache,
      now: NOW,
      days: 2,
    });

    // 00:30 +0200 is 22:30 UTC the day before.
    expect(await entries(cache, 'a', TODAY)).toHaveLength(1);
    expect(await entries(cache, 'a', TOMORROW)).toHaveLength(0);
  });

  it('reassembles a document that is not grouped by channel, and says so', async () => {
    // Ordered by time across channels, which the DTD allows and some publishers
    // do: a, b, a, b.
    const interleaved = document(
      [
        programme('a', '20260829060000'),
        programme('b', '20260829060000'),
        programme('a', '20260829070000'),
        programme('b', '20260829070000'),
      ].join(''),
    );
    const source = await serveGzip(interleaved);
    const cache = store();
    const report = collect();

    const summary = await grab([defineXmltvSite({ site: 'published.example', url: source.url })], {
      cache,
      now: NOW,
      days: 1,
      reporter: report.reporter,
    });

    // Nothing lost: both programmes of each channel are there, in order.
    expect(await entries(cache, 'a', TODAY)).toHaveLength(2);
    expect(await entries(cache, 'b', TODAY)).toHaveLength(2);
    expect(summary.fetched).toBe(2);
    expect(report.messages.some((line) => line.includes('not grouped by channel'))).toBe(true);
  });

  it('is not thrown off by a channel nobody asked for coming between two runs', async () => {
    // `a … x … a`, with `x` outside the list. For the channels actually wanted
    // this is one contiguous run of `a`, so nothing needs holding — but the
    // ordering used to be decided before the list was consulted, and `x` made
    // the pass give up and hold the whole rest of the document.
    const source = await serveGzip(
      document(
        [
          programme('a', '20260829060000'),
          programme('x', '20260829060000'),
          programme('a', '20260829070000'),
        ].join(''),
        ['a', 'x'],
      ),
    );
    const cache = store();
    const report = collect();

    const summary = await grab(
      [
        defineXmltvSite({
          site: 'published.example',
          url: source.url,
          channels: [{ xmltvId: 'a', siteId: 'a' }],
        }),
      ],
      { cache, now: NOW, days: 1, reporter: report.reporter },
    );

    expect(await entries(cache, 'a', TODAY)).toHaveLength(2);
    // One write, not a write and an append — and no warning about a document
    // that is grouped as far as this site is concerned.
    expect(summary.fetched).toBe(1);
    expect(report.of('entry:appended')).toEqual([]);
    expect(report.messages.some((line) => line.includes('not grouped'))).toBe(false);
  });

  it('holds everything from the start when told the order is anything', async () => {
    const interleaved = document(
      [
        programme('a', '20260829060000'),
        programme('b', '20260829060000'),
        programme('a', '20260829070000'),
      ].join(''),
    );
    const source = await serveGzip(interleaved);
    const cache = store();
    const report = collect();

    await grab([defineXmltvSite({ site: 'published.example', url: source.url, order: 'any' })], {
      cache,
      now: NOW,
      days: 1,
      reporter: report.reporter,
    });

    expect(await entries(cache, 'a', TODAY)).toHaveLength(2);
    // Nothing to warn about: it was told.
    expect(report.messages.some((line) => line.includes('not grouped'))).toBe(false);
  });

  it('caches empty the channel-days the document never mentions', async () => {
    // `b` is declared and has nothing on.
    const source = await serveGzip(document(programme('a', '20260829060000')));
    const cache = store();

    const summary = await grab([defineXmltvSite({ site: 'published.example', url: source.url })], {
      cache,
      now: NOW,
      days: 1,
    });

    expect(summary.empty).toBe(1);
    expect(await entries(cache, 'b', TODAY)).toEqual([]);
  });

  describe('however the document is compressed', () => {
    const cases: Array<{
      name: string;
      headers: Record<string, string>;
      body: (xml: string) => Buffer | string;
    }> = [
      {
        name: 'plain XML',
        headers: { 'content-type': 'application/xml' },
        body: (xml) => xml,
      },
      {
        name: 'a .gz file, which fetch does not decode',
        headers: { 'content-type': 'application/gzip' },
        body: (xml) => gzipSync(xml),
      },
      {
        name: 'gzip that fetch has already decoded',
        headers: { 'content-type': 'application/xml', 'content-encoding': 'gzip' },
        body: (xml) => gzipSync(xml),
      },
      {
        name: 'a .gz file served as Content-Encoding: gzip as well',
        headers: { 'content-type': 'application/gzip', 'content-encoding': 'gzip' },
        body: (xml) => gzipSync(xml),
      },
    ];

    for (const { name, headers, body } of cases) {
      it(`reads ${name}`, async () => {
        const source = await serve((_request, response) => {
          response.writeHead(200, headers);
          response.end(body(GROUPED));
        });
        const cache = store();

        const summary = await grab(
          [defineXmltvSite({ site: 'published.example', url: source.url })],
          { cache, now: NOW, days: 1 },
        );

        expect(summary.failed).toBe(0);
        expect(await entries(cache, 'a', TODAY)).toHaveLength(1);
      });
    }

    it('reads brotli when it is named, having no magic number to go by', async () => {
      const source = await serve((_request, response) => {
        response.writeHead(200, { 'content-type': 'application/xml' });
        response.end(brotliCompressSync(GROUPED));
      });
      const cache = store();

      const summary = await grab(
        [defineXmltvSite({ site: 'published.example', url: source.url, compression: 'brotli' })],
        { cache, now: NOW, days: 1 },
      );

      expect(summary.failed).toBe(0);
      expect(await entries(cache, 'a', TODAY)).toHaveLength(1);
    });

    it('reads a gzip whose magic number arrives a byte at a time', async () => {
      // A body arrives as the socket gave it, and a dribbling origin or a proxy
      // flushing small frames really does hand over one byte first. Deciding on
      // the first chunk rather than the first four bytes read that as a document
      // that is "neither XML nor anything recognizable".
      const body = gzipSync(GROUPED);
      const source = await serve((_request, response) => {
        response.writeHead(200, { 'content-type': 'application/gzip' });
        response.write(body.subarray(0, 1));
        setTimeout(() => {
          response.write(body.subarray(1, 3));
          setTimeout(() => response.end(body.subarray(3)), 5);
        }, 5);
      });
      const cache = store();

      const summary = await grab(
        [defineXmltvSite({ site: 'published.example', url: `${source.url}guide.xml.gz` })],
        { cache, now: NOW, days: 1 },
      );

      expect(summary.failed).toBe(0);
      expect(await entries(cache, 'a', TODAY)).toHaveLength(1);
    });

    it('reads a document that ends inside the first few bytes', async () => {
      // Shorter than the window the sniff needs, so there is never a fourth byte
      // to wait for. The stream has said `end` by then and will not take its
      // bytes back, so what was held is the whole document and is handed on as
      // one — the case that turns "wait for four" into a stall.
      const source = await serve((_request, response) => {
        response.writeHead(200, { 'content-type': 'application/xml' });
        response.end('<tv/>');
      });
      const cache = store();

      const summary = await grab(
        [defineXmltvSite({ site: 'published.example', url: source.url })],
        { cache, now: NOW, days: 1 },
      );

      // A guide declaring no channels is a guide with nothing to grab, which is
      // not a failure — it is a source that had nothing to say.
      expect(summary.failed).toBe(0);
      expect(summary.fetched).toBe(0);
    });

    it('says so when the bytes are neither XML nor anything it knows', async () => {
      const source = await serve((_request, response) => {
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        response.end(brotliCompressSync(GROUPED));
      });
      const cache = store();

      const report = collect();
      const summary = await grab(
        [defineXmltvSite({ site: 'published.example', url: source.url })],
        { cache, now: NOW, days: 1, reporter: report.reporter },
      );

      // The channel list comes out of the same document, so an unreadable one
      // fails the site rather than each of its channel-days: there are none.
      expect(summary.failed).toBe(1);
      expect(report.of('site:failed')).toEqual([
        expect.objectContaining({ site: 'published.example' }),
      ]);
      expect((report.of('site:failed')[0]!.error as Error).message).toContain(
        "compression: 'brotli'",
      );
    });
  });

  it('fails the channel-days it never reached when the download breaks', async () => {
    const whole = gzipSync(GROUPED);
    const source = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/gzip' });
      // Half a gzip member, then nothing. A quiet end here would be read as a
      // complete document and cache "nothing on" for the rest of the guide.
      response.end(whole.subarray(0, Math.floor(whole.length / 2)));
    });
    const cache = store();

    const summary = await grab(
      [
        defineXmltvSite({
          site: 'published.example',
          url: source.url,
          channels: [
            { xmltvId: 'a', siteId: 'a' },
            { xmltvId: 'b', siteId: 'b' },
          ],
        }),
      ],
      { cache, now: NOW, days: 1 },
    );

    expect(summary.failed).toBeGreaterThan(0);
    expect(summary.empty).toBe(0);
    // Nothing was quietly blanked.
    expect(await entries(cache, 'b', TODAY)).toBeUndefined();
  });

  it('asks conditionally on a later run, and downloads nothing when told to', async () => {
    let downloads = 0;
    const body = gzipSync(GROUPED);
    const source = await serve((request, response) => {
      if (request.headers['if-none-match'] === 'W/"g1"') {
        response.writeHead(304, { etag: 'W/"g1"' });
        response.end();
        return;
      }

      downloads++;
      response.writeHead(200, { 'content-type': 'application/gzip', etag: 'W/"g1"' });
      response.end(body);
    });
    const cache = store();
    const site = defineXmltvSite({ site: 'published.example', url: source.url });

    const first = await grab([site], { cache, now: NOW, days: 1 });
    const afterFirst = downloads;
    const second = await grab([site], { cache, now: NOW, days: 1 });

    expect(first.fetched).toBe(2);
    expect(second.unchanged).toBe(2);
    expect(second.fetched).toBe(0);
    // The second run downloads nothing at all: the guide answered 304, and the
    // channel list came out of the cache rather than out of another request.
    expect(downloads).toBe(afterFirst);
    expect(source.asked.at(-1)!.headers['if-none-match']).toBe('W/"g1"');
    expect(await entries(cache, 'a', TODAY)).toHaveLength(1);
  });

  it('passes its own settings through to the site', async () => {
    const source = await serveGzip();
    const site = defineXmltvSite({
      site: 'published.example',
      url: source.url,
      days: 3,
      conditionalGet: false,
      cacheChannels: false,
      transform: (programme) => programme,
    });

    expect(site).toMatchObject({
      site: 'published.example',
      days: 3,
      conditionalGet: false,
      cacheChannels: false,
    });
    expect(typeof site.transform).toBe('function');
  });
});
