import { describe, expect, it } from 'vitest';
import { parseTitleNumbering, stripTitleSeason } from '../src/xmltv/main.js';

/** A source's own words for a season and an episode, as homepi's sites write them. */
const SLOVAK = [
  /^(?<title>.+?)(?::|\s+-)?\s+(?:Sez[oó]na\s+(?<season>\d+)\s+)?Epiz[oó]da\s+(?<episode>\d+)(?:\s+-\s+(?<subTitle>.+))?$/u,
  /^(?<title>.+?)(?::|\s+-)\s+Sez[oó]na\s+(?<season>\d+)$/u,
];

const HUNGARIAN = [
  /^(?<title>.+?)(?:\s+-)?\s+(?<season>\d+)\.\s*évad$/u,
  /^(?<title>.+?)(?:\s+-)?\s+(?<season>\S+)\.\s*sorozat$/u,
];

describe('a title’s numbering', () => {
  it.each([
    ['Duel S01E99', { title: 'Duel', season: 1, episode: 99 }],
    ['Duel - S01E02 - Pilot', { title: 'Duel', season: 1, episode: 2, subTitle: 'Pilot' }],
    // The rest of the onscreen grammar: an "Ep", totals and a part.
    ['Duel S01 Ep 5', { title: 'Duel', season: 1, episode: 5 }],
    ['Duel S01.E02', { title: 'Duel', season: 1, episode: 2 }],
    ['Duel S01E02/12', { title: 'Duel', season: 1, episode: 2, episodes: 12 }],
    ['Duel S1/3E2 P1/2', { title: 'Duel', season: 1, seasons: 3, episode: 2, part: 1, parts: 2 }],
    ['TrimZZ: Episode 4', { title: 'TrimZZ', episode: 4 }],
    ['Single Minded - Episode 1', { title: 'Single Minded', episode: 1 }],
    [
      'Walker, Texas Ranger Season 4 Episode 5',
      { title: 'Walker, Texas Ranger', season: 4, episode: 5 },
    ],
    [
      'Morning Season 2 Episode 5 - Monday',
      { title: 'Morning', season: 2, episode: 5, subTitle: 'Monday' },
    ],
    ['Komisár Rex III (13)', { title: 'Komisár Rex', season: 3, episode: 13 }],
    ['Kobra 11 XXV (3)', { title: 'Kobra 11', season: 25, episode: 3 }],
    ['Kobra 11 XXIII. (3)', { title: 'Kobra 11', season: 23, episode: 3 }],
    ['Hospital CLV (2)', { title: 'Hospital', season: 155, episode: 2 }],
    ['Hospital XIX (2)', { title: 'Hospital', season: 19, episode: 2 }],
    ['Hospital XLIV (2)', { title: 'Hospital', season: 44, episode: 2 }],
    ['M*A*S*H (49)', { title: 'M*A*S*H', episode: 49 }],
    // A word of a numeral's letters, or one written as no numeral is, stays
    // in the title.
    ['CIVIL (2)', { title: 'CIVIL', episode: 2 }],
    ['Agent CIVIL (2)', { title: 'Agent CIVIL', episode: 2 }],
    ['Agent IIII (2)', { title: 'Agent IIII', episode: 2 }],
    ['Filter (6/6)', { title: 'Filter', episode: 6, episodes: 6 }],
    ['Грузія в серці (31)', { title: 'Грузія в серці', episode: 31 }],
    ['Robogobo: Season 1', { title: 'Robogobo', season: 1 }],
    [
      'Big Coast - Season 12 - Duncanby Lodge',
      { title: 'Big Coast', season: 12, subTitle: 'Duncanby Lodge' },
    ],
    // A separator between a season and its episode, and a dash of any width.
    ['Show - Season 2 - Episode 5', { title: 'Show', season: 2, episode: 5 }],
    ['Show: Season 2, Episode 5', { title: 'Show', season: 2, episode: 5 }],
    [
      'Big Coast - Season 12 - Episode 3 - Lodge',
      { title: 'Big Coast', season: 12, episode: 3, subTitle: 'Lodge' },
    ],
    ['Duel – S01E02 – Pilot', { title: 'Duel', season: 1, episode: 2, subTitle: 'Pilot' }],
    ['Duel — S01E02', { title: 'Duel', season: 1, episode: 2 }],
    ['Show - (13)', { title: 'Show', episode: 13 }],
    ['Komisár Rex – III (13)', { title: 'Komisár Rex', season: 3, episode: 13 }],
    // A comma before the numbering is no part of the title.
    ['Show, Episode 5', { title: 'Show', episode: 5 }],
    ['Duel, S01E02', { title: 'Duel', season: 1, episode: 2 }],
    // The words in any case.
    ['Duel s01e05', { title: 'Duel', season: 1, episode: 5 }],
    ['Robogobo: season 1', { title: 'Robogobo', season: 1 }],
    ['Show - EPISODE 4', { title: 'Show', episode: 4 }],
    // A numeral of one letter is a season as I or V, and a name otherwise; a
    // numeral in small letters is a word.
    ['Komisár Rex V (3)', { title: 'Komisár Rex', season: 5, episode: 3 }],
    ['Malcolm X (2)', { title: 'Malcolm X', episode: 2 }],
    ['Vitamin C (3)', { title: 'Vitamin C', episode: 3 }],
    ['Agent iii (2)', { title: 'Agent iii', episode: 2 }],
    // A special's season is none, and its episode still one.
    ['Duel S00E05', { title: 'Duel', episode: 5 }],
    ['  Duel S01E99  ', { title: 'Duel', season: 1, episode: 99 }],
    [13, { title: '13' }],
  ])('%s', (raw, numbering) => {
    expect(parseTitleNumbering(raw)).toEqual(numbering);
  });

  it.each([
    // A film's sequel, not a season; a road, not an episode.
    'Spinal Tap II',
    'Poprask na silnici E4',
    'Studio 6 II',
    // A year, a season with no separator, a series' name.
    'Hrdinové (2019)',
    'Rocky II (1979)',
    // A season and episode with no series before them: taking them off would
    // leave nothing of the title but the season.
    'Season 2 Episode 5 - Monday',
    // A season's span of years.
    'Extraliga (2023/24)',
    'Liga majstrov (2023/2024)',
    // Noughts alone, which leave nothing to write in place of what they said.
    'Duel S00E00',
    'Show (0)',
    // A total alone, which names no episode to write.
    'Show (0/12)',
    'Robogobo: Season 0',
    '450kg sestry VI: A Taste Of Season 6',
    'Slovensko - Ukrajina',
    // Not English, so nothing built in reads it.
    'MacGyver Sezóna 3 Epizoda 19',
    'Bor, mámor, szerelem 3. évad',
    'Magyar népmesék - I. sorozat',
  ])('leaves %s as it is', (raw) => {
    expect(parseTitleNumbering(raw)).toEqual({ title: raw });
  });

  it('reads no title longer than any title is', () => {
    const long = `${'x'.repeat(500)} S01E02`;
    // Padding that would cost a pattern time growing with its square.
    const padded = `a${' '.repeat(50_000)}b`;
    const started = performance.now();

    expect(parseTitleNumbering(long)).toEqual({ title: long });
    expect(parseTitleNumbering(padded)).toEqual({ title: padded });
    expect(performance.now() - started).toBeLessThan(100);
  });

  it('trims a title it leaves as it is', () => {
    expect(parseTitleNumbering('  Spinal Tap II  ')).toEqual({ title: 'Spinal Tap II' });
  });

  describe("a source's own patterns", () => {
    const patterns = [...SLOVAK, ...HUNGARIAN];

    it.each([
      ['MacGyver Sezóna 3 Epizoda 19', { title: 'MacGyver', season: 3, episode: 19 }],
      [
        'Ráno Sezóna 2 Epizóda 5 - Pondelok',
        { title: 'Ráno', season: 2, episode: 5, subTitle: 'Pondelok' },
      ],
      ['Apokalypsa - Hitler Epizoda 1', { title: 'Apokalypsa - Hitler', episode: 1 }],
      ['Bor, mámor, szerelem 3. évad', { title: 'Bor, mámor, szerelem', season: 3 }],
      ['Magyar népmesék - I. sorozat', { title: 'Magyar népmesék', season: 1 }],
      ['Kérem a következőt! I. sorozat', { title: 'Kérem a következőt!', season: 1 }],
      // And the built-in ones after them.
      ['Duel S01E99', { title: 'Duel', season: 1, episode: 99 }],
      ['Komisár Rex III (13)', { title: 'Komisár Rex', season: 3, episode: 13 }],
    ])('read %s', (raw, numbering) => {
      expect(parseTitleNumbering(raw, { patterns })).toEqual(numbering);
    });

    it.each([
      'NA ŠÍRAVE - Ako dopadla letná sezóna 2026?',
      'Csoóri sorozat',
      // A word where a number goes passes the title on, and nothing after reads it.
      'Ez a Nagy. sorozat',
    ])('leave %s as it is', (raw) => {
      expect(parseTitleNumbering(raw, { patterns })).toEqual({ title: raw });
    });

    it('are tried before the built-in ones', () => {
      const season = /^(?<title>.+?)\s+\((?<season>\d+)\)$/u;

      expect(parseTitleNumbering('M*A*S*H (2)', { patterns: [season] })).toEqual({
        title: 'M*A*S*H',
        season: 2,
      });
    });

    it('pass a title on where a number they found is not one', () => {
      const word = /^(?<title>.+?)\s+(?<episode>\S+)\s+\((?<episodes>\d+)\)$/u;

      expect(parseTitleNumbering('Hospital Nine (12)', { patterns: [word] })).toEqual({
        title: 'Hospital Nine',
        episode: 12,
      });
    });

    it('pass a title on where they read no title', () => {
      const untitled = /^(?<title>\s*)S(?<season>\d+)$/u;

      expect(parseTitleNumbering('S01', { patterns: [untitled] })).toEqual({ title: 'S01' });
    });

    it('read every title from its start, a global one too, and leave its place alone', () => {
      const global = /^(?<title>.+?)\s+#(?<episode>\d+)$/gu;

      global.lastIndex = 5;

      expect(parseTitleNumbering('Show #3', { patterns: [global] })).toEqual({
        title: 'Show',
        episode: 3,
      });
      expect(parseTitleNumbering('Show #4', { patterns: [global] })).toEqual({
        title: 'Show',
        episode: 4,
      });
      expect(global.lastIndex).toBe(5);
    });

    it('may be frozen', () => {
      const frozen = Object.freeze(/^(?<title>.+?)\s+#(?<episode>\d+)$/u);

      expect(parseTitleNumbering('Show #3', { patterns: [frozen] })).toEqual({
        title: 'Show',
        episode: 3,
      });
    });

    it('read a title only where they match the whole of it', () => {
      // Unanchored, this finds "szerelem 3. évad" and would drop "Bor, mámor,".
      const part = /(?<title>\S+)\s+(?<season>\d+)\.\s*évad/u;

      expect(parseTitleNumbering('Bor, mámor, szerelem 3. évad', { patterns: [part] })).toEqual({
        title: 'Bor, mámor, szerelem 3. évad',
      });
    });

    it('read a number with space around it and an ordinal dot after it', () => {
      const spaced = /^(?<title>.+?)(?<season>\s+\d+\.)\s*évad$/u;
      const roman = /^(?<title>.+?)\s+(?<season>\S+\.)\s*sorozat$/u;

      expect(parseTitleNumbering('Bor 3. évad', { patterns: [spaced] })).toEqual({
        title: 'Bor',
        season: 3,
      });
      expect(parseTitleNumbering('Kérem a következőt! I. sorozat', { patterns: [roman] })).toEqual({
        title: 'Kérem a következőt!',
        season: 1,
      });
    });

    it('read no title from a total alone', () => {
      const parts = /^(?<title>.+?)\s+\((?<episodes>\d+) dielov\)$/u;

      expect(parseTitleNumbering('Show (12 dielov)', { patterns: [parts] })).toEqual({
        title: 'Show (12 dielov)',
      });
    });

    it('need a title group, and say so the first time they are used', () => {
      const show = /^(?<show>.+?)\s+(?<season>\d+)\.\s*évad$/u;

      expect(() => parseTitleNumbering('Bor 3. évad', { patterns: [show] })).toThrow(
        /needs a \(\?<title>…\) group/,
      );
      // A title it would never have matched says so as well.
      expect(() => parseTitleNumbering('Duel S01E02', { patterns: [show] })).toThrow(
        /needs a \(\?<title>…\) group/,
      );
      // And one a pattern before it reads.
      const good = /^(?<title>.+?)\s+#(?<episode>\d+)$/u;

      expect(() => parseTitleNumbering('Show #3', { patterns: [good, show] })).toThrow(
        /needs a \(\?<title>…\) group/,
      );
    });

    it('are matched against the whole title, unanchored ones too', () => {
      // Its first match, "Show #3", is not the whole title; anchored, it reads it.
      const hash = /(?<title>.+?)\s+#(?<episode>\d+)/u;

      expect(parseTitleNumbering('Show #3 #4', { patterns: [hash] })).toEqual({
        title: 'Show #3',
        episode: 4,
      });
    });

    it('do not stand in for the built-in ones where they read no number', () => {
      // Every title matches it, its season being optional — and none is read.
      const optional = /^(?<title>.+?)(?:\s+(?<season>\d+)\.\s*évad)?$/u;

      expect(parseTitleNumbering('Duel S01E02', { patterns: [optional] })).toEqual({
        title: 'Duel',
        season: 1,
        episode: 2,
      });
      expect(stripTitleSeason('Zločin III', 3, { patterns: [optional] })).toBe('Zločin');
    });

    it("read what the built-in ones leave alone, as a daily soap's year-like episode", () => {
      const soap = /(?<title>.+?)\s*\((?<episode>\d+)\)/u;

      expect(parseTitleNumbering('Ulice (1999)')).toEqual({ title: 'Ulice (1999)' });
      expect(parseTitleNumbering('Ulice (1999)', { patterns: [soap] })).toEqual({
        title: 'Ulice',
        episode: 1999,
      });
    });

    it('take a group that matched nothing as a number not given', () => {
      const optional = /^(?<title>.+?)\s+(?<season>\d+)\.\s*évad\s*(?<episode>\d*)$/u;

      expect(parseTitleNumbering('Show 3. évad', { patterns: [optional] })).toEqual({
        title: 'Show',
        season: 3,
      });
    });
  });
});

describe('a season the source gives apart', () => {
  it.each([
    ['Zločin III', 3, 'Zločin'],
    ['Kobra 11 XXIII.', 23, 'Kobra 11'],
    ['Robogobo: Season 1', 1, 'Robogobo'],
    ['Big Coast - Season 12', 12, 'Big Coast'],
    ['Zločin III', '3', 'Zločin'],
  ])('comes off %s', (title, season, stripped) => {
    expect(stripTitleSeason(title, season)).toBe(stripped);
  });

  it.each([
    ['Herbárium 1. évad', 1, 'Herbárium'],
    ['Anyai örökség - 1. évad', 1, 'Anyai örökség'],
    ['Magyar népmesék - I. sorozat', 1, 'Magyar népmesék'],
    ['Zločin III', 3, 'Zločin'],
  ])("comes off %s by a source's own pattern too", (title, season, stripped) => {
    expect(stripTitleSeason(title, season, { patterns: HUNGARIAN })).toBe(stripped);
  });

  it.each([
    // Another season, or none given.
    ['Spinal Tap II', 1],
    ['Zločin III', null],
    ['Zločin III', undefined],
    ['Bedekr XII', '0'],
    ['Bedekr XII', 'XII'],
    // More than the season: an episode, a sub-title.
    ['Duel S01E05', 1],
    ['Big Coast - Season 12 - Duncanby Lodge', 12],
    // Digits at the end are a name, a numeral a season.
    ['Studio 6', 6],
    // Not English, and no pattern given for it.
    ['Herbárium 1. évad', 1],
    // An episode, though of nought.
    ['Duel S01E00', 1],
  ])('stays on %s for season %s', (title, season) => {
    expect(stripTitleSeason(title, season)).toBe(title);
  });

  it('reads a numeral of one letter, where the season is given', () => {
    expect(stripTitleSeason('Malcolm X', 10)).toBe('Malcolm');
  });

  it('comes back trimmed, whether or not a season comes off', () => {
    expect(stripTitleSeason('  Zločin III  ', 3)).toBe('Zločin');
    expect(stripTitleSeason('  Zločin  ', 3)).toBe('Zločin');
    expect(stripTitleSeason('  Zločin  ', null)).toBe('Zločin');
  });

  it('takes a title given as a number', () => {
    expect(stripTitleSeason(13, 1)).toBe('13');
  });

  it('hands back a title that is neither text nor a number as it came, and says so', () => {
    // As an API sends one: `"title": null`.
    const title = null as string | null;
    const stripped: string | null = stripTitleSeason(title, 3);
    const parsed: { title: string | null; season?: number } = parseTitleNumbering(title);

    expect(stripped).toBeNull();
    expect(parsed).toEqual({ title: null });
  });
});
