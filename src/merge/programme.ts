import type { NearMissWhy } from '../core/events.js';
import type { XmltvCredits, XmltvPersonValue, XmltvProgramme } from '../xmltv/types.js';
import type {
  MergeUnion,
  ProgrammeMatch,
  ProgrammeMatcher,
  ProgrammeStrategy,
  WindowedMatcher,
} from './types.js';
import { normalizeTitle, textKey, unionBy, urlKey } from './text.js';
import { resolveUnion } from './union.js';

/**
 * How two programmes are paired up when nothing says otherwise: five minutes
 * apart at most, agreeing on their title if they are apart at all, and — where
 * both say when they end — closer together than the shorter of the two.
 */
export const DEFAULT_MATCH: Required<ProgrammeMatch> = {
  startToleranceMs: 300_000,
  titles: 'when-shifted',
  normalizeTitle,
};

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

/** Do these two programmes share a title, in any language either offers? */
export function titlesMatch(
  a: XmltvProgramme,
  b: XmltvProgramme,
  normalize: (title: string) => string = normalizeTitle,
): boolean {
  const titles = new Set(a.title.map((title) => normalize(title.value)));

  return b.title.some((title) => titles.has(normalize(title.value)));
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
  /**
   * What keeps two programmes from being one broadcast — nothing, where they
   * are. One answer to both questions a merge asks of a pair, whether they are
   * one and why not, so the two cannot disagree: see {@link NearMissWhy}.
   */
  apart(a: XmltvProgramme, b: XmltvProgramme): NearMissWhy | undefined;
  /**
   * How it compares titles — a match's own `normalizeTitle`, or the default
   * for a matcher of one's own, which says nothing about titles. What a
   * `merge.union` of titles compares by too.
   */
  normalizeTitle: (title: string) => string;
}

/** What kept two programmes from being one — declared with the event that says it. */
export type { NearMissWhy };

/**
 * A matcher of one's own as a {@link ResolvedMatch.apart}: beyond its window,
 * which it is never asked about, `start`; within it, what it says — and where
 * it says no, `matcher`. Nothing of the shipped rules is asked on its behalf:
 * what titles it compares, and how, is its own business.
 */
function ownMatcher(matches: ProgrammeMatcher, windowMs: number): ResolvedMatch['apart'] {
  return (a, b) => (shiftOf(a, b) > windowMs ? 'start' : matches(a, b) ? undefined : 'matcher');
}

/**
 * Settle {@link ProgrammeMatch} into something to match with. A matcher of
 * one's own passes through with no reach to speak of — only it knows what it
 * pairs up, so every candidate is offered to it.
 */
export function resolveMatch(
  match?: ProgrammeMatch | ProgrammeMatcher | WindowedMatcher | null,
): ResolvedMatch {
  if (typeof match === 'function') {
    // Everything, because a function that never said how far it looks might
    // look anywhere — and the cost of that is in `WindowedMatcher`, which is
    // how a matcher says.
    return {
      windowMs: Number.POSITIVE_INFINITY,
      apart: ownMatcher(match, Number.POSITIVE_INFINITY),
      normalizeTitle,
    };
  }

  if (match !== undefined && match !== null && 'matches' in match) {
    return {
      windowMs: match.windowMs,
      apart: ownMatcher(match.matches, match.windowMs),
      normalizeTitle,
    };
  }

  const {
    startToleranceMs,
    titles,
    normalizeTitle: normalize,
  } = {
    ...DEFAULT_MATCH,
    ...match,
  };

  return {
    windowMs: startToleranceMs,
    normalizeTitle: normalize,
    apart: (a, b) => {
      const shift = shiftOf(a, b);
      // The titles, where they are compared: on an identical start only when a
      // config says even that has to be corroborated, and never under `never`.
      const compared = titles === 'always' || (titles !== 'never' && shift !== 0);
      const titlesDiffer = compared && !titlesMatch(a, b, normalize);
      const beyond = shift > startToleranceMs;
      const why: NearMissWhy = titlesDiffer
        ? beyond
          ? 'both'
          : 'title'
        : beyond
          ? 'start'
          : 'runs';

      // The titles agreeing and the starts near enough, one broadcast — save
      // where they start further apart than the shorter lasts. Consecutive
      // programmes sit exactly one duration apart, and a segment lies within
      // the show it is part of, so anything that far out is the neighbour or
      // the part rather than the same broadcast told twice: decidable only
      // when both say where they end, and never of the same instant.
      if (
        why === 'runs' &&
        (shift === 0 || shift < Math.min(duration(a) ?? Infinity, duration(b) ?? Infinity))
      ) {
        return undefined;
      }

      return why;
    },
  };
}

