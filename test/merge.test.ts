import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CacheStore, ChannelDayKey } from '../src/cache/types.js';
import type { GrabberChannel, SiteConfig } from '../src/grabber/types.js';
import { mergeChannels } from '../src/merge/channel.js';
import { mergeProgrammeLists, mergeProgrammes } from '../src/merge/programme.js';
import { parseXmltvDate } from '../src/xmltv/main.js';
import type { BuildGuideOptions } from '../src/merge/types.js';
import type { XmltvChannel, XmltvProgramme } from '../src/xmltv/types.js';

// The xmltv module is developed concurrently; guide tests are skipped when it
// (or its writeXmltvStream export) is not available yet.
const xmltvReady = await import('../src/xmltv/main.js')
  .then((mod) => typeof (mod as { writeXmltvStream?: unknown }).writeXmltvStream === 'function')
  .catch(() => false);

function prog(
  channel: string,
  start: string,
  title: string,
  lang?: string,
  extras: Partial<XmltvProgramme> = {},
): XmltvProgramme {
  return {
    channel,
    start: new Date(start),
    title: [lang ? { value: title, lang } : { value: title }],
    ...extras,
  };
}

function createFakeCache(entries: Record<string, XmltvProgramme[]> = {}): CacheStore {
  const map = new Map(Object.entries(entries));
  const keyOf = (key: ChannelDayKey) => `${key.site}|${key.channelId}|${key.day}`;

  return {
    async getMeta(key) {
      const programmes = map.get(keyOf(key));
      return programmes
        ? { grabbedAt: '2026-01-15T00:00:00.000Z', programmeCount: programmes.length }
        : undefined;
    },
    async read(key) {
      return map.get(keyOf(key));
    },
    async write(key, programmes) {
      map.set(keyOf(key), programmes);
    },
    async delete(key) {
      map.delete(keyOf(key));
    },
    async prune() {
      return 0;
    },
  };
}

function makeSite(site: string, channels: GrabberChannel[]): SiteConfig<unknown> {
  return {
    site,
    channels,
    request: async () => ({}),
    parseDay: () => [],
  };
}

async function collect(generator: AsyncGenerator<string>): Promise<string> {
  let output = '';
  for await (const chunk of generator) {
    output += chunk;
  }
  return output;
}

const NOW = new Date('2026-01-15T05:00:00.000Z');
const DAY = '2026-01-15';

