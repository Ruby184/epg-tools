import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { CacheManager, MemoryCacheDriver } from '../src/cache/main.js';
import type { CacheStore } from '../src/cache/main.js';
import {
  channelsFromM3u,
  defineM3uSite,
  grab,
  guideUrlsFromM3u,
  resolveChannels,
} from '../src/grabber/main.js';
import { parseM3uString } from '../src/m3u/main.js';

/** Header attributes, written the way a test wants to read them. */
const attrs = (record: Record<string, string>): Map<string, string> =>
  new Map(Object.entries(record));

const NOW = new Date('2026-08-29T12:00:00.000Z');
const TODAY = '2026-08-29';
const TOMORROW = '2026-08-30';

const GUIDE =
  '<?xml version="1.0"?><tv>' +
  ['a.tv', 'b.tv']
    .map((id) => `<channel id="${id}"><display-name>Guide ${id}</display-name></channel>`)
    .join('') +
  ['a.tv', 'b.tv']
    .flatMap((id) =>
      [TODAY, TOMORROW].map(
        (day) =>
          `<programme channel="${id}" start="${day.replaceAll('-', '')}060000 +0000">` +
          `<title>${id} on ${day}</title></programme>`,
      ),
    )
    .join('') +
  '</tv>';

let running: Server | undefined;

