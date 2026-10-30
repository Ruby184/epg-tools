import {
  addDays,
  dayIn,
  dayRange,
  daysCovering,
  dayToDate,
  resolveTimeZone,
  wallClock,
  wallTimeIn,
} from '../core/days.js';
import { errorMessage, GrabberError } from '../core/error.js';
import { writeOutput, type OutputOptions, type OutputTarget } from '../core/output.js';
import { emitter } from '../core/events.js';
import type { Says, UnmatchedProgramme } from '../core/events.js';
import { channelElement, covered, defaultChannelInfo, resolveSites } from '../grabber/channels.js';
import { siteDayZone } from '../grabber/site.js';
import type { GrabberChannel } from '../grabber/types.js';
import { formatXmltvDate, getXmltvOffset, writeXmltvStream, xmltvDate } from '../xmltv/main.js';
import { outputOptions } from '../xmltv/serialize.js';
import type { XmltvChannel, XmltvProgramme } from '../xmltv/types.js';
import { mergeChannels } from './channel.js';
import { derivedChannelElement, resolveDerived, shiftProgrammes } from './derive.js';
import {
  backfillInto,
  DEFAULT_FILL_STOP_MS,
  firstSite,
  mergeInto,
  resolveMatch,
  type MergeOrigin,
  type MergeWatch,
  type Sites,
} from './programme.js';
import { resolveUnion } from './union.js';
import type { ChannelSource, RegistryEntry } from './registry.js';
import { channelSelection, configured, unmatched, unmatchedMessage } from './select.js';
import type {
  BuildGuideOptions,
  ChannelStrategy,
  FillGapsContext,
  FillGapsOptions,
  GuideContext,
  MergeOptions,
  ProgrammeStrategy,
} from './types.js';

/**
 * How many channel-days are read from the cache ahead of the writer when
 * nothing says. The same order of magnitude as the grab's `localConcurrency`,
 * and for the same reason: what it bounds is open files and how many programme
 * lists are alive at once, and Node's file operations run on a threadpool of
 * four by default anyway.
 */
const DEFAULT_READ_AHEAD = 16;

/**
 * Yield `items` in order, with `depth` of them being read at once.
 *
 * A merge is nearly all waiting: read a channel-day, write it out, read the
 * next. Serializing is quick and the reads are what the wall clock goes on, so
 * a guide of a few hundred channels spends its time on thousands of round trips
 * taken one at a time, with nothing being read while one is written. Reading
 * ahead overlaps the two without giving up the order the writer needs, and
 * holds no more than `depth` results at once — the backpressure is the window
 * itself. A queue would not do: it would run the reads `depth` at a time but
 * keep every finished one, and a guide's worth of channel-days buffered ahead
 * of the writer is the memory all of this exists to avoid.
 *
 * A read that rejects is settled into a value and rethrown when its turn comes,
 * so a failure surfaces in order — and so no promise sitting in the window is
 * ever unhandled, which one abandoned by a consumer that stopped early would
 * otherwise be.
 */
async function* readAhead<TItem, TResult>(
  items: readonly TItem[],
  depth: number,
  read: (item: TItem) => Promise<TResult>,
): AsyncGenerator<TResult, void, void> {
  type Settled = { value: TResult } | { error: unknown };

  const window: Promise<Settled>[] = [];
  let next = 0;

  const fill = (): void => {
    while (window.length < depth && next < items.length) {
      window.push(
        read(items[next++]!).then(
          (value) => ({ value }),
          (error) => ({ error }),
        ),
      );
    }
  };

  fill();

  while (window.length > 0) {
    const settled = await window.shift()!;

    // Before yielding, so the next read is under way while what it follows is
    // being written rather than after it.
    fill();

    if ('error' in settled) {
      throw settled.error;
    }

    yield settled.value;
  }
}

// Where it lives now, re-exported for the entry points that published it.
export { defaultChannelInfo };

/**
 * How many of the programmes after `outer` sit wholly inside it.
 *
 * Counts across the batch and into what is still held, since a container that
 * runs to the end of a day holds programmes the next day's read supplies. Both
 * lists are sorted by start, so the walk stops at the first start the container
 * does not reach — nothing later can be inside it.
 */
function containedCount(
  outer: XmltvProgramme,
  after: readonly XmltvProgramme[],
  from: number,
  held: readonly XmltvProgramme[],
): number {
  const stop = outer.stop?.getTime();

  if (stop === undefined) {
    return 0;
  }

  const start = outer.start.getTime();
  let count = 0;

  for (const programme of [...after.slice(from), ...held]) {
    const at = programme.start.getTime();

    if (at >= stop) {
      break;
    }

    const ends = programme.stop?.getTime();

    if (at >= start && ends !== undefined && ends <= stop) {
      count++;
    }
  }

  return count;
}

/**
 * The guide's days, as a site on another calendar has them: which of its own
 * days each one is read from, and how many of the guide's days read each.
 */