describe('mergeProgrammes', () => {
  it('unions multi-language text arrays and dedupes identical (lang, value) pairs', () => {
    const base: XmltvProgramme = {
      channel: 'X',
      start: new Date('2026-01-15T10:00:00Z'),
      title: [{ value: 'Správy', lang: 'sk' }],
      desc: [{ value: 'Popis', lang: 'sk' }],
      category: [
        { value: 'news', lang: 'en' },
        { value: 'spravodajstvo', lang: 'sk' },
      ],
    };
    const extra: XmltvProgramme = {
      channel: 'X',
      start: new Date('2026-01-15T10:00:00Z'),
      title: [
        { value: 'News', lang: 'en' },
        { value: 'Správy', lang: 'sk' },
      ],
      desc: [{ value: 'Description', lang: 'en' }],
      category: [{ value: 'news', lang: 'en' }],
    };

    const merged = mergeProgrammes(base, extra);

    expect(merged.title).toEqual([
      { value: 'Správy', lang: 'sk' },
      { value: 'News', lang: 'en' },
    ]);
    expect(merged.desc).toEqual([
      { value: 'Popis', lang: 'sk' },
      { value: 'Description', lang: 'en' },
    ]);
    expect(merged.category).toEqual([
      { value: 'news', lang: 'en' },
      { value: 'spravodajstvo', lang: 'sk' },
    ]);
    // Same value in a different language is a distinct entry.
    const both = mergeProgrammes(
      { ...base, title: [{ value: 'Same', lang: 'sk' }] },
      { ...extra, title: [{ value: 'Same', lang: 'en' }] },
    );
    expect(both.title).toHaveLength(2);
  });

  it('prefers base scalars and falls back to extra when base lacks them', () => {
    const base: XmltvProgramme = {
      channel: 'X',
      start: new Date('2026-01-15T10:00:00Z'),
      stop: new Date('2026-01-15T11:00:00Z'),
      title: [{ value: 'A' }],
      date: parseXmltvDate('2020'),
    };
    const extra: XmltvProgramme = {
      channel: 'Y',
      start: new Date('2026-01-15T10:00:00Z'),
      stop: new Date('2026-01-15T11:30:00Z'),
      title: [{ value: 'B' }],
      date: parseXmltvDate('2021'),
      language: { value: 'en' },
      new: true,
      length: { units: 'minutes', value: 60 },
    };

    const merged = mergeProgrammes(base, extra);

    expect(merged).not.toBe(base);
    expect(merged.channel).toBe('X');
    expect(merged.stop).toEqual(new Date('2026-01-15T11:00:00Z'));
    expect(merged.date).toEqual(parseXmltvDate('2020'));
    // Base lacks these, so extra fills in.
    expect(merged.language).toEqual({ value: 'en' });
    expect(merged.new).toBe(true);
    expect(merged.length).toEqual({ units: 'minutes', value: 60 });
  });

  it('does not set optional properties when the merged result is empty', () => {
    const base = prog('X', '2026-01-15T10:00:00Z', 'A');
    const extra = prog('X', '2026-01-15T10:00:00Z', 'A');

    const merged = mergeProgrammes(base, extra);

    expect('desc' in merged).toBe(false);
    expect('credits' in merged).toBe(false);
    expect('stop' in merged).toBe(false);
    expect(merged.title).toEqual([{ value: 'A' }]);
  });

  it('merges credits per field with dedup', () => {
    const base = prog('X', '2026-01-15T10:00:00Z', 'A', 'sk', {
      credits: {
        director: ['Jane Doe'],
        actor: [{ value: 'John Smith', role: 'Hero' }],
      },
    });
    const extra = prog('X', '2026-01-15T10:00:00Z', 'A', 'en', {
      credits: {
        director: ['Jane Doe', 'Max Power'],
        actor: [
          { value: 'John Smith', role: 'Hero' },
          { value: 'John Smith', role: 'Villain' },
          { value: 'Ann Lee' },
        ],
        writer: ['W. Riter'],
      },
    });

    const merged = mergeProgrammes(base, extra);

    expect(merged.credits?.director).toEqual(['Jane Doe', 'Max Power']);
    expect(merged.credits?.writer).toEqual(['W. Riter']);
    expect(merged.credits?.actor).toEqual([
      { value: 'John Smith', role: 'Hero' },
      { value: 'John Smith', role: 'Villain' },
      { value: 'Ann Lee' },
    ]);
  });

  it('dedupes other arrays by their specific keys', () => {
    const base = prog('X', '2026-01-15T10:00:00Z', 'A', 'sk', {
      url: ['https://a.example'],
      icon: [{ src: 'https://img.example/1.png' }],
      episodeNum: [{ system: 'xmltv_ns', value: '0.1.' }],
      rating: [{ system: 'MPAA', value: 'PG' }],
    });
    const extra = prog('X', '2026-01-15T10:00:00Z', 'A', 'en', {
      url: ['https://a.example', 'https://b.example'],
      icon: [{ src: 'https://img.example/1.png', width: 100 }],
      episodeNum: [{ system: 'xmltv_ns', value: '0.1.' }, { value: '2' }],
      rating: [{ system: 'MPAA', value: 'PG' }, { system: 'VCHIP', value: 'TV-PG' }],
    });

    const merged = mergeProgrammes(base, extra);

    expect(merged.url).toEqual(['https://a.example', 'https://b.example']);
    expect(merged.icon).toEqual([{ src: 'https://img.example/1.png' }]);
    expect(merged.episodeNum).toEqual([{ system: 'xmltv_ns', value: '0.1.' }, { value: '2' }]);
    expect(merged.rating).toEqual([
      { system: 'MPAA', value: 'PG' },
      { system: 'VCHIP', value: 'TV-PG' },
    ]);
  });

  it('unions extension elements structurally and merges extraAttributes base-wins', () => {
    const base = prog('X', '2026-01-15T10:00:00Z', 'A', 'sk', {
      extra: [{ name: 'crid', value: 'crid://a/1' }, { name: 'live' }],
      extraAttributes: { uniqueID: 'base-id', shared: 'from-base' },
    });
    const extra = prog('X', '2026-01-15T10:00:00Z', 'A', 'en', {
      extra: [{ name: 'crid', value: 'crid://a/1' }, { name: 'crid', value: 'crid://a/2' }],
      extraAttributes: { shared: 'from-extra', onlyExtra: 'x' },
    });

    const merged = mergeProgrammes(base, extra);

    // Structurally identical extension elements dedupe; distinct kept, base first.
    expect(merged.extra).toEqual([
      { name: 'crid', value: 'crid://a/1' },
      { name: 'live' },
      { name: 'crid', value: 'crid://a/2' },
    ]);
    // Attribute keys unioned; base wins on a conflicting key.
    expect(merged.extraAttributes).toEqual({
      uniqueID: 'base-id',
      shared: 'from-base',
      onlyExtra: 'x',
    });
  });
});

