/**
 * The episode numbering a source writes into a title rather than beside it —
 * "Duel S01E99", "Komisár Rex III (13)", "Robogobo: Season 1" — taken off, so
 * the title is the series' and the numbers can go where XMLTV keeps them.
 *
 * The guards matter as much as the patterns. A numeral at the end of a title is
 * as often a sequel as a season ("Spinal Tap II"), a number in brackets as often
 * a year ("(2019)") and an `E` and a digit a road ("Poprask na silnici E4"), so
 * a title is only read where it says outright what its numbers are.
 *
 * What is built in is English, or no language at all: a source's own words for
 * a season — "Sezóna", "évad" — are a pattern it is given, tried before these.
 */

import { ONSCREEN_IN_TITLE } from './episode-num.js';

/**
 * A title with the numbering its source wrote into it taken off. The numbers
 * are 1-based, and are what `ProgrammeBuilder.episode()` takes.
 */
export interface TitleNumbering {
  /** What is left: the series' own title. */
  title: string;
  season?: number;
  /** How many seasons there are, from "S1/3E2". */
  seasons?: number;
  episode?: number;
  /** How many episodes there are, from "(6/12)". */
  episodes?: number;
  /** Which part of a multi-part episode, from "S01E02 P1/2". */
  part?: number;
  /** How many parts the episode is in. */
  parts?: number;
  /** What follows the numbering after " - ": "Season 2 Episode 5 - Monday". */
  subTitle?: string;
}

/** What {@link parseTitleNumbering} and {@link stripTitleSeason} read a title with. */
export interface TitleNumberingOptions {
  /**
   * Forms of a source's own, tried before the built-in ones — each a regular
   * expression with named groups: `title`, which is required, and any of
   * `season`, `seasons`, `episode`, `episodes`, `part`, `parts` and
   * `subTitle`. It is matched against the whole title, as though it began with
   * `^` and ended with `$`, and one without a `title` group throws the first
   * time it is used.
   *
   * A number may be digits or a well-formed Roman numeral, with space around
   * it and an ordinal's dot after it — "3." and "I." are 3 and 1. Nought is left
   * out, and a reading with no season or episode above nought is none. A word
   * that is no number has the pattern pass the title on rather than read it, as
   * "CIVIL (2)" is not season `CIVIL`.
   *
   * Tried first, a pattern is also how a source reads what the built-in ones
   * leave alone: a daily soap's "(1999)", which they take for a year, is
   * `/(?<title>.+?)\s*\((?<episode>\d+)\)/u`.
   *
   * ```ts
   * { patterns: [/^(?<title>.+?)\s+(?<season>\d+)\.\s*évad$/u] }
   * ```
   */
  patterns?: readonly RegExp[];
}

/**
 * Between a title and its numbering: a colon, a comma, or a dash — "-", "–" or
 * "—" — after a space.
 */
const SEPARATOR = String.raw`(?::|,|\s+[-–—])`;

/** A sub-title after the numbering, after a dash. */
const SUB_TITLE = String.raw`(?:\s+[-–—]\s+(?<subTitle>.+))?`;

/**
 * "(13)" or "(6/12)": an episode, of how many. Not a year, "(2019)", nor a
 * season's span of two, "(2023/24)".
 */
const EPISODE_OF = String.raw`\((?!(?:19|20)\d\d[)/])(?<episode>\d{1,4})(?:\/(?<episodes>\d+))?\)`;

/**
 * The forms read out of the box, in the order they are tried:
 *
 * - "Duel S01E99", "Duel - s01e02 - Pilot", "Duel S01 Ep 5", "Duel S1/3E2/10
 *   P1/2" — the `onscreen` grammar `parseOnscreenEpisodeNum` reads, with the
 *   season it leaves optional required.
 * - "Walker, Texas Ranger Season 4 Episode 5", "Show: Season 2, Episode 5",
 *   "TrimZZ: Episode 4".
 * - "Komisár Rex III (13)", "Kobra 11 XXIII. (3)" — a season numeral and the
 *   episode. A numeral of one letter is a season only as `I` or `V`: "Malcolm
 *   X", "Vitamin C" and "Generation X" are names.
 * - "M*A*S*H (49)", "Filter (6/6)" — the episode, of how many.
 * - "Robogobo: Season 1", "Big Coast - Season 12 - Duncanby Lodge" — the
 *   season, after a separator.
 *
 * The words are read in any case; a Roman numeral only in capitals, since
 * "civil" is no more a numeral than "CIVIL" is.
 */
