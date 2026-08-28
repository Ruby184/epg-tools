import ky, { type KyInstance } from 'ky';
import PQueue from 'p-queue';
import type { CacheStore } from '../cache/types.js';
import { ChannelBuilder } from '../xmltv/builder.js';
import type { XmltvChannel } from '../xmltv/types.js';
import { channelsMaxAgeMs, SiteStateHandle } from './state.js';
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

/** What a caller can offer {@link resolveChannels} beyond the site itself. */
export interface ResolveChannelsOptions {
  /** The site's client, when the caller already has one. Built otherwise. */
  http?: KyInstance;
  signal?: AbortSignal;
  /**
   * This site's state, when the caller has opened it — where a cached channel
   * list is read from and written to. Without one, a site that asked for
   * `cacheChannels` is simply asked for its list like any other.
   */
  state?: SiteStateHandle;
  /** Fetch the list whatever is cached — what `--refresh` amounts to here. */
  refresh?: boolean;
  /** "Now", for reckoning how old a cached list is. Defaults to the real one. */
  now?: Date;
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
 * list reaches all of them the same way. Which is also where a site's
 * `cacheChannels` is honoured: given a state handle, a list still inside its max
 * age comes back without the source being asked, and a freshly fetched one is
 * remembered for the next command. The handle is *not* saved here — whoever
 * opened it saves it once, when it is done with the site.
 */
export async function resolveChannels(
  config: AnySiteConfig,
  options: ResolveChannelsOptions = {},
): Promise<GrabberChannel[]> {
  // In a local, so the narrowing survives into the closure below.
  const source = config.channels;

  if (typeof source !== 'function') {
    return source;
  }

  const fromSource = async (): Promise<GrabberChannel[]> =>
    source({
      http: options.http ?? siteHttp(config, options.signal),
      ...(options.signal ? { signal: options.signal } : {}),
    });

  const maxAgeMs = channelsMaxAgeMs(config);
  const { state } = options;

  // Nothing to read and nothing to keep: the site did not ask for its list to be
  // cached, or this caller has nowhere to put it.
  if (maxAgeMs === undefined || state === undefined) {
    return fromSource();
  }

  const now = options.now ?? new Date();
  const group = await state.channels();

  if (options.refresh !== true) {
    const held = group.fresh(maxAgeMs, now);

    if (held !== undefined) {
      return held;
    }
  }

  const channels = await fromSource();

  group.set(channels, now);

  return channels;
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
 *
 * Given a `store`, a site that asked for `cacheChannels` reads its list from
 * there and writes a fetched one back — one state handle per site, opened and
 * saved here, since resolving is the whole of what this call does with a site.
 */
export async function resolveSites(
  sites: AnySiteConfig[],
  options: {
    signal?: AbortSignal;
    concurrency?: number;
    /** Where a cached channel list lives. Without it, every list is fetched. */
    store?: CacheStore;
    /** Fetch every list whatever is cached — `--refresh`. */
    refresh?: boolean;
    now?: Date;
  } = {},
): Promise<AnySiteConfig[]> {
  const queue = new PQueue({ concurrency: Math.max(1, options.concurrency ?? sites.length) });
  const { store } = options;

  return Promise.all(
    sites.map((site) =>
      queue.add(async (): Promise<AnySiteConfig> => {
        const state = store === undefined ? undefined : SiteStateHandle.open(store, site.site);
        const channels = await resolveChannels(site, {
          ...(options.signal ? { signal: options.signal } : {}),
          ...(state ? { state } : {}),
          ...(options.refresh === undefined ? {} : { refresh: options.refresh }),
          ...(options.now ? { now: options.now } : {}),
        });

        // Only a list that was fetched is one to write, and the handle knows
        // whether that happened — so a merge over a cached list touches nothing.
        await state?.save();

        return { ...site, channels };
      }),
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