interface Covering {
  days: Map<string, string[]>;
  uses: Map<string, number>;
}

/** One of a site's own days, read and transformed, and how many more ask. */
interface HeldDay {
  list: Promise<XmltvProgramme[] | undefined>;
  left: number;
}

/** `fillGaps`, with its defaults filled in and its numbers checked. */
interface ResolvedFillGaps {
  blockMs: number;
  minMs: number;
  maxMs: number;
  edges: boolean;
  title: (context: FillGapsContext) => string;
  programme:
    | ((block: XmltvProgramme, context: FillGapsContext) => XmltvProgramme | undefined | null)
    | undefined;
}

/**
 * Read the option, and refuse a number that cannot work.
 *
 * The only merge option validated at all, because it is the only one whose bad
 * value does not merely produce a wrong guide: a `blockMs` that is zero,
 * negative or `NaN` makes laying blocks across a gap never terminate.
 */
function resolveFillGaps(options: FillGapsOptions): ResolvedFillGaps {
  const positive = (value: number | undefined, name: string, fallback: number): number => {
    if (value === undefined) {
      return fallback;
    }

    if (!Number.isFinite(value) || value <= 0) {
      throw new GrabberError(
        `merge.fillGaps.${name} must be a positive number of milliseconds, not ${String(value)}`,
      );
    }

    return value;
  };

  const title = options.title ?? 'No information';

  return {
    blockMs: positive(options.blockMs, 'blockMs', 30 * 60_000),
    minMs: positive(options.minMs, 'minMs', 60_000),
    maxMs: positive(options.maxMs, 'maxMs', Number.POSITIVE_INFINITY),
    edges: options.edges ?? true,
    title: typeof title === 'function' ? title : () => title,
    programme: options.programme,
  };
}

/**
 * The blocks that cover one gap, laid end to end.
 *
 * Half-open and exactly abutting, which is what keeps a filled guide valid: the
 * DTD makes a programme on at its start and off just before its stop, so one
 * ending at 12:00 and the next starting at 12:00 do not overlap. The last block
 * is truncated to the gap rather than overrunning it — a block past the end
 * would claim time the next real programme is already on.
 *
 * A generator, not an array: an empty channel over a fortnight is 672 blocks,
 * and four hundred of them would otherwise be held at once.
 */
function* blocks(
  xmltvId: string,
  from: number,
  to: number,
  offset: number,
  gaps: ResolvedFillGaps,
): Generator<XmltvProgramme> {
  const width = to - from;

  if (width < gaps.minMs || width > gaps.maxMs) {
    return;
  }

  let at = from;
  let index = 0;

  while (at < to) {
    const end = Math.min(at + gaps.blockMs, to);
    const context: FillGapsContext = {
      xmltvId,
      gapStart: new Date(from),
      gapEnd: new Date(to),
      index,
    };
    const block: XmltvProgramme = {
      channel: xmltvId,
      start: xmltvDate(new Date(at), { offset }),
      stop: xmltvDate(new Date(end), { offset }),
      title: [{ value: gaps.title(context) }],
    };
    const kept =
      gaps.programme === undefined ? block : (gaps.programme(block, context) ?? undefined);

    if (kept !== undefined) {
      yield kept;
    }

    at = end;
    index++;
  }
}

/**
 * Build the XMLTV guide as a stream of XML string chunks.
 *
 * Programmes are read from the cache a channel-day at a time (across the
 * channel's covering sites), merged and passed lazily into the XMLTV writer, so
 * the whole guide is never materialized in memory. One day of one channel is
 * held back as it goes, which is what lets a programme two adjacent days both
 * reported be emitted once, and the entries ahead of the writer are read while
 * it works — `readAhead` of them. So what is alive at once is those two days
 * plus that window, flat in the size of the guide however large it gets.
 *
 * A `derived` channel holds a little longer: its programmes arrive shifted, so
 * what a day contributes reaches up to its offset past that day's own end and
 * waits a fold longer to be emitted. One day plus the largest offset declared,
 * which is why an offset is held under a day.
 */
/**
 * How many near misses are reported in full.
 *
 * Enough to see whether they are one channel or all of them, which is the
 * question a count cannot answer, and few enough that a guide of thousands
 * carries the same handful as a guide of ten.
 */
const MAX_NEAR_MISSES = 5;

/** A programme's title, for saying which one nearly matched which. */
function titleOf(programme: XmltvProgramme): string {
  return programme.title[0]?.value ?? '';
}

/** One side of a near miss, as `merge:unmatched` says it. */
function nearMissSide(programme: XmltvProgramme, site: string): UnmatchedProgramme {
  return { site, title: titleOf(programme), start: formatXmltvDate(programme.start) };
}

/**
 * The strategies a merge goes by: the config's, and where it says none, the
 * defaults — what a guide is built by, and what `--explain` says it was.
 */
