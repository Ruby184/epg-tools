import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { CacheStore, ChannelDayKey } from '../src/cache/types.js';
import type { EpgEvent } from '../src/core/events.js';
import type { GrabberChannel, SiteConfig } from '../src/grabber/types.js';
import { mergeChannels } from '../src/merge/channel.js';
import { mergeProgrammeLists, mergeProgrammes, resolveMatch } from '../src/merge/programme.js';
import { normalizeTitle } from '../src/merge/text.js';
import { DEFAULT_UNION, ResolvedUnion, resolveUnion } from '../src/merge/union.js';
import { parseXmltvDate } from '../src/xmltv/main.js';
import type { BuildGuideOptions, MergeUnion } from '../src/merge/types.js';
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

describe('merge.union', () => {
  const at = new Date('2026-01-15T20:00:00Z');
  /** Two programmes for one broadcast, carrying `base` and `extra`'s texts. */
  const merge = (
    base: Partial<XmltvProgramme>,
    extra: Partial<XmltvProgramme>,
    union?: MergeUnion | 'exact',
  ): XmltvProgramme =>
    resolveUnion(union).apply(
      mergeProgrammes(
        { channel: 'X', start: at, title: [{ value: 'A' }], ...base },
        { channel: 'X', start: at, title: [{ value: 'A' }], ...extra },
      ),
    );
  const values = (texts: { value: string }[] | undefined) => texts?.map(({ value }) => value);

  it('takes titles the same by the match’s comparison for one, the first kept', () => {
    const merged = merge(
      { title: [{ value: 'Správy', lang: 'sk' }] },
      {
        title: [
          { value: 'SPRAVY  ', lang: 'sk' },
          { value: 'News', lang: 'en' },
        ],
      },
    );

    expect(merged.title).toEqual([
      { value: 'Správy', lang: 'sk' },
      { value: 'News', lang: 'en' },
    ]);
  });

  it('takes categories, keywords and countries the same but for case for one', () => {
    const merged = merge(
      { category: [{ value: 'Film' }], keyword: [{ value: 'Drama' }], country: [{ value: 'SK' }] },
      { category: [{ value: 'film' }], keyword: [{ value: 'drama ' }], country: [{ value: 'sk' }] },
    );

    expect([values(merged.category), values(merged.keyword), values(merged.country)]).toEqual([
      ['Film'],
      ['Drama'],
      ['SK'],
    ]);
  });

  it('drops a description another contains, the fuller one taking its place', () => {
    const merged = merge(
      {
        desc: [
          { value: 'Príbeh o láske…', lang: 'sk' },
          { value: 'A story of love.', lang: 'en' },
        ],
      },
      {
        desc: [
          { value: 'Príbeh o láske a vojne na Slovensku.', lang: 'sk' },
          // In another language, so nothing to compare it with.
          { value: 'Príbeh o láske', lang: 'cs' },
        ],
      },
    );

    expect(values(merged.desc)).toEqual([
      'Príbeh o láske a vojne na Slovensku.',
      'A story of love.',
      'Príbeh o láske',
    ]);
  });

  it('keeps every spelling a field is set to exact on', () => {
    const merged = merge(
      { category: [{ value: 'Film' }] },
      { category: [{ value: 'film' }] },
      { category: 'exact' },
    );

    expect(values(merged.category)).toEqual(['Film', 'film']);
  });

  it('compares as a function of its own says', () => {
    const merged = merge(
      { title: [{ value: 'Priatelia I.' }] },
      { title: [{ value: 'Priatelia' }] },
      { title: (value) => value.replace(/\s+[IVX]+\.?$/, '') },
    );

    expect(values(merged.title)).toEqual(['Priatelia I.']);
  });

  it('finds one description inside another as a function of its own compares them', () => {
    const merged = merge(
      { desc: [{ value: 'Správy dňa. (skryté titulky)' }] },
      { desc: [{ value: 'Správy dňa. Počasie a šport.' }] },
      { desc: { contained: (value) => value.replace(/\s*\(skryté titulky\)$/, '') } },
    );

    expect(values(merged.desc)).toEqual(['Správy dňa. Počasie a šport.']);
  });

  it('takes titles for one by a match’s own normalizeTitle', () => {
    const loose = (title: string) => title.toLowerCase().replace(/[^\p{L}]+/gu, '');
    const [merged] = mergeProgrammeLists(
      [
        [prog('X', '2026-01-15T20:00:00Z', 'DJ Mixes premiere')],
        [prog('X', '2026-01-15T20:00:00Z', 'Dj-Mixes Premiere!')],
      ],
      'merge',
      { normalizeTitle: loose },
    );

    expect(values(merged?.title)).toEqual(['DJ Mixes premiere']);
  });

  it('applies to a source’s own rows for one broadcast, as configured', () => {
    // Two rows at one instant in one source's list are pooled into one programme.
    const [pooled] = mergeProgrammeLists(
      [
        [
          prog('X', '2026-01-15T20:00:00Z', 'Film', undefined, { category: [{ value: 'Film' }] }),
          prog('X', '2026-01-15T20:00:00Z', 'Film', undefined, { category: [{ value: 'film' }] }),
        ],
      ],
      'merge',
      undefined,
      undefined,
      { category: 'exact' },
    );

    expect(values(pooled?.category)).toEqual(['Film', 'film']);
  });

  it('leaves a numeral the default comparison keeps', () => {
    // Folding case, accents and spacing is all the default does; a numeral
    // takes a looser normalizeTitle, or a title function of its own.
    const merged = merge(
      { title: [{ value: 'Priatelia I.' }] },
      { title: [{ value: 'Priatelia' }] },
    );

    expect(values(merged.title)).toEqual(['Priatelia I.', 'Priatelia']);
  });

  it('still merges a third source whose title only the dropped spelling matches', () => {
    // A title rule looser than the match: had the second spelling been dropped
    // as A and B merged, C's shifted start would have had nothing to match.
    const merged = mergeProgrammeLists(
      [
        [prog('X', '2026-01-15T20:00:00Z', 'Priatelia I.')],
        [prog('X', '2026-01-15T20:00:00Z', 'Priatelia')],
        [prog('X', '2026-01-15T20:03:00Z', 'Priatelia')],
      ],
      'merge',
      undefined,
      undefined,
      { title: (value) => value.replace(/\s+[IVX]+\.?$/, '') },
    );

    expect(merged.map((programme) => values(programme.title))).toEqual([['Priatelia I.']]);
  });

  it('compares descriptions as contained does after a function of its own', () => {
    const merged = merge(
      { desc: [{ value: 'Správy dňa…' }] },
      { desc: [{ value: 'SPRÁVY DŇA. Počasie a šport. (skryté titulky)' }] },
      { desc: { contained: (value) => value.replace(/\s*\(skryté titulky\)$/, '') } },
    );

    expect(values(merged.desc)).toEqual(['SPRÁVY DŇA. Počasie a šport. (skryté titulky)']);
  });

  it('takes a text with no language and one with an empty one as in one language', () => {
    const merged = merge(
      { desc: [{ value: 'Príbeh o láske…', lang: '' }] },
      { desc: [{ value: 'Príbeh o láske a vojne.' }] },
    );

    expect(values(merged.desc)).toEqual(['Príbeh o láske a vojne.']);
  });

  it('compares letters written in either Unicode form as one', () => {
    const merged = merge(
      { category: [{ value: 'Dráma'.normalize('NFC') }] },
      { category: [{ value: 'Dráma'.normalize('NFD') }] },
    );

    expect(merged.category).toHaveLength(1);
  });

  it('takes categories one genre is for one, as a profile does', () => {
    const merged = merge({ category: [{ value: 'Sci-Fi' }] }, { category: [{ value: 'Sci Fi' }] });

    expect(values(merged.category)).toEqual(['Sci-Fi']);
  });

  it('keeps every spelling of every field under exact on its own', () => {
    const merged = merge(
      { title: [{ value: 'Správy' }], category: [{ value: 'Film' }] },
      { title: [{ value: 'správy' }], category: [{ value: 'film' }] },
      'exact',
    );

    expect([values(merged.title), values(merged.category)]).toEqual([
      ['Správy', 'správy'],
      ['Film', 'film'],
    ]);
  });

  it('refuses a field it does not have, and a union that is no object', () => {
    expect(() => resolveUnion({ description: 'exact' } as never)).toThrow(
      'merge.union has no field "description": its fields are title, subTitle, desc, category, keyword, country',
    );
    expect(() => resolveUnion(null as never)).toThrow("merge.union must be 'exact' or an object");
  });

  it('takes one already settled as it is, for the match it was settled with', () => {
    const loose = (title: string) => title.replace(/\s+[IVX]+\.?$/, '');
    const settled = resolveUnion({ title: 'match' }, loose);

    expect(resolveUnion(settled, loose)).toBe(settled);
    expect(
      settled.apply({
        ...prog('X', '2026-01-15T20:00:00Z', 'Priatelia I.'),
        title: [{ value: 'Priatelia I.' }, { value: 'Priatelia' }],
      }).title,
    ).toEqual([{ value: 'Priatelia I.' }]);
  });

  it('takes its titles by a match of options, and by the default for a matcher of its own', () => {
    const own = (title: string) => title;

    expect(resolveMatch({ normalizeTitle: own }).normalizeTitle).toBe(own);
    expect(resolveMatch(() => true).normalizeTitle).toBe(normalizeTitle);
    expect(resolveMatch({ windowMs: 1, matches: () => true }).normalizeTitle).toBe(normalizeTitle);
  });

  it('settles one already settled again for a match that has changed since', () => {
    const settled = resolveUnion({ title: 'match' });
    const loose = (title: string) => title.replace(/\s+[IVX]+\.?$/, '');
    const again = resolveUnion(settled, loose);

    expect(again).not.toBe(settled);
    expect(
      again.apply({
        ...prog('X', '2026-01-15T20:00:00Z', 'Priatelia I.'),
        title: [{ value: 'Priatelia I.' }, { value: 'Priatelia' }],
      }).title,
    ).toEqual([{ value: 'Priatelia I.' }]);
  });

  it('takes one settled by another copy of the package for one', () => {
    // What another install's would look like from here: its own class, the
    // same registered brand holding its comparison, and the fields it was
    // settled from as its own.
    class Theirs {
      readonly desc = 'exact';

      apply(programme: XmltvProgramme): XmltvProgramme {
        return programme;
      }
    }

    const theirs = Object.defineProperty(new Theirs(), Symbol.for('epg-tools.ResolvedUnion'), {
      value: normalizeTitle,
    });

    expect(theirs instanceof ResolvedUnion).toBe(true);
    expect(resolveUnion(theirs as never)).toBe(theirs);
    // Settled again for another comparison, from its own fields.
    expect(
      resolveUnion(theirs as never, (title) => title).apply({
        ...prog('X', '2026-01-15T20:00:00Z', 'A'),
        desc: [{ value: 'Príbeh…' }, { value: 'Príbeh o láske.' }],
      }).desc,
    ).toHaveLength(2);
  });

  it('takes a copy of a settled one for the union it was settled from', () => {
    const settled = resolveUnion({ category: 'exact' });
    const programme = {
      ...prog('X', '2026-01-15T20:00:00Z', 'A'),
      category: [{ value: 'Film' }, { value: 'film' }],
      desc: [{ value: 'Príbeh…' }, { value: 'Príbeh o láske.' }],
    };

    // A spread keeps what it was settled from and none of what it was settled into.
    const changed = resolveUnion({ ...settled, desc: 'exact' });

    expect(values(changed.apply(programme).category)).toEqual(['Film', 'film']);
    expect(values(changed.apply(programme).desc)).toEqual(['Príbeh…', 'Príbeh o láske.']);
    expect(resolveUnion(structuredClone({ ...settled })).apply(programme).category).toHaveLength(2);
  });

  it('refuses what a union cannot be, naming it by what it is', () => {
    expect(() => resolveUnion(new Map([['desc', 'exact']]) as never)).toThrow(
      '(got an instance of Map)',
    );
    expect(() => new ResolvedUnion({ description: 'exact' } as never)).toThrow(
      'merge.union has no field "description"',
    );
  });

  it('keeps its defaults as they are, whoever holds them', () => {
    expect(Object.isFrozen(DEFAULT_UNION)).toBe(true);
  });

  it('keeps a short description that is a word of a longer one rather than the same', () => {
    const merged = merge(
      { desc: [{ value: 'Krimi' }] },
      { desc: [{ value: 'Krimiseriál o vyšetrovateľovi.' }] },
    );

    expect(values(merged.desc)).toEqual(['Krimi', 'Krimiseriál o vyšetrovateľovi.']);
  });

  it('takes a teaser cut off part way through a word for the whole of it', () => {
    const merged = merge(
      { desc: [{ value: 'Príbeh o lás…' }] },
      { desc: [{ value: 'Príbeh o láske a vojne.' }] },
    );

    expect(values(merged.desc)).toEqual(['Príbeh o láske a vojne.']);
  });

  it('leaves texts as the sources gave them under exact, a source’s own repeats included', () => {
    const programme = {
      ...prog('X', '2026-01-15T20:00:00Z', 'Film'),
      category: [{ value: 'Film' }, { value: 'Film' }],
    };

    expect(resolveUnion('exact').apply(programme)).toBe(programme);
  });

  it('takes a language tag in any case for one language', () => {
    const merged = merge(
      { title: [{ value: 'Správy', lang: 'sk' }] },
      { title: [{ value: 'SPRÁVY', lang: 'SK' }] },
    );

    expect(merged.title).toEqual([{ value: 'Správy', lang: 'sk' }]);
  });

  it('refuses a mode said as null, and names what it got whatever it is', () => {
    expect(() => resolveUnion({ desc: null as never })).toThrow(
      "merge.union.desc must be 'exact', 'caseless', 'match', 'contained', { contained: fn } or a function (got null)",
    );
    expect(() => resolveUnion(((value: string) => value) as never)).toThrow('(got a function)');
  });

  it('merges lists under concat with no match to speak of', () => {
    const merged = mergeProgrammeLists(
      [[prog('X', '2026-01-15T20:00:00Z', 'A')], [prog('X', '2026-01-15T19:00:00Z', 'B')]],
      'concat',
      null as never,
    );

    expect(merged.map((programme) => values(programme.title))).toEqual([['B'], ['A']]);
  });

  it('refuses a mode it does not know, naming the field', () => {
    expect(() => resolveUnion({ desc: 'containd' as never })).toThrow(
      "merge.union.desc must be 'exact', 'caseless', 'match', 'contained', { contained: fn } or a function (got \"containd\")",
    );
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

describe('why two programmes did not match', () => {
  const at = (start: string, title: string, stop?: string): XmltvProgramme => ({
    ...prog('X', start, title),
    ...(stop === undefined ? {} : { stop: parseXmltvDate(stop) }),
  });
  const why = (match: ReturnType<typeof resolveMatch>, a: XmltvProgramme, b: XmltvProgramme) =>
    match.apart(a, b);

  it('says the titles, the starts, both, or the runs, by the rules it matched by', () => {
    const match = resolveMatch();

    // Nothing, of one broadcast: one answer to whether they are, and why not.
    expect(why(match, at('2026-01-15T10:00:00Z', 'News'), at('2026-01-15T10:02:00Z', 'News'))).toBe(
      undefined,
    );

    expect(
      why(match, at('2026-01-15T10:00:00Z', 'News'), at('2026-01-15T10:02:00Z', 'Správy')),
    ).toBe('title');
    expect(why(match, at('2026-01-15T10:00:00Z', 'Film'), at('2026-01-15T10:07:00Z', 'Film'))).toBe(
      'start',
    );
    expect(why(match, at('2026-01-15T10:00:00Z', 'News'), at('2026-01-15T10:07:00Z', 'Film'))).toBe(
      'both',
    );
    // Near enough and the same title, but further apart than the shorter
    // lasts: two clips in a row, which no tolerance would join…
    expect(
      why(
        match,
        at('2026-01-15T10:00:00Z', 'Clip', '20260115100200 +0000'),
        at('2026-01-15T10:03:00Z', 'Clip', '20260115100500 +0000'),
      ),
    ).toBe('runs');
    // …or a segment within the show it is part of.
    expect(
      why(
        match,
        at('2026-01-15T06:00:00Z', 'Morning', '20260115090000 +0000'),
        at('2026-01-15T06:04:00Z', 'Morning', '20260115060600 +0000'),
      ),
    ).toBe('runs');
  });

  it('counts the titles only where they are compared', () => {
    // Never: the starts alone, whatever the titles say.
    expect(
      why(
        resolveMatch({ titles: 'never' }),
        at('2026-01-15T10:00:00Z', 'News'),
        at('2026-01-15T10:07:00Z', 'Správy'),
      ),
    ).toBe('start');
    // Always: on an identical start too.
    expect(
      why(
        resolveMatch({ titles: 'always' }),
        at('2026-01-15T10:00:00Z', 'News'),
        at('2026-01-15T10:00:00Z', 'Správy'),
      ),
    ).toBe('title');
  });

  it('says a matcher of one’s own said no, whatever the shipped rules would say', () => {
    // At the same instant, under the same title: its own reasons.
    expect(
      why(
        resolveMatch(() => false),
        at('2026-01-15T10:00:00Z', 'News'),
        at('2026-01-15T10:00:00Z', 'News'),
      ),
    ).toBe('matcher');
    // Titles the shipped rules would call different are its business too:
    // nothing of them is asked on its behalf.
    expect(
      why(
        resolveMatch({ windowMs: 180_000, matches: () => false }),
        at('2026-01-15T10:00:00Z', 'News'),
        at('2026-01-15T10:02:00Z', 'Správy'),
      ),
    ).toBe('matcher');
  });

  it('says a matcher with a window that two start beyond it, and never asks it', () => {
    const asked = vi.fn(() => true);

    expect(
      why(
        resolveMatch({ windowMs: 60_000, matches: asked }),
        at('2026-01-15T10:00:00Z', 'News'),
        at('2026-01-15T10:02:00Z', 'News'),
      ),
    ).toBe('start');
    expect(asked).not.toHaveBeenCalled();
  });
});

describe('mergeProgrammeLists start tolerance', () => {
  it('joins the nearest it matches, though a farther one comes after it', () => {
    const merged = mergeProgrammeLists(
      [
        [
          prog('X', '2026-01-15T10:00:00Z', 'News', 'sk'),
          prog('X', '2026-01-15T10:04:00Z', 'News', 'sk'),
        ],
        // A minute from the first, three from the second: both within reach.
        [
          prog('X', '2026-01-15T10:01:00Z', 'News', 'en', {
            desc: [{ value: 'the second source' }],
          }),
        ],
      ],
      'merge',
    );

    // Joined to the first — nearest — and the second left as it was.
    expect(merged).toHaveLength(2);
    expect(merged[0]!.desc).toEqual([{ value: 'the second source' }]);
    expect(merged[1]!.desc).toBeUndefined();
  });

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

  it('asks a matcher of its own only about what is near, when it says how near', () => {
    // A bare function is asked about everything, which is what makes a custom
    // matcher slow on a fortnight of listings. Saying how far it looks is what
    // keeps the walk short — and the proof is in what it was asked.
    const asked: number[] = [];
    const matches = (a: XmltvProgramme, b: XmltvProgramme): boolean => {
      asked.push(Math.abs(a.start.getTime() - b.start.getTime()));

      return false;
    };

    const day = Array.from({ length: 24 }, (_, hour) =>
      prog('X', `2026-01-15T${String(hour).padStart(2, '0')}:00:00Z`, `Show ${String(hour)}`, 'sk'),
    );
    const second = [prog('X', '2026-01-15T12:02:00Z', 'Show 12', 'en')];

    mergeProgrammeLists([day, second], 'merge', { windowMs: 600_000, matches });

    // Only the hours either side of 12:02, not the whole day.
    expect(asked).toHaveLength(1);
    expect(asked[0]).toBe(120_000);

    asked.length = 0;
    mergeProgrammeLists([day, second], 'merge', matches);

    // The same matcher without a window is offered every programme there is.
    expect(asked).toHaveLength(24);
  });

  it('takes a title rule of the caller’s own, which is cheaper than a matcher', () => {
    // What a provider adds to a title is a rule only the caller can write, and
    // writing it as a whole matcher means rediscovering the tolerance and the
    // duration guard to keep them.
    const merged = mergeProgrammeLists(
      [
        [prog('X', '2026-01-15T20:00:00Z', 'Film: Casablanca', 'sk')],
        [prog('X', '2026-01-15T20:02:00Z', 'Casablanca', 'en')],
      ],
      'merge',
      { normalizeTitle: (title) => title.replace(/^film:\s*/i, '').toLowerCase() },
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]?.title).toEqual([
      { value: 'Film: Casablanca', lang: 'sk' },
      { value: 'Casablanca', lang: 'en' },
    ]);
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

  it('hands a transform the next programme as it will be written', async () => {
    const cache = createFakeCache({
      [`site-a.sk|X|${DAY}`]: [
        prog('X', '2026-01-15T10:00:00Z', 'Správy', 'sk'),
        prog('X', '2026-01-15T11:00:00Z', 'Film', 'sk', {
          category: [{ value: 'Film' }, { value: 'film' }],
        }),
      ],
    });
    const seen: unknown[] = [];

    await generate({
      sites: [siteA],
      cache,
      days: 1,
      startDay: DAY,
      now: NOW,
      merge: {
        transform: (programme, { next }) => {
          if (next) seen.push(next.category);

          return programme;
        },
      },
    });

    expect(seen).toEqual([[{ value: 'Film' }]]);
  });

  it('takes them for one under backfill, and across the day boundary', async () => {
    const DAY2 = '2026-01-16';
    // One source, a broadcast across midnight in both days' entries, with its
    // category spelt two ways: merged as the days meet, written once.
    const cache = createFakeCache({
      [`site-a.sk|X|${DAY}`]: [
        prog('X', '2026-01-15T23:00:00Z', 'Film', 'sk', { category: [{ value: 'Film' }] }),
      ],
      [`site-a.sk|X|${DAY2}`]: [
        prog('X', '2026-01-15T23:00:00Z', 'Film', 'sk', { category: [{ value: 'film' }] }),
      ],
    });
    const categories = async (programmeStrategy: 'merge' | 'backfill') =>
      [
        ...(
          await generate({
            sites: [siteA],
            cache,
            days: 2,
            startDay: DAY,
            now: NOW,
            merge: { programmeStrategy },
          })
        ).matchAll(/<category[^>]*>([^<]*)<\/category>/g),
      ].map((found) => found[1]);

    expect(await categories('merge')).toEqual(['Film']);
    expect(await categories('backfill')).toEqual(['Film']);
  });

  it('takes texts two sites spell differently for one, as merge.union says', async () => {
    const cache = createFakeCache({
      [`site-a.sk|X|${DAY}`]: [
        prog('X', '2026-01-15T10:00:00Z', 'Správy', 'sk', { category: [{ value: 'News' }] }),
      ],
      [`site-b.com|X|${DAY}`]: [
        prog('X', '2026-01-15T10:00:00Z', 'Správy', 'sk', { category: [{ value: 'news' }] }),
      ],
    });
    const categories = async (merge: NonNullable<BuildGuideOptions['merge']>) =>
      [
        ...(
          await generate({ sites: [siteA, siteB], cache, days: 1, startDay: DAY, now: NOW, merge })
        ).matchAll(/<category[^>]*>([^<]*)<\/category>/g),
      ].map((found) => found[1]);

    expect(await categories({})).toEqual(['News']);
    expect(await categories({ union: { category: 'exact' } })).toEqual(['News', 'news']);
  });

  describe('dropContainers', () => {
    const site = makeSite('site-a.sk', [{ xmltvId: 'X', siteId: 'a-x' }]);

    const guide = (
      programmes: XmltvProgramme[],
      merge: NonNullable<BuildGuideOptions['merge']> = {},
    ) =>
      generate({
        sites: [site],
        cache: createFakeCache({ [`site-a.sk|X|${DAY}`]: programmes }),
        days: 1,
        startDay: DAY,
        now: NOW,
        merge: { programmeStrategy: 'concat', ...merge },
      });

    const titles = (output: string): string[] =>
      [...output.matchAll(/<title[^>]*>([^<]*)<\/title>/g)].map((found) => found[1]!);

    const span = (start: string, stop: string, title: string) =>
      prog('X', `2026-01-15T${start}:00Z`, title, undefined, {
        stop: new Date(`2026-01-15T${stop}:00Z`),
      });

    /** A magazine block published beside the two programmes inside it. */
    const magazine = [
      span('06:00', '09:00', 'Breakfast'),
      span('06:00', '07:30', 'News'),
      span('07:30', '09:00', 'Weather'),
    ];

    it('drops the container and keeps its parts', async () => {
      expect(titles(await guide(magazine))).toEqual(['News', 'Weather']);
    });

    // The reason this rule exists rather than being left to `clipOverlaps`:
    // without it the guide is not merely untidy, it is invalid.
    it('is what makes such a guide validate', async () => {
      const { validateXmltv } = await import('../src/xmltv/validate.js');

      expect((await validateXmltv([await guide(magazine)])).ok).toBe(true);
      expect((await validateXmltv([await guide(magazine, { dropContainers: false })])).ok).toBe(
        false,
      );
    });

    it('leaves a programme containing only one alone', async () => {
      // One contained programme is as likely a source's rounding, which
      // `clipOverlaps` is the rule for. Two is a container.
      const found = await guide(
        [span('06:00', '09:00', 'Long'), span('06:00', '07:30', 'Inside')],
        {
          clipOverlaps: false,
        },
      );

      expect(titles(found)).toEqual(['Long', 'Inside']);
    });

    it('leaves neighbours that merely touch alone', async () => {
      const found = await guide([
        span('06:00', '07:00', 'First'),
        span('07:00', '08:00', 'Second'),
        span('08:00', '09:00', 'Third'),
      ]);

      expect(titles(found)).toEqual(['First', 'Second', 'Third']);
    });

    it('needs a stop to contain anything', async () => {
      const found = await guide(
        [
          prog('X', '2026-01-15T06:00:00Z', 'Open ended'),
          span('06:30', '07:00', 'One'),
          span('07:00', '07:30', 'Two'),
        ],
        { fillStop: false },
      );

      // Nothing is dropped: without an end there is no span to contain them.
      expect(titles(found)).toEqual(['Open ended', 'One', 'Two']);
    });

    it('can be turned off', async () => {
      expect(titles(await guide(magazine, { dropContainers: false }))).toEqual([
        'Breakfast',
        'News',
        'Weather',
      ]);
    });
  });

  describe('fillGaps', () => {
    const site = makeSite('site-a.sk', [{ xmltvId: 'X', siteId: 'a-x' }]);

    const fill = (
      merge: NonNullable<BuildGuideOptions['merge']>,
      entries: Record<string, XmltvProgramme[]>,
    ) =>
      generate({
        sites: [site],
        cache: createFakeCache(entries),
        days: 1,
        startDay: DAY,
        now: NOW,
        merge,
      });

    /** Every programme as (start, stop, title). */
    const laid = (output: string): string[] =>
      [
        ...output.matchAll(
          /<programme start="(\d{14})[^"]*" stop="(\d{14})[^"]*"[^>]*>\s*<title[^>]*>([^<]*)/g,
        ),
      ].map((found) => `${found[1]!.slice(8, 12)}-${found[2]!.slice(8, 12)} ${found[3]!}`);

    /** Two programmes with a three-hour hole between them. */
    const withHole = {
      [`site-a.sk|X|${DAY}`]: [
        prog('X', '2026-01-15T10:00:00Z', 'Before', undefined, {
          stop: new Date('2026-01-15T11:00:00Z'),
        }),
        prog('X', '2026-01-15T14:00:00Z', 'After', undefined, {
          stop: new Date('2026-01-15T15:00:00Z'),
        }),
      ],
    };

    it('is off by default, and changes nothing when it is', async () => {
      expect(laid(await fill({}, withHole))).toEqual(['1000-1100 Before', '1400-1500 After']);
    });

    it('lays blocks end to end across a hole', async () => {
      const found = laid(await fill({ fillGaps: { edges: false } }, withHole));

      expect(found).toEqual([
        '1000-1100 Before',
        '1100-1130 No information',
        '1130-1200 No information',
        '1200-1230 No information',
        '1230-1300 No information',
        '1300-1330 No information',
        '1330-1400 No information',
        '1400-1500 After',
      ]);
    });

    it('truncates the last block to the gap rather than overrunning it', async () => {
      const found = laid(
        await fill({ fillGaps: { edges: false, blockMs: 45 * 60_000 } }, withHole),
      );

      // 3 hours in 45-minute blocks is 45/45/45/45 exactly; make it uneven.
      expect(found.at(-2)).toBe('1315-1400 No information');
      expect(found.at(-1)).toBe('1400-1500 After');
    });

    it('leaves a gap shorter than minMs alone', async () => {
      const found = laid(
        await fill(
          { fillGaps: { edges: false } },
          {
            [`site-a.sk|X|${DAY}`]: [
              prog('X', '2026-01-15T10:00:00Z', 'Before', undefined, {
                stop: new Date('2026-01-15T10:59:30Z'),
              }),
              prog('X', '2026-01-15T11:00:00Z', 'After', undefined, {
                stop: new Date('2026-01-15T12:00:00Z'),
              }),
            ],
          },
        ),
      );

      expect(found).toEqual(['1000-1059 Before', '1100-1200 After']);
    });

    it('leaves a gap longer than maxMs alone, as genuinely off air', async () => {
      const found = laid(await fill({ fillGaps: { edges: false, maxMs: 60 * 60_000 } }, withHole));

      expect(found).toEqual(['1000-1100 Before', '1400-1500 After']);
    });

    it('covers the window edges, and the whole window for a channel with nothing', async () => {
      const edges = laid(await fill({ fillGaps: true }, withHole));

      expect(edges[0]).toBe('0000-0030 No information');
      // The tail is not filled: the last programme has a stop here, so it is.
      expect(edges.at(-1)).toBe('2330-0000 No information');

      // A channel cached empty: edges are all there is.
      const nothing = laid(await fill({ fillGaps: true }, { [`site-a.sk|X|${DAY}`]: [] }));

      expect(nothing).toHaveLength(48);
      expect(nothing[0]).toBe('0000-0030 No information');
      expect(nothing.at(-1)).toBe('2330-0000 No information');
    });

    it('fills for a channel with no cache entry at all, not only an empty one', async () => {
      // `undefined` from the cache and `[]` are different code paths.
      expect(laid(await fill({ fillGaps: true }, {}))).toHaveLength(48);
    });

    it('refuses a blockMs that would never finish a gap', async () => {
      await expect(fill({ fillGaps: { blockMs: 0 } }, withHole)).rejects.toThrow(
        /blockMs must be a positive number/,
      );
      await expect(fill({ fillGaps: { blockMs: Number.NaN } }, withHole)).rejects.toThrow(
        /blockMs must be a positive number/,
      );
    });

    it('takes a title and a programme hook', async () => {
      const found = laid(
        await fill(
          {
            fillGaps: {
              edges: false,
              blockMs: 90 * 60_000,
              title: ({ index }) => `Nothing on (${index})`,
              programme: (block, { index }) => (index === 0 ? block : undefined),
            },
          },
          withHole,
        ),
      );

      // The hook dropped every block but the first.
      expect(found).toEqual(['1000-1100 Before', '1100-1230 Nothing on (0)', '1400-1500 After']);
    });
  });

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

  it("cover: 'first' builds the same guide as 'first-wins'", async () => {
    // The difference between them is what a *grab* asks for; a merge handed the
    // same cache has to answer identically, since a merge run on its own
    // resolves the lists itself and nothing has narrowed them.
    const options = { sites: [siteA, siteB], cache: cacheForBothSites(), days: 1, now: NOW };
    const only = await generate({ ...options, merge: { cover: 'first' } });

    expect(only).toBe(await generate({ ...options, merge: { channelStrategy: 'first-wins' } }));
    expect(only.match(/id=["']X["']/g)).toHaveLength(1);
    expect(only).toContain('Správy');
    expect(only).not.toContain('News');
  });

  it('says how much of the guide the sources agreed on', async () => {
    const said: Extract<EpgEvent, { type: 'merge:summary' }>[] = [];

    await generate({
      sites: [siteA, siteB],
      cache: cacheForBothSites(),
      days: 1,
      now: NOW,
      reporter: (event) => {
        if (event.type === 'merge:summary') {
          said.push(event);
        }
      },
    });

    // The two sites describe the 10:00 broadcast; `Film` is site A's alone.
    expect(said[0]).toMatchObject({ combined: 1, nearMiss: 0, examples: [] });
  });

  it('counts a source that merged into nothing, and says what it nearly met', async () => {
    // The quiet failure this exists for: a source published on a different
    // grid merges with nothing and the guide carries every programme twice,
    // which no count of programmes can tell from a guide that is simply fuller.
    const said: Extract<EpgEvent, { type: 'merge:summary' }>[] = [];
    const output = await generate({
      sites: [siteA, siteB],
      cache: createFakeCache({
        [`site-a.sk|X|${DAY}`]: [prog('X', '2026-01-15T10:00:00Z', 'Správy', 'sk')],
        // Seven minutes adrift, which is past the five-minute tolerance.
        [`site-b.com|X|${DAY}`]: [prog('X', '2026-01-15T10:07:00Z', 'News', 'en')],
      }),
      days: 1,
      now: NOW,
      reporter: (event) => {
        if (event.type === 'merge:summary') {
          said.push(event);
        }
      },
    });

    // Both are in the guide, which is the symptom.
    expect(output).toContain('Správy');
    expect(output).toContain('News');

    expect(said[0]).toMatchObject({
      combined: 0,
      nearMiss: 1,
      examples: [{ channelId: 'X', gapMs: 420_000, title: 'News', nearby: 'Správy' }],
    });
  });

  it('keeps the near misses it reports to a handful, however many there are', async () => {
    const said: Extract<EpgEvent, { type: 'merge:summary' }>[] = [];
    const drifting = Array.from({ length: 12 }, (_, index) => index);

    await generate({
      sites: [siteA, siteB],
      cache: createFakeCache({
        [`site-a.sk|X|${DAY}`]: drifting.map((hour) =>
          prog('X', `2026-01-15T${String(hour).padStart(2, '0')}:00:00Z`, 'Správy', 'sk'),
        ),
        [`site-b.com|X|${DAY}`]: drifting.map((hour) =>
          prog('X', `2026-01-15T${String(hour).padStart(2, '0')}:07:00Z`, 'News', 'en'),
        ),
      }),
      days: 1,
      now: NOW,
      reporter: (event) => {
        if (event.type === 'merge:summary') {
          said.push(event);
        }
      },
    });

    // Counted in full, reported five at a time: the count is the alarm, and
    // the examples are only there to say whether it is one channel or all.
    expect(said[0]?.nearMiss).toBe(12);
    expect(said[0]?.examples).toHaveLength(5);
  });

  it('says each near miss, whose each one is, and what kept them apart', async () => {
    const said: Extract<EpgEvent, { type: 'merge:unmatched' }>[] = [];

    await generate({
      sites: [siteA, siteB],
      cache: createFakeCache({
        [`site-a.sk|X|${DAY}`]: [
          prog('X', '2026-01-15T10:00:00Z', 'Správy', 'sk'),
          prog('X', '2026-01-15T12:00:00Z', 'Film', 'sk'),
          prog('X', '2026-01-15T14:00:00Z', 'Šport', 'sk'),
        ],
        [`site-b.com|X|${DAY}`]: [
          // Near enough, under another name.
          prog('X', '2026-01-15T10:02:00Z', 'News', 'en'),
          // The same name, too far apart.
          prog('X', '2026-01-15T12:07:00Z', 'Film', 'en'),
          // Neither.
          prog('X', '2026-01-15T14:07:00Z', 'Football', 'en'),
        ],
      }),
      days: 1,
      now: NOW,
      reporter: (event) => {
        if (event.type === 'merge:unmatched') {
          said.push(event);
        }
      },
    });

    expect(said.map(({ type: _type, level: _level, phase: _phase, ...rest }) => rest)).toEqual([
      {
        channelId: 'X',
        shiftMs: 120_000,
        why: 'title',
        programme: { site: 'site-b.com', title: 'News', start: '20260115100200 +0000' },
        nearby: { site: 'site-a.sk', title: 'Správy', start: '20260115100000 +0000' },
      },
      {
        channelId: 'X',
        shiftMs: 420_000,
        why: 'start',
        programme: { site: 'site-b.com', title: 'Film', start: '20260115120700 +0000' },
        nearby: { site: 'site-a.sk', title: 'Film', start: '20260115120000 +0000' },
      },
      {
        channelId: 'X',
        shiftMs: 420_000,
        why: 'both',
        programme: { site: 'site-b.com', title: 'Football', start: '20260115140700 +0000' },
        nearby: { site: 'site-a.sk', title: 'Šport', start: '20260115140000 +0000' },
      },
    ]);
    // At `debug`: a guide on two grids says thousands of these.
    expect(said[0]).toMatchObject({ level: 'debug', phase: 'merge' });
  });

  it('says how much later a near miss starts than the one it nearly met — or earlier', async () => {
    const said: Extract<EpgEvent, { type: 'merge:unmatched' }>[] = [];

    await generate({
      sites: [siteA, siteB],
      cache: createFakeCache({
        [`site-a.sk|X|${DAY}`]: [prog('X', '2026-01-15T10:00:00Z', 'Správy', 'sk')],
        [`site-b.com|X|${DAY}`]: [prog('X', '2026-01-15T09:53:00Z', 'Správy', 'en')],
      }),
      days: 1,
      now: NOW,
      reporter: (event) => {
        if (event.type === 'merge:unmatched') {
          said.push(event);
        }
      },
    });

    expect(said).toEqual([expect.objectContaining({ shiftMs: -420_000, why: 'start' })]);
  });

  it('takes for no near miss a programme a later one of the same list then joined', async () => {
    const said: Extract<EpgEvent, { type: 'merge:unmatched' }>[] = [];
    const summary: Extract<EpgEvent, { type: 'merge:summary' }>[] = [];

    await generate({
      sites: [siteA, siteB],
      cache: createFakeCache({
        [`site-a.sk|X|${DAY}`]: [
          prog('X', '2026-01-15T19:45:00Z', 'Reklama', 'sk'),
          prog('X', '2026-01-15T20:00:00Z', 'Film', 'sk'),
          prog('X', '2026-01-15T23:00:00Z', 'Správy', 'sk'),
        ],
        // B's filler is nearest A's film, which B's own film then joins: the
        // filler's near miss is A's advert, the nearest still left.
        [`site-b.com|X|${DAY}`]: [
          prog('X', '2026-01-15T19:53:00Z', 'Filler', 'en'),
          prog('X', '2026-01-15T20:00:00Z', 'Film', 'en'),
          // And one whose only candidate was taken: none at all.
          prog('X', '2026-01-15T22:53:00Z', 'Promo', 'en'),
          prog('X', '2026-01-15T23:00:00Z', 'Správy', 'en'),
        ],
      }),
      days: 1,
      now: NOW,
      reporter: (event) => {
        if (event.type === 'merge:unmatched') {
          said.push(event);
        } else if (event.type === 'merge:summary') {
          summary.push(event);
        }
      },
    });

    expect(said.map((event) => [event.programme.title, event.nearby.title])).toEqual([
      ['Filler', 'Reklama'],
    ]);
    expect(summary[0]).toMatchObject({ combined: 2, nearMiss: 1 });
  });

  it('says what the sources made of each other once, though a channel is derived from them', async () => {
    const said: EpgEvent[] = [];

    await generate({
      sites: [siteA, siteB],
      cache: createFakeCache({
        [`site-a.sk|X|${DAY}`]: [
          prog('X', '2026-01-15T10:00:00Z', 'Správy', 'sk'),
          prog('X', '2026-01-15T12:00:00Z', 'Film', 'sk'),
        ],
        [`site-b.com|X|${DAY}`]: [
          prog('X', '2026-01-15T10:00:00Z', 'Správy', 'en'),
          prog('X', '2026-01-15T12:07:00Z', 'Film', 'en'),
        ],
      }),
      days: 1,
      now: NOW,
      derived: [{ xmltvId: 'X.plus1', from: 'X', offset: 60 }],
      reporter: (event) => said.push(event),
    });

    const unmatched = said.filter((event) => event.type === 'merge:unmatched');

    expect(unmatched).toEqual([expect.objectContaining({ channelId: 'X' })]);
    expect(said.find((event) => event.type === 'merge:summary')).toMatchObject({
      combined: 1,
      nearMiss: 1,
    });
  });

  it('makes no near miss for a reporter that does not want one, and counts it all the same', async () => {
    const said: EpgEvent[] = [];

    await generate({
      sites: [siteA, siteB],
      cache: createFakeCache({
        [`site-a.sk|X|${DAY}`]: [prog('X', '2026-01-15T10:00:00Z', 'Správy', 'sk')],
        [`site-b.com|X|${DAY}`]: [prog('X', '2026-01-15T10:07:00Z', 'News', 'en')],
      }),
      days: 1,
      now: NOW,
      // Told everything it is handed, and wanting all but those.
      reporter: Object.assign((event: EpgEvent) => said.push(event), {
        wants: (type: EpgEvent['type']) => type !== 'merge:unmatched',
      }),
    });

    expect(said.some((event) => event.type === 'merge:unmatched')).toBe(false);
    expect(said.find((event) => event.type === 'merge:summary')).toMatchObject({ nearMiss: 1 });
  });

  it('takes no source’s own programme of the day before for one it nearly was', async () => {
    const NEXT_DAY = '2026-01-16';
    const said: Extract<EpgEvent, { type: 'merge:unmatched' }>[] = [];

    await generate({
      sites: [siteA, siteB],
      cache: createFakeCache({
        [`site-a.sk|X|${DAY}`]: [prog('X', '2026-01-15T12:00:00Z', 'Obed', 'sk')],
        [`site-a.sk|X|${NEXT_DAY}`]: [prog('X', '2026-01-16T12:00:00Z', 'Obed', 'sk')],
        // B's late programme, held into the next day, and B's next one after it.
        [`site-b.com|X|${DAY}`]: [prog('X', '2026-01-15T23:50:00Z', 'Late', 'en')],
        [`site-b.com|X|${NEXT_DAY}`]: [prog('X', '2026-01-16T00:05:00Z', 'Night', 'en')],
      }),
      days: 2,
      now: NOW,
      reporter: (event) => {
        if (event.type === 'merge:unmatched') {
          said.push(event);
        }
      },
    });

    // Two programmes of B's in a row, not two sources that nearly agreed.
    expect(said).toEqual([]);
  });

  it('takes no source’s own programme of the day before for one it nearly was, though another joined it', async () => {
    const NEXT_DAY = '2026-01-16';
    const said: Extract<EpgEvent, { type: 'merge:unmatched' }>[] = [];

    await generate({
      sites: [siteA, siteB],
      cache: createFakeCache({
        // A's and B's late programme, one broadcast, held into the next day.
        [`site-a.sk|X|${DAY}`]: [prog('X', '2026-01-15T23:50:00Z', 'Late', 'sk')],
        [`site-a.sk|X|${NEXT_DAY}`]: [prog('X', '2026-01-16T12:00:00Z', 'Obed', 'sk')],
        [`site-b.com|X|${DAY}`]: [prog('X', '2026-01-15T23:50:00Z', 'Late', 'en')],
        [`site-b.com|X|${NEXT_DAY}`]: [prog('X', '2026-01-16T00:05:00Z', 'Night', 'en')],
      }),
      days: 2,
      now: NOW,
      reporter: (event) => {
        if (event.type === 'merge:unmatched') {
          said.push(event);
        }
      },
    });

    // B's programme as much as A's: two of B's in a row.
    expect(said).toEqual([]);
  });

  it('counts no source’s own programme of the day before, said again, as two that agreed', async () => {
    const NEXT_DAY = '2026-01-16';
    const said: Extract<EpgEvent, { type: 'merge:summary' }>[] = [];

    await generate({
      sites: [siteA, siteB],
      cache: createFakeCache({
        [`site-a.sk|X|${DAY}`]: [prog('X', '2026-01-15T12:00:00Z', 'Obed', 'sk')],
        [`site-a.sk|X|${NEXT_DAY}`]: [prog('X', '2026-01-16T12:00:00Z', 'Obed', 'sk')],
        // B's late programme, and B saying it again with the next day's.
        [`site-b.com|X|${DAY}`]: [prog('X', '2026-01-15T23:50:00Z', 'Late', 'en')],
        [`site-b.com|X|${NEXT_DAY}`]: [
          prog('X', '2026-01-15T23:50:00Z', 'Late', 'en'),
          prog('X', '2026-01-16T00:05:00Z', 'Night', 'en'),
        ],
      }),
      days: 2,
      now: NOW,
      reporter: (event) => {
        if (event.type === 'merge:summary') {
          said.push(event);
        }
      },
    });

    expect(said[0]).toMatchObject({ combined: 0 });
  });

  it('watches a day’s first source too, against another’s programme held over from the day before', async () => {
    const NEXT_DAY = '2026-01-16';
    const unmatched: Extract<EpgEvent, { type: 'merge:unmatched' }>[] = [];
    const summary: Extract<EpgEvent, { type: 'merge:summary' }>[] = [];

    await generate({
      sites: [siteA, siteB],
      cache: createFakeCache({
        // Only B answered for the first day, so its late programmes are held.
        [`site-b.com|X|${DAY}`]: [
          prog('X', '2026-01-15T23:30:00Z', 'Late', 'en'),
          prog('X', '2026-01-15T23:50:00Z', 'Later', 'en'),
        ],
        // A, first of the next day, meets one of them and nearly meets the other.
        [`site-a.sk|X|${NEXT_DAY}`]: [
          prog('X', '2026-01-15T23:30:00Z', 'Late', 'sk'),
          prog('X', '2026-01-15T23:57:00Z', 'Later', 'sk'),
        ],
      }),
      days: 2,
      now: NOW,
      reporter: (event) => {
        if (event.type === 'merge:unmatched') {
          unmatched.push(event);
        } else if (event.type === 'merge:summary') {
          summary.push(event);
        }
      },
    });

    expect(unmatched).toEqual([
      expect.objectContaining({
        why: 'start',
        programme: expect.objectContaining({ site: 'site-a.sk', title: 'Later' }),
        nearby: expect.objectContaining({ site: 'site-b.com', title: 'Later' }),
      }),
    ]);
    expect(summary[0]).toMatchObject({ combined: 1, nearMiss: 1 });
  });

  it('says which site a near miss is with, though two had merged it, or a third joined it', async () => {
    const siteC = makeSite('site-c.cz', [{ xmltvId: 'X', siteId: 'c-x' }]);
    const said: Extract<EpgEvent, { type: 'merge:unmatched' }>[] = [];

    await generate({
      sites: [siteA, siteB, siteC],
      cache: createFakeCache({
        // A's and B's 10:00 are one programme, made anew; B's 12:00 is B's alone.
        [`site-a.sk|X|${DAY}`]: [prog('X', '2026-01-15T10:00:00Z', 'Správy', 'sk')],
        [`site-b.com|X|${DAY}`]: [
          prog('X', '2026-01-15T10:00:00Z', 'Správy', 'en'),
          prog('X', '2026-01-15T12:00:00Z', 'Film', 'en'),
        ],
        // And C nearly meets each.
        [`site-c.cz|X|${DAY}`]: [
          prog('X', '2026-01-15T10:07:00Z', 'Správy', 'cs'),
          prog('X', '2026-01-15T12:07:00Z', 'Film', 'cs'),
        ],
      }),
      days: 1,
      now: NOW,
      reporter: (event) => {
        if (event.type === 'merge:unmatched') {
          said.push(event);
        }
      },
    });

    expect(said.map((event) => [event.programme.site, event.nearby.site])).toEqual([
      // The merged one is its base's: the higher site's.
      ['site-c.cz', 'site-a.sk'],
      ['site-c.cz', 'site-b.com'],
    ]);
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

  describe('document meta', () => {
    const site = makeSite('site-a.sk', [{ xmltvId: 'X', siteId: 'a-x', name: 'Sky One' }]);

    it('asks a function for the root attributes, against the channels there are', async () => {
      // The same question `derived` is asked, for the same reason: what the
      // document calls itself can depend on which channels turned up.
      const seen: { ids: string[]; now: Date }[] = [];
      const output = await generate({
        sites: [site],
        cache: createFakeCache({
          [`site-a.sk|X|${DAY}`]: [prog('X', '2026-01-15T10:00:00Z', 'A')],
        }),
        days: 1,
        startDay: DAY,
        now: NOW,
        meta: ({ channels, now }) => {
          seen.push({ ids: channels.map((channel) => channel.xmltvId), now });

          return { sourceInfoName: `${String(channels.length)} channels` };
        },
      });

      expect(seen).toEqual([{ ids: ['X'], now: NOW }]);
      expect(output).toContain('source-info-name="1 channels"');
    });

    it('takes a plain object as it always did', async () => {
      const output = await generate({
        sites: [site],
        cache: createFakeCache({ [`site-a.sk|X|${DAY}`]: [] }),
        days: 1,
        startDay: DAY,
        now: NOW,
        meta: { sourceInfoName: 'written down' },
      });

      expect(output).toContain('source-info-name="written down"');
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

    it('asks a function what to derive, against the channels there are', async () => {
      // The form that exists for a lineup nobody writes down: a provider sync
      // adds a channel, and its `+1` has to follow without the config changing.
      const seen: string[][] = [];
      const output = await guide(
        ({ channels }) => {
          seen.push(channels.map((channel) => channel.xmltvId));

          return channels.map((channel) => ({
            xmltvId: `${channel.xmltvId}.plus1`,
            from: channel.xmltvId,
            offset: 60,
          }));
        },
        withDays({ [`site-a.sk|X|${DAY}`]: [prog('X', '2026-01-15T10:00:00Z', 'A')] }),
      );

      // The channels the sites resolved to, which is what makes it answerable.
      expect(seen).toEqual([['X']]);
      expect(output).toContain('<channel id="X.plus1">');
      expect(aired(output)).toEqual(['X 20260115100000', 'X.plus1 20260115110000']);
    });

    it('lets a function say why it derived nothing', async () => {
      const said: string[] = [];
      const output = await guide(
        ({ channels, warn }) => {
          warn(`no shift for ${String(channels.length)} channel(s)`);

          return [];
        },
        withDays({ [`site-a.sk|X|${DAY}`]: [prog('X', '2026-01-15T10:00:00Z', 'A')] }),
        {
          reporter: (event) =>
            said.push(`${event.type}:${'message' in event ? event.message : ''}`),
        },
      );

      expect(said).toContain('merge:warning:no shift for 1 channel(s)');
      expect(aired(output)).toEqual(['X 20260115100000']);
    });

    it('keeps the source a function-declared shift needs, under a selection', async () => {
      // `channels` selects only the derived id; the source it shifts has to
      // survive the narrowing, which is the thing a plain filter gets wrong.
      const output = await guide(
        ({ channels }) =>
          channels.map((channel) => ({
            xmltvId: `${channel.xmltvId}.plus1`,
            from: channel.xmltvId,
            offset: 60,
          })),
        withDays({ [`site-a.sk|X|${DAY}`]: [prog('X', '2026-01-15T10:00:00Z', 'A')] }),
        { channels: ['X.plus1'] },
      );

      // The source is kept and published with it — what a selection of a shift
      // means, and the thing a plain filter on the sites gets wrong.
      expect(output).toContain('<channel id="X.plus1">');
      expect(output).toContain('<channel id="X">');
      expect(aired(output)).toEqual(['X 20260115100000', 'X.plus1 20260115110000']);
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
