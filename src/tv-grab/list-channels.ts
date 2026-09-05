import type { EpgConfig } from '../config.js';
import { channelElement, resolveChannels } from '../grabber/channels.js';
import type { GrabberChannel } from '../grabber/types.js';
import { derivedChannelElement, resolveDeclarations } from '../merge/derive.js';
import { mergeChannels } from '../merge/main.js';
import {
  serializeChannel,
  serializeDocumentFooter,
  serializeDocumentHeader,
} from '../xmltv/main.js';
import type { XmltvChannel } from '../xmltv/types.js';

/**
 * One `<channel>` per distinct id, in site priority order — re-setting an
 * existing key leaves its position in the Map alone, so merging a later site's
 * metadata does not move the channel.
 */
async function collectChannels(config: EpgConfig): Promise<XmltvChannel[]> {
  const byId = new Map<string, XmltvChannel>();

  for (const site of config.sites) {
    const channels: GrabberChannel[] = await resolveChannels(site);

    for (const channel of channels) {
      const info = channelElement(site, channel);
      const existing = byId.get(channel.xmltvId);

      // The same merge the guide does, so a channel covered by several sites
      // is described identically in both.
      byId.set(channel.xmltvId, existing === undefined ? info : mergeChannels(existing, info));
    }
  }

  // A derived channel is one this grabber can deliver, so it belongs in the
  // list a caller chooses from — without it, tvheadend can never map the `+1`.
  // Built from the source's merged element, exactly as the guide builds it.
  if (config.derived?.length) {
    for (const { declaration, rootId, offsetMinutes } of resolveDeclarations(
      config.derived,
      new Set(byId.keys()),
      new Set(),
    )) {
      const inherited = byId.get(rootId);

      if (inherited !== undefined) {
        byId.set(declaration.xmltvId, derivedChannelElement(inherited, declaration, offsetMinutes));
      }
    }
  }

  return [...byId.values()];
}

/**
 * An XMLTV document containing only `<channel>` elements — what
 * `--list-channels` returns.
 *
 * Every channel the grabber can deliver is listed, deliberately ignoring any
 * selection in the configuration: the caller uses this to *offer* a choice.
 */
export async function listChannelsXml(config: EpgConfig): Promise<string> {
  const options = {
    ...(config.indent !== undefined ? { indent: config.indent } : {}),
    ...(config.extensions !== undefined ? { extensions: config.extensions } : {}),
  };
  const channels = await collectChannels(config);

  let out = serializeDocumentHeader(config.meta, options);

  for (const channel of channels) {
    out += serializeChannel(channel, options);
  }

  return out + serializeDocumentFooter(options);
}

/** Channel ids and display names, for the channel-selection stage. */
export async function listChannelChoices(
  config: EpgConfig,
): Promise<{ id: string; name?: string }[]> {
  return (await collectChannels(config)).map((channel) => {
    const name = channel.displayName?.[0]?.value;
    return name === undefined ? { id: channel.id } : { id: channel.id, name };
  });
}
