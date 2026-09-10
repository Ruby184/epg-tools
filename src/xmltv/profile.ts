/**
 * Output profiles: a named bundle of the knobs that shape a guide for the
 * consumer that will read it.
 *
 * A correct XMLTV document is not the same as one a particular consumer
 * understands, and the gap is what this closes — which `<episode-num>` systems
 * go out and in what order, what a `<category>` is called, which of a
 * programme's nine icons or five languages of description it actually needs,
 * which optional elements are left out entirely.
 *
 * All of it applies as the document is **written**, never to what was grabbed.
 * One cache therefore serves every consumer, and changing profile costs no
 * refetch — the same property that makes `--no-extensions` cheap. It is also
 * the only safe place for a genre code: the merge dedupes categories on
 * `(lang, value)` and ignores their attributes, so an `eit` attached earlier
 * would be discarded depending on which source happened to be the base.
 */

import {
  formatDdProgidEpisodeNum,
  formatOnscreenEpisodeNum,
  formatXmltvNsEpisodeNum,
  parseDdProgidEpisodeNum,
  parseOnscreenEpisodeNum,
  parseXmltvNsEpisodeNum,
  type EpisodeNumbers,
} from './episode-num.js';
import { genreKey, genreOf } from './genres.js';
import type {
  XmltvEpisodeNum,
  XmltvIcon,
  XmltvImage,
  XmltvPersonValue,
  XmltvRating,
  XmltvReview,
  XmltvStarRating,
  XmltvSubtitles,
  XmltvTextValue,
  XmltvUrlValue,
} from './types.js';

/*
 * The elements a profile may shape, as paths from the document root.
 *
 * Which elements those are comes from the DTD's content models: a child with
 * `*` or `?` cardinality can be dropped, one with `+` or bare cardinality
 * cannot. So `programme/title`, `channel/display-name` and both `value`
 * elements appear nowhere below — a document without them is not one this
 * package will write.
 *
 * Paths rather than bare names because `icon` appears in four content models
 * and `url` in three, so `'icon'` alone reads as unambiguous and is not.
 */

/** `credits (director*, actor*, …)` — every role repeatable. */
const CREDIT_ROLES = [
  'director',
  'actor',
  'writer',
  'adapter',
  'producer',
  'composer',
  'editor',
  'presenter',
  'commentator',
  'guest',
] as const;

/** The `?` children of `<programme>`: at most one each, so nothing to choose. */
const PROGRAMME_SINGLE = [
  'credits',
  'date',
  'language',
  'orig-language',
  'length',
  'video',
  'audio',
  'previously-shown',
  'premiere',
  'last-chance',
  'new',
] as const;

const VIDEO_DETAILS = ['present', 'colour', 'aspect', 'quality'] as const;
const AUDIO_DETAILS = ['present', 'stereo'] as const;

type CreditRole = (typeof CREDIT_ROLES)[number];

/**
 * Every repeatable path and what it holds — the one place both are declared,
 * so an {@link ElementPicker} is handed the elements it actually picks from
 * rather than something to cast.
 */
type RepeatableElement = {
  [P in `programme/credits/${CreditRole}`]: XmltvPersonValue;
} & {
  [P in `programme/credits/${CreditRole}/image`]: XmltvImage;
} & {
  [P in `programme/credits/${CreditRole}/url`]: XmltvUrlValue;
} & {
  'channel/icon': XmltvIcon;
  'channel/url': XmltvUrlValue;
  'programme/sub-title': XmltvTextValue;
  'programme/desc': XmltvTextValue;
  'programme/category': XmltvTextValue;
  'programme/keyword': XmltvTextValue;
  'programme/icon': XmltvIcon;
  'programme/url': XmltvUrlValue;
  'programme/country': XmltvTextValue;
  'programme/episode-num': XmltvEpisodeNum;
  'programme/subtitles': XmltvSubtitles;
  'programme/rating': XmltvRating;
  'programme/star-rating': XmltvStarRating;
  'programme/review': XmltvReview;
  'programme/image': XmltvImage;
  'programme/rating/icon': XmltvIcon;
  'programme/star-rating/icon': XmltvIcon;
};