describe('mergeChannels', () => {
  it('unions display names, icons and urls with base first', () => {
    const base: XmltvChannel = {
      id: 'X',
      displayName: [{ value: 'Channel X', lang: 'sk' }],
      icon: [{ src: 'https://logo.example/x.png' }],
      url: ['https://a.example/x'],
    };
    const extra: XmltvChannel = {
      id: 'X',
      displayName: [
        { value: 'Channel X Intl', lang: 'en' },
        { value: 'Channel X', lang: 'sk' },
      ],
      icon: [
        { src: 'https://logo.example/x.png', width: 100 },
        { src: 'https://logo.example/x-alt.png' },
      ],
      url: ['https://b.example/x'],
    };

    expect(mergeChannels(base, extra)).toEqual({
      id: 'X',
      displayName: [
        { value: 'Channel X', lang: 'sk' },
        { value: 'Channel X Intl', lang: 'en' },
      ],
      icon: [
        { src: 'https://logo.example/x.png' },
        { src: 'https://logo.example/x-alt.png' },
      ],
      url: ['https://a.example/x', 'https://b.example/x'],
    });
  });

  it('does not set icon or url when both sides lack them', () => {
    const merged = mergeChannels(
      { id: 'X', displayName: [{ value: 'A' }] },
      { id: 'X', displayName: [{ value: 'B' }] },
    );

    expect(merged).toEqual({ id: 'X', displayName: [{ value: 'A' }, { value: 'B' }] });
    expect('icon' in merged).toBe(false);
    expect('url' in merged).toBe(false);
  });

  it('unions channel extension elements and merges extraAttributes base-wins', () => {
    const merged = mergeChannels(
      {
        id: 'X',
        displayName: [{ value: 'A' }],
        extra: [{ name: 'lcn', value: '36' }],
        extraAttributes: { rank: '1' },
      },
      {
        id: 'X',
        displayName: [{ value: 'B' }],
        extra: [{ name: 'lcn', value: '36' }, { name: 'lcn', value: '99' }],
        extraAttributes: { rank: '2', region: 'sk' },
      },
    );

    expect(merged.extra).toEqual([{ name: 'lcn', value: '36' }, { name: 'lcn', value: '99' }]);
    expect(merged.extraAttributes).toEqual({ rank: '1', region: 'sk' });
  });
});

describe('mergeProgrammeLists', () => {
  const listA = [
    prog('X', '2026-01-15T10:00:00Z', 'Správy', 'sk'),
    prog('X', '2026-01-15T11:00:00Z', 'Film', 'sk'),
  ];
  const listB = [
    prog('X', '2026-01-15T12:00:00Z', 'Late Show', 'en'),
    prog('X', '2026-01-15T10:00:00Z', 'News', 'en'),
  ];

  it("'merge' combines same-start programmes across priority lists, sorted by start", () => {
    const merged = mergeProgrammeLists([listA, listB], 'merge');

    expect(merged).toHaveLength(3);
    expect(merged.map((p) => p.start.toISOString())).toEqual([
      '2026-01-15T10:00:00.000Z',
      '2026-01-15T11:00:00.000Z',
      '2026-01-15T12:00:00.000Z',
    ]);
    // Same-start programme merged with priority list as base.
    expect(merged[0]?.title).toEqual([
      { value: 'Správy', lang: 'sk' },
      { value: 'News', lang: 'en' },
    ]);
    expect(merged[1]?.title).toEqual([{ value: 'Film', lang: 'sk' }]);
    expect(merged[2]?.title).toEqual([{ value: 'Late Show', lang: 'en' }]);
  });

  it("'concat' keeps duplicates and sorts by start", () => {
    const merged = mergeProgrammeLists([listA, listB], 'concat');

    expect(merged).toHaveLength(4);
    expect(merged.map((p) => p.start.toISOString())).toEqual([
      '2026-01-15T10:00:00.000Z',
      '2026-01-15T10:00:00.000Z',
      '2026-01-15T11:00:00.000Z',
      '2026-01-15T12:00:00.000Z',
    ]);
  });
});

