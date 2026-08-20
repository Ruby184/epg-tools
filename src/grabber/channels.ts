import ky, { type KyInstance } from 'ky';
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
  const signals = [config.ky?.signal, signal].filter((candidate): candidate is AbortSignal => candidate != null);

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