afterEach(async () => {
  const server = running;

  running = undefined;

  // Guarded rather than `running?.close(…)` inside the promise: a test that
  // never started a server would leave that promise with nothing to resolve it,
  // and the hook would hang for its whole timeout.
  if (server !== undefined) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

interface Source {
  /** The playlist's url. */
  url: string;
  /** Every request the server took, in order. */
  asked: IncomingMessage[];
}

/**
 * A server holding a playlist and the guide it names.
 *
 * The playlist body is built from `header`, which is given the base url — a
 * playlist points at its guide absolutely, and the port is only known once the
 * server is listening.
 */
async function serve(
  options: {
    header?: (base: string) => string;
    entries?: string;
    gzipPlaylist?: boolean;
  } = {},
): Promise<Source> {
  const asked: IncomingMessage[] = [];
  let base = '';

  const server = createServer((request, response) => {
    asked.push(request);

    if (request.url?.startsWith('/guide.xml') === true) {
      response.writeHead(200, { 'content-type': 'application/xml' });
      response.end(GUIDE);

      return;
    }

    const header = (options.header ?? ((at: string) => `x-tvg-url="${at}guide.xml"`))(base);
    const playlist =
      `#EXTM3U ${header}\r\n` +
      (options.entries ??
        '#EXTINF:-1 tvg-id="a.tv" tvg-logo="https://example.test/a.png",Channel A\r\n' +
          `${base}stream/a\r\n` +
          '#EXTINF:-1 tvg-id="b.tv",Channel B\r\n' +
          `${base}stream/b\r\n`);

    if (options.gzipPlaylist === true) {
      response.writeHead(200, { 'content-type': 'application/gzip' });
      response.end(gzipSync(playlist));

      return;
    }

    response.writeHead(200, { 'content-type': 'audio/x-mpegurl' });
    response.end(playlist);
  });

  running = server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

  return { asked, url: `${base}playlist.m3u` };
}

const store = (): CacheStore => new CacheManager({ driver: new MemoryCacheDriver() });

describe('guideUrlsFromM3u', () => {
  it('reads x-tvg-url', () => {
    expect(guideUrlsFromM3u({ attributes: attrs({ 'x-tvg-url': 'http://e/g.xml' }) })).toEqual([
      'http://e/g.xml',
    ]);
  });

  it('falls back to the other spelling', () => {
    expect(guideUrlsFromM3u({ attributes: attrs({ 'url-tvg': 'http://e/g.xml' }) })).toEqual([
      'http://e/g.xml',
    ]);
  });

  // Kodi's own source says the value may be a comma-separated list, and that it
  // takes the first because it does not support more than one.
  it('splits a comma-separated list, trimming each', () => {
    expect(
      guideUrlsFromM3u({ attributes: attrs({ 'x-tvg-url': 'http://e/1.xml, http://e/2.xml ,' }) }),
    ).toEqual(['http://e/1.xml', 'http://e/2.xml']);
  });

  it('is empty when the playlist names no guide', () => {
    expect(guideUrlsFromM3u({ attributes: new Map() })).toEqual([]);
    expect(guideUrlsFromM3u({ attributes: attrs({ 'x-tvg-url': '  ' }) })).toEqual([]);
  });
});

describe('channelsFromM3u', () => {
  const channels = (text: string, options?: Parameters<typeof channelsFromM3u>[1]) =>
    channelsFromM3u(parseM3uString(text), options);

  // `#EXTGRP` is a *begin* directive: Kodi sets the group from one and
  // deliberately does not clear it after each entry, so one line groups every
  // entry that follows until the next one.
  it('carries an #EXTGRP forward until the next one', async () => {
    const found = await channels(
      '#EXTM3U\n' +
        '#EXTGRP:News\n#EXTINF:-1 tvg-id="a",A\nhttp://e/a\n' +
        '#EXTINF:-1 tvg-id="b",B\nhttp://e/b\n' +
        '#EXTGRP:Sports\n#EXTINF:-1 tvg-id="c",C\nhttp://e/c\n',
    );

    expect(found.map((channel) => channel.data?.groups)).toEqual([['News'], ['News'], ['Sports']]);
  });

  it('unions #EXTGRP with group-title, both being semi-colon lists', async () => {
    const found = await channels(
      '#EXTM3U\n#EXTGRP:News;Docs\n#EXTINF:-1 tvg-id="a" group-title="Local; News",A\nhttp://e/a\n',
    );

    // Deduplicated, the entry's own first, and each side trimmed.
    expect(found[0]?.data?.groups).toEqual(['Local', 'News', 'Docs']);
  });

  it('keeps a group in force across an entry it had to skip', async () => {
    const found = await channels(
      '#EXTM3U\n#EXTGRP:News\n#EXTINF:-1,No Id\nhttp://e/x\n#EXTINF:-1 tvg-id="b",B\nhttp://e/b\n',
    );

    expect(found.map((channel) => channel.data?.groups)).toEqual([['News']]);
  });

  // tvheadend resolves a relative stream url against the playlist's own url;
  // a channel list holding `stream/a.m3u8` is of no use downstream.
  it('resolves a relative stream url against the playlist', async () => {
    const found = await channels('#EXTM3U\n#EXTINF:-1 tvg-id="a",A\nstream/a.m3u8\n', {
      base: 'https://host.example/lists/uk.m3u',
    });

    expect(found[0]?.data?.url).toBe('https://host.example/lists/stream/a.m3u8');
  });

  it('leaves an absolute url, and anything unparseable, exactly as written', async () => {
    const found = await channels(
      '#EXTM3U\n' +
        '#EXTINF:-1 tvg-id="a",A\nhttps://cdn.example/a.m3u8\n' +
        '#EXTINF:-1 tvg-id="b",B\nhttp://e/b|User-Agent=X\n',
      { base: 'https://host.example/lists/uk.m3u' },
    );

    expect(found.map((channel) => channel.data?.url)).toEqual([
      'https://cdn.example/a.m3u8',
      // The header convention survives resolution untouched.
      'http://e/b|User-Agent=X',
    ]);
  });

  it('keeps the url as written when given no base', async () => {
    const found = await channels('#EXTM3U\n#EXTINF:-1 tvg-id="a",A\nstream/a.m3u8\n');

    expect(found[0]?.data?.url).toBe('stream/a.m3u8');
  });
});

describe('defineM3uSite', () => {
  it('takes its channels from the playlist', async () => {
    const source = await serve();
    const channels = await resolveChannels(
      defineM3uSite({ site: 'playlist.example', url: source.url }),
    );

    expect(channels).toEqual([
      {
        xmltvId: 'a.tv',
        siteId: 'a.tv',
        name: 'Channel A',
        logo: 'https://example.test/a.png',
        data: expect.objectContaining({ groups: [] }),
      },
      { xmltvId: 'b.tv', siteId: 'b.tv', name: 'Channel B', data: expect.anything() },
    ]);
  });

  it('grabs the guide the playlist names, from one url', async () => {
    const source = await serve();
    const cache = store();

    const summary = await grab([defineM3uSite({ site: 'playlist.example', url: source.url })], {
      cache,
      now: NOW,
      days: 2,
    });

    // Two channels the config never mentioned, over two days — the playlist
    // said which channels, its header said where their guide was.
    expect(summary.fetched).toBe(4);
    expect(summary.failed).toBe(0);
    expect(
      await cache.read({ site: 'playlist.example', channelId: 'a.tv', day: TODAY }),
    ).toHaveLength(1);
    expect(
      await cache.read({ site: 'playlist.example', channelId: 'b.tv', day: TOMORROW }),
    ).toHaveLength(1);
  });

  it('reads the playlist once, however many passes ask', async () => {
    const source = await serve();

    await grab([defineM3uSite({ site: 'playlist.example', url: source.url })], {
      cache: store(),
      now: NOW,
      days: 1,
    });

    // The channel pass and the grab both need something out of it; a playlist is
    // megabytes and is fetched for both at once.
    const playlists = source.asked.filter((request) => request.url?.includes('playlist') === true);

    expect(playlists).toHaveLength(1);
  });

  it('reads a gzipped playlist', async () => {
    const source = await serve({ gzipPlaylist: true });
    const channels = await resolveChannels(
      defineM3uSite({ site: 'playlist.example', url: source.url }),
    );

    expect(channels.map((channel) => channel.xmltvId)).toEqual(['a.tv', 'b.tv']);
  });

  it('takes the first guide of a list, and lets a caller pick another', async () => {
    const source = await serve({
      header: (base) => `x-tvg-url="${base}missing.xml,${base}guide.xml"`,
    });

    const picked = defineM3uSite({
      site: 'playlist.example',
      url: source.url,
      guide: (urls) => urls.find((one) => one.endsWith('guide.xml')) ?? urls[0]!,
    });

    const summary = await grab([picked], { cache: store(), now: NOW, days: 1 });

    expect(summary.failed).toBe(0);
    expect(summary.fetched).toBe(2);
  });

  it('says so when the playlist names no guide at all', async () => {
    const source = await serve({ header: () => '' });
    const site = defineM3uSite({ site: 'playlist.example', url: source.url });

    // Channels still resolve — a playlist without a guide is a perfectly good
    // channel list, it just cannot be a source.
    await expect(resolveChannels(site)).resolves.toHaveLength(2);

    const summary = await grab([site], { cache: store(), now: NOW, days: 1 });

    expect(summary.failed).toBeGreaterThan(0);
  });

  it('skips an entry with no tvg-id, and can say which', async () => {
    const skipped: string[] = [];
    const source = await serve({
      entries:
        '#EXTINF:-1 tvg-id="a.tv",Channel A\r\nhttp://e/a\r\n' +
        '#EXTINF:-1,No Id Here\r\nhttp://e/x\r\n',
    });

    const channels = await resolveChannels(
      defineM3uSite({
        site: 'playlist.example',
        url: source.url,
        channels: { onSkipped: (entry, reason) => skipped.push(`${entry.name}:${reason}`) },
      }),
    );

    expect(channels.map((channel) => channel.xmltvId)).toEqual(['a.tv']);
    expect(skipped).toEqual(['No Id Here:no-id']);
  });

  // Counted and said once, not once per entry: the default skips every entry
  // with no `tvg-id`, which on iptv-org is 1,948 of them.
  it("says how many entries it skipped, through the site's own warn", async () => {
    const warned: string[] = [];
    const source = await serve({
      entries:
        '#EXTINF:-1 tvg-id="a.tv",Channel A\r\nhttp://e/a\r\n' +
        '#EXTINF:-1,No Id One\r\nhttp://e/x\r\n' +
        '#EXTINF:-1,No Id Two\r\nhttp://e/y\r\n',
    });

    await resolveChannels(defineM3uSite({ site: 'playlist.example', url: source.url }), {
      says: { log: () => {}, warn: (message) => warned.push(message) },
    });

    expect(warned).toEqual(['2 playlist entries skipped (no-id)']);
  });

  it('forwards a playlist parse warning to the site', async () => {
    const warned: string[] = [];
    const source = await serve({
      entries: '#EXTINF:abc tvg-id="a.tv",Channel A\r\nhttp://e/a\r\n',
    });

    const channels = await resolveChannels(
      defineM3uSite({ site: 'playlist.example', url: source.url }),
      { says: { log: () => {}, warn: (message) => warned.push(message) } },
    );

    // Reported, and the entry kept regardless — the parser never throws.
    expect(warned).toEqual(['playlist line 2: #EXTINF duration "abc" is not a number']);
    expect(channels.map((channel) => channel.xmltvId)).toEqual(['a.tv']);
  });

  it('reads the uppercase tvg-ID some providers write', async () => {
    const source = await serve({
      entries: '#EXTINF:-1 tvg-ID="a.tv",Channel A\r\nhttp://e/a\r\n',
    });

    const channels = await resolveChannels(
      defineM3uSite({ site: 'playlist.example', url: source.url }),
    );

    expect(channels.map((channel) => channel.xmltvId)).toEqual(['a.tv']);
  });
});