/** A repeatable element, which {@link OutputProfile.keep} can narrow. */
export type RepeatableRef = keyof RepeatableElement;

/** One element a profile can leave out. See {@link OutputProfile.drop}. */
export type DropRef =
  | RepeatableRef
  | `programme/${(typeof PROGRAMME_SINGLE)[number]}`
  | `programme/video/${(typeof VIDEO_DETAILS)[number]}`
  | `programme/audio/${(typeof AUDIO_DETAILS)[number]}`
  | 'programme/subtitles/language';

/**
 * The same repeatable paths as a value, for checking one that did not come
 * through TypeScript.
 *
 * `satisfies` is what keeps it honest: a path misspelled here would otherwise
 * be a validation rule that silently never fires.
 */
const REPEATABLE_PATHS = [
  'channel/icon',
  'channel/url',
  'programme/sub-title',
  'programme/desc',
  'programme/category',
  'programme/keyword',
  'programme/icon',
  'programme/url',
  'programme/country',
  'programme/episode-num',
  'programme/subtitles',
  'programme/rating',
  'programme/star-rating',
  'programme/review',
  'programme/image',
  'programme/rating/icon',
  'programme/star-rating/icon',
] as const satisfies readonly RepeatableRef[];

/**
 * Which of a repeated element are written, and in what order — given all of
 * them, return the ones to keep.
 *
 * The whole list rather than one at a time, because the interesting choices are
 * comparative: the widest icon, the English description *if there is one*. A
 * per-element predicate is `(all) => all.filter(…)`, so nothing is lost.
 *
 * Must not mutate its argument or the elements in it. They may be a cache
 * store's own objects, and a server re-serializes the same ones on every poll.
 */
export type ElementPicker<T> = (elements: readonly T[]) => readonly T[];

/**
 * Which of a repeated element survive: a count from the first, or a picker.
 *
 * `1` is shorthand for "just the first", which is much the commonest wish.
 */
export type KeepRule<T> = number | ElementPicker<T>;

/**
 * A {@link KeepRule} with its element type erased, which is how
 * {@link ResolvedProfile} can hold the rules for every path in one map.
 */
export type ResolvedKeepRule = number | ElementPicker<unknown>;

/** What a profile does to a programme's `<episode-num>` entries. */
export interface EpisodeNumPolicy {
  /**
   * The systems kept, best first — everything else goes. Omit to keep all, in
   * the order the programme carries them.
   *
   * Order is what usually matters rather than selection: MediaPortal reads the
   * **first** `<episode-num>` and skips the rest, and tvheadend lets whichever
   * comes first fill the same episode number. So `['xmltv_ns', 'dd_progid']`
   * fixes both at once, while dropping `dd_progid` outright would lose the
   * series identity both of them want.
   *
   * Matched against the DTD's default: an entry with no `system` attribute is
   * `'onscreen'`.
   */
  systems?: readonly string[];
  /** Keep only the first surviving entry. */
  single?: boolean;
  /**
   * Write a system {@link systems} asks for that the programme does not carry,
   * derived from one it does.
   *
   * Only ever **fills a gap** — an entry a source supplied is never replaced,
   * because `onscreen` is free-form display text and overwriting somebody's
   * `'#FFEE'` with a fabricated `S02E06` is data loss. Between `xmltv_ns` and
   * `onscreen` only, and only from a value that reads unambiguously.
   */
  deriveMissing?: boolean;
  /**
   * Rewrite a `dd_progid` into its canonical dotted form.
   *
   * The three forms XMLTV's grabbers emit are not read alike: tvheadend scans
   * backwards for a dot, so an undotted id yields it neither a series uri nor
   * an episode, and a three-field one makes it read the part as the episode.
   */
  normalizeDdProgid?: boolean;
}

/**
 * Category text to replace it with, keyed by the text a source wrote.
 *
 * Keys are matched by {@link genreKey} — case, spacing, underscores and hyphens
 * all ignored — so one entry covers `Sci-Fi`, `sci fi` and `SciFi`.
 */
export type CategoryMap = Readonly<Record<string, string>>;

