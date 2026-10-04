import type { EpgConfig } from '../config.js';
import { resolveChannels } from '../grabber/channels.js';
import type { GrabberChannel } from '../grabber/types.js';
import { resolveDeclarations } from '../merge/derive.js';
import { configured } from '../merge/select.js';

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
  // One `Set` and no list beside it: it dedupes and keeps insertion order, which
  // is the two things the ids are wanted for.
  const ids = new Set<string>();
  const channels: GrabberChannel[] = [];

  for (const site of config.sites) {
    const listed = await resolveChannels(site);

    channels.push(...listed);

    for (const channel of listed) {
      ids.add(channel.xmltvId);
    }
  }

  // Asked against the lists just read, so a `derived` function offers what this
  // run would build rather than what was written down.
  const declarations = await configured(config.derived, {
    channels,
    now: new Date(),
    log: () => {},
    warn: () => {},
  });

  if (declarations?.length) {
    // After the real ones, and counted the same: a selection offering them, and
    // `--channel-updates` not calling them "no longer offered" every run.
    //
    // `ids` is both what a declaration is resolved against and where its own id
    // lands, as it was before: a chain is declared in terms of what came
    // earlier, so each one is on the books by the time the next is read.
    for (const { declaration } of resolveDeclarations(declarations, ids, new Set())) {
      ids.add(declaration.xmltvId);
    }
  }

  return [...ids];
}
