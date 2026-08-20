import type { EpgConfig } from '../config.js';
import type { AnySiteConfig, GrabberChannel } from '../grabber/types.js';

/**
 * Restrict every site to the selected channel ids.
 *
 * A site's `channels` may be a function, so filtering stays lazy: resolving it
 * here would fire a site's remote channel-list request during option handling,
 * which `--capabilities` and friends must never trigger. Sites left with no
 * channels are dropped, which is only decidable for the eager form.
 */
export function applyChannelSelection(config: EpgConfig, selected: Set<string>): EpgConfig {
  const sites: AnySiteConfig[] = [];

  for (const site of config.sites) {
    if (typeof site.channels === 'function') {
      const resolve = site.channels;

      sites.push({
        ...site,
        channels: async (): Promise<GrabberChannel[]> =>
          (await resolve()).filter((channel) => selected.has(channel.xmltvId)),
      });

      continue;
    }

    const channels = site.channels.filter((channel) => selected.has(channel.xmltvId));

    if (channels.length > 0) {
      sites.push({ ...site, channels });
    }
  }

  return { ...config, sites };
}

/** Every channel id a config can deliver, in site priority order, deduplicated. */
export async function resolveChannelIds(config: EpgConfig): Promise<string[]> {
  const ids: string[] = [];
  const seen = new Set<string>();

  for (const site of config.sites) {
    const channels = typeof site.channels === 'function' ? await site.channels() : site.channels;

    for (const channel of channels) {
      if (!seen.has(channel.xmltvId)) {
        seen.add(channel.xmltvId);
        ids.push(channel.xmltvId);
      }
    }
  }

  return ids;
}