/**
 * A category's replacement, decided one at a time.
 *
 * Return a string to rewrite the text, a whole {@link XmltvTextValue} to change
 * its `lang` too, `undefined` to leave it exactly as it was, or `null` to drop
 * it. The two nothings differ on purpose: one is "no opinion", the other is
 * "remove this".
 */
export type CategoryMapper = (
  category: XmltvTextValue,
) => string | XmltvTextValue | null | undefined;

/** A bundle of the knobs that shape output for one consumer. */
export interface OutputProfile {
  episodeNum?: EpisodeNumPolicy;
  /**
   * Elements to leave out, as paths from the document root —
   * `'programme/image'`, `'programme/credits/actor'`, `'channel/icon'`.
   *
   * A container and its children are both spellable, and the container is the
   * one to reach for: `'programme/credits'` drops the block without generating
   * any of it, where listing all ten roles builds each, drops it, and lets the
   * empty parent collapse. The per-role paths are for what the container cannot
   * say — keep the director, drop a twenty-name cast.
   */
  drop?: readonly DropRef[];
  /**
   * Which of a repeated element to write: a count, or a function given all of
   * them that returns the ones to keep.
   *
   * ```ts
   * keep: {
   *   'programme/icon': 1,
   *   // the biggest, rather than whichever came first
   *   'programme/image': (all) => [...all].sort(bySize).slice(0, 1),
   *   // one language, but not at the cost of having none
   *   'programme/desc': (all) => {
   *     const english = all.filter((desc) => desc.lang === 'en');
   *     return english.length > 0 ? english : all.slice(0, 1);
   *   },
   * }
   * ```
   *
   * A multilingual guide is the case that earns the function form. A source
   * carrying five languages of `<desc>` is right to, a consumer showing one is
   * right to want one, and that last example is the rule people actually mean —
   * which neither a count nor a per-element predicate can express.
   *
   * Only elements the DTD lets repeat can be narrowed, which the type enforces:
   * there is nothing to choose from a `<video>` block that occurs once. `0`
   * removes the element, which {@link drop} says more plainly, and where both
   * name the same path `drop` wins.
   */
  keep?: { readonly [P in RepeatableRef]?: KeepRule<RepeatableElement[P]> };
  /**
   * Rewrite `<category>` text: `true` for the shipped DVB vocabulary, a
   * {@link CategoryMap} of your own, or a {@link CategoryMapper}.
   *
   * The shipped table is worth having because the consumer that reads
   * categories matches them exactly and drops a near-miss silently — `Movie`
   * means nothing to it, `Movie / Drama` means a film. A rewrite from that
   * table sets `lang="en"`, since the vocabulary is English by construction and
   * leaving a `lang="de"` on English text would be a lie the merge believes. A
   * rewrite from *your* map keeps the original `lang`, because mapping into
   * canonical German is a reasonable thing to do.
   */
  categories?: boolean | CategoryMap | CategoryMapper;
  /**
   * Attach the DVB genre code as `eit="0xNN"`.
   *
   * A provider extension rather than a DTD attribute, so it is subject to
   * `extensions` like any other: `--no-extensions` removes it even under a
   * profile that asks for it, which is what keeps "no extensions" meaning "a
   * document that validates". A code a source supplied already is left alone.
   *
   * Opt-in because it is inert by default — tvheadend reads it only when its
   * Category Code XPath is pointed at `@eit`. {@link categories} is the half
   * that works out of the box.
   */
  eit?: boolean;
}

/**
 * The profiles this package ships, for the two consumers whose handling of a
 * guide was read from their source rather than inferred.
 *
 * Start from one by spreading it — `{ ...OUTPUT_PROFILES.tvheadend, eit: false }`
 * — so there is no merge API to learn.
 *
 * No Plex or Emby profile: both are closed source, so there is nothing to read,
 * and a profile that is wrong is worse than none because it is what people
 * will reach for without checking.
 */
