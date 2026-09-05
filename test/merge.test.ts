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
import { collect as collectEvents } from './reporting.js';

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
    async getMetas(keys) {
      return Promise.all(keys.map((key) => this.getMeta(key)));
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
    // A merge asks nothing of a site's state, so this one remembers nothing.
    async getState() {
      return undefined;
    },
    async setState() {},
    async close() {},
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
      rating: [
        { system: 'MPAA', value: 'PG' },
        { system: 'VCHIP', value: 'TV-PG' },
      ],
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
      extra: [
        { name: 'crid', value: 'crid://a/1' },
        { name: 'crid', value: 'crid://a/2' },
      ],
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
      icon: [{ src: 'https://logo.example/x.png' }, { src: 'https://logo.example/x-alt.png' }],
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
        extra: [
          { name: 'lcn', value: '36' },
          { name: 'lcn', value: '99' },
        ],
        extraAttributes: { rank: '2', region: 'sk' },
      },
    );

    expect(merged.extra).toEqual([
      { name: 'lcn', value: '36' },
      { name: 'lcn', value: '99' },
    ]);
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

  it('collapses two programmes of one list that describe the same broadcast', () => {
    const doubled = [
      prog('X', '2026-01-15T10:00:00Z', 'Film', 'sk'),
      prog('X', '2026-01-15T10:00:00Z', 'Film', 'en'),
    ];

    expect(mergeProgrammeLists([doubled], 'merge')).toHaveLength(1);
  });
});

