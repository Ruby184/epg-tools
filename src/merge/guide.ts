import { dayRange, dayToDate, toDayString } from '../core/days.js';
import { writeOutput, type OutputOptions, type OutputTarget } from '../core/output.js';
import { emitter } from '../core/events.js';
import type { Says } from '../core/events.js';
import { channelElement, defaultChannelInfo, resolveSites } from '../grabber/channels.js';
import type { GrabberChannel } from '../grabber/types.js';
import { getXmltvOffset, writeXmltvStream, xmltvDate } from '../xmltv/main.js';
import type { XmltvChannel, XmltvProgramme } from '../xmltv/types.js';
import { mergeChannels } from './channel.js';
import { derivedChannelElement, resolveDerived, shiftProgrammes } from './derive.js';
import { mergeInto, resolveMatch } from './programme.js';
import type { ChannelSource, RegistryEntry } from './registry.js';
import type { BuildGuideOptions } from './types.js';

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
 * How long `fillStop` may make a programme run: long enough for any film, short
 * enough that the gap where a channel stops broadcasting for the night stays a
 * gap rather than becoming one nine-hour programme.
 */
const DEFAULT_FILL_STOP_MS = 6 * 60 * 60 * 1000;

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
  const resolved = (
    await resolveSites(options.sites, {
      emit,
      ...(options.siteConcurrency !== undefined ? { concurrency: options.siteConcurrency } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
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
  const derived = options.derived?.length
    ? resolveDerived(options.derived, registry, mergeSays)
    : [];

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

    channels.push(derivedChannelElement(inherited, entry, mergeSays));
    registry.push(entry);
  }

  const listStrategy = channelStrategy === 'merge-programmes' ? programmeStrategy : 'concat';
  const match = resolveMatch(options.merge?.match);
  const {
    fillStop = true,
    clipOverlaps = true,
    clampToWindow = false,
    transform,
  } = options.merge ?? {};
  const fillStopMs =
    fillStop === false
      ? undefined
      : ((typeof fillStop === 'object' ? fillStop.maxMs : undefined) ?? DEFAULT_FILL_STOP_MS);

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

      for (const [index, programme] of ready.entries()) {
        // What follows it on this channel: the next one out, or — for the last
        // of this batch — the first one still being held. Which is what the day
        // held back is for, over and above the merging it was added for.
        const finished = finish(programme, ready[index + 1] ?? pending[0], entry.xmltvId);

        if (finished !== undefined) {
          yield finished;
        }
      }

      if (last) {
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