export const OUTPUT_PROFILES = {
  /** Read from tvheadend's `src/epggrab/module/xmltv.c` and `src/epg.c`, 2026-09. */
  tvheadend: {
    episodeNum: {
      // `xmltv_ns` first so it wins the episode number, `dd_progid` kept but
      // after it: tvheadend takes the series uri from it, and misreads its
      // tail as an episode number if it gets there first.
      systems: ['xmltv_ns', 'dd_progid', 'onscreen'],
      deriveMissing: true,
      normalizeDdProgid: true,
    },
    categories: true,
    eit: true,
    // It has no handling for either element.
    drop: ['programme/review', 'programme/image'],
  },
  /** Read from `jellyfin/Jellyfin.XmlTv`'s `XmlTvReader.cs`, 2026-09. */
  jellyfin: {
    episodeNum: {
      // `onscreen` left out on purpose: its parser for that system is a stub
      // whose body is `reader.Skip()`. `dd_progid` kept — it becomes the
      // programme's own id, which is how episodes are told apart.
      systems: ['xmltv_ns', 'dd_progid'],
      deriveMissing: true,
      normalizeDdProgid: true,
    },
    categories: true,
    // No case for it in the programme reader.
    drop: ['programme/review'],
  },
} as const satisfies Record<string, OutputProfile>;

/** The name of a profile this package ships. */
export type OutputProfileName = keyof typeof OUTPUT_PROFILES;

/** Every shipped profile name, for a command line that offers a choice. */
export const OUTPUT_PROFILE_NAMES = Object.keys(OUTPUT_PROFILES) as OutputProfileName[];

/** A profile, or the name of one this package ships. */
export type ProfileRef = OutputProfileName | OutputProfile;

/**
 * A profile compiled into the form the serializer uses: sets, maps and
 * closures, with every lookup table already built.
 *
 * Resolved once per options object rather than per element, because the
 * serializer's formatting record is rebuilt for every channel and programme in
 * the guide.
 */
export interface ResolvedProfile {
  /** Paths to leave out, absent when nothing is dropped. */
  drop?: ReadonlySet<string>;
  /** Which of each repeated element to write. */
  keep?: ReadonlyMap<string, ResolvedKeepRule>;
  /** Reshapes a programme's `<episode-num>` list. */
  episodeNum?: (entries: readonly XmltvEpisodeNum[]) => XmltvEpisodeNum[];
  /** Rewrites a programme's `<category>` list, dedupe included. */
  categories?: (values: readonly XmltvTextValue[]) => XmltvTextValue[];
}

const REPEATABLE: ReadonlySet<string> = new Set<string>([
  ...REPEATABLE_PATHS,
  ...CREDIT_ROLES.flatMap((role) => [
    `programme/credits/${role}`,
    `programme/credits/${role}/image`,
    `programme/credits/${role}/url`,
  ]),
]);

/** Every droppable path, repeatable ones included. */
const DROPPABLE: ReadonlySet<string> = new Set<string>([
  ...REPEATABLE,
  ...PROGRAMME_SINGLE.map((name) => `programme/${name}`),
  ...VIDEO_DETAILS.map((name) => `programme/video/${name}`),
  ...AUDIO_DETAILS.map((name) => `programme/audio/${name}`),
  'programme/subtitles/language',
]);

/**
 * Apply a keep rule to a list.
 *
 * The one cast in this module: {@link ResolvedProfile} holds the rules for
 * every path in one map, which erases the element type
 * {@link OutputProfile.keep} checked on the way in.
 */
export function pick<T>(rule: ResolvedKeepRule, elements: readonly T[]): readonly T[] {
  return typeof rule === 'number' ? elements.slice(0, rule) : (rule as ElementPicker<T>)(elements);
}

/** The DTD's default: an `<episode-num>` with no `system` is `onscreen`. */
function systemOf(entry: XmltvEpisodeNum): string {
  return entry.system ?? 'onscreen';
}

/**
 * Numbers to derive from, preferring `xmltv_ns` because it is structured where
 * `onscreen` is display text.
 */
function numbersFrom(entries: readonly XmltvEpisodeNum[]): EpisodeNumbers | undefined {
  for (const entry of entries) {
    if (systemOf(entry) === 'xmltv_ns') {
      const numbers = parseXmltvNsEpisodeNum(entry.value);

      if (numbers !== undefined) {
        return numbers;
      }
    }
  }

  for (const entry of entries) {
    if (systemOf(entry) === 'onscreen') {
      const numbers = parseOnscreenEpisodeNum(entry.value);

      if (numbers !== undefined) {
        return numbers;
      }
    }
  }

  return undefined;
}

