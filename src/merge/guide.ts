import { dayRange, toDayString } from '../core/days.js';
import { writeOutput, type OutputTarget } from '../core/output.js';
import { channelElement, defaultChannelInfo, resolveChannels } from '../grabber/channels.js';
import type { AnySiteConfig, GrabberChannel } from '../grabber/types.js';
import { writeXmltvStream } from '../xmltv/main.js';
import type { XmltvChannel, XmltvProgramme } from '../xmltv/types.js';
import { mergeChannels } from './channel.js';
import { mergeProgrammeLists } from './programme.js';
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
 * Programmes are read from the cache one channel-day at a time (across the
 * channel's covering sites), merged and passed lazily into the XMLTV writer,
 * so the whole guide is never materialized in memory.
 */
export async function* generateGuide(options: BuildGuideOptions): AsyncGenerator<string> {
  const now = options.now ?? new Date();
  const days = [...dayRange(options.startDay ?? toDayString(now), options.days ?? 7)];
  const channelStrategy = options.merge?.channelStrategy ?? 'merge-programmes';
  const programmeStrategy = options.merge?.programmeStrategy ?? 'merge';
  const { cache, logger } = options;

  const resolved: { config: AnySiteConfig; channels: GrabberChannel[] }[] = [];

  for (const config of options.sites) {
    resolved.push({ config, channels: await resolveChannels(config) });
  }

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

  async function* programmes(): AsyncGenerator<XmltvProgramme> {
    for (const entry of registry) {
      for (const day of days) {
        // Memory stays bounded to one channel-day across covering sites;
        // the covering sites' entries are read in parallel.
        const cached = await Promise.all(
          entry.sources.map((source) =>
            cache.read({ site: source.config.site, channelId: entry.xmltvId, day }),
          ),
        );
        const lists = cached.filter((list): list is XmltvProgramme[] => list !== undefined);

        yield* mergeProgrammeLists(lists, listStrategy);
      }

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
