import { dayRange, dayToDate, toDayString } from '../core/days.js';
import { GrabberError } from '../core/error.js';
import { writeOutput, type OutputOptions, type OutputTarget } from '../core/output.js';
import { emitter } from '../core/events.js';
import type { Says } from '../core/events.js';
import { channelElement, defaultChannelInfo, resolveSites } from '../grabber/channels.js';
import type { GrabberChannel } from '../grabber/types.js';
import { getXmltvOffset, writeXmltvStream, xmltvDate } from '../xmltv/main.js';
import type { XmltvChannel, XmltvProgramme } from '../xmltv/types.js';
import { mergeChannels } from './channel.js';
import { derivedChannelElement, resolveDerived, shiftProgrammes } from './derive.js';
import { backfillInto, DEFAULT_FILL_STOP_MS, mergeInto, resolveMatch } from './programme.js';
import type { ChannelSource, RegistryEntry } from './registry.js';
import { channelSelection, unmatched, unmatchedMessage } from './select.js';
import type { BuildGuideOptions, FillGapsContext, FillGapsOptions } from './types.js';

/**
 * How many channel-days are read from the cache ahead of the writer when
 * nothing says. The same order of magnitude as the grab's `localConcurrency`,
 * and for the same reason: what it bounds is open files and how many programme
 * lists are alive at once, and Node's file operations run on a threadpool of
 * four by default anyway.
 */
const DEFAULT_READ_AHEAD = 16;

const DAY_MS = 86_400_000;

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
export async function* generateGuide(options: BuildGuideOptions): AsyncGenerator<string> {
  const now = options.now ?? new Date();
  const days = [...dayRange(options.startDay ?? toDayString(now), options.days ?? 7)];
  const channelStrategy = options.merge?.channelStrategy ?? 'merge-programmes';
  const programmeStrategy = options.merge?.programmeStrategy ?? 'merge';
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
  // What `channels` selects, with the sources a derived channel needs added to
  // it — asked here rather than passed in, since the answer is the same however
  // the caller arrived and this is where the lists are fetched.
  const selection = channelSelection(options);
  const resolved = (
    await resolveSites(options.sites, {
      emit,
      ...(options.siteConcurrency !== undefined ? { concurrency: options.siteConcurrency } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(selection ? { select: selection.select } : {}),
      store: cache,
      now,
    })
  ).map((config) => ({ config, channels: config.channels as GrabberChannel[] }));

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
  const declared = selection?.derived ?? options.derived;
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

  const listStrategy = channelStrategy === 'merge-programmes' ? programmeStrategy : 'concat';
  const match = resolveMatch(options.merge?.match);
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

  // Checked rather than trusted, which nothing else in `merge` needs to be: a
  // `blockMs` of zero or a NaN makes the loop that lays blocks out never reach
  // the end of a gap, inside a generator a file is being written from. A wedged
  // merge is worse than a rejected option.
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

  // The guide's own bounds, for `clampToWindow`: the first day's midnight, and
  // the midnight that ends the last one.
  const windowStart = days.length > 0 ? dayToDate(days[0]!).getTime() : 0;
  const windowEnd =
    days.length > 0
      ? dayToDate(days[days.length - 1]!).getTime() + DAY_MS
      : Number.MAX_SAFE_INTEGER;

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
    let result = programme;

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
        result = { ...result, stop: xmltvDate(next.start) };
      }
    }

    if (transform === undefined) {
      return result;
    }

    return (
      transform(result, { xmltvId, ...mergeSays, ...(next === undefined ? {} : { next }) }) ??
      undefined
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
      const context = {
        channel: source.channel,
        day,
        date: dayToDate(day),
        ...saysFor(source.config.site),
      };

      programmes = programmes.flatMap((programme) => {
        const kept = siteTransform(programme, context);
        return kept ? [kept] : [];
      });
    }

    return programmes;
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
  }): Promise<{ entry: RegistryEntry; day: string; lists: XmltvProgramme[][] }> => {
    // A derived channel reads what it shifts. Its source's rows rather than its
    // source's *output*, so the lists stay separate and the merging below does
    // for the derived channel exactly what it does for the channel it shifts.
    const { source: read, offsetMs } = entry.derivedFrom ?? { source: entry, offsetMs: 0 };

    // The covering sites' entries for this day are read in parallel.
    const cached = await Promise.all(
      read.sources.map((source) =>
        cache.read({ site: source.config.site, channelId: read.xmltvId, day }),
      ),
    );

    const lists: XmltvProgramme[][] = [];

    // Each site's own say over its own programmes, before they meet anyone
    // else's — so what merging sees, and what the rules run on, is already
    // what the site meant. A site's transform therefore sees the times it
    // published, and the shift comes after it.
    for (const [index, list] of cached.entries()) {
      if (list !== undefined) {
        const mine = contribution(read.sources[index]!, day, list);

        lists.push(clamped(offsetMs === 0 ? mine : shiftProgrammes(mine, offsetMs, entry.xmltvId)));
      }
    }

    return { entry, day, lists };
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

    for await (const { entry, day, lists } of readAhead(
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
        for (const list of lists) {
          mergeInto(pending, list, match);
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
      const horizon = dayToDate(day).getTime();
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

  yield* writeXmltvStream(
    {
      ...(options.meta ? { meta: options.meta } : {}),
      channels,
      programmes: programmes(),
    },
    {
      ...(options.indent !== undefined ? { indent: options.indent } : {}),
      ...(options.extensions !== undefined ? { extensions: options.extensions } : {}),
    },
  );
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