const BUILT_IN: readonly RegExp[] = [
  new RegExp(String.raw`^(?<title>.+?)${SEPARATOR}?\s+${ONSCREEN_IN_TITLE}${SUB_TITLE}$`, 'iu'),
  new RegExp(
    String.raw`^(?<title>.+?)(?<!\bSeason\s+\d+)${SEPARATOR}?\s+(?:Season\s+(?<season>\d+)${SEPARATOR}?\s+)?Episode\s+(?<episode>\d+)${SUB_TITLE}$`,
    'iu',
  ),
  new RegExp(
    String.raw`^(?<title>.+?)${SEPARATOR}?\s+(?<season>[IVXLC]{2,}|[IV])\.?\s*${EPISODE_OF}$`,
    'u',
  ),
  new RegExp(String.raw`^(?<title>.+?)${SEPARATOR}?\s*${EPISODE_OF}$`, 'u'),
  new RegExp(String.raw`^(?<title>.+?)${SEPARATOR}\s+Season\s+(?<season>\d+)${SUB_TITLE}$`, 'iu'),
];

/**
 * A numeral ending a title, read only by {@link stripTitleSeason}: a season
 * where a source says apart which one it is, a sequel's name where it does not.
 */
const TRAILING_NUMERAL = /^(?<title>.+?)\s+(?<season>[IVXLC]+)\.?$/u;

const NUMBERS = ['season', 'seasons', 'episode', 'episodes', 'part', 'parts'] as const;

/** The longest text read as a title — see {@link read}. */
const LONGEST_TITLE = 500;

/** A pattern's named groups, as a match has them. */
type Groups = Record<string, string | undefined>;

/**
 * What one pattern read: the numbering, and the groups it read it from — which
 * still say what a nought the numbering leaves out was.
 */
interface Reading {
  numbering: TitleNumbering;
  groups: Groups;
}

/**
 * A title, and the numbering at its end where it says outright what that is.
 * A title nothing reads comes back as the only field, trimmed.
 *
 * ```ts
 * parseTitleNumbering('Komisár Rex III (13)'); // { title: 'Komisár Rex', season: 3, episode: 13 }
 * parseTitleNumbering('Spinal Tap II');        // { title: 'Spinal Tap II' }
 * ```
 *
 * A number is taken too, as an API gives a title of "13", and a `null` or
 * `undefined` one comes back as it came — the type says so.
 */
export function parseTitleNumbering<T extends string | number | null | undefined>(
  title: T,
  options?: TitleNumberingOptions,
): Omit<TitleNumbering, 'title'> & { title: string | Extract<T, null | undefined> } {
  // Neither, as an API can send a title, is handed back as it came rather
  // than made the text "null" — as a builder keeps it.
  if (typeof title !== 'string' && typeof title !== 'number') {
    return { title: title as Extract<T, null | undefined> };
  }

  const full = String(title).trim();

  return readTitleNumbering(full, options?.patterns) ?? { title: full };
}

/**
 * {@link parseTitleNumbering}, with nothing where nothing reads the title — so
 * a builder can leave the title it was given as it was given.
 */
export function readTitleNumbering(
  title: string,
  patterns?: readonly RegExp[],
): TitleNumbering | undefined {
  return read(title.trim(), patterns)?.numbering;
}

/**
 * A title, trimmed, without the season a source also gives apart, where the
 * title repeats it at its end: "Zločin III", "Kobra 11 XXIII.", "Robogobo:
 * Season 1" for season 3, 23 and 1. A source's own forms are read too, before
 * these.
 *
 * Only that season, and only where it is all the title says: "Spinal Tap II"
 * from a source that says season 1 is a sequel's name, "Duel S01E05" has an
 * episode in it as well, and a title with no season given stays whole. A
 * `null` or `undefined` title comes back as it came, as the type says.
 */
export function stripTitleSeason<T extends string | number | null | undefined>(
  title: T,
  season: number | string | null | undefined,
  options?: TitleNumberingOptions,
): string | Extract<T, null | undefined> {
  // Neither, as an API can send a title, is handed back as it came — see
  // parseTitleNumbering.
  if (typeof title !== 'string' && typeof title !== 'number') {
    return title as Extract<T, null | undefined>;
  }

  const full = String(title).trim();
  const wanted = Number(season);

  if (!Number.isInteger(wanted) || wanted <= 0) {
    return full;
  }

  const reading = read(full, options?.patterns, TRAILING_NUMERAL);

  return reading !== undefined &&
    reading.numbering.season === wanted &&
    reading.numbering.subTitle === undefined &&
    NUMBERS.every((key) => key === 'season' || written(reading.groups[key]) === undefined)
    ? reading.numbering.title
    : full;
}

/**
 * What the first pattern to read `full` read — a source's own, the built-in
 * ones, then `last` — or nothing where none does.
 */