/** A system's value built from numbers, for the two that can be written. */
function derived(system: string, numbers: EpisodeNumbers): string | undefined {
  if (system === 'xmltv_ns') {
    return formatXmltvNsEpisodeNum(numbers);
  }

  return system === 'onscreen' ? formatOnscreenEpisodeNum(numbers) : undefined;
}

function episodeNumRewrite(policy: EpisodeNumPolicy): ResolvedProfile['episodeNum'] | undefined {
  const { systems, single = false, deriveMissing = false, normalizeDdProgid = false } = policy;

  if (systems === undefined && !single && !deriveMissing && !normalizeDdProgid) {
    return undefined;
  }

  return (entries) => {
    let kept: XmltvEpisodeNum[] = normalizeDdProgid
      ? entries.map((entry) => {
          if (systemOf(entry) !== 'dd_progid') {
            return entry;
          }

          const id = parseDdProgidEpisodeNum(entry.value);

          // A value that is not a dd_progid is left exactly as it came: it is
          // still somebody's identifier, just not one that can be normalised.
          return id === undefined ? entry : { ...entry, value: formatDdProgidEpisodeNum(id) };
        })
      : [...entries];

    if (deriveMissing && systems !== undefined) {
      const numbers = numbersFrom(kept);

      if (numbers !== undefined) {
        for (const system of systems) {
          if (kept.some((entry) => systemOf(entry) === system)) {
            continue;
          }

          const value = derived(system, numbers);

          if (value !== undefined) {
            // The system is written out explicitly: an entry with none is read
            // as a bare episode number, which is not what this says.
            kept.push({ system, value });
          }
        }
      }
    }

    if (systems !== undefined) {
      // Walking the wanted systems and collecting what matches does the filter
      // and the ordering in one pass, and is stable within a system for free.
      //
      // The obvious `filter().map().sort().map()` costs four arrays and a
      // wrapper object per entry to sort by index — for a list that is almost
      // always two or three long, on every programme in the guide.
      const ordered: XmltvEpisodeNum[] = [];

      for (const system of systems) {
        for (const entry of kept) {
          if (systemOf(entry) === system) {
            ordered.push(entry);
          }
        }
      }

      kept = ordered;
    }

    return single ? kept.slice(0, 1) : kept;
  };
}

/** Lookup tables built from a caller's record, keyed by the record itself. */
const CATEGORY_MAPS = new WeakMap<CategoryMap, ReadonlyMap<string, string>>();

function categoryLookup(map: CategoryMap): ReadonlyMap<string, string> {
  let folded = CATEGORY_MAPS.get(map);

  if (folded === undefined) {
    folded = new Map(Object.entries(map).map(([from, to]) => [genreKey(from), to]));
    CATEGORY_MAPS.set(map, folded);
  }

  return folded;
}

