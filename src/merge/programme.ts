import type {
  XmltvCredits,
  XmltvPersonValue,
  XmltvProgramme,
  XmltvTextValue,
  XmltvUrlValue,
} from '../xmltv/types.js';
import type { ProgrammeStrategy } from './types.js';

/** Union two optional arrays, keeping first occurrence per dedup key. */
export function unionBy<T>(
  base: T[] | undefined,
  extra: T[] | undefined,
  key: (item: T) => string,
): T[] {
  const result: T[] = [];
  const seen = new Set<string>();

  // Iterate the two sources directly rather than spreading them into a
  // throwaway concat array — this is the merge hot path.
  for (let s = 0; s < 2; s++) {
    const items = s === 0 ? base : extra;

    if (!items) {
      continue;
    }

    for (const item of items) {
      const k = key(item);

      if (!seen.has(k)) {
        seen.add(k);
        result.push(item);
      }
    }
  }

  return result;
}

export function textKey(item: XmltvTextValue): string {
  return `${item.lang ?? ''}|${item.value}`;
}

/** Dedup key for `<url>` values (string or object with `system`). */
export function urlKey(item: XmltvUrlValue): string {
  return typeof item === 'string' ? `|${item}` : `${item.system ?? ''}|${item.value}`;
}

function personKey(item: XmltvPersonValue): string {
  return typeof item === 'string' ? item : item.value;
}

/** Credit roles whose entries are plain persons (everything except `actor`). */
const CREDIT_STRING_FIELDS = [
  'director',
  'writer',
  'adapter',
  'producer',
  'composer',
  'editor',
  'presenter',
  'commentator',
  'guest',
] as const;

