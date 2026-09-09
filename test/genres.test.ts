import { describe, expect, it } from 'vitest';
import { DVB_GENRES, genreKey, genreOf, type Genre } from '../src/xmltv/genres.js';

describe('the DVB genre table', () => {
  it('holds exactly the codes a genre can be named by', () => {
    // Every other populated slot in the source table repeats its row's name,
    // so a lookup finds the major first and the repeat is unreachable — and
    // listing one would collide here and win, sending every film out as a
    // *reserved* code. Spelled out rather than counted, because a count agrees
    // with the wrong table as easily as the right one.
    const range = (from: number, to: number): string[] =>
      Array.from({ length: to - from + 1 }, (_, index) => `0x${(from + index).toString(16)}`);

    expect(DVB_GENRES.map((genre) => genre.eit)).toEqual([
      ...range(0x10, 0x18),
      ...range(0x20, 0x24),
      ...range(0x30, 0x33),
      ...range(0x40, 0x4b),
      ...range(0x50, 0x55),
      ...range(0x60, 0x66),
      ...range(0x70, 0x7b),
      ...range(0x80, 0x83),
      ...range(0x90, 0x97),
      ...range(0xa0, 0xa7),
    ]);

    for (const genre of DVB_GENRES) {
      // `0x00` is "undefined content", which a consumer reading codes rejects,
      // so no major nibble is ever zero.
      expect(genre.eit, genre.name).toMatch(/^0x[1-9a-f][0-9a-f]$/);
    }
  });

  it('gives every genre a distinct code', () => {
    const codes = DVB_GENRES.map((genre) => genre.eit);

    expect(new Set(codes).size).toBe(codes.length);
  });

  it('never lets two genres claim the same name', () => {
    // The guard a contributor needs: adding `Documentary` to a second genre
    // would silently steal it from the first, and the table is long enough
    // that nobody would notice. Checked here rather than at module load, so a
    // data typo fails CI instead of every process that imports the library.
    const claimed = new Map<string, Genre>();

    for (const genre of DVB_GENRES) {
      for (const name of [genre.name, ...(genre.aliases ?? [])]) {
        const key = genreKey(name);
        const already = claimed.get(key);

        expect(
          already === undefined || already === genre,
          `"${name}" folds to "${key}", claimed by both ${already?.name} and ${genre.name}`,
        ).toBe(true);

        claimed.set(key, genre);
      }
    }
  });

  it('keeps every string matchable by the consumer that reads them', () => {
    for (const genre of DVB_GENRES) {
      for (const name of [genre.name, ...(genre.aliases ?? [])]) {
        // ASCII only: the matcher case-folds with `| 0x20`, which cannot fold
        // an accented character.
        expect(name, name).toMatch(/^[ -~]+$/);
        // No leading or trailing space: one walks that matcher past its own
        // terminator and reads out of bounds.
        expect(name, name).toBe(name.trim());
      }
    }
  });
});

describe('genreOf', () => {
  it('finds a genre by its canonical name', () => {
    expect(genreOf('Movie / Drama')?.eit).toBe('0x10');
    expect(genreOf('Documentary')?.eit).toBe('0x23');
    expect(genreOf('Cartoons / Puppets')?.eit).toBe('0x55');
  });

  it('ignores case, spacing, underscores and hyphens', () => {
    for (const value of [
      'Movie / Drama',
      'movie/drama',
      'MOVIE / DRAMA',
      'Movie/Drama',
      'Movie_/_Drama',
    ]) {
      expect(genreOf(value)?.eit, value).toBe('0x10');
    }

    // Which is also why only one spelling of these needs to be listed.
    expect(genreOf('Sci-Fi')?.eit).toBe('0x13');
    expect(genreOf('SciFi')?.eit).toBe('0x13');
    expect(genreOf('sci fi')?.eit).toBe('0x13');
  });

  it('finds a genre by what real guides actually write', () => {
    // The canonical strings almost never appear in the wild; these do.
    expect(genreOf('Movie')?.eit).toBe('0x10');
    expect(genreOf('Kids')?.eit).toBe('0x50');
    expect(genreOf('Entertainment')?.eit).toBe('0x30');
    expect(genreOf('Shopping')?.eit).toBe('0xa6');
    // `Science fiction` alone is one of the commonest, and does not fold onto
    // the full canonical name.
    expect(genreOf('Science fiction')?.eit).toBe('0x13');
    // A real public guide spells it this way, a couple of hundred times.
    expect(genreOf('Gradening')?.eit).toBe('0xa7');
  });

  it('finds a genre by ETSI’s own wording, not just the consumer’s', () => {
    // The standard's spelling should not be the one that fails to match.
    expect(genreOf('movie/drama (general)')?.eit).toBe('0x10');
    expect(genreOf('sports (general)')?.eit).toBe('0x40');
    expect(genreOf('arts/culture (without music, general)')?.eit).toBe('0x70');
    // British `programmes`, where the canonical form is American `programs`.
    expect(genreOf("children's/youth programmes")?.eit).toBe('0x50');
    expect(genreOf("pre-school children's programmes")?.eit).toBe('0x51');
    expect(genreOf('informational/educational/school programmes')?.eit).toBe('0x54');
  });

  it('keeps ETSI’s and the consumer’s arts magazines apart', () => {
    // The one cell where the two genuinely disagree on wording rather than
    // spelling, and the reason `/` is not folded away.
    expect(genreOf('Arts magazines / Culture magazines')?.eit).toBe('0x7a');
    expect(genreOf('arts/culture magazines')?.eit).toBe('0x7a');
    expect(genreOf('Arts / Culture (without music)')?.eit).toBe('0x70');
  });

  it('returns nothing for a category that is not a genre', () => {
    // Not an error, and the common case: `Series` is among the most frequent
    // categories in any real guide, and DVB has no concept for it.
    for (const value of ['Series', 'Special Interest', 'Other', 'Specialist', 'NFL', '']) {
      expect(genreOf(value), value).toBeUndefined();
    }
  });

  it('carries the code and the canonical text together', () => {
    // Both halves matter: the text is what works on a default install, the
    // code only for a consumer configured to read one.
    const genre = genreOf('Kids');

    expect(genre?.name).toBe("Children's / Youth programs");
    expect(genre?.eit).toBe('0x50');
  });
});
