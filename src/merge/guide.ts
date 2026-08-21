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

// Where it lives now, re-exported for the entry points that published it.
export { defaultChannelInfo };

/**
 * Build the XMLTV guide as a stream of XML string chunks.
 *
 * Programmes are read from the cache a channel-day at a time (across the
 * channel's covering sites), merged and passed lazily into the XMLTV writer, so
 * the whole guide is never materialized in memory. One day of one channel is
 * held back as it goes, which is what lets a programme two adjacent days both
 * reported be emitted once — so the working set is two days of one channel,
 * flat in the size of the guide either way.
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

  async function* programmes(): AsyncGenerator<XmltvProgramme> {
    for (const entry of registry) {
      // What a day contributed but the next day may still have something to say
      // about. A source's "day" is its own idea — plenty run 06:00 to 06:00, and
      // plenty repeat the programme that spans midnight in both days' payloads —
      // so a day is folded in and then held, and only what the following day can
      // no longer reach is emitted. Two adjacent days of one channel is what is
      // ever alive, whatever the guide's size.
      let pending: XmltvProgramme[] = [];

      for (const day of days) {
        // The covering sites' entries for this day are read in parallel.
        const cached = await Promise.all(
          entry.sources.map((source) =>
            cache.read({ site: source.config.site, channelId: entry.xmltvId, day }),
          ),
        );
        const lists = cached.filter((list): list is XmltvProgramme[] => list !== undefined);

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
      }

      yield* pending;

      logger?.(`merge: channel ${entry.xmltvId} done`);
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