/** How far apart two programmes start. */
function shiftOf(a: XmltvProgramme, b: XmltvProgramme): number {
  return Math.abs(a.start.getTime() - b.start.getTime());
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
 * The nearest programme of another source's a programme did not join — kept
 * by {@link matchOf} as it scans the window, and by {@link nearMissOf} beyond
 * it. One for a whole list, set afresh for each programme: asking costs a
 * merge nothing per programme.
 */
interface Refused {
  index: number;
  gapMs: number;
  /** What kept them apart — asked of one beyond the window only once it is the nearest. */
  why: NearMissWhy | undefined;
}

/** A near miss, as {@link MergeWatch.nearMiss} is told it. */
interface NearMiss {
  index: number;
  gapMs: number;
  candidate: XmltvProgramme;
  why: NearMissWhy;
}

/**
 * Whether `candidate` is another source's than the list folding in — see
 * {@link MergeOrigin}: the one rule for which of `target` the list may have
 * nearly joined, and which it combined with.
 */
function others(origin: MergeOrigin | undefined, candidate: XmltvProgramme): boolean {
  // This source's own, held from the day before, is the programme before this
  // one, not one it nearly was, nor another source agreeing with it.
  return origin === undefined || !ownedBy(origin.sites.get(candidate), origin.site);
}

/**
 * The index of the programme of `target` that `programme` should be merged
 * into, or `-1` to insert it — and, where given `refused`, the nearest within
 * the window that another source's said no to, and why. Each pair judged once.
 *
 * The nearest acceptable candidate wins. A source shifted by a minute against
 * two of another's programmes must join the one it is a minute from, not
 * whichever the scan reached first.
 */
function matchOf(
  target: XmltvProgramme[],
  programme: XmltvProgramme,
  match: ResolvedMatch,
  taken: ReadonlySet<number>,
  origin: MergeOrigin | undefined,
  refused: Refused | undefined,
): number {
  const start = programme.start.getTime();
  const { windowMs } = match;
  let best = -1;
  let bestShift = Number.POSITIVE_INFINITY;

  for (let index = lowerBound(target, start - windowMs); index < target.length; index++) {
    const candidate = target[index]!;
    const shift = candidate.start.getTime() - start;

    // Past the window — or, with a match in hand, past where anything could be
    // nearer than it: the list is sorted, so all that follows is further.
    if (shift > windowMs || (best !== -1 && shift >= bestShift)) {
      break;
    }

    const distance = Math.abs(shift);

    // Taken already, or no nearer than a match in hand: nothing to ask.
    if (taken.has(index) || (best !== -1 && distance >= bestShift)) {
      continue;
    }

    const why = match.apart(candidate, programme);

    if (why === undefined) {
      best = index;
      bestShift = distance;
    } else if (
      refused !== undefined &&
      distance <= NEAR_MISS_MS &&
      distance < refused.gapMs &&
      others(origin, candidate)
    ) {
      refused.index = index;
      refused.gapMs = distance;
      refused.why = why;
    }
  }

  return best;
}

/**
 * The near miss of a programme that matched nothing: what {@link matchOf} kept
 * of the window, or — where the window had nothing even nearly it — the
 * nearest other source's programme within {@link NEAR_MISS_MS}, beyond it.
 * Anything beyond the window is further than what is in it, so that wider
 * scan is only for where the window had none, and why is asked of the
 * nearest, once.
 */
function nearMissOf(
  target: XmltvProgramme[],
  programme: XmltvProgramme,
  match: ResolvedMatch,
  taken: ReadonlySet<number>,
  origin: MergeOrigin | undefined,
  refused: Refused,
): NearMiss | undefined {
  const start = programme.start.getTime();
  const { windowMs } = match;

  if (refused.index === -1 && NEAR_MISS_MS > windowMs) {
    for (let index = lowerBound(target, start - NEAR_MISS_MS); index < target.length; index++) {
      const candidate = target[index]!;
      const shift = candidate.start.getTime() - start;

      if (shift > NEAR_MISS_MS) {
        break;
      }

      const distance = Math.abs(shift);

      if (
        distance > windowMs &&
        distance < refused.gapMs &&
        !taken.has(index) &&
        others(origin, candidate)
      ) {
        refused.index = index;
        refused.gapMs = distance;
        refused.why = undefined;
      }
    }
  }

  if (refused.index === -1) {
    return undefined;
  }

  const candidate = target[refused.index]!;

  return {
    index: refused.index,
    gapMs: refused.gapMs,
    candidate,
    why: refused.why ?? match.apart(candidate, programme) ?? 'matcher',
  };
}

/** {@link Refused} with nothing in it yet. */
function refusedAfresh(refused: Refused): Refused {
  refused.index = -1;
  refused.gapMs = Number.POSITIVE_INFINITY;
  refused.why = undefined;

  return refused;
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
  watch?: MergeWatch,
): XmltvProgramme[] {
  const origin = watch?.origin;

  // Every candidate is decided against `target` as it stands, and only then is
  // anything added to it. Otherwise a list's second programme could be paired
  // with its own first one the moment that landed in `target` — the tolerance
  // turned loose inside one schedule, which `pool` is careful not to do.
  const merges: [index: number, programme: XmltvProgramme][] = [];
  const inserts: XmltvProgramme[] = [];
  const taken = new Set<number>();

  const looking = watch?.nearMiss !== undefined;
  const refused: Refused | undefined = looking
    ? { index: -1, gapMs: Number.POSITIVE_INFINITY, why: undefined }
    : undefined;
  /** What matched nothing, with what it nearly did — said once the whole list is placed. */
  const missed: Array<[programme: XmltvProgramme, near: NearMiss]> = [];

  for (const programme of pool(incoming)) {
    // Taken entries are passed over: one programme of `target` stands for one
    // broadcast, so it absorbs one programme of `incoming` and no more.
    const index = matchOf(
      target,
      programme,
      match,
      taken,
      origin,
      refused && refusedAfresh(refused),
    );

    if (index === -1) {
      inserts.push(programme);

      const near = refused && nearMissOf(target, programme, match, taken, origin, refused);

      if (near !== undefined) {
        missed.push([programme, near]);
      }
    } else {
      taken.add(index);
      merges.push([index, programme]);

      // Two sources agreeing — not one source and its own programme, held
      // over from the day before and said again today.
      if (others(origin, target[index]!)) {
        watch?.combined?.();
      }
    }
  }

  // Said once the whole list is placed: a programme a later one of it then
  // took is no near miss, and the nearest still left in its place is. The
  // left only ever narrow, so one still left was the nearest all along.
  for (const [programme, near] of missed) {
    let nearest: NearMiss | undefined = near;

    if (taken.has(near.index)) {
      // Matches nothing still: the window is only narrower.
      matchOf(target, programme, match, taken, origin, refusedAfresh(refused!));
      nearest = nearMissOf(target, programme, match, taken, origin, refused!);
    }

    if (nearest !== undefined) {
      watch!.nearMiss!(nearest.gapMs, programme, nearest.candidate, nearest.why);
    }
  }

  // Merging first, while the indices above still mean what they meant. A merge
  // keeps the base's start, so it moves nothing — and its sites, with this one.
  for (const [index, programme] of merges) {
    const base = target[index]!;
    const merged = mergeProgrammes(base, programme);

    if (origin !== undefined) {
      origin.sites.set(merged, withSite(origin.sites.get(base), origin.site));
    }

    target[index] = merged;
  }

  for (const programme of inserts) {
    origin?.sites.set(programme, origin.site);
    // After anything starting at the same instant, so what could not be merged
    // still follows what it arrived behind.
    target.splice(lowerBound(target, programme.start.getTime() + 1), 0, programme);
  }

  return target;
}

/**
 * How far apart two programmes may be and still be worth reporting as a pair
 * that nearly matched.
 *
 * Half an hour, because the thing being looked for is a source published on a
 * different grid — five past against on the hour, a schedule shifted by the
 * adverts — and not two genuinely different programmes. Beyond this the
 * question stops being "did these fail to merge" and starts being "what else
 * is on tonight".
 */
export const NEAR_MISS_MS = 30 * 60_000;

/**
 * What a merge noticed, for a caller that wants to know how well two sources
 * line up rather than only what came out.
 *
 * Given to {@link mergeInto} only where the answer means something — a site's
 * list folding into what another site already contributed — so a guide of
 * single-source channels pays nothing for it.
 */
export interface MergeWatch {
  /**
   * Whose list is folded in, and whose each programme of `target` is — kept as
   * the merge makes new programmes out of old ones, for saying which two
   * nearly matched, and for not taking a source's own for another's.
   */
  origin?: MergeOrigin;
  /**
   * One of `incoming` joined a programme already in `target` — another site's,
   * where `origin` says whose: not its own, held over from the day before.
   */
  combined?(): void;
  /**
   * One of `incoming` joined nothing, and `candidate` — the nearest of `target`
   * within {@link NEAR_MISS_MS}, another site's where `origin` says whose — is
   * left unjoined too, once the whole of `incoming` is placed.
   *
   * `gapMs` is what the two starts are apart, and `why` what kept them apart.
   */
  nearMiss?(
    gapMs: number,
    programme: XmltvProgramme,
    candidate: XmltvProgramme,
    why: NearMissWhy,
  ): void;
}

/**
 * Which sites each programme of a merge came from, for saying which two nearly
 * matched — kept by {@link mergeInto} for every programme it puts in `target`:
 * one added, `site`'s; one merged, its base's and then each that joined it.
 */
export interface MergeOrigin {
  /** Whose list is folded in now. */
  site: string;
  /** Every programme's sites, as far as it has been told — see {@link Sites}. */
  sites: WeakMap<XmltvProgramme, Sites>;
}

/**
 * Whose a programme is: the one site it came from, or — once others joined it
 * — each of them, its base's first. A string for the one, which is nearly
 * every programme, rather than a list each.
 */
export type Sites = string | readonly string[];

/** Whether `site` is one of a programme's `sites`. */
export function ownedBy(sites: Sites | undefined, site: string): boolean {
  return sites === site || (Array.isArray(sites) && sites.includes(site));
}

/** The site a programme came from first — its base's, once others joined it. */
export function firstSite(sites: Sites | undefined): string | undefined {
  return typeof sites === 'string' ? sites : sites?.[0];
}

/** `sites`, with `site` among them. */
function withSite(sites: Sites | undefined, site: string): Sites {
  if (sites === undefined) {
    return site;
  }

  if (ownedBy(sites, site)) {
    return sites;
  }

  return typeof sites === 'string' ? [sites, site] : [...sites, site];
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
    if (matchOf(target, programme, match, taken, undefined, undefined) !== -1) {
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
  match?: ProgrammeMatch | ProgrammeMatcher | WindowedMatcher,
  fillStopMs: number | undefined = DEFAULT_FILL_STOP_MS,
  /**
   * Which texts of a programme say the same thing — see {@link MergeUnion}.
   * Applied to each programme of the result, as the guide applies it to each
   * one it writes.
   */
  union?: MergeUnion | 'exact',
): XmltvProgramme[] {
  const resolved = resolveMatch(match);
  const texts = resolveUnion(union, resolved.normalizeTitle);
  const written = (programmes: XmltvProgramme[]) =>
    programmes.map((programme) => texts.apply(programme));

  if (strategy === 'concat') {
    return written(lists.flat().sort((a, b) => a.start.getTime() - b.start.getTime()));
  }

  const merged: XmltvProgramme[] = [];

  // A branch of its own rather than falling through to the merge: they take the
  // lists in the same order and differ entirely in what they do with the second
  // one, and a strategy that silently merged would be the worst of both.
  if (strategy === 'backfill') {
    for (const list of lists) {
      backfillInto(merged, list, { match: resolved, fillStopMs });
    }

    return written(merged);
  }

  for (const list of lists) {
    mergeInto(merged, list, resolved);
  }

  return written(merged);
}