export function mergeStrategies(merge: MergeOptions | undefined): {
  channelStrategy: ChannelStrategy;
  programmeStrategy: ProgrammeStrategy;
} {
  return {
    channelStrategy: merge?.channelStrategy ?? 'merge-programmes',
    programmeStrategy: merge?.programmeStrategy ?? 'merge',
  };
}

export async function* generateGuide(options: BuildGuideOptions): AsyncGenerator<string> {
  const now = options.now ?? new Date();
  const timeZone = resolveTimeZone(options.timeZone);
  const days = [...dayRange(options.startDay ?? dayIn(now, timeZone), options.days ?? 7)];
  const { channelStrategy, programmeStrategy } = mergeStrategies(options.merge);
  const { cache } = options;
  const emit = emitter(options);

  /**
   * Where a `merge.transform` says things — no site on it, because the code is
   * the config's own rather than any site's. Also where a `derived` declaration
   * the guide cannot honour is reported.
   */
  const mergeSays: Says = {
    log: (message, data) => emit({ type: 'merge:note', message, ...(data ? { data } : {}) }),
    warn: (message, data) => emit({ type: 'merge:warning', message, ...(data ? { data } : {}) }),
  };

  // Through the same helper the grab uses, so a site that fetches its channel
  // list is asked the same way by both — and every site at once rather than one
  // after another, since each is a single request to a host of its own.
  //
  // The cache goes with it: a site that keeps its channel list there has one the
  // grab just wrote, and a merge asking the source again could only disagree
  // with what it is about to read.
  // `cover` here as well as before the grab, for the reason the lists are
  // resolved here at all: a merge run on its own has no grab to have narrowed
  // them, and the two have to produce the same guide either way. Over lists a
  // grab already narrowed it changes nothing — a channel one site is left with
  // is a channel nobody is asked about.
  const sites = (
    await covered(
      await resolveSites(options.sites, {
        emit,
        ...(options.siteConcurrency !== undefined ? { concurrency: options.siteConcurrency } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        store: cache,
        now,
        timeZone,
        // Left out, and said: with no list there is nothing to read its
        // entries by, and one source down is no reason to write no guide.
        failed: (site, error) => {
          emit({
            type: 'merge:warning',
            message:
              `${site.site} could not resolve its channel list, so the guide has none of its ` +
              `channels: ${errorMessage(error)}`,
          });

          return undefined;
        },
      }),
      options.merge?.cover,
      { now, ...mergeSays },
    )
  ).map((config) => ({ config, channels: config.channels as GrabberChannel[] }));

  // What `channels` selects, with the sources a derived channel needs added to
  // it — asked here rather than passed in, since the answer is the same however
  // the caller arrived and this is where the lists are fetched.
  //
  // After the lists rather than before them, because a `derived` function is a
  // function *of* them: what it declares cannot be known until there are
  // channels to declare it about. The selection then narrows what was resolved,
  // which is the same answer as narrowing on the way out of each site — what a
  // site stores is its whole list either way.
  const guideContext: GuideContext = {
    channels: sites.flatMap((site) => site.channels),
    now,
    timeZone,
    ...mergeSays,
  };
  const declarations = await configured(options.derived, guideContext);
  const selection = channelSelection({
    ...(options.channels ? { channels: options.channels } : {}),
    ...(declarations ? { derived: declarations } : {}),
  });
  const resolved =
    selection === undefined
      ? sites
      : sites.map((site) => ({
          ...site,
          channels: site.channels.filter((channel) => selection.select.has(channel.xmltvId)),
        }));

  const registry: RegistryEntry[] = [];

  if (channelStrategy === 'keep-all') {
    for (const { config, channels } of resolved) {
      for (const channel of channels) {
        registry.push({ xmltvId: channel.xmltvId, sources: [{ config, channel }] });
      }
    }
  } else {
    const byId = new Map<string, RegistryEntry>();

    for (const { config, channels } of resolved) {
      for (const channel of channels) {
        let entry = byId.get(channel.xmltvId);

        if (!entry) {
          entry = { xmltvId: channel.xmltvId, sources: [] };
          byId.set(channel.xmltvId, entry);
          registry.push(entry);
        }

        if (channelStrategy === 'first-wins' && entry.sources.length > 0) {
          continue;
        }

        entry.sources.push({ config, channel });
      }
    }
  }

  // What a derived channel shifts has to be a channel this guide already has,
  // so this comes after the registry and adds to it. A declaration the guide
  // cannot honour has already had its say — thrown for a config that cannot be
  // right, warned about for a source that merely is not here today.
  // The selection's own, where there is one: a declaration whose source was not
  // selected has been flattened past it, and one nobody selected is gone.
  const declared = selection?.derived ?? declarations;
  const derived = declared?.length ? resolveDerived(declared, registry, mergeSays) : [];

  const channels: XmltvChannel[] = [];
  const elementById = new Map<string, XmltvChannel>();

  for (const entry of registry) {
    // Channel metadata from every covering site is merged (display names
    // unioned by (lang, value), icons by src), highest priority first.
    // Under 'first-wins' and 'keep-all' an entry has a single source, so
    // this reduces to that site's info unchanged.
    const infos = entry.sources.map((source) => channelElement(source.config, source.channel));
    const first = infos[0];

    if (!first) {
      continue;
    }

    const element = infos.slice(1).reduce(mergeChannels, first);

    channels.push(element);

    if (!elementById.has(entry.xmltvId)) {
      elementById.set(entry.xmltvId, element);
    }
  }

  // A derived channel's element is its source's, renamed — so it is built from
  // what that source published rather than from any one site's idea of it, and
  // a channel three sites cover is derived from all three merged.
  for (const entry of derived) {
    const inherited = elementById.get(entry.derivedFrom.source.xmltvId);

    if (inherited === undefined) {
      continue;
    }

    channels.push(
      derivedChannelElement(
        inherited,
        entry.derivedFrom.declaration,
        entry.derivedFrom.offsetMs / 60_000,
        mergeSays,
      ),
    );
    registry.push(entry);
  }

  // After the derived entries join it, so a selected `+1` is not called missing
  // by the very pass that just built it. Said once, naming them: a selection
  // silently one channel short is the whole failure this feature exists to
  // stop, and it looks exactly like a guide that is simply small.
  const missing = unmatched(
    selection,
    registry.map((entry) => entry.xmltvId),
  );

  if (missing.length > 0) {
    mergeSays.warn(unmatchedMessage(missing, selection?.select.size ?? 0));
  }

  /**
   * What the merge made of the sources, reported once at the end.
   *
   * Counters rather than lists, with a handful of near misses kept in full:
   * on a guide of thousands the count is the alarm and the examples are what
   * make it actionable, and keeping every one of them would be the one thing
   * here that grows with the size of the guide.
   */
  let combined = 0;
  let nearMiss = 0;
  let containers = 0;
  let clipped = 0;
  const examples: { channelId: string; gapMs: number; title: string; nearby: string }[] = [];

  const listStrategy = channelStrategy === 'merge-programmes' ? programmeStrategy : 'concat';
  const match = resolveMatch(options.merge?.match);
  // Which texts of a programme say the same thing, applied as each is written.
  // A loaded config's is settled already — refused, if it had to be, before
  // anything was grabbed — and taken as it is; a caller's own is settled here.
  const textUnion = resolveUnion(options.merge?.union, match.normalizeTitle);
  /**
   * A programme with its texts as the union leaves them, worked out once: one
   * handed to a transform as `next` is finished itself straight after, and the
   * union is asked of it once rather than twice. By identity, so one merged
   * again in the meantime — held across midnight, and joined by the next day —
   * is a programme of its own and asked anew.
   */
  const unioned = new WeakMap<XmltvProgramme, XmltvProgramme>();
  const written = (programme: XmltvProgramme): XmltvProgramme => {
    let result = unioned.get(programme);

    if (result === undefined) {
      result = textUnion.apply(programme);
      unioned.set(programme, result);
    }

    return result;
  };
  const {
    fillStop = true,
    clipOverlaps = true,
    clampToWindow = false,
    fillGaps = false,
    dropContainers = true,
    transform,
  } = options.merge ?? {};
  const fillStopMs =
    fillStop === false
      ? undefined
      : ((typeof fillStop === 'object' ? fillStop.maxMs : undefined) ?? DEFAULT_FILL_STOP_MS);

  // Checked rather than trusted, as `union` is: a `blockMs` of zero or a NaN
  // makes the loop that lays blocks out never reach the end of a gap, inside a
  // generator a file is being written from. A wedged merge is worse than a
  // rejected option.
  const gaps = fillGaps === false ? undefined : resolveFillGaps(fillGaps === true ? {} : fillGaps);

  // Two entries share an `xmltvId` under `keep-all`, so each would fill the
  // other's silence and the two would interleave under one id. Said once rather
  // than quietly doing the wrong thing.
  if (gaps !== undefined && channelStrategy === 'keep-all') {
    mergeSays.warn(
      'fillGaps does nothing under channelStrategy: keep-all, where a channel has more than one entry',
    );
  }

  const filling = channelStrategy === 'keep-all' ? undefined : gaps;

  // Where each of the guide's days begins and ends, on the run's clock — the
  // calendar its days are on — worked out once rather than per channel-day.
  const bounds = new Map(
    days.map((day) => [
      day,
      { from: wallTimeIn(day, timeZone), to: wallTimeIn(addDays(day, 1), timeZone) },
    ]),
  );

  // The guide's own bounds, for `clampToWindow`: the first day's midnight, and
  // the midnight that ends the last one. A source filing local days would
  // otherwise lose the small hours of the first one to a UTC midnight that
  // comes later.
  const windowStart = days.length > 0 ? bounds.get(days[0]!)!.from : 0;
  const windowEnd = days.length > 0 ? bounds.get(days.at(-1)!)!.to : Number.MAX_SAFE_INTEGER;

  /**
   * One programme as the guide will have it, given the one that follows it.
   *
   * The rules only ever need the successor, which the day being held back has
   * already provided — so nothing is buffered for their sake. A change is made
   * on a copy: the programme belongs to whatever the cache store handed over,
   * and a store that keeps its entries in memory hands out the same object
   * every read.
   */
  const finish = (
    programme: XmltvProgramme,
    next: XmltvProgramme | undefined,
    xmltvId: string,
  ): XmltvProgramme | undefined => {
    let result = written(programme);

    if (next !== undefined) {
      const start = programme.start.getTime();
      const nextStart = next.start.getTime();

      if (programme.stop === undefined) {
        if (fillStopMs !== undefined && nextStart > start) {
          // The next start, unless the two are further apart than a programme
          // plausibly runs — a channel that stops for the night leaves a gap,
          // not one very long programme.
          result = {
            ...result,
            stop:
              nextStart - start <= fillStopMs
                ? xmltvDate(next.start)
                : xmltvDate(new Date(start + fillStopMs), {
                    offset: getXmltvOffset(programme.start),
                  }),
          };
        }
      } else if (clipOverlaps && start < nextStart && programme.stop.getTime() > nextStart) {
        clipped += 1;
        result = { ...result, stop: xmltvDate(next.start) };
      }
    }

    if (transform === undefined) {
      return result;
    }

    return (
      transform(result, {
        xmltvId,
        timeZone,
        ...mergeSays,
        // With its texts as the union leaves them, as the guide will write
        // them — unless it is the last of a day, held for the next one, which
        // may yet merge more into it.
        ...(next === undefined ? {} : { next: written(next) }),
      }) ?? undefined
    );
  };

  /**
   * Where a site's own `transform` says things, one pair per site.
   *
   * Built once and kept rather than made per channel-day: `contribution` runs
   * for every one of them, and the transform inside it for every programme.
   */
  const saysBySite = new Map<string, Says>();

  const saysFor = (site: string): Says => {
    let says = saysBySite.get(site);

    if (says === undefined) {
      says = {
        log: (message, data) =>
          emit({ type: 'site:note', site, message, ...(data ? { data } : {}) }),
        warn: (message, data) =>
          emit({ type: 'site:warning', site, message, ...(data ? { data } : {}) }),
      };
      saysBySite.set(site, says);
    }

    return says;
  };

  /** What a site contributes for one channel-day, as the site would have it. */
  const contribution = (
    source: ChannelSource,
    day: string,
    list: XmltvProgramme[],
  ): XmltvProgramme[] => {
    const { transform: siteTransform } = source.config;
    let programmes = list;

    if (siteTransform) {
      const dayZone = zoneOf(source.config);
      const context = {
        channel: source.channel,
        day,
        date: dayToDate(day),
        ...saysFor(source.config.site),
        timeZone,
        dayZone,
        at: (time: string, on = day) => wallClock(on, time, dayZone, timeZone),
      };

      programmes = programmes.flatMap((programme) => {
        const kept = siteTransform(programme, context);
        return kept ? [kept] : [];
      });
    }

    return programmes;
  };

  /** The zone each site's days are on, worked out once — see `siteDayZone`. */
  const zones = new Map<ChannelSource['config'], string>();

  const zoneOf = (config: ChannelSource['config']): string => {
    let zone = zones.get(config);

    if (zone === undefined) {
      zone = siteDayZone(config, timeZone);
      zones.set(config, zone);
    }

    return zone;
  };

  /**
   * For sites keeping one other calendar: which of their own days each of the
   * guide's is read from, and how many of the guide's days read each of those —
   * worked out once per zone, since every channel-day of such a site asks.
   *
   * The days that cover it, and the one either side where the window covers
   * that too. A source's day is the source's to draw: one that runs on to five
   * the next morning, or that opens with the evening before, holds programmes
   * of a day it does not cover, and read only where it covers they would be in
   * no day of the guide. A neighbour inside the window is one some other day
   * of the guide reads anyway, so this reads nothing more than the window's
   * own days — each once, and held a day or two longer. Outside it, nothing:
   * a source on the guide's calendar shows nothing of the day before its
   * window either, and this keeps a zone on the guide's clock reading exactly
   * as one would.
   */
  const coverings = new Map<string, Covering>();

  const coveringIn = (zone: string): Covering => {
    let covering = coverings.get(zone);

    if (covering === undefined) {
      covering = { days: new Map(), uses: new Map() };

      const window = new Set(daysCovering(days, timeZone, zone));

      for (const day of days) {
        const covered = daysCovering([day], timeZone, zone);
        const own = [addDays(covered[0]!, -1), ...covered, addDays(covered.at(-1)!, 1)].filter(
          (ownDay) => window.has(ownDay),
        );

        covering.days.set(day, own);

        for (const ownDay of own) {
          covering.uses.set(ownDay, (covering.uses.get(ownDay) ?? 0) + 1);
        }
      }

      coverings.set(zone, covering);
    }

    return covering;
  };

  /**
   * A site's own days, for one on another calendar, while one of the guide's
   * days still has to read them.
   *
   * Most of them cover two of the guide's days, and each is read and put
   * through the site's transform once rather than once for each — then let go
   * as the last of those asks. Counted by how many of the guide's days cover
   * it, which is how many times one channel's turn asks: a channel's days are
   * read one after another, so its turn is done with a day before a derived
   * channel reading the same source starts on it afresh.
   */
  const held = new Map<ChannelSource, Map<string, HeldDay>>();

  const readOwnDay = (
    source: ChannelSource,
    channelId: string,
    day: string,
    uses: number,
  ): Promise<XmltvProgramme[] | undefined> => {
    let days = held.get(source);

    if (days === undefined) {
      days = new Map();
      held.set(source, days);
    }

    let entry = days.get(day);

    if (entry === undefined) {
      entry = {
        list: cache
          .read({ site: source.config.site, channelId, day })
          .then((list) => (list === undefined ? undefined : contribution(source, day, list))),
        left: uses,
      };
      days.set(day, entry);
    }

    entry.left -= 1;

    if (entry.left === 0) {
      days.delete(day);

      if (days.size === 0) {
        held.delete(source);
      }
    }

    return entry.list;
  };

  /**
   * What one site holds for one of the guide's days, its own say over it
   * included — or `undefined` where it holds nothing.
   *
   * The entry for that day, for a site on the guide's calendar. A site keeping
   * another — a source keyed by UTC date — has no entry for the guide's day: it
   * has the entries of its own days that cover it, and the programmes from
   * them that start within it. Each of those goes through the site's transform
   * as the day it was kept under, which is the day the site said it was.
   */
  const readSource = async (
    source: ChannelSource,
    channelId: string,
    day: string,
  ): Promise<XmltvProgramme[] | undefined> => {
    const zone = zoneOf(source.config);

    if (zone === timeZone) {
      const list = await cache.read({ site: source.config.site, channelId, day });

      return list === undefined ? undefined : contribution(source, day, list);
    }

    // Asked for before anything is awaited, so the days are asked for in the
    // order the channel-days are read: what `held` counts on.
    const { days: own, uses } = coveringIn(zone);
    const lists = await Promise.all(
      own.get(day)!.map((ownDay) => readOwnDay(source, channelId, ownDay, uses.get(ownDay)!)),
    );

    if (lists.every((list) => list === undefined)) {
      return undefined;
    }

    const { from, to } = bounds.get(day)!;
    // The programme already on air as the guide begins, too — which a source
    // on the guide's calendar would have in its first day, and which
    // `clampToWindow` drops alike from either.
    const first = day === days[0];

    return lists
      .flatMap((list) => list ?? [])
      .filter((programme) => {
        const start = programme.start.getTime();

        return (
          start < to &&
          (start >= from ||
            (first && programme.stop !== undefined && programme.stop.getTime() > from))
        );
      });
  };

  /**
   * The window, applied to the times the guide will publish.
   *
   * After a derived channel's shift rather than before it, which is the only
   * place it can be: a `+1` channel's window is about its own hours, so
   * clamping on what its source said would cut it an hour out at both ends.
   */
  const clamped = (programmes: XmltvProgramme[]): XmltvProgramme[] =>
    clampToWindow
      ? programmes.filter((programme) => {
          const start = programme.start.getTime();
          return start >= windowStart && start < windowEnd;
        })
      : programmes;

  // Every channel-day the guide is made of, in the order it is written: each
  // channel's days in turn. Which is also why the last day of the window is
  // where a channel is finished, below — every entry covers the same days.
  const plan = registry.flatMap((entry) => days.map((day) => ({ entry, day })));
  const lastDay = days[days.length - 1];

  /** One channel-day, as its covering sites have it — priority order kept. */
  const readChannelDay = async ({
    entry,
    day,
  }: {
    entry: RegistryEntry;
    day: string;
  }): Promise<{
    entry: RegistryEntry;
    day: string;
    lists: XmltvProgramme[][];
    sites: string[];
  }> => {
    // A derived channel reads what it shifts. Its source's rows rather than its
    // source's *output*, so the lists stay separate and the merging below does
    // for the derived channel exactly what it does for the channel it shifts.
    const { source: read, offsetMs } = entry.derivedFrom ?? { source: entry, offsetMs: 0 };

    // The covering sites' entries for this day are read in parallel — each
    // site's own say over its own programmes applied before they meet anyone
    // else's, so what merging sees, and what the rules run on, is already what
    // the site meant. A site's transform therefore sees the times it
    // published, and the shift comes after it.
    const cached = await Promise.all(
      read.sources.map((source) => readSource(source, read.xmltvId, day)),
    );

    const lists: XmltvProgramme[][] = [];
    /** Whose each list is, in step with them. */
    const sites: string[] = [];

    for (const [index, mine] of cached.entries()) {
      if (mine !== undefined) {
        lists.push(clamped(offsetMs === 0 ? mine : shiftProgrammes(mine, offsetMs, entry.xmltvId)));
        sites.push(read.sources[index]!.config.site);
      }
    }

    return { entry, day, lists, sites };
  };

  async function* programmes(): AsyncGenerator<XmltvProgramme> {
    // What a day contributed but the next day may still have something to say
    // about. A source's "day" is its own idea — plenty run 06:00 to 06:00, and
    // plenty repeat the programme that spans midnight in both days' payloads —
    // so a day is folded in and then held, and only what the following day can
    // no longer reach is emitted. Two adjacent days of one channel is what is
    // ever alive, whatever the guide's size.
    let pending: XmltvProgramme[] = [];
    /**
     * How far this channel is covered, and which channel that is.
     *
     * A running maximum rather than the last stop seen: with `clipOverlaps` off,
     * or under `concat`, a later programme can end before an earlier one did,
     * and a filler block laid from the shorter of the two would sit on top of a
     * real programme.
     *
     * `undefined` where the gap after a programme cannot be measured — it had no
     * `stop` — which is a different thing from the channel having covered
     * nothing, and is why `covering` is tracked apart from it.
     */
    let coveredUntil: number | undefined;
    /** The entry `coveredUntil` belongs to, by identity: `keep-all` reuses ids. */
    let covering: RegistryEntry | undefined;
    /**
     * Whether this channel has produced anything at all.
     *
     * Not the same question as `coveredUntil !== undefined`, and conflating them
     * is a way to fill a whole window over the top of real programmes: a channel
     * whose last programme has no `stop` has an unmeasurable tail *and* an unset
     * `coveredUntil`, but it is emphatically not empty.
     */
    let emitted = false;
    /** The offset to write a synthesized time in — the last real one seen. */
    let offset = 0;
    /**
     * Which site each programme of a channel came from, for a channel more
     * than one site covers — the only kind with a near miss to say. Kept by
     * the merge as it makes new programmes out of old ones.
     */
    const origins = new WeakMap<XmltvProgramme, Sites>();
    /**
     * What one channel's sources made of each other — see `merge:summary` —
     * as `site`'s list folds in: the first of a day's too, which folds into
     * yesterday's tail, where another source's programme may be held over. Its
     * own, continuing, is no other source's: `origin` says whose each is.
     */
    const watching = (channelId: string, origin: MergeOrigin): MergeWatch => ({
      origin,
      combined: () => {
        combined += 1;
      },
      nearMiss: (gapMs, programme, candidate, why) => {
        nearMiss += 1;

        if (examples.length < MAX_NEAR_MISSES) {
          examples.push({
            channelId,
            gapMs,
            title: titleOf(programme),
            nearby: titleOf(candidate),
          });
        }

        // Made only where a reporter wants it — one at `debug`, `--explain
        // unmatched`, a sink that did not say — since each side's start is
        // formatted as the guide writes it, for thousands of these where two
        // sources run on two grids, and a run at `info` reads none of them.
        if (emit.hears.has('merge:unmatched')) {
          emit({
            type: 'merge:unmatched',
            channelId,
            shiftMs: programme.start.getTime() - candidate.start.getTime(),
            why,
            programme: nearMissSide(programme, origin.site),
            nearby: nearMissSide(candidate, firstSite(origins.get(candidate)) ?? ''),
          });
        }
      },
    });

    for await (const { entry, day, lists, sites } of readAhead(
      plan,
      Math.max(1, options.readAhead ?? DEFAULT_READ_AHEAD),
      readChannelDay,
    )) {
      // Between channel-days, which is as often as this has anything to say:
      // a cancelled merge stops here rather than finishing a document nobody
      // is going to keep. The reads already in the window settle into their
      // slots and are dropped with it.
      options.signal?.throwIfAborted();

      if (listStrategy === 'merge') {
        // Whose each programme is, for a channel more than one site covers —
        // from the first list on, and on a day only one of them answered for,
        // since tomorrow's lists meet what today's leave. Not for a channel
        // derived from one: the same lists again, shifted, whose sources
        // agreeing or nearly agreeing is said once, of the channel itself.
        const several = entry.derivedFrom === undefined && entry.sources.length > 1;

        for (const [index, list] of lists.entries()) {
          mergeInto(
            pending,
            list,
            match,
            // Made only where it is kept: one source's channel pays nothing.
            several ? watching(entry.xmltvId, { site: sites[index]!, sites: origins }) : undefined,
          );
        }
      } else if (listStrategy === 'backfill') {
        // Across the sites of *this day* first, into an array of its own, and
        // only then across the day boundary. Folding straight into `pending`
        // would test today's programmes against yesterday's tail, whose last
        // entry has no stop and is therefore taken to run six hours — so a
        // site's own morning would read as already covered by its own evening.
        const today: XmltvProgramme[] = [];

        for (const list of lists) {
          backfillInto(today, list, { match, fillStopMs });
        }

        // The boundary stays a merge: two days of one source describing the
        // same broadcast are one broadcast, which is a different question from
        // which of two *sources* wins.
        mergeInto(pending, today, match);
      } else {
        // Nothing is deduplicated under `concat`, but the hold still buys the
        // ordering: a programme a later day reported for an earlier one lands
        // where it belongs rather than after everything already emitted.
        pending = [...pending, ...lists.flat()].sort(
          (a, b) => a.start.getTime() - b.start.getTime(),
        );
      }

      // Anything starting before the day just folded in: no later day can
      // reasonably claim it, so it is done.
      const horizon = bounds.get(day)!.from;
      let held = 0;

      while (held < pending.length && pending[held]!.start.getTime() < horizon) {
        held++;
      }

      // The window's last day: nothing is left to hold this channel's tail back
      // for, and the next channel-day read belongs to another channel.
      const last = day === lastDay;
      const ready = last ? pending.splice(0) : pending.splice(0, held);

      // A new channel: whatever the last one was covered to says nothing about
      // this one.
      if (covering !== entry) {
        covering = entry;
        coveredUntil = undefined;
        emitted = false;
        offset = 0;
      }

      for (const [index, programme] of ready.entries()) {
        // A magazine block published beside the programmes inside it. Dropped
        // before anything else looks at it: it is not overrunning the next
        // programme — which is what `clipOverlaps` fixes — it is describing the
        // same hours at a coarser grain, and keeping both leaves the guide
        // genuinely overlapping.
        if (dropContainers && containedCount(programme, ready, index + 1, pending) >= 2) {
          containers += 1;

          continue;
        }

        // What follows it on this channel: the next one out, or — for the last
        // of this batch — the first one still being held. Which is what the day
        // held back is for, over and above the merging it was added for.
        const finished = finish(programme, ready[index + 1] ?? pending[0], entry.xmltvId);

        if (finished === undefined) {
          continue;
        }

        const start = finished.start.getTime();

        offset = getXmltvOffset(finished.start);

        // Blocks are laid before the programme that ends the gap, and never go
        // through `finish`: they are born with both ends, so `clipOverlaps` has
        // nothing to do, and handing one to `fillStop` would be circular.
        if (filling !== undefined && (coveredUntil !== undefined || filling.edges)) {
          const from = coveredUntil ?? windowStart;

          if (from < start) {
            yield* blocks(entry.xmltvId, from, start, offset, filling);
          }
        }

        yield finished;
        emitted = true;

        // No `stop` means the gap after it cannot be measured — the guide does
        // not know when it ended — so the next gap is skipped rather than
        // guessed at. That is what `undefined` says here, as against "nothing
        // covered yet", which `covering` above distinguishes.
        coveredUntil =
          finished.stop === undefined
            ? undefined
            : Math.max(coveredUntil ?? Number.NEGATIVE_INFINITY, finished.stop.getTime());
      }

      if (last) {
        // The trailing edge, and the whole window for a channel that had
        // nothing at all — which is the same case, since `coveredUntil` is then
        // still unset and the fill runs from the window's start.
        if (filling !== undefined && filling.edges) {
          const from = coveredUntil ?? (emitted ? undefined : windowStart);

          if (from !== undefined && from < windowEnd) {
            yield* blocks(entry.xmltvId, from, windowEnd, offset, filling);
          }
        }

        emit({ type: 'merge:channel', channelId: entry.xmltvId });
      }
    }
  }

  // Asked the same thing `derived` was, and here rather than up there because
  // nothing between the two needs it — the writer is the only reader of it.
  const meta = await configured(options.meta, guideContext);

  yield* writeXmltvStream(
    {
      ...(meta ? { meta } : {}),
      channels,
      programmes: programmes(),
    },
    outputOptions(options),
  );

  // After the writing, because that is what pulls the generator above: until
  // the last programme is out, none of these numbers are final.
  emit({ type: 'merge:summary', combined, nearMiss, examples, containers, clipped });
}

/**
 * Write the guide to `output`: a file, replaced atomically; a Unix socket,
 * streamed to whoever is listening; or a stream to write into.
 */
export async function writeGuide(
  options: BuildGuideOptions & { output: OutputTarget; compress?: OutputOptions['compress'] },
): Promise<void> {
  const { output, compress, ...guideOptions } = options;

  await writeOutput(output, generateGuide(guideOptions), {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(compress !== undefined ? { compress } : {}),
  });
}
