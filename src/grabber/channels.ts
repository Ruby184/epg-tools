import ky, { type KyInstance } from 'ky';
import PQueue from 'p-queue';
import { ChannelBuilder } from '../xmltv/builder.js';
import type { XmltvChannel } from '../xmltv/types.js';
import type { AnySiteConfig, GrabberChannel } from './types.js';

/**
 * A site's own HTTP client, built from its `ky` options.
 *
 * One place builds it, so everything that talks to a site — its requests and
 * its channel list — goes out with the same prefix, headers, retry and
 * dispatcher, and no site's settings can reach another's.
 *
 * `signal` is baked into the instance rather than handed to the site to pass
 * on: every call through `http` is then abortable whether or not whoever wrote
 * the site remembered to forward it. A site that brought a signal of its own in
 * `ky.signal` keeps it — both are honoured, either one aborts.
 */
export function siteHttp(config: AnySiteConfig, signal?: AbortSignal): KyInstance {
  const signals = [config.ky?.signal, signal].filter(
    (candidate): candidate is AbortSignal => candidate != null,
  );

  return ky.create({
    ...config.ky,
    ...(signals.length > 0
      ? { signal: signals.length === 1 ? signals[0]! : AbortSignal.any(signals) }
      : {}),
  });
}

/**
 * A site's channels, whichever form it declares them in.
 *
 * The function form is called with the site's HTTP client, so a channel list
 * that has to be fetched needs nothing of its own — no second client, and no
 * copy of the credentials the site's `ky` options already carry. Pass `http`
 * when the caller already has the site's instance (a grab does); one is built
 * otherwise.
 *
 * Every caller resolves channels through this — the grab, the merge,
 * `--list-channels`, `--configure` and the lineups capability — so a fetched
 * list reaches all of them the same way.
 */
export async function resolveChannels(
  config: AnySiteConfig,
  options: { http?: KyInstance; signal?: AbortSignal } = {},
): Promise<GrabberChannel[]> {
  if (typeof config.channels !== 'function') {
    return config.channels;
  }

  return config.channels({
    http: options.http ?? siteHttp(config, options.signal),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/**
 * Every site with its channels resolved to a plain list.
 *
 * What to reach for when more than one pass has to agree about the same sites:
 * a fetched list resolved separately by a grab and by the merge that reads what
 * it wrote can differ between the two, leaving the guide describing channels
 * nothing ever grabbed. Resolving up front is also one request per site instead
 * of one per pass.
 *
 * `concurrency` defaults to all of them at once — one request each, to one host
 * each; pass the run's `siteConcurrency` to hold it to the same bound the grab
 * itself uses.
 */
export async function resolveSites(
  sites: AnySiteConfig[],
  options: { signal?: AbortSignal; concurrency?: number } = {},
): Promise<AnySiteConfig[]> {
  const queue = new PQueue({ concurrency: Math.max(1, options.concurrency ?? sites.length) });

  return Promise.all(
    sites.map((site) =>
      queue.add(async (): Promise<AnySiteConfig> => ({
        ...site,
        channels: await resolveChannels(site, {
          ...(options.signal ? { signal: options.signal } : {}),
        }),
      })),
    ),
  );
}

/**
 * The `<channel>` element a site gets when it defines no `channelInfo`:
 * id + display name + icon. Exported because the same mapping is what an
 * XMLTV grabber's `--list-channels` has to emit.
 */
export function defaultChannelInfo(channel: GrabberChannel): XmltvChannel {
  return {
    id: channel.xmltvId,
    displayName: [{ value: channel.name ?? channel.xmltvId }],
    ...(channel.logo ? { icon: [{ src: channel.logo }] } : {}),
  };
}

/**
 * How a site describes one of its channels, whichever way it says it: the
 * default element, or what its `channelInfo` builds — as a builder or as a
 * plain object.
 *
 * Everything that emits a `<channel>` goes through this — the merge and
 * `--list-channels` — so a channel is described identically wherever it turns
 * up.
 */
export function channelElement(config: AnySiteConfig, channel: GrabberChannel): XmltvChannel {
  if (!config.channelInfo) {
    return defaultChannelInfo(channel);
  }

  const element = (displayName?: string): ChannelBuilder => {
    const builder = new ChannelBuilder({
      id: channel.xmltvId,
      displayName: displayName ?? channel.name ?? channel.xmltvId,
      ...(channel.lang === undefined ? {} : { lang: channel.lang }),
    });

    // Where the default element leaves off, so a site adds to it rather than
    // restating it.
    return channel.logo ? builder.icon(channel.logo) : builder;
  };

  const info = config.channelInfo(channel, element);

  return info instanceof ChannelBuilder ? info.build() : info;
}
