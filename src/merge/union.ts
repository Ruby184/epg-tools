/**
 * Which of a programme's texts say the same thing, and so which one the guide
 * keeps.
 *
 * Two sources rarely write a title, a category or a description the same way
 * to the letter — "DJ Mixes premiere" and "Dj Mixes Premiere", "Film" and
 * "film", a teaser cut off with "…" beside the whole of it — and a programme
 * merged from both carries every spelling, so a guide shows two titles and a
 * description twice.
 *
 * Applied as each programme is written, not as two are merged. Merging decides
 * which programmes are one broadcast by their titles, and a title dropped at
 * the first merge would be one a third source's could no longer match: the
 * merge keeps every text, so matching sees all of them, and the guide writes
 * one of each.
 */

import { genreKey } from '../xmltv/genres.js';
import type { XmltvProgramme, XmltvTextValue } from '../xmltv/types.js';
import { foldText, normalizeTitle as matchTitle, unionBy } from './text.js';
import type { MergeUnion, TextUnion } from './types.js';

/** The fields a {@link MergeUnion} speaks for. */
type UnionField = keyof MergeUnion;

/** One field's texts, as the guide writes them — the same array where none is dropped. */
type FieldUnion = (texts: XmltvTextValue[]) => XmltvTextValue[];

const FIELDS: readonly UnionField[] = [
  'title',
  'subTitle',
  'desc',
  'category',
  'keyword',
  'country',
];

/**
 * What each field does when a config says nothing: a title or a sub-title is
 * the same as another by the match's own comparison, a description another
 * contains says nothing new, and a category, keyword or country is the same
 * but for case, spacing, hyphens and underscores. `'exact'` on a field is what
 * every field did before.
 */
export const DEFAULT_UNION: Readonly<Required<MergeUnion>> = Object.freeze({
  title: 'match',
  subTitle: 'match',
  desc: 'contained',
  category: 'caseless',
  keyword: 'caseless',
  country: 'caseless',
});

/**
 * What marks a settled union, holding the title comparison it was settled with
 * — by the global registry, so a union another copy of this package settled is
 * taken for one too, as two installs side by side would otherwise not.
 *
 * Not enumerable, so a copy — a spread, `structuredClone`, a deep clone — does
 * not take it along: a copy has the fields a union was settled from and none
 * of what it was settled into, and is a union to settle again.
 */
const SETTLED = Symbol.for('epg-tools.ResolvedUnion');

/**
 * `merge.union`, settled: one union per field, and the match it was settled
 * with — what {@link resolveUnion} makes, and what a loaded config carries in
 * `merge.union` in place of what it was given.
 *
 * Its own fields are the union it was settled from, so it is a
 * {@link MergeUnion} itself: a fingerprint of the options reads what it says, a
 * spread of it is that union, and `merge.union`'s type stays what a config
 * writes. What it was settled into is its own, behind {@link apply}.
 */
export class ResolvedUnion implements MergeUnion {
  /** One of these, from this copy of the package or another — see {@link SETTLED}. */
  static [Symbol.hasInstance](value: unknown): value is ResolvedUnion {
    return (
      typeof value === 'object' &&
      value !== null &&
      typeof (value as { [SETTLED]?: unknown })[SETTLED] === 'function'
    );
  }

  declare readonly title?: TextUnion;
  declare readonly subTitle?: TextUnion;
  declare readonly desc?: TextUnion;
  declare readonly category?: TextUnion;
  declare readonly keyword?: TextUnion;
  declare readonly country?: TextUnion;
  readonly #fields: Readonly<Record<UnionField, FieldUnion>>;