function mergeCredits(
  base: XmltvCredits | undefined,
  extra: XmltvCredits | undefined,
): XmltvCredits | undefined {
  if (!base && !extra) {
    return undefined;
  }

  const merged: XmltvCredits = {};

  for (const field of CREDIT_STRING_FIELDS) {
    const values = unionBy(base?.[field], extra?.[field], personKey);

    if (values.length > 0) {
      merged[field] = values;
    }
  }

  const actors = unionBy(base?.actor, extra?.actor, (actor) => `${actor.value}|${actor.role ?? ''}`);

  if (actors.length > 0) {
    merged.actor = actors;
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Merge two programmes describing the same broadcast into a new programme.
 *
 * Scalar fields come from `base`, falling back to `extra`. Language-tagged
 * text arrays are unioned by `(lang, value)` with `base` entries first, so a
 * Slovak title from `base` and an English title from `extra` both survive.
 */
export function mergeProgrammes(base: XmltvProgramme, extra: XmltvProgramme): XmltvProgramme {
  const merged: XmltvProgramme = {
    channel: base.channel,
    start: base.start,
    title: unionBy(base.title, extra.title, textKey),
  };

  // Scalars: base wins, extra fills the gaps.
  const stop = base.stop ?? extra.stop;
  if (stop !== undefined) merged.stop = stop;

  const date = base.date ?? extra.date;
  if (date !== undefined) merged.date = date;

  const language = base.language ?? extra.language;
  if (language !== undefined) merged.language = language;

  const origLanguage = base.origLanguage ?? extra.origLanguage;
  if (origLanguage !== undefined) merged.origLanguage = origLanguage;

  const length = base.length ?? extra.length;
  if (length !== undefined) merged.length = length;

  const previouslyShown = base.previouslyShown ?? extra.previouslyShown;
  if (previouslyShown !== undefined) merged.previouslyShown = previouslyShown;

  const premiere = base.premiere ?? extra.premiere;
  if (premiere !== undefined) merged.premiere = premiere;

  const lastChance = base.lastChance ?? extra.lastChance;
  if (lastChance !== undefined) merged.lastChance = lastChance;

  const isNew = base.new ?? extra.new;
  if (isNew !== undefined) merged.new = isNew;

  const pdcStart = base.pdcStart ?? extra.pdcStart;
  if (pdcStart !== undefined) merged.pdcStart = pdcStart;

  const vpsStart = base.vpsStart ?? extra.vpsStart;
  if (vpsStart !== undefined) merged.vpsStart = vpsStart;

  const showview = base.showview ?? extra.showview;
  if (showview !== undefined) merged.showview = showview;

  const videoplus = base.videoplus ?? extra.videoplus;
  if (videoplus !== undefined) merged.videoplus = videoplus;

  const clumpidx = base.clumpidx ?? extra.clumpidx;
  if (clumpidx !== undefined) merged.clumpidx = clumpidx;

  const video = base.video ?? extra.video;
  if (video !== undefined) merged.video = video;

  const audio = base.audio ?? extra.audio;
  if (audio !== undefined) merged.audio = audio;

  // Language-tagged text arrays, unioned by (lang, value).
  const subTitle = unionBy(base.subTitle, extra.subTitle, textKey);
  if (subTitle.length > 0) merged.subTitle = subTitle;

  const desc = unionBy(base.desc, extra.desc, textKey);
  if (desc.length > 0) merged.desc = desc;

  const category = unionBy(base.category, extra.category, textKey);
  if (category.length > 0) merged.category = category;

  const keyword = unionBy(base.keyword, extra.keyword, textKey);
  if (keyword.length > 0) merged.keyword = keyword;

  const country = unionBy(base.country, extra.country, textKey);
  if (country.length > 0) merged.country = country;

  // Other arrays with element-specific dedup keys.
  const url = unionBy(base.url, extra.url, urlKey);
  if (url.length > 0) merged.url = url;

  const icon = unionBy(base.icon, extra.icon, (item) => item.src);
  if (icon.length > 0) merged.icon = icon;

  const episodeNum = unionBy(
    base.episodeNum,
    extra.episodeNum,
    (item) => `${item.system ?? ''}|${item.value}`,
  );
  if (episodeNum.length > 0) merged.episodeNum = episodeNum;

  const rating = unionBy(base.rating, extra.rating, (item) => `${item.system ?? ''}|${item.value}`);
  if (rating.length > 0) merged.rating = rating;

  const starRating = unionBy(
    base.starRating,
    extra.starRating,
    (item) => `${item.system ?? ''}|${item.value}`,
  );
  if (starRating.length > 0) merged.starRating = starRating;

  const subtitles = unionBy(
    base.subtitles,
    extra.subtitles,
    (item) => `${item.type ?? ''}|${item.language?.value ?? ''}`,
  );
  if (subtitles.length > 0) merged.subtitles = subtitles;

  const review = unionBy(
    base.review,
    extra.review,
    (item) => `${item.type}|${item.source ?? ''}|${item.value}`,
  );
  if (review.length > 0) merged.review = review;

  const image = unionBy(base.image, extra.image, (item) => item.value);
  if (image.length > 0) merged.image = image;

  const credits = mergeCredits(base.credits, extra.credits);
  if (credits !== undefined) merged.credits = credits;

  // Extension data: elements unioned structurally, attributes base-wins.
  const extras = unionBy(base.extra, extra.extra, (item) => JSON.stringify(item));
  if (extras.length > 0) merged.extra = extras;

  const extraAttributes = { ...extra.extraAttributes, ...base.extraAttributes };
  if (Object.keys(extraAttributes).length > 0) merged.extraAttributes = extraAttributes;

  return merged;
}

/**
 * Combine per-site programme lists (in priority order, index 0 = highest)
 * into one list sorted by start time.
 *
 * - `concat`: flatten everything, keep duplicates.
 * - `merge`: programmes sharing the same start time are merged into one via
 *   {@link mergeProgrammes}; the first occurrence (highest priority) is base.
 */
export function mergeProgrammeLists(
  lists: XmltvProgramme[][],
  strategy: ProgrammeStrategy,
): XmltvProgramme[] {
  if (strategy === 'concat') {
    return lists.flat().sort((a, b) => a.start.getTime() - b.start.getTime());
  }

  const byStart = new Map<number, XmltvProgramme>();

  for (const list of lists) {
    for (const programme of list) {
      const key = programme.start.getTime();
      const existing = byStart.get(key);

      byStart.set(key, existing ? mergeProgrammes(existing, programme) : programme);
    }
  }

  return [...byStart.values()].sort((a, b) => a.start.getTime() - b.start.getTime());
}