function categoryRewrite(
  categories: OutputProfile['categories'],
  eit: boolean,
): ResolvedProfile['categories'] | undefined {
  const rewriting = categories !== undefined && categories !== false;

  if (!rewriting && !eit) {
    return undefined;
  }

  const one = (category: XmltvTextValue): XmltvTextValue | undefined => {
    let next = category;

    if (categories === true) {
      const genre = genreOf(category.value);

      // English by construction, so saying so is true — and leaving a
      // `lang="de"` on `Movie / Drama` is a lie the merge would believe.
      if (genre !== undefined) {
        next = { ...category, value: genre.name, lang: 'en' };
      }
    } else if (typeof categories === 'function') {
      const result = categories(category);

      if (result === null) {
        return undefined;
      }

      if (typeof result === 'string') {
        next = { ...category, value: result };
      } else if (result !== undefined) {
        next = result;
      }
    } else if (rewriting) {
      // The caller's own mapping, which keeps whatever `lang` was there: a map
      // into canonical German is a reasonable thing to have written.
      const to = categoryLookup(categories as CategoryMap).get(genreKey(category.value));

      if (to !== undefined) {
        next = { ...category, value: to };
      }
    }

    if (eit) {
      const genre = genreOf(next.value);

      // A code the source supplied wins: it knows its own data.
      if (genre !== undefined && next.extraAttributes?.eit === undefined) {
        next = { ...next, extraAttributes: { ...next.extraAttributes, eit: genre.eit } };
      }
    }

    return next;
  };

  return (values) => {
    // One category cannot collide with anything, and that is the overwhelmingly
    // common case — so the dedupe below allocates nothing for it.
    if (values.length < 2) {
      const only = values.length === 0 ? undefined : one(values[0]!);

      return only === undefined ? [] : [only];
    }

    const out: XmltvTextValue[] = [];
    // Two categories in different languages can canonicalise onto one, and the
    // merge deduped before any of this ran, so the rewrite dedupes its own
    // output or the genre goes out twice.
    const seen = new Set<string>();

    for (const value of values) {
      const mapped = one(value);

      if (mapped === undefined) {
        continue;
      }

      const key = `${mapped.lang ?? ''}|${mapped.value}`;

      if (!seen.has(key)) {
        seen.add(key);
        out.push(mapped);
      }
    }

    return out;
  };
}

function compile(profile: OutputProfile): ResolvedProfile {
  const resolved: ResolvedProfile = {};

  if (profile.drop !== undefined && profile.drop.length > 0) {
    for (const path of profile.drop) {
      if (!DROPPABLE.has(path)) {
        throw new TypeError(
          `Cannot drop ${path}: not an optional element. The DTD requires programme/title and channel/display-name, and a path names an element from the document root — 'programme/image', not 'image'.`,
        );
      }
    }

    resolved.drop = new Set(profile.drop);
  }

  if (profile.keep !== undefined) {
    const rules = new Map<string, ResolvedKeepRule>();

    for (const [path, rule] of Object.entries(profile.keep) as [string, ResolvedKeepRule][]) {
      if (!REPEATABLE.has(path)) {
        throw new TypeError(
          `Cannot narrow ${path}: the DTD allows at most one, so there is nothing to choose between. Use drop to remove it.`,
        );
      }

      if (typeof rule === 'number' && (!Number.isInteger(rule) || rule < 0)) {
        throw new TypeError(
          `Cannot keep ${rule} of ${path}: expected a whole number 0 or more, or a function.`,
        );
      }

      rules.set(path, rule);
    }

    if (rules.size > 0) {
      resolved.keep = rules;
    }
  }

  const episodeNum =
    profile.episodeNum === undefined ? undefined : episodeNumRewrite(profile.episodeNum);

  if (episodeNum !== undefined) {
    resolved.episodeNum = episodeNum;
  }

  const categories = categoryRewrite(profile.categories, profile.eit ?? false);

  if (categories !== undefined) {
    resolved.categories = categories;
  }

  return resolved;
}

/**
 * Two caches, because a name cannot key a `WeakMap` and an object should not be
 * held by a strong one — it is the caller's, and may not outlive one call.
 */
const BY_OBJECT = new WeakMap<OutputProfile, ResolvedProfile>();
const BY_NAME = new Map<OutputProfileName, ResolvedProfile>();

/**
 * Compile a profile, once per profile rather than once per element.
 *
 * Throws on a name this package does not ship, a path that names no optional
 * element, or a count that is not one — at resolve time, so a mistake surfaces
 * on the first element written rather than the ten-thousandth.
 */
export function resolveProfile(profile: ProfileRef): ResolvedProfile {
  if (typeof profile === 'string') {
    let held = BY_NAME.get(profile);

    if (held === undefined) {
      const shipped = OUTPUT_PROFILES[profile] as OutputProfile | undefined;

      if (shipped === undefined) {
        throw new TypeError(
          `Unknown output profile: ${profile}. Available: ${OUTPUT_PROFILE_NAMES.join(', ')}`,
        );
      }

      held = compile(shipped);
      BY_NAME.set(profile, held);
    }

    return held;
  }

  let held = BY_OBJECT.get(profile);

  if (held === undefined) {
    held = compile(profile);
    BY_OBJECT.set(profile, held);
  }

  return held;
}
