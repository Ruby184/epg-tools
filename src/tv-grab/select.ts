import type { EpgConfig } from '../config.js';
import { resolveChannels } from '../grabber/channels.js';
import { resolveDeclarations } from '../merge/derive.js';

/**
 * Restrict a config to the selected channel ids.
 *
 * Only records the selection — {@link channelSelection} is what reads it back,
 * and `resolveChannels` is what applies it. It deliberately does **not** filter
 * the sites here: a site's `channels` may be a function, and wrapping it would
 * put the filter on the wrong side of `cacheChannels`, where a cached list
 * returns without the wrapper running and a fetched one is stored already
 * narrowed. See `ResolveChannelsOptions.select`.
 */
export function applyChannelSelection(config: EpgConfig, selected: Set<string>): EpgConfig {
  return { ...config, channels: [...selected] };
}

/** Every channel id a config can deliver, in site priority order, deduplicated. */
export async function resolveChannelIds(config: EpgConfig): Promise<string[]> {
  const ids: string[] = [];
  const seen = new Set<string>();

  for (const site of config.sites) {
    const channels = await resolveChannels(site);

    for (const channel of channels) {
      if (!seen.has(channel.xmltvId)) {
        seen.add(channel.xmltvId);
        ids.push(channel.xmltvId);
      }
    }
  }

  if (config.derived?.length) {
    // After the real ones, and counted the same: a selection offering them, and
    // `--channel-updates` not calling them "no longer offered" every run.
    for (const { declaration } of resolveDeclarations(config.derived, seen, new Set())) {
      if (!seen.has(declaration.xmltvId)) {
        seen.add(declaration.xmltvId);
        ids.push(declaration.xmltvId);
      }
    }
  }

  return ids;
}
