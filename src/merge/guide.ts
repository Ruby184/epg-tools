import { dayRange, dayToDate, toDayString } from '../core/days.js';
import { writeOutput, type OutputTarget } from '../core/output.js';
import { channelElement, defaultChannelInfo, resolveSites } from '../grabber/channels.js';
import type { AnySiteConfig, GrabberChannel } from '../grabber/types.js';
import { writeXmltvStream } from '../xmltv/main.js';
import type { XmltvChannel, XmltvProgramme } from '../xmltv/types.js';
import { mergeChannels } from './channel.js';
import { mergeInto, resolveMatch } from './programme.js';
import type { BuildGuideOptions } from './types.js';

interface ChannelSource {
  config: AnySiteConfig;
  channel: GrabberChannel;
}

/** One output `<channel>` with its covering sites in priority order. */
interface RegistryEntry {
  xmltvId: string;
  sources: ChannelSource[];
}

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
 * Build the XMLTV guide as a stream of XML string chunks.
 *
 * Programmes are read from the cache a channel-day at a time (across the
 * channel's covering sites), merged and passed lazily into the XMLTV writer, so
 * the whole guide is never materialized in memory. One day of one channel is
 * held back as it goes, which is what lets a programme two adjacent days both
 * reported be emitted once, and the entries ahead of the writer are read while
 * it works — `readAhead` of them. So what is alive at once is those two days
 * plus that window, flat in the size of the guide however large it gets.
 */
export async function* generateGuide(options: BuildGuideOptions): AsyncGenerator<string> {
  const now = options.now ?? new Date();
  const days = [...dayRange(options.startDay ?? toDayString(now), options.days ?? 7)];
  const channelStrategy = options.merge?.channelStrategy ?? 'merge-programmes';
  const programmeStrategy = options.merge?.programmeStrategy ?? 'merge';
  const { cache, logger } = options;

  // Through the same helper the grab uses, so a site that fetches its channel
  // list is asked the same way by both — and every site at once rather than one
  // after another, since each is a single request to a host of its own.
  const resolved = (
    await resolveSites(options.sites, {
      ...(options.siteConcurrency !== undefined ? { concurrency: options.siteConcurrency } : {}),
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

  const channels: XmltvChannel[] = [];

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

    channels.push(infos.slice(1).reduce(mergeChannels, first));
  }

  const listStrategy = channelStrategy === 'merge-programmes' ? programmeStrategy : 'concat';
  const match = resolveMatch(options.merge?.match);

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
    // The covering sites' entries for this day are read in parallel.
    const cached = await Promise.all(
      entry.sources.map((source) =>
        cache.read({ site: source.config.site, channelId: entry.xmltvId, day }),
      ),
    );

    return {
      entry,
      day,
      lists: cached.filter((list): list is XmltvProgramme[] => list !== undefined),
    };
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

      yield* pending.splice(0, held);

      // The window's last day: nothing is left to hold this channel's tail
      // back for, and the next channel-day read belongs to another channel.
      if (day === lastDay) {
        yield* pending;
        pending = [];

        logger?.(`merge: channel ${entry.xmltvId} done`);
      }
    }
  }

  yield* writeXmltvStream(
    {
      ...(options.meta ? { meta: options.meta } : {}),
      channels,
      programmes: programmes(),
    },
    options.indent !== undefined ? { indent: options.indent } : undefined,
  );
}

/**
 * Write the guide to `output`: a file, replaced atomically; a Unix socket,
 * streamed to whoever is listening; or a stream to write into.
 */
export async function writeGuide(
  options: BuildGuideOptions & { output: OutputTarget },
): Promise<void> {
  const { output, ...guideOptions } = options;

  await writeOutput(output, generateGuide(guideOptions));
}