function read(
  full: string,
  own: readonly RegExp[] | undefined,
  last?: RegExp,
): Reading | undefined {
  // Each of a source's patterns checked before any reads, so one that cannot
  // read anything says so on the first title, not on the first that the
  // patterns before it leave to it.
  for (const pattern of own ?? []) {
    whole(pattern);
  }

  // No title is this long, and a text that is — a description in the wrong
  // field, a run of padding — is one a pattern's `.+?\s+` would take time
  // that grows with the square of its length to give up on.
  if (full.length > LONGEST_TITLE) {
    return undefined;
  }

  for (const pattern of own ?? []) {
    const reading = readWith(whole(pattern), full);

    if (reading !== undefined) {
      return reading;
    }
  }

  for (const pattern of BUILT_IN) {
    const reading = readWith(pattern, full);

    if (reading !== undefined) {
      return reading;
    }
  }

  return last === undefined ? undefined : readWith(last, full);
}

/** What one pattern reads `full` as, if anything. */
function readWith(pattern: RegExp, full: string): Reading | undefined {
  const groups = pattern.exec(full)?.groups;

  return groups === undefined ? undefined : numbered(groups);
}

/** A source's global or sticky pattern, as one that keeps no place between titles. */
const WHOLE = new WeakMap<RegExp, RegExp>();

/**
 * A source's pattern as one over the whole title, compiled the first time it
 * is used: anchored at both ends, so a match is the whole title or none — one
 * that read part of it would drop the rest with nothing said — and without the
 * flags that would have it go on from where it stopped on the last title, or
 * match one line of it. The caller's own pattern, and its `lastIndex`, are
 * left alone.
 *
 * One with nowhere to put the title is a mistake in it, which would read
 * nothing, ever, with nothing said — so it is refused here, as it is first
 * used, rather than the first time it would have matched.
 */
function whole(pattern: RegExp): RegExp {
  let compiled = WHOLE.get(pattern);

  if (compiled === undefined) {
    if (!pattern.source.includes('(?<title>')) {
      throw new TypeError(
        `A title-numbering pattern needs a (?<title>…) group, and ${String(pattern)} has none`,
      );
    }

    compiled = new RegExp(`^(?:${pattern.source})$`, pattern.flags.replace(/[gmy]/g, ''));
    WHOLE.set(pattern, compiled);
  }

  return compiled;
}

/**
 * A number as a group wrote it, without the space around it and an ordinal's
 * dot — or nothing where the group took no part or matched nothing, which is
 * a number not given.
 */
function written(group: string | undefined): string | undefined {
  const number = group?.trim().replace(/\.$/, '');

  return number ? number : undefined;
}

/**
 * What one pattern read, or nothing where it read no title, a number that is
 * not one, or no season or episode above nought — which hands the title on to
 * the next pattern.
 */
function numbered(groups: Groups): Reading | undefined {
  const title = groups['title']?.trim();

  if (!title) {
    return undefined;
  }

  const numbering: TitleNumbering = { title };

  for (const key of NUMBERS) {
    const number = written(groups[key]);

    if (number === undefined) {
      continue;
    }

    const value = /^\d+$/.test(number) ? Number(number) : romanToNumber(number);

    if (value === undefined) {
      return undefined;
    }

    // Nought is no number to write — "S00E05" is a special, its season none —
    // and the rest of what the pattern read stands.
    if (value > 0 && Number.isSafeInteger(value)) {
      numbering[key] = value;
    }
  }

  // A reading names a season or an episode. Without one there is nothing to
  // write — a total, a part, a nought, or a pattern whose numbers are all
  // optional and took no part — and taking anything off the title would lose
  // what it said: "Duel S00E00" and "Show (0/12)" stay as they are.
  if (numbering.season === undefined && numbering.episode === undefined) {
    return undefined;
  }

  const subTitle = groups['subTitle']?.trim();

  if (subTitle) {
    numbering.subTitle = subTitle;
  }

  return { numbering, groups };
}

const ROMAN_DIGITS: Readonly<Record<string, number>> = { I: 1, V: 5, X: 10, L: 50, C: 100 };

/** A well-formed numeral up to 399, so a word of those letters — "CIVIL" — is not one. */
const ROMAN = /^C{0,3}(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/;

/** A Roman numeral's value — "XXV" is 25 — or nothing for anything else. */
function romanToNumber(roman: string): number | undefined {
  if (roman === '' || !ROMAN.test(roman)) {
    return undefined;
  }

  const digits = [...roman].map((letter) => ROMAN_DIGITS[letter] ?? 0);

  return digits.reduce(
    (sum, value, i) => ((digits[i + 1] ?? 0) > value ? sum - value : sum + value),
    0,
  );
}