describe.skipIf(!xmltvReady)('generateGuide', () => {
  const siteA = makeSite('site-a.sk', [
    { xmltvId: 'X', siteId: 'a-x', name: 'Channel X', logo: 'https://logo.example/x.png' },
  ]);
  const siteB = makeSite('site-b.com', [{ xmltvId: 'X', siteId: 'b-x', name: 'Channel X Intl' }]);

  function cacheForBothSites(): CacheStore {
    return createFakeCache({
      [`site-a.sk|X|${DAY}`]: [
        prog('X', '2026-01-15T10:00:00Z', 'Správy', 'sk'),
        prog('X', '2026-01-15T11:00:00Z', 'Film', 'sk'),
      ],
      [`site-b.com|X|${DAY}`]: [prog('X', '2026-01-15T10:00:00Z', 'News', 'en')],
    });
  }

  async function generate(options: BuildGuideOptions): Promise<string> {
    const { generateGuide } = await import('../src/merge/guide.js');
    return collect(generateGuide(options));
  }

  it('describes a channel with the builder its channelInfo was handed', async () => {
    const site: SiteConfig<unknown> = {
      ...makeSite('site-a.sk', [{
        xmltvId: 'X',
        siteId: 'a-x',
        name: 'Channel X',
        lang: 'sk',
        logo: 'https://logo.example/x.png',
        data: { callSign: 'CHX', page: 'https://x.example/', lcn: 5 },
      }]),
      // No id, no display name, no logo restated: `element()` starts where the
      // default element would, and this adds to it.
      channelInfo({ data }, element) {
        const extra = data as { callSign: string; page: string; lcn: number };

        return element()
          .displayName(extra.callSign, 'en')
          .url(extra.page)
          .extra({ name: 'lcn', value: String(extra.lcn) });
      },
    };

    const output = await generate({
      sites: [site],
      cache: cacheForBothSites(),
      days: 1,
      now: NOW,
    });

    expect(output).toContain('<display-name lang="sk">Channel X</display-name>');
    expect(output).toContain('<display-name lang="en">CHX</display-name>');
    expect(output).toContain('<icon src="https://logo.example/x.png"');
    expect(output).toContain('<url>https://x.example/</url>');
    expect(output).toContain('<lcn>5</lcn>');
  });

  it('emits a single <channel> and merged multi-language programmes for two covering sites', async () => {
    const output = await generate({
      sites: [siteA, siteB],
      cache: cacheForBothSites(),
      days: 1,
      now: NOW,
    });

    expect(output.match(/id=["']X["']/g)).toHaveLength(1);
    // Channel metadata is merged across covering sites, priority site first.
    expect(output).toContain('Channel X');
    expect(output).toContain('Channel X Intl');
    expect(output.indexOf('Channel X')).toBeLessThan(output.indexOf('Channel X Intl'));
    expect(output).toContain('https://logo.example/x.png');
    // Same-start programmes merged: both language titles present exactly once.
    expect(output.match(/Správy/g)).toHaveLength(1);
    expect(output.match(/News/g)).toHaveLength(1);
    expect(output).toContain('Film');
    // Merged 10:00 programme means only 2 programme starts overall.
    expect(output.match(/<programme/g)).toHaveLength(2);
  });

  it('emits a compact guide by default and pretty-prints with the indent option', async () => {
    const base = { sites: [siteA], cache: cacheForBothSites(), days: 1, now: NOW };

    const compact = await generate(base);
    expect(compact.startsWith('<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE tv SYSTEM "xmltv.dtd"><tv')).toBe(true);
    expect(compact).not.toContain('\n');

    const indented = await generate({ ...base, indent: 2 });
    expect(indented).toContain('\n  <channel ');
    expect(indented).toContain('\n  <programme ');
    expect(indented.endsWith('</tv>\n')).toBe(true);
  });

  it("'first-wins' ignores the lower-priority site's programmes", async () => {
    const output = await generate({
      sites: [siteA, siteB],
      cache: cacheForBothSites(),
      days: 1,
      now: NOW,
      merge: { channelStrategy: 'first-wins' },
    });

    expect(output.match(/id=["']X["']/g)).toHaveLength(1);
    expect(output).toContain('Správy');
    expect(output).not.toContain('News');
  });

  it('skips missing cache entries silently', async () => {
    const siteY = makeSite('site-a.sk', [
      { xmltvId: 'X', siteId: 'a-x' },
      { xmltvId: 'Y', siteId: 'a-y' },
    ]);
    const cache = createFakeCache({
      [`site-a.sk|X|${DAY}`]: [prog('X', '2026-01-15T10:00:00Z', 'Správy', 'sk')],
    });

    const output = await generate({ sites: [siteY], cache, days: 2, now: NOW });

    expect(output.match(/id=["']Y["']/g)).toHaveLength(1);
    expect(output).not.toMatch(/channel=["']Y["']/);
    expect(output.match(/<programme/g)).toHaveLength(1);
  });

  it('logs progress per channel', async () => {
    const messages: string[] = [];

    await generate({
      sites: [siteA, siteB],
      cache: cacheForBothSites(),
      days: 1,
      now: NOW,
      logger: (message) => messages.push(message),
    });

    expect(messages.some((message) => message.includes('X'))).toBe(true);
  });

  it('writeGuide streams to <output>.tmp and renames atomically', async () => {
    const { writeGuide } = await import('../src/merge/guide.js');
    const dir = await mkdtemp(join(tmpdir(), 'epg-merge-test-'));
    const output = join(dir, 'nested', 'guide.xml');

    await writeGuide({
      sites: [siteA, siteB],
      cache: cacheForBothSites(),
      days: 1,
      now: NOW,
      output,
    });

    expect(existsSync(output)).toBe(true);
    expect(existsSync(`${output}.tmp`)).toBe(false);
    expect(await readdir(join(dir, 'nested'))).toEqual(['guide.xml']);

    const content = await readFile(output, 'utf8');
    expect(content).toContain('<tv');
    expect(content).toContain('</tv>');
    expect(content).toContain('Správy');
  });

  it('writeGuide streams into a Unix socket instead of replacing it', async () => {
    const { writeGuide } = await import('../src/merge/guide.js');
    const { createServer } = await import('node:net');
    const { stat } = await import('node:fs/promises');
    const dir = await mkdtemp(join(tmpdir(), 'epg-merge-test-'));
    const output = join(dir, 'xmltv.sock');

    const server = createServer((socket) => {
      const chunks: string[] = [];
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => chunks.push(chunk));
      socket.on('end', () => resolveReceived(chunks.join('')));
    });

    let resolveReceived: (text: string) => void = () => {};
    const received = new Promise<string>((resolve) => {
      resolveReceived = resolve;
    });

    await new Promise<void>((resolve) => server.listen(output, resolve));

    try {
      await writeGuide({
        sites: [siteA, siteB],
        cache: cacheForBothSites(),
        days: 1,
        now: NOW,
        output,
      });

      const content = await received;

      expect(content).toContain('<tv');
      expect(content).toContain('</tv>');
      expect(content).toContain('Správy');
      // Still a socket: nothing was renamed over it, no temp file left beside
      // it. (Node unlinks the path when the server closes, so this has to be
      // checked while it is still listening.)
      expect((await stat(output)).isSocket()).toBe(true);
      expect(await readdir(dir)).toEqual(['xmltv.sock']);
    } finally {
      server.close();
    }
  });
});

if (!xmltvReady) {
  // eslint-disable-next-line no-console
  console.warn('[merge.test] src/xmltv/main.js not available yet — generateGuide tests skipped');
}
