import type {
  XmltvCredits,
  XmltvPersonValue,
  XmltvProgramme,
  XmltvTextValue,
  XmltvUrlValue,
} from '../xmltv/types.js';
import type { ProgrammeMatch, ProgrammeMatcher, ProgrammeStrategy } from './types.js';

/**
 * How two programmes are paired up when nothing says otherwise: five minutes
 * apart at most, agreeing on their title if they are apart at all, and — where
 * both say when they end — closer together than the shorter of the two.
 */
export const DEFAULT_MATCH: Required<ProgrammeMatch> = {
  startToleranceMs: 300_000,
  titles: 'when-shifted',
};

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

  const actors = unionBy(
    base?.actor,
    extra?.actor,
    (actor) => `${actor.value}|${actor.role ?? ''}`,
  );

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
 * A title as it is compared: case folded, accents dropped and whitespace
 * collapsed, so `Správy  ` and `spravy` are one title.
 *
 * Accents go because the two sources being merged are very often one local
 * feed and one international one, and the international one is the one that
 * spells `Vecernicek` — while a source that drops accents rarely reinstates
 * them for a different programme. It is a comparison only: what a programme
 * carries is never rewritten.
 */
export function normalizeTitle(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Do these two programmes share a title, in any language either offers? */
export function titlesMatch(a: XmltvProgramme, b: XmltvProgramme): boolean {
  const titles = new Set(a.title.map((title) => normalizeTitle(title.value)));

  return b.title.some((title) => titles.has(normalizeTitle(title.value)));
}

/** How long a programme runs, when it says where it ends. */
function duration(programme: XmltvProgramme): number | undefined {
  if (programme.stop === undefined) {
    return undefined;
  }

  const length = programme.stop.getTime() - programme.start.getTime();

  return length > 0 ? length : undefined;
}

/**
 * A matcher with the reach it needs: two programmes further apart than
 * `windowMs` can never be one broadcast, which is what lets a merge stop
 * looking instead of comparing against a whole day.
 */
export interface ResolvedMatch {
  windowMs: number;
  matches: ProgrammeMatcher;
}

/**
 * Settle {@link ProgrammeMatch} into something to match with. A matcher of
 * one's own passes through with no reach to speak of — only it knows what it
 * pairs up, so every candidate is offered to it.
 */
export function resolveMatch(match?: ProgrammeMatch | ProgrammeMatcher): ResolvedMatch {
  if (typeof match === 'function') {
    return { windowMs: Number.POSITIVE_INFINITY, matches: match };
  }

  const { startToleranceMs, titles } = { ...DEFAULT_MATCH, ...match };

  return {
    windowMs: startToleranceMs,
    matches: (a, b) => {
      const shift = Math.abs(a.start.getTime() - b.start.getTime());

      if (shift > startToleranceMs) {
        return false;
      }

      // The same instant: two sources describing one broadcast, unless a
      // config says even that has to be corroborated by the title.
      if (shift === 0) {
        return titles === 'always' ? titlesMatch(a, b) : true;
      }

      if (titles !== 'never' && !titlesMatch(a, b)) {
        return false;
      }

      // What keeps a wide tolerance from swallowing the programme next door:
      // consecutive programmes sit exactly one duration apart, so anything
      // that far out is the neighbour rather than the same broadcast told
      // twice. Only decidable when both sides say where they end.
      const shorter = Math.min(duration(a) ?? Infinity, duration(b) ?? Infinity);

      return shift < shorter;
    },
  };
}

/** First index whose start is at or after `time`, in a list sorted by start. */
function lowerBound(programmes: XmltvProgramme[], time: number): number {
  let low = 0;
  let high = programmes.length;

  while (low < high) {
    const mid = (low + high) >>> 1;

    if (programmes[mid]!.start.getTime() < time) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low;
}

/**
 * Where in `target` `programme` belongs, and what it belongs with: the index of
 * the programme it should be merged into, or `-1` to insert it.
 *
 * The nearest acceptable candidate wins. A source shifted by a minute against
 * two of another's programmes must join the one it is a minute from, not
 * whichever the scan reached first.
 */
function findMatch(
  target: XmltvProgramme[],
  programme: XmltvProgramme,
  match: ResolvedMatch,
  taken: ReadonlySet<number>,
): number {
  const start = programme.start.getTime();
  let best = -1;
  let bestShift = Number.POSITIVE_INFINITY;

  for (let index = lowerBound(target, start - match.windowMs); index < target.length; index++) {
    const candidate = target[index]!;
    const shift = candidate.start.getTime() - start;

    if (shift > match.windowMs) {
      break;
    }

    const distance = Math.abs(shift);

    if (distance < bestShift && !taken.has(index) && match.matches(candidate, programme)) {
      best = index;
      bestShift = distance;
    }
  }

  return best;
}

/**
 * One source's list with its own duplicate rows pooled — programmes naming the
 * *identical* instant, and only those.
 *
 * A source's list is a schedule: two entries in it are two broadcasts, however
 * alike, and a tolerance let loose inside one would merge a clip with the clip
 * that follows it. Between two sources the same tolerance is the whole point.
 * So the boundary is the list, which is why it is what {@link mergeInto} takes.
 */
function pool(incoming: readonly XmltvProgramme[]): XmltvProgramme[] {
  const pooled: XmltvProgramme[] = [];

  for (const programme of incoming) {
    const time = programme.start.getTime();
    const index = lowerBound(pooled, time);
    const existing = pooled[index];

    if (existing && existing.start.getTime() === time) {
      pooled[index] = mergeProgrammes(existing, programme);
    } else {
      pooled.splice(index, 0, programme);
    }
  }

  return pooled;
}

/**
 * Fold one source's `incoming` list into `target`, which is kept sorted by
 * start and returned.
 *
 * The one place two programmes are ever recognized as one: a lower-priority
 * site's list joining a higher-priority one, and the next day's entry joining
 * what is still held from this one. `target` is what a match is merged *into*,
 * so it must be the higher-priority side — {@link mergeProgrammes} takes its
 * scalars from there.
 */
export function mergeInto(
  target: XmltvProgramme[],
  incoming: readonly XmltvProgramme[],
  match: ResolvedMatch,
): XmltvProgramme[] {
  // Every candidate is decided against `target` as it stands, and only then is
  // anything added to it. Otherwise a list's second programme could be paired
  // with its own first one the moment that landed in `target` — the tolerance
  // turned loose inside one schedule, which `pool` is careful not to do.
  const merges: [index: number, programme: XmltvProgramme][] = [];
  const inserts: XmltvProgramme[] = [];
  const taken = new Set<number>();

  for (const programme of pool(incoming)) {
    // Taken entries are passed over: one programme of `target` stands for one
    // broadcast, so it absorbs one programme of `incoming` and no more.
    const index = findMatch(target, programme, match, taken);

    if (index === -1) {
      inserts.push(programme);
    } else {
      taken.add(index);
      merges.push([index, programme]);
    }
  }

  // Merging first, while the indices above still mean what they meant. A merge
  // keeps the base's start, so it moves nothing.
  for (const [index, programme] of merges) {
    target[index] = mergeProgrammes(target[index]!, programme);
  }

  for (const programme of inserts) {
    // After anything starting at the same instant, so what could not be merged
    // still follows what it arrived behind.
    target.splice(lowerBound(target, programme.start.getTime() + 1), 0, programme);
  }

  return target;
}

/**
 * How long a programme with no `stop` is taken to run when working out what a
 * source already covers.
 *
 * The same six hours `fillStop` uses, and for the same reason: the two have to
 * agree about where a hole is, or `backfill` drops a programme into a span
 * `fillStop` is about to claim.
 */
export const DEFAULT_FILL_STOP_MS = 6 * 60 * 60 * 1000;

/** What `backfillInto` needs beyond the two lists. */
export interface BackfillOptions {
  match: ResolvedMatch;
  /**
   * The cap a stop-less programme is taken to run for. `undefined` — which is
   * `fillStop: false` — means no assumption at all, so such a programme covers
   * only the instant it starts.
   */
  fillStopMs?: number | undefined;
}

/**
 * The half-open span each programme of a list occupies, in order.
 *
 * A source that gives no `stop` still covers something, and this is the same
 * answer `fillStop` will reach later: up to the next programme of its own list,
 * capped. Widened to a millisecond where it would be empty, so a bare instant
 * still collides with another at the same instant rather than slipping past it.
 */
function spans(
  list: readonly XmltvProgramme[],
  fillStopMs: number | undefined,
): [number, number][] {
  return list.map((programme, index) => {
    const start = programme.start.getTime();

    if (programme.stop !== undefined) {
      return [start, Math.max(programme.stop.getTime(), start + 1)] as [number, number];
    }

    const next = list[index + 1]?.start.getTime() ?? Number.POSITIVE_INFINITY;
    const capped = fillStopMs === undefined ? start : Math.min(next, start + fillStopMs);

    return [start, Math.max(capped, start + 1)] as [number, number];
  });
}

/**
 * Fold one lower-priority source's list into `target`, adding only what falls
 * where `target` has nothing.
 *
 * The difference from {@link mergeInto} is the whole of `backfill`: a candidate
 * that matches something already there is **dropped**, not merged. The higher
 * priority side keeps its broadcast whole rather than taking fields from a
 * source it outranks.
 *
 * A candidate that only *partly* fits a hole is dropped too. Inserting it and
 * leaving `clipOverlaps` to sort it out would pull back the `stop` of the
 * programme that outranks it — the lower-priority source rewriting the higher
 * one — and moving its start forward would be a lie about when a broadcast
 * began. So two sources on different grids may contribute nothing at the seam,
 * which is the price of not corrupting either.
 */
export function backfillInto(
  target: XmltvProgramme[],
  incoming: readonly XmltvProgramme[],
  options: BackfillOptions,
): XmltvProgramme[] {
  const { match, fillStopMs } = options;
  const pooled = pool(incoming);
  const occupied = spans(target, fillStopMs);
  const candidates = spans(pooled, fillStopMs);
  const inserts: XmltvProgramme[] = [];
  const taken = new Set<number>();

  // Every candidate decided against `target` as it stands, as `mergeInto` is
  // careful to do: otherwise a source's second programme is tested against its
  // own first one the moment that lands, and a run of them filling one hole
  // would turn each other away.
  for (const [index, programme] of pooled.entries()) {
    if (findMatch(target, programme, match, taken) !== -1) {
      continue;
    }

    const [start, end] = candidates[index]!;

    if (occupied.some(([from, to]) => start < to && from < end)) {
      continue;
    }

    inserts.push(programme);
  }

  for (const programme of inserts) {
    target.splice(lowerBound(target, programme.start.getTime() + 1), 0, programme);
  }

  return target;
}

/**
 * Combine per-site programme lists (in priority order, index 0 = highest)
 * into one list sorted by start time.
 *
 * - `concat`: flatten everything, keep duplicates.
 * - `merge`: programmes describing the same broadcast are merged into one via
 *   {@link mergeProgrammes}, the higher-priority one as base. Which those are
 *   is {@link ProgrammeMatch}'s to say — by default a start within five
 *   minutes, corroborated by the title once the two differ at all.
 */
export function mergeProgrammeLists(
  lists: XmltvProgramme[][],
  strategy: ProgrammeStrategy,
  match?: ProgrammeMatch | ProgrammeMatcher,
  fillStopMs: number | undefined = DEFAULT_FILL_STOP_MS,
): XmltvProgramme[] {
  if (strategy === 'concat') {
    return lists.flat().sort((a, b) => a.start.getTime() - b.start.getTime());
  }

  const resolved = resolveMatch(match);
  const merged: XmltvProgramme[] = [];

  // A branch of its own rather than falling through to the merge: they take the
  // lists in the same order and differ entirely in what they do with the second
  // one, and a strategy that silently merged would be the worst of both.
  if (strategy === 'backfill') {
    for (const list of lists) {
      backfillInto(merged, list, { match: resolved, fillStopMs });
    }

    return merged;
  }

  for (const list of lists) {
    mergeInto(merged, list, resolved);
  }

  return merged;
}