describe('mergeProgrammeLists start tolerance', () => {
  it('merges a shifted start when the titles agree', () => {
    const merged = mergeProgrammeLists(
      [
        [
          prog('X', '2026-01-15T20:00:00Z', 'Film', 'sk', {
            stop: new Date('2026-01-15T21:50:00Z'),
          }),
        ],
        [
          prog('X', '2026-01-15T20:02:00Z', 'film ', 'en', {
            stop: new Date('2026-01-15T21:50:00Z'),
          }),
        ],
      ],
      'merge',
    );

    expect(merged).toHaveLength(1);
    // The higher-priority side's instant is the one that survives.
    expect(merged[0]?.start.toISOString()).toBe('2026-01-15T20:00:00.000Z');
    // Normalization is for comparing only — what each source called it is kept
    // exactly as it came, trailing space and all.
    expect(merged[0]?.title).toEqual([
      { value: 'Film', lang: 'sk' },
      { value: 'film ', lang: 'en' },
    ]);
  });

  it('ignores accents and case when comparing titles', () => {
    const merged = mergeProgrammeLists(
      [
        [prog('X', '2026-01-15T20:00:00Z', 'Správy', 'sk')],
        [prog('X', '2026-01-15T20:01:00Z', 'SPRAVY', 'en')],
      ],
      'merge',
    );

    expect(merged).toHaveLength(1);
  });

  it('keeps a shifted pair apart when the titles disagree', () => {
    const merged = mergeProgrammeLists(
      [
        [prog('X', '2026-01-15T20:00:00Z', 'Správy', 'sk')],
        [prog('X', '2026-01-15T20:02:00Z', 'Šport', 'sk')],
      ],
      'merge',
    );

    expect(merged).toHaveLength(2);
  });

  it('merges an identical start whatever the two sources call it', () => {
    const merged = mergeProgrammeLists(
      [
        [prog('X', '2026-01-15T20:00:00Z', 'Film', 'sk')],
        [prog('X', '2026-01-15T20:00:00Z', 'Movie', 'en')],
      ],
      'merge',
    );

    expect(merged).toHaveLength(1);
  });

  it("requires the title on an identical start under titles: 'always'", () => {
    const lists = [
      [prog('X', '2026-01-15T20:00:00Z', 'Film', 'sk')],
      [prog('X', '2026-01-15T20:00:00Z', 'Movie', 'en')],
    ];

    expect(mergeProgrammeLists(lists, 'merge', { titles: 'always' })).toHaveLength(2);
  });

  it("matches on the instant alone under titles: 'never'", () => {
    const merged = mergeProgrammeLists(
      [
        [prog('X', '2026-01-15T20:00:00Z', 'Film', 'sk')],
        [prog('X', '2026-01-15T20:02:00Z', 'Movie', 'en')],
      ],
      'merge',
      { titles: 'never' },
    );

    expect(merged).toHaveLength(1);
  });

  it('takes the nearest candidate when two are inside the window', () => {
    const merged = mergeProgrammeLists(
      [
        [
          prog('X', '2026-01-15T20:00:00Z', 'Klip', 'sk'),
          prog('X', '2026-01-15T20:04:00Z', 'Klip', 'sk'),
        ],
        [prog('X', '2026-01-15T20:03:00Z', 'Klip', 'en')],
      ],
      'merge',
      // No durations to go on here, so only the tolerance and title apply.
      { startToleranceMs: 300_000 },
    );

    expect(merged).toHaveLength(2);
    // Joined the 20:04 one, a minute away, not the 20:00 one three minutes off.
    expect(merged[1]?.title).toEqual([
      { value: 'Klip', lang: 'sk' },
      { value: 'Klip', lang: 'en' },
    ]);
  });

  it('respects an explicit tolerance of zero', () => {
    const merged = mergeProgrammeLists(
      [
        [prog('X', '2026-01-15T20:00:00Z', 'Film', 'sk')],
        [prog('X', '2026-01-15T20:00:30Z', 'Film', 'en')],
      ],
      'merge',
      { startToleranceMs: 0 },
    );

    expect(merged).toHaveLength(2);
  });

  it("defers to a matcher of the caller's own", () => {
    const merged = mergeProgrammeLists(
      [
        [prog('X', '2026-01-15T20:00:00Z', 'Film', 'sk')],
        // An hour out and differently titled: nothing the options describe
        // would pair these up.
        [prog('X', '2026-01-15T21:00:00Z', 'Movie', 'en')],
      ],
      'merge',
      () => true,
    );

    expect(merged).toHaveLength(1);
  });

  describe('the duration guard', () => {
    it('keeps consecutive same-titled clips apart', () => {
      const merged = mergeProgrammeLists(
        [
          [
            prog('X', '2026-01-15T20:00:00Z', 'Klip', 'sk', {
              stop: new Date('2026-01-15T20:03:00Z'),
            }),
          ],
          [
            prog('X', '2026-01-15T20:03:00Z', 'Klip', 'sk', {
              stop: new Date('2026-01-15T20:06:00Z'),
            }),
          ],
        ],
        'merge',
      );

      expect(merged).toHaveLength(2);
    });

    it('lets a long programme drift by minutes', () => {
      expect(
        mergeProgrammeLists(
          [
            [
              prog('X', '2026-01-15T20:00:00Z', 'Film', 'sk', {
                stop: new Date('2026-01-15T21:50:00Z'),
              }),
            ],
            [
              prog('X', '2026-01-15T20:04:00Z', 'Film', 'en', {
                stop: new Date('2026-01-15T21:50:00Z'),
              }),
            ],
          ],
          'merge',
        ),
      ).toHaveLength(1);
    });

    it('falls back to the tolerance when neither side says where it ends', () => {
      expect(
        mergeProgrammeLists(
          [
            [prog('X', '2026-01-15T20:00:00Z', 'Klip', 'sk')],
            [prog('X', '2026-01-15T20:03:00Z', 'Klip', 'sk')],
          ],
          'merge',
        ),
      ).toHaveLength(1);
    });
  });

  it('is unused by concat, which keeps every programme', () => {
    const merged = mergeProgrammeLists(
      [
        [prog('X', '2026-01-15T20:00:00Z', 'Film', 'sk')],
        [prog('X', '2026-01-15T20:02:00Z', 'Film', 'en')],
      ],
      'concat',
    );

    expect(merged).toHaveLength(2);
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

  describe("programmeStrategy: 'backfill'", () => {
    /** A partial primary and a broad fallback — the case the strategy is for. */
    function twoSources(): CacheStore {
      return createFakeCache({
        // The good source covers the evening only.
        [`site-a.sk|X|${DAY}`]: [
          prog('X', '2026-01-15T18:00:00Z', 'Správy', 'sk', {
            stop: new Date('2026-01-15T19:00:00Z'),
          }),
        ],
        // The broad one covers the whole day, including the same broadcast.
        [`site-b.com|X|${DAY}`]: [
          prog('X', '2026-01-15T08:00:00Z', 'Morning', 'en', {
            stop: new Date('2026-01-15T09:00:00Z'),
          }),
          prog('X', '2026-01-15T18:00:00Z', 'The News', 'en', {
            stop: new Date('2026-01-15T19:00:00Z'),
          }),
          prog('X', '2026-01-15T20:00:00Z', 'Late', 'en', {
            stop: new Date('2026-01-15T21:00:00Z'),
          }),
        ],
      });
    }

    const titles = (output: string): string[] =>
      [...output.matchAll(/<title[^>]*>([^<]*)<\/title>/g)].map((found) => found[1]!);

    it('takes the hole from the fallback and leaves the primary whole', async () => {
      const output = await generate({
        sites: [siteA, siteB],
        cache: twoSources(),
        days: 1,
        startDay: DAY,
        now: NOW,
        merge: { programmeStrategy: 'backfill' },
      });

      // The primary's own broadcast, not merged with the fallback's title for
      // the same hour — that is the difference from `merge`.
      expect(titles(output)).toEqual(['Morning', 'Správy', 'Late']);
      expect(output).not.toContain('The News');
    });

    it('merges the same hour under the default strategy, for contrast', async () => {
      const output = await generate({
        sites: [siteA, siteB],
        cache: twoSources(),
        days: 1,
        startDay: DAY,
        now: NOW,
      });

      // Both titles on one programme: what `backfill` exists not to do.
      expect(output).toContain('Správy');
      expect(output).toContain('The News');
    });

    it('skips a fallback programme that only partly fits the hole', async () => {
      const output = await generate({
        sites: [siteA, siteB],
        cache: createFakeCache({
          [`site-a.sk|X|${DAY}`]: [
            prog('X', '2026-01-15T18:00:00Z', 'Správy', 'sk', {
              stop: new Date('2026-01-15T19:00:00Z'),
            }),
          ],
          [`site-b.com|X|${DAY}`]: [
            // Overlaps the primary's 18:00–19:00 by half an hour.
            prog('X', '2026-01-15T17:30:00Z', 'Overlapping', 'en', {
              stop: new Date('2026-01-15T18:30:00Z'),
            }),
          ],
        }),
        days: 1,
        startDay: DAY,
        now: NOW,
        merge: { programmeStrategy: 'backfill' },
      });

      // Dropped rather than clipped: clipping would pull back the stop of the
      // programme that outranks it.
      expect(titles(output)).toEqual(['Správy']);
    });

    it('works on bare starts, taking a stop-less programme to run its cap', async () => {
      const output = await generate({
        sites: [siteA, siteB],
        cache: createFakeCache({
          // No stops anywhere: coverage has to come from the next start.
          [`site-a.sk|X|${DAY}`]: [prog('X', '2026-01-15T18:00:00Z', 'Správy', 'sk')],
          [`site-b.com|X|${DAY}`]: [
            prog('X', '2026-01-15T19:00:00Z', 'Swallowed', 'en'),
            prog('X', '2026-01-16T02:00:00Z', 'Kept', 'en'),
          ],
        }),
        days: 1,
        startDay: DAY,
        now: NOW,
        merge: { programmeStrategy: 'backfill' },
      });

      // 19:00 falls inside the six hours the primary's 18:00 is taken to run, so
      // it is already covered; 02:00 is past that cap, so it is a real hole and
      // is filled. Without the cap the first would come through too and this
      // would be `concat` by another name.
      expect(titles(output)).toEqual(['Správy', 'Kept']);
      expect(output).not.toContain('Swallowed');
    });
  });

  it('describes a channel with the builder its channelInfo was handed', async () => {
    const site: SiteConfig<unknown> = {
      ...makeSite('site-a.sk', [
        {
          xmltvId: 'X',
          siteId: 'a-x',
          name: 'Channel X',
          lang: 'sk',
          logo: 'https://logo.example/x.png',
          data: { callSign: 'CHX', page: 'https://x.example/', lcn: 5 },
        },
      ]),
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
    expect(
      compact.startsWith(
        '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE tv SYSTEM "xmltv.dtd"><tv',
      ),
    ).toBe(true);
    expect(compact).not.toContain('\n');

    const indented = await generate({ ...base, indent: 2 });
    expect(indented).toContain('\n  <channel ');
    expect(indented).toContain('\n  <programme ');
    expect(indented.endsWith('</tv>\n')).toBe(true);
  });

  it("lets a site's transform say something, under that site's name", async () => {
    // It runs as the cache is read, which is where a site notices what only the
    // whole of a channel-day shows — and until now it had nowhere to say so.
    const report = collectEvents();

    await generate({
      sites: [
        {
          ...siteA,
          transform: (programme, { channel, day, warn }) => {
            warn('a padding programme', { channel: channel.xmltvId, day });

            return programme;
          },
        },
      ],
      cache: cacheForBothSites(),
      days: 1,
      now: NOW,
      reporter: report.reporter,
    });

    expect(report.of('site:warning')).toContainEqual(
      expect.objectContaining({
        site: 'site-a.sk',
        message: 'a padding programme',
        data: { channel: 'X', day: DAY },
      }),
    );
  });

  it('lets a merge transform say something, with no site on it', async () => {
    // The config's own code rather than any site's, so there is nobody to
    // attribute it to — which is why these are their own two event kinds.
    const report = collectEvents();

    await generate({
      sites: [siteA],
      cache: cacheForBothSites(),
      days: 1,
      now: NOW,
      merge: {
        transform: (programme, { xmltvId, log }) => {
          log('unmapped category', { xmltvId });

          return programme;
        },
      },
      reporter: report.reporter,
    });

    const notes = report.of('merge:note');

    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0]).toMatchObject({ message: 'unmapped category', data: { xmltvId: 'X' } });
    expect(notes[0]).not.toHaveProperty('site');
  });

  it('carries the extensions option through to the writer', async () => {
    const base = {
      sites: [siteA],
      cache: createFakeCache({
        [`site-a.sk|X|${DAY}`]: [
          prog('X', '2026-01-15T10:00:00Z', 'Správy', 'sk', {
            extraAttributes: { uniqueID: 'ev-1' },
            extra: [
              { name: 'lcn', value: '12' },
              { name: 'crid', value: 'abc' },
            ],
          }),
        ],
      }),
      days: 1,
      now: NOW,
    };

    // All of them by default, as a guide for tvheadend wants.
    const full = await generate(base);
    expect(full).toContain('uniqueID="ev-1"');
    expect(full).toContain('<lcn>12</lcn>');
    expect(full).toContain('<crid>abc</crid>');

    // None of them, which is the DTD-valid document.
    const plain = await generate({ ...base, extensions: false });
    expect(plain).not.toContain('uniqueID');
    expect(plain).not.toContain('<lcn>');
    expect(plain).not.toContain('<crid>');

    // Or a named few — one grab, three documents from the same cache.
    const some = await generate({ ...base, extensions: ['lcn'] });
    expect(some).toContain('<lcn>12</lcn>');
    expect(some).not.toContain('<crid>');
    expect(some).not.toContain('uniqueID');
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

  describe('a programme two adjacent days both report', () => {
    const NEXT_DAY = '2026-01-16';
    // What a source whose day runs to 06:00 hands back: the programme spanning
    // midnight turns up in both days' entries, the second time as the day's
    // opening item.
    const midnight = () =>
      prog('X', '2026-01-15T23:30:00Z', 'Nočný film', 'sk', {
        stop: new Date('2026-01-16T01:10:00Z'),
      });

    function cacheAcrossMidnight(): CacheStore {
      return createFakeCache({
        [`site-a.sk|X|${DAY}`]: [prog('X', '2026-01-15T22:00:00Z', 'Správy', 'sk'), midnight()],
        [`site-a.sk|X|${NEXT_DAY}`]: [midnight(), prog('X', '2026-01-16T06:00:00Z', 'Ráno', 'sk')],
      });
    }

    it('is emitted once', async () => {
      const output = await generate({
        sites: [siteA],
        cache: cacheAcrossMidnight(),
        days: 2,
        startDay: DAY,
        now: NOW,
      });

      expect(output.match(/Nočný film/g)).toHaveLength(1);
      expect(output.match(/<programme/g)).toHaveLength(3);
    });

    it('is emitted in start order across the boundary', async () => {
      const output = await generate({
        sites: [siteA],
        cache: cacheAcrossMidnight(),
        days: 2,
        startDay: DAY,
        now: NOW,
      });
      const starts = [...output.matchAll(/start=["'](\d+)/g)].map(([, start]) => start);

      expect(starts).toEqual([...starts].sort());
    });

    it("is kept twice under 'concat', but still in order", async () => {
      const output = await generate({
        sites: [siteA],
        cache: cacheAcrossMidnight(),
        days: 2,
        startDay: DAY,
        now: NOW,
        merge: { programmeStrategy: 'concat' },
      });
      const starts = [...output.matchAll(/start=["'](\d+)/g)].map(([, start]) => start);

      expect(output.match(/Nočný film/g)).toHaveLength(2);
      expect(starts).toEqual([...starts].sort());
    });

    it('still emits a programme only the later day knew about', async () => {
      const output = await generate({
        sites: [siteA],
        cache: cacheAcrossMidnight(),
        days: 2,
        startDay: DAY,
        now: NOW,
      });

      expect(output).toContain('Ráno');
      expect(output).toContain('Správy');
    });

    it('merges what the two days each knew about it', async () => {
      const cache = createFakeCache({
        [`site-a.sk|X|${DAY}`]: [prog('X', '2026-01-15T23:30:00Z', 'Nočný film', 'sk')],
        [`site-a.sk|X|${NEXT_DAY}`]: [
          prog('X', '2026-01-15T23:30:00Z', 'Night Film', 'en', {
            stop: new Date('2026-01-16T01:10:00Z'),
          }),
        ],
      });

      const output = await generate({
        sites: [siteA],
        cache,
        days: 2,
        startDay: DAY,
        now: NOW,
      });

      expect(output.match(/<programme/g)).toHaveLength(1);
      // The day that had a stop time contributed it; both titles survive.
      expect(output).toContain('stop=');
      expect(output).toContain('Nočný film');
      expect(output).toContain('Night Film');
    });
  });

  describe('cleaning up the output', () => {
    const NEXT_DAY = '2026-01-16';

    /** The `<programme>` elements as (start, stop) pairs, in document order. */
    function emitted(output: string): { start: string; stop?: string }[] {
      return [
        ...output.matchAll(/<programme start="(\d{14})[^"]*"(?: stop="(\d{14})[^"]*")?/g),
      ].map(([, start, stop]) =>
        stop === undefined ? { start: start! } : { start: start!, stop },
      );
    }

    const site = makeSite('site-a.sk', [{ xmltvId: 'X', siteId: 'a-x' }]);

    function cacheWith(programmes: XmltvProgramme[], day = DAY): CacheStore {
      return createFakeCache({ [`site-a.sk|X|${day}`]: programmes });
    }

    const one = (
      options: Partial<BuildGuideOptions> = {},
      cache = cacheWith([]),
    ): Promise<string> =>
      generate({ sites: [site], cache, days: 1, startDay: DAY, now: NOW, ...options });

    describe('fillStop', () => {
      it("gives a programme with no stop the next one's start", async () => {
        const output = await one(
          {},
          cacheWith([
            prog('X', '2026-01-15T10:00:00Z', 'A'),
            prog('X', '2026-01-15T11:30:00Z', 'B'),
          ]),
        );

        expect(emitted(output)).toEqual([
          { start: '20260115100000', stop: '20260115113000' },
          // The last one has nothing to take an end from.
          { start: '20260115113000' },
        ]);
      });

      it('caps it at six hours, leaving the gap a channel goes off air for', async () => {
        const output = await one(
          {},
          cacheWith([
            prog('X', '2026-01-15T01:00:00Z', 'Overnight'),
            prog('X', '2026-01-15T12:00:00Z', 'Noon'),
          ]),
        );

        expect(emitted(output)[0]).toEqual({ start: '20260115010000', stop: '20260115070000' });
      });

      it('takes a cap of its own', async () => {
        const output = await one(
          { merge: { fillStop: { maxMs: 30 * 60_000 } } },
          cacheWith([
            prog('X', '2026-01-15T10:00:00Z', 'A'),
            prog('X', '2026-01-15T12:00:00Z', 'B'),
          ]),
        );

        expect(emitted(output)[0]).toEqual({ start: '20260115100000', stop: '20260115103000' });
      });

      it('leaves an existing stop alone', async () => {
        const output = await one(
          {},
          cacheWith([
            prog('X', '2026-01-15T10:00:00Z', 'A', undefined, {
              stop: new Date('2026-01-15T10:45:00Z'),
            }),
            prog('X', '2026-01-15T11:30:00Z', 'B'),
          ]),
        );

        expect(emitted(output)[0]).toEqual({ start: '20260115100000', stop: '20260115104500' });
      });

      it('is off when told to be', async () => {
        const output = await one(
          { merge: { fillStop: false } },
          cacheWith([
            prog('X', '2026-01-15T10:00:00Z', 'A'),
            prog('X', '2026-01-15T11:30:00Z', 'B'),
          ]),
        );

        expect(emitted(output)).toEqual([{ start: '20260115100000' }, { start: '20260115113000' }]);
      });

      it("reaches across the day boundary for the next day's first programme", async () => {
        const cache = createFakeCache({
          [`site-a.sk|X|${DAY}`]: [prog('X', '2026-01-15T23:30:00Z', 'Late')],
          [`site-a.sk|X|${NEXT_DAY}`]: [prog('X', '2026-01-16T00:15:00Z', 'Later')],
        });

        const output = await one({ cache, days: 2 });

        // The day held back for merging is the same day that supplies this.
        expect(emitted(output)[0]).toEqual({ start: '20260115233000', stop: '20260116001500' });
      });
    });

    describe('clipOverlaps', () => {
      const overlapping = (): XmltvProgramme[] => [
        prog('X', '2026-01-15T10:00:00Z', 'A', undefined, {
          stop: new Date('2026-01-15T11:00:00Z'),
        }),
        prog('X', '2026-01-15T10:45:00Z', 'B', undefined, {
          stop: new Date('2026-01-15T11:30:00Z'),
        }),
      ];

      it('pulls a stop back to the next start', async () => {
        const output = await one({}, cacheWith(overlapping()));

        expect(emitted(output)[0]).toEqual({ start: '20260115100000', stop: '20260115104500' });
      });

      it('leaves a stop that reaches exactly to the next start', async () => {
        const output = await one(
          {},
          cacheWith([
            prog('X', '2026-01-15T10:00:00Z', 'A', undefined, {
              stop: new Date('2026-01-15T10:45:00Z'),
            }),
            prog('X', '2026-01-15T10:45:00Z', 'B'),
          ]),
        );

        expect(emitted(output)[0]).toEqual({ start: '20260115100000', stop: '20260115104500' });
      });

      it('is off when told to be', async () => {
        const output = await one({ merge: { clipOverlaps: false } }, cacheWith(overlapping()));

        expect(emitted(output)[0]).toEqual({ start: '20260115100000', stop: '20260115110000' });
      });
    });

    describe('clampToWindow', () => {
      const spilling = (): CacheStore =>
        cacheWith([
          prog('X', '2026-01-14T23:00:00Z', 'Before'),
          prog('X', '2026-01-15T10:00:00Z', 'Inside'),
          prog('X', '2026-01-16T02:00:00Z', 'After'),
        ]);

      it('keeps what a source spilled either side, by default', async () => {
        expect(emitted(await one({}, spilling()))).toHaveLength(3);
      });

      it('leaves out what starts outside the window when asked', async () => {
        const output = await one({ merge: { clampToWindow: true } }, spilling());

        expect(emitted(output)).toEqual([{ start: '20260115100000' }]);
      });
    });

    describe("a site's own transform", () => {
      it('runs before the merge, so what it returns is what merges', async () => {
        const siteB = makeSite('site-b.com', [{ xmltvId: 'X', siteId: 'b-x' }]);
        const shouty: SiteConfig<unknown> = {
          ...siteB,
          transform: (programme) => ({
            ...programme,
            title: programme.title.map((title) => ({ ...title, value: title.value.toUpperCase() })),
          }),
        };
        const cache = createFakeCache({
          [`site-a.sk|X|${DAY}`]: [prog('X', '2026-01-15T10:00:00Z', 'Správy', 'sk')],
          [`site-b.com|X|${DAY}`]: [prog('X', '2026-01-15T10:00:00Z', 'News', 'en')],
        });

        const output = await generate({
          sites: [site, shouty],
          cache,
          days: 1,
          startDay: DAY,
          now: NOW,
        });

        expect(output).toContain('Správy');
        expect(output).toContain('NEWS');
        expect(output).not.toContain('>News<');
      });

      it('closes the gap when it drops one, since the rules run after it', async () => {
        const filtered: SiteConfig<unknown> = {
          ...site,
          transform: (programme) => (programme.title[0]?.value === 'Filler' ? null : programme),
        };

        const output = await generate({
          sites: [filtered],
          cache: cacheWith([
            prog('X', '2026-01-15T10:00:00Z', 'A'),
            prog('X', '2026-01-15T10:30:00Z', 'Filler'),
            prog('X', '2026-01-15T11:00:00Z', 'B'),
          ]),
          days: 1,
          startDay: DAY,
          now: NOW,
        });

        // A's end is B's start, not the dropped programme's.
        expect(emitted(output)).toEqual([
          { start: '20260115100000', stop: '20260115110000' },
          { start: '20260115110000' },
        ]);
      });

      it('is told which channel-day it is looking at', async () => {
        const seen: string[] = [];
        const noting: SiteConfig<unknown> = {
          ...site,
          transform: (programme, { channel, day, date }) => {
            seen.push(`${channel.xmltvId} ${channel.siteId} ${day} ${date.toISOString()}`);
            return programme;
          },
        };

        await generate({
          sites: [noting],
          cache: cacheWith([prog('X', '2026-01-15T10:00:00Z', 'A')]),
          days: 1,
          startDay: DAY,
          now: NOW,
        });

        expect(seen).toEqual([`X a-x ${DAY} 2026-01-15T00:00:00.000Z`]);
      });

      it('leaves the cache entry it was handed alone', async () => {
        const cached = [prog('X', '2026-01-15T10:00:00Z', 'A')];
        const cache = cacheWith(cached);
        const options = {
          sites: [
            {
              ...site,
              transform: (programme: XmltvProgramme) => ({ ...programme, title: [{ value: 'B' }] }),
            } as SiteConfig<unknown>,
          ],
          cache,
          days: 1,
          startDay: DAY,
          now: NOW,
        };

        expect(await generate(options)).toContain('B');
        // The same entry, read again: a store that keeps its programmes in
        // memory hands out the objects themselves.
        expect(await generate(options)).toContain('B');
        expect(cached[0]?.title).toEqual([{ value: 'A' }]);
      });
    });

    describe('the guide-wide transform', () => {
      it('sees the stop the rules filled in, and what follows', async () => {
        const seen: { start: string; stop?: string; next?: string }[] = [];

        await one(
          {
            merge: {
              transform: (programme, { next }) => {
                seen.push({
                  start: programme.start.toISOString(),
                  ...(programme.stop ? { stop: programme.stop.toISOString() } : {}),
                  ...(next ? { next: next.start.toISOString() } : {}),
                });

                return programme;
              },
            },
          },
          cacheWith([
            prog('X', '2026-01-15T10:00:00Z', 'A'),
            prog('X', '2026-01-15T11:30:00Z', 'B'),
          ]),
        );

        expect(seen).toEqual([
          {
            start: '2026-01-15T10:00:00.000Z',
            stop: '2026-01-15T11:30:00.000Z',
            next: '2026-01-15T11:30:00.000Z',
          },
          { start: '2026-01-15T11:30:00.000Z' },
        ]);
      });

      it('leaves out what it returns nothing for', async () => {
        const output = await one(
          {
            merge: {
              transform: (programme) => (programme.title[0]?.value === 'B' ? null : programme),
            },
          },
          cacheWith([
            prog('X', '2026-01-15T10:00:00Z', 'A'),
            prog('X', '2026-01-15T11:30:00Z', 'B'),
          ]),
        );

        expect(emitted(output)).toEqual([{ start: '20260115100000', stop: '20260115113000' }]);
      });

      it('can rewrite a programme on its way out', async () => {
        const output = await one(
          {
            merge: {
              transform: (programme) => ({
                ...programme,
                category: [{ value: 'Movie', lang: 'en' }],
              }),
            },
          },
          cacheWith([prog('X', '2026-01-15T10:00:00Z', 'A')]),
        );

        expect(output).toContain('<category lang="en">Movie</category>');
      });
    });
  });

  describe('derived channels', () => {
    const site = makeSite('site-a.sk', [{ xmltvId: 'X', siteId: 'a-x', name: 'Sky One' }]);
    const DAY2 = '2026-01-16';

    /** Every `<programme>` as `channel start`, in document order. */
    function aired(output: string): string[] {
      return [...output.matchAll(/<programme ([^>]*?)>/g)].map(([, attrs]) => {
        const start = /start="(\d{14})/.exec(attrs!)?.[1];
        const channel = /channel="([^"]*)"/.exec(attrs!)?.[1];

        return `${channel} ${start}`;
      });
    }

    const withDays = (entries: Record<string, XmltvProgramme[]>): CacheStore =>
      createFakeCache(entries);

    const guide = (
      derived: BuildGuideOptions['derived'],
      cache: CacheStore,
      options: Partial<BuildGuideOptions> = {},
    ): Promise<string> =>
      generate({
        sites: [site],
        cache,
        days: 1,
        startDay: DAY,
        now: NOW,
        ...(derived ? { derived } : {}),
        ...options,
      });

    it('publishes a channel of its own, with every programme under its id', async () => {
      const output = await guide(
        [{ xmltvId: 'X.plus1', from: 'X', offset: 60 }],
        withDays({ [`site-a.sk|X|${DAY}`]: [prog('X', '2026-01-15T10:00:00Z', 'A')] }),
      );

      expect(output).toContain('<channel id="X.plus1">');
      // The name a playlist uses for it, built from the source's own.
      expect(output).toContain('<display-name>Sky One +1</display-name>');
      expect(aired(output)).toEqual(['X 20260115100000', 'X.plus1 20260115110000']);
    });

    // The one worth being explicit about: a shift moves programmes across the
    // day boundary, so the day the merge holds back has to carry them — and the
    // programme both days report has to still be recognized after the move.
    it('carries a programme across midnight, once', async () => {
      const midnight = prog('X', '2026-01-15T23:30:00Z', 'Midnight');
      const output = await guide(
        [{ xmltvId: 'X.plus1', from: 'X', offset: 60 }],
        withDays({
          [`site-a.sk|X|${DAY}`]: [prog('X', '2026-01-15T22:00:00Z', 'Late'), midnight],
          // The same programme again, as a source whose day runs to 06:00 does.
          [`site-a.sk|X|${DAY2}`]: [midnight, prog('X', '2026-01-16T09:00:00Z', 'Morning')],
        }),
        { days: 2 },
      );

      expect(aired(output)).toEqual([
        'X 20260115220000',
        'X 20260115233000',
        'X 20260116090000',
        'X.plus1 20260115230000',
        'X.plus1 20260116003000',
        'X.plus1 20260116100000',
      ]);
    });

    it('keeps the offset each date was published in', async () => {
      const { xmltvDate } = await import('../src/xmltv/main.js');
      const output = await guide(
        [{ xmltvId: 'X.plus1', from: 'X', offset: 60 }],
        withDays({
          [`site-a.sk|X|${DAY}`]: [
            {
              ...prog('X', '2026-01-15T08:00:00Z', 'A'),
              start: xmltvDate(new Date('2026-01-15T08:00:00Z'), { offset: 120 }),
            },
          ],
        }),
      );

      // 10:00 +0200 an hour later is 11:00 +0200 — not 09:00 UTC.
      expect(output).toMatch(/start="20260115110000 ?\+0200"/);
    });

    it('leaves the production year and an earlier airing where they were', async () => {
      const output = await guide(
        [{ xmltvId: 'X.plus1', from: 'X', offset: 60 }],
        withDays({
          [`site-a.sk|X|${DAY}`]: [
            prog('X', '2026-01-15T10:00:00Z', 'A', undefined, {
              date: new Date('2020-01-01T00:00:00Z'),
              previouslyShown: { start: new Date('2019-05-05T20:00:00Z') },
            }),
          ],
        }),
      );

      expect(output).toContain('20200101000000');
      expect(output).toContain('20190505200000');
    });

    it('sums a chain of shifts', async () => {
      const output = await guide(
        [
          { xmltvId: 'X.plus1', from: 'X', offset: 60 },
          { xmltvId: 'X.plus2', from: 'X.plus1', offset: 60 },
        ],
        withDays({ [`site-a.sk|X|${DAY}`]: [prog('X', '2026-01-15T10:00:00Z', 'A')] }),
      );

      expect(aired(output)).toEqual([
        'X 20260115100000',
        'X.plus1 20260115110000',
        'X.plus2 20260115120000',
      ]);
    });

    it('keeps the source name, and says so, for an offset it cannot spell', async () => {
      const report = collectEvents();
      const output = await guide(
        [{ xmltvId: 'X.plus90', from: 'X', offset: 90 }],
        withDays({ [`site-a.sk|X|${DAY}`]: [prog('X', '2026-01-15T10:00:00Z', 'A')] }),
        { reporter: report.reporter },
      );

      expect(output).toContain('<display-name>Sky One</display-name>');
      expect(aired(output)).toContain('X.plus90 20260115113000');
      expect(report.of('merge:warning')[0]?.message).toMatch(/no name to say it with/);
    });

    it('goes on without a channel nothing produces, rather than failing', async () => {
      const report = collectEvents();
      const output = await guide(
        [{ xmltvId: 'Y.plus1', from: 'Y', offset: 60 }],
        withDays({ [`site-a.sk|X|${DAY}`]: [prog('X', '2026-01-15T10:00:00Z', 'A')] }),
        { reporter: report.reporter },
      );

      expect(output).not.toContain('Y.plus1');
      expect(report.of('merge:warning')[0]?.message).toMatch(/which no site produces/);
    });

    it.each([
      [
        'a cycle',
        [
          { xmltvId: 'A1', from: 'A2', offset: 60 },
          { xmltvId: 'A2', from: 'A1', offset: 60 },
        ],
        /shifts itself/,
      ],
      ['itself', [{ xmltvId: 'X.plus1', from: 'X.plus1', offset: 60 }], /shifts itself/],
      ['a channel a site produces', [{ xmltvId: 'X', from: 'X', offset: 60 }], /shifts itself/],
      ['a day or more', [{ xmltvId: 'X.plus24', from: 'X', offset: 1440 }], /a day or more/],
      [
        'half a minute',
        [{ xmltvId: 'X.half', from: 'X', offset: 0.5 }],
        /not a whole number of minutes/,
      ],
      [
        'no shift at all',
        [{ xmltvId: 'X.same', from: 'X', offset: 0 }],
        /not a whole number of minutes/,
      ],
      [
        'the same id twice',
        [
          { xmltvId: 'X.plus1', from: 'X', offset: 60 },
          { xmltvId: 'X.plus1', from: 'X', offset: 120 },
        ],
        /declared twice/,
      ],
    ])('refuses %s', async (_what, derived, expected) => {
      await expect(guide(derived, withDays({ [`site-a.sk|X|${DAY}`]: [] }))).rejects.toThrow(
        expected,
      );
    });

    it('refuses an id a site already produces', async () => {
      await expect(
        guide([{ xmltvId: 'X', from: 'Z', offset: 60 }], withDays({ [`site-a.sk|X|${DAY}`]: [] })),
      ).rejects.toThrow(/a channel a site already produces/);
    });

    it("refuses a source 'keep-all' produces more than once", async () => {
      const second = makeSite('site-b.sk', [{ xmltvId: 'X', siteId: 'b-x' }]);

      await expect(
        generate({
          sites: [site, second],
          cache: withDays({ [`site-a.sk|X|${DAY}`]: [] }),
          days: 1,
          startDay: DAY,
          now: NOW,
          derived: [{ xmltvId: 'X.plus1', from: 'X', offset: 60 }],
          merge: { channelStrategy: 'keep-all' },
        }),
      ).rejects.toThrow(/more than one site produces/);
    });

    describe('the window it can fill', () => {
      const cache = (): CacheStore =>
        withDays({
          [`site-a.sk|X|${DAY}`]: [
            prog('X', '2026-01-15T00:30:00Z', 'First'),
            prog('X', '2026-01-15T23:30:00Z', 'Last'),
          ],
        });

      it('overhangs the end by its offset, by default', async () => {
        const output = await guide([{ xmltvId: 'X.plus1', from: 'X', offset: 60 }], cache());

        // 23:30 + 1h is the next day, past the window — kept, like any spill.
        expect(aired(output)).toContain('X.plus1 20260116003000');
      });

      it('has that overhang clamped off when the window is enforced', async () => {
        const output = await guide([{ xmltvId: 'X.plus1', from: 'X', offset: 60 }], cache(), {
          merge: { clampToWindow: true },
        });

        // Clamped on its own hours, not the source's: 01:30 is inside, 00:30
        // of the next day is not.
        expect(aired(output).filter((line) => line.startsWith('X.plus1'))).toEqual([
          'X.plus1 20260115013000',
        ]);
      });
    });
  });

  describe('reading the cache ahead of the writer', () => {
    /** A cache that records the order reads were started in, and their overlap. */
    function tracingCache(): {
      cache: CacheStore;
      order: string[];
      peak: () => number;
    } {
      const order: string[] = [];
      let inFlight = 0;
      let peak = 0;

      return {
        cache: {
          ...createFakeCache(),
          async read(key: ChannelDayKey): Promise<XmltvProgramme[] | undefined> {
            order.push(`${key.channelId} ${key.day}`);
            inFlight++;
            peak = Math.max(peak, inFlight);
            // A turn of the event loop, so an overlap is observable.
            await new Promise((resolve) => setTimeout(resolve, 1));
            inFlight--;

            return [prog(key.channelId, `${key.day}T10:00:00Z`, `p-${key.channelId}-${key.day}`)];
          },
        },
        order,
        peak: () => peak,
      };
    }

    const CHANNELS = ['A', 'B', 'C'];
    const DAYS = ['2026-01-15', '2026-01-16', '2026-01-17', '2026-01-18'];
    const site = makeSite(
      'site-a.sk',
      CHANNELS.map((id) => ({ xmltvId: id, siteId: `a-${id}` })),
    );

    it('overlaps reads, in the order the writer needs them', async () => {
      const { cache, order, peak } = tracingCache();

      const output = await generate({
        sites: [site],
        cache,
        days: DAYS.length,
        startDay: DAYS[0]!,
        now: NOW,
      });

      // Every channel-day, each read once, in the order it is written.
      expect(order).toEqual(CHANNELS.flatMap((id) => DAYS.map((day) => `${id} ${day}`)));
      // And they overlapped: strictly serial reads are what this replaces.
      expect(peak()).toBeGreaterThan(1);

      // The guide itself is unaffected — same channels, in the same order.
      expect([...output.matchAll(/channel="(\w+)"/g)].map(([, id]) => id)).toEqual(
        CHANNELS.flatMap((id) => DAYS.map(() => id)),
      );
    });

    it('holds no more than readAhead of them at once', async () => {
      const { cache, peak } = tracingCache();

      await generate({
        sites: [site],
        cache,
        days: DAYS.length,
        startDay: DAYS[0]!,
        now: NOW,
        readAhead: 2,
      });

      expect(peak()).toBe(2);
    });

    it('reads one at a time when told to', async () => {
      const { cache, peak } = tracingCache();

      await generate({
        sites: [site],
        cache,
        days: DAYS.length,
        startDay: DAYS[0]!,
        now: NOW,
        readAhead: 1,
      });

      expect(peak()).toBe(1);
    });

    it('surfaces a failed read rather than losing it in the window', async () => {
      const cache = Object.assign(createFakeCache(), {
        async read(key: ChannelDayKey): Promise<XmltvProgramme[] | undefined> {
          if (key.channelId === 'B') {
            throw new Error('cache entry is unreadable');
          }

          return [prog(key.channelId, `${key.day}T10:00:00Z`, 'p')];
        },
      });

      await expect(
        generate({
          sites: [site],
          cache,
          days: DAYS.length,
          startDay: DAYS[0]!,
          now: NOW,
        }),
      ).rejects.toThrow('cache entry is unreadable');
    });
  });

  it('reports each channel as it is finished', async () => {
    const report = collectEvents();

    await generate({
      sites: [siteA, siteB],
      cache: cacheForBothSites(),
      days: 1,
      now: NOW,
      reporter: report.reporter,
    });

    expect(report.of('merge:channel')).toEqual([
      expect.objectContaining({ channelId: 'X', level: 'debug', phase: 'merge' }),
    ]);
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