  /**
   * Settle a union, checked: a field or a mode it does not know is refused
   * rather than read as the default — a misspelt one would otherwise keep
   * every duplicate it was set to remove, or remove what it was set to keep,
   * and nothing would say so. `'exact'` on its own is every field exact.
   */
  constructor(
    given: MergeUnion | 'exact' = {},
    normalizeTitle: (title: string) => string = matchTitle,
  ) {
    const union = read(given);
    const fields = {} as Record<UnionField, FieldUnion>;

    for (const field of FIELDS) {
      const mode = union[field];

      if (mode !== undefined) {
        (this as { -readonly [F in UnionField]?: TextUnion })[field] = mode;
      }

      // Left out is the default; anything else said, `null` included, is a
      // mode to read — and refused when it is not one.
      fields[field] = fieldUnion(
        mode === undefined ? DEFAULT_UNION[field] : mode,
        normalizeTitle,
        field,
      );
    }

    Object.defineProperty(this, SETTLED, { value: normalizeTitle });
    this.#fields = fields;
  }

  /**
   * A programme with its texts as the union says, field by field — the same
   * programme where nothing changes, which is nearly always: a field with
   * fewer than two texts has nothing to compare.
   */
  apply(programme: XmltvProgramme): XmltvProgramme {
    let result = programme;

    for (const field of FIELDS) {
      const texts = programme[field];

      if (texts === undefined || texts.length < 2) {
        continue;
      }

      const kept = this.#fields[field](texts);

      if (kept !== texts) {
        result = result === programme ? { ...programme } : result;
        result[field] = kept as XmltvProgramme['title'];
      }
    }

    return result;
  }
}

/**
 * Settle `merge.union` into something to write with, for a match's
 * `normalizeTitle`: what decides two programmes are one broadcast also decides
 * their titles are one title, so a config that loosens one loosens both.
 *
 * One already settled for the same comparison — a loaded config's — is taken
 * as it is; for another, it is settled again from the union it was settled
 * from.
 */
export function resolveUnion(
  union: MergeUnion | 'exact' | undefined = {},
  normalizeTitle: (title: string) => string = matchTitle,
): ResolvedUnion {
  return union instanceof ResolvedUnion &&
    (union as { [SETTLED]?: unknown })[SETTLED] === normalizeTitle
    ? union
    : new ResolvedUnion(union, normalizeTitle);
}

/** A union as given, checked for being one — a settled one by its own fields. */
function read(given: unknown): MergeUnion {
  if (given === 'exact') {
    return Object.fromEntries(FIELDS.map((field) => [field, 'exact']));
  }

  const prototype: unknown =
    typeof given === 'object' && given !== null ? Object.getPrototypeOf(given) : undefined;

  // A plain object, or a settled union read by the fields it was settled from.
  // A `Map`, or an instance of another class, has no fields to read, and
  // reading it as none would be the default unasked.
  if (!(given instanceof ResolvedUnion) && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(
      `merge.union must be 'exact' or an object of fields — ${FIELDS.join(', ')} ` +
        `(got ${described(given)})`,
    );
  }

  const union = given as Record<string, unknown>;
  const unknown = Object.keys(union).filter((field) => !FIELDS.includes(field as UnionField));

  if (unknown.length > 0) {
    throw new TypeError(
      `merge.union has no field ${unknown.map((field) => JSON.stringify(field)).join(', ')}: ` +
        `its fields are ${FIELDS.join(', ')}`,
    );
  }

  return Object.fromEntries(
    FIELDS.map((field) => [field, union[field]]).filter(([, mode]) => mode !== undefined),
  );
}

/** A value as an error can name it, whatever it is. */
function described(value: unknown): string {
  if (typeof value === 'function') {
    return 'a function';
  }

  if (typeof value === 'object' && value !== null) {
    const prototype: unknown = Object.getPrototypeOf(value);

    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
      const name = (value as { constructor?: { name?: string } }).constructor?.name;

      return name ? `an instance of ${name}` : 'an object of a class';
    }
  }

  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/** One field's mode as a union. */
