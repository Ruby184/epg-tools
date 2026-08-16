import type { EpgConfig } from '../config.js';
import type { GrabberChannel } from '../grabber/types.js';
import { defaultChannelInfo, mergeChannels } from '../merge/main.js';
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
    const channels: GrabberChannel[] =
      typeof site.channels === 'function' ? await site.channels() : site.channels;

    for (const channel of channels) {
      const info = site.channelInfo?.(channel) ?? defaultChannelInfo(channel);
      const existing = byId.get(channel.xmltvId);

      // The same merge the guide does, so a channel covered by several sites
      // is described identically in both.
      byId.set(channel.xmltvId, existing === undefined ? info : mergeChannels(existing, info));
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
  const options = config.indent !== undefined ? { indent: config.indent } : undefined;
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