function fieldUnion(
  mode: TextUnion,
  normalizeTitle: (title: string) => string,
  field: UnionField,
): FieldUnion {
  if (typeof mode === 'function') {
    return byKey(mode);
  }

  if (typeof mode === 'object' && mode !== null && typeof mode.contained === 'function') {
    // The site's own comparison first — a suffix of its own taken off — and
    // then the built-in one, so case, spacing and a teaser's "…" still count.
    return byContainment((value) => comparable(mode.contained(value)));
  }

  switch (mode) {
    case 'exact':
      // The texts as the sources gave them: merging two programmes already
      // keeps one of two identical ones, and nothing more is asked of these.
      return (texts) => texts;
    case 'caseless':
      return byKey(genreKey);
    case 'match':
      return byKey(normalizeTitle);
    case 'contained':
      return byContainment(comparable);
    default:
      throw new TypeError(
        `merge.union.${field} must be 'exact', 'caseless', 'match', 'contained', ` +
          `{ contained: fn } or a function (got ${described(mode)})`,
      );
  }
}

/**
 * The language a text is in: a missing one and an empty one alike, and a tag in
 * any case, as BCP 47 has them — `sk` and `SK` are one language.
 */
function language(text: XmltvTextValue): string {
  return (text.lang ?? '').toLowerCase();
}

/** Texts the same by `key`, within a language: the first of them kept. */
function byKey(key: (value: string) => string): FieldUnion {
  return (texts) => {
    const kept = unionBy(texts, undefined, (text) => `${language(text)}\0${key(text.value)}`);

    return kept.length === texts.length ? texts : kept;
  };
}

/** A text as `contained` compares it, and whether it was cut off. */
interface Comparable {
  key: string;
  /** It ended in "…", so it may stop part way through a word. */
  teaser: boolean;
}

/**
 * Texts said by another, within a language: one whose comparable form another
 * contains, as whole words, is dropped, and the one containing it takes its
 * place — so a fuller description from a lower-priority source stands where
 * the teaser it completes stood, and priority order holds. Of two the same, the
 * first stays. One that compares as nothing at all is dropped beside any other.
 *
 * Whole words, because a short text inside a longer one is often not the same
 * thing said again: "Krimi" is not "Krimiseriál o vyšetrovateľovi". Only a
 * teaser — cut off with "…" — may end part way through one.
 */
function byContainment(compare: (value: string) => Comparable): FieldUnion {
  return (texts) => {
    const compared = texts.map((text) => compare(text.value));
    const languages = texts.map(language);
    const covers = (j: number, i: number): boolean =>
      j !== i &&
      languages[j] === languages[i] &&
      contains(compared[j]!.key, compared[i]!) &&
      (compared[j]!.key !== compared[i]!.key || j < i);
    const kept = texts.map((_, i) => !texts.some((__, j) => covers(j, i)));
    const order = new Set<number>();

    for (const i of texts.keys()) {
      // Where a dropped one stood, the first kept text that covers it — once.
      const at = kept[i] ? i : texts.findIndex((_, j) => kept[j] && covers(j, i));

      if (at >= 0) {
        order.add(at);
      }
    }

    return order.size === texts.length ? texts : [...order].map((i) => texts[i]!);
  };
}

/** A letter or a digit — what a word is made of. */
const WORD = /[\p{L}\p{N}]/u;

/** Whether `inner` is in `outer` as whole words, its end free where it is a teaser. */
function contains(outer: string, inner: Comparable): boolean {
  if (inner.key === '') {
    return true;
  }

  for (let at = outer.indexOf(inner.key); at !== -1; at = outer.indexOf(inner.key, at + 1)) {
    const end = at + inner.key.length;
    const starts = at === 0 || !WORD.test(outer[at - 1]!);
    const ends = inner.teaser || end === outer.length || !WORD.test(outer[end]!);

    if (starts && ends) {
      return true;
    }
  }

  return false;
}

/**
 * A description as compared for `contained`: folded as text is, with a
 * teaser's trailing "…" or "..." taken off, so the cut-off one is found inside
 * the whole.
 */
function comparable(value: string): Comparable {
  const folded = foldText(value);
  const key = folded.replace(/(?:\.{3}|…)$/, '').trim();

  return { key, teaser: key !== folded };
}
