/**
 * `epg serve` — the merged guide over HTTP, for a consumer that polls.
 *
 * The serving half of what `conditionalGet` does on the fetching side, and for
 * the same reason: a consumer that asks hourly for a guide that changes nightly
 * spends twenty-three of those asks receiving a document it already has. An
 * answer of `304 Not Modified` costs a header instead of a merge.
 *
 * Which turns on having a validator that is **cheaper than the guide** — and a
 * guide is a generator, so its bytes cannot be hashed without buffering the
 * document this package exists to avoid buffering. The cache answers instead:
 * the newest `grabbedAt` across the window, with how many entries are in it.
 * Nothing else can change what the merge would produce, since the merge reads
 * exactly those entries.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import PQueue from 'p-queue';
import { resolveConfigSource, type ConfigSource } from '../config.js';
import { createCacheStore } from '../build.js';
import type { CacheStore, ChannelDayKey } from '../cache/types.js';
import { dayRange, toDayString, addDays } from '../core/days.js';
import { emitter, type Reporter } from '../core/events.js';
import { compressor, type CompressionFormat } from '../core/output.js';
import { resolveSites } from '../grabber/channels.js';
import type { AnySiteConfig, GrabberChannel } from '../grabber/types.js';
import { generateGuide } from '../merge/guide.js';
import type { BuildGuideOptions } from '../merge/types.js';

/** Where the guide is served from when nothing says otherwise. */
export const DEFAULT_SERVE_PATH = '/guide.xml';

export const DEFAULT_SERVE_PORT = 8080;

/**
 * Loopback, deliberately.
 *
 * A guide is not a secret, but which sites you grab and which channels you
 * watch is not nothing — and a command that put an HTTP server on every
 * interface because the flag was left off would be the wrong default to have
 * chosen once. `--host 0.0.0.0` is one word, and is a decision.
 */
export const DEFAULT_SERVE_HOST = '127.0.0.1';

/**
 * How long a fingerprint stands before it is worked out again.
 *
 * Not a cache of the answer so much as a collapse of bursts: a client that
 * sends `HEAD` and then `GET`, two consumers polling on the same cron minute,
 * a browser revalidating a subresource. A poll a minute apart pays for its own
 * sweep, which is the intent — the point is not to skip the check but to make
 * it much cheaper than the merge it avoids.
 */
export const DEFAULT_REVALIDATE_MS = 1000;

/** How many guides are generated at once, when nothing says. */
const DEFAULT_CONCURRENCY = 2;

export interface ServeOptions {
  port?: number;
  /** Defaults to `127.0.0.1` — see {@link DEFAULT_SERVE_HOST}. */
  host?: string;
  /** The one path that answers with a guide. Defaults to `/guide.xml`. */
  path?: string;
  /**
   * How many guides may be generated at once. Defaults to 2.
   *
   * A slot is held for as long as the response takes, a slow consumer included,
   * which is the point: a merge reads the whole cache, and a burst of polls
   * that each started one would turn a cheap poll into the most expensive thing
   * the machine does.
   */
  concurrency?: number;
  /** See {@link DEFAULT_REVALIDATE_MS}. */
  revalidateMs?: number;
  /**
   * What to compress a served guide with, when the client accepts it.
   *
   * Defaults to `'gzip'`: every consumer understands it, and on a guide it is
   * within a few seconds of what brotli costs at the quality this package would
   * pick. `false` never compresses. Whatever is chosen is only used when the
   * request's `Accept-Encoding` names it.
   */
  compress?: CompressionFormat | false;
  /** Stop serving. The returned promise resolves once the server has closed. */
  signal?: AbortSignal;
  reporter?: Reporter;
  now?: Date;
  /** Shift the window, as a run's `offset` does. */
  offset?: number;
  /**
   * A cache to serve from, rather than the one the config describes.
   *
   * It stays the caller's, as it does for a run: nothing here closes what it
   * did not open.
   */
  cache?: CacheStore;
}

export interface GuideServer {
  /** Where it is listening, with the path — what to hand a consumer. */
  url: string;
  port: number;
  /** Stop listening and let go of the cache, if this opened one. */
  close(): Promise<void>;
  /** Resolves when it has stopped, however it was stopped. */
  closed: Promise<void>;
}

/** What the cache says the guide would be, without generating it. */
interface Fingerprint {
  etag: string;
  /** The newest `grabbedAt` in the window, to the second. */
  lastModified: Date;
}

/**
 * The channel-days a guide is made of — the same grid the merge will read.
 *
 * Which is why the sites are resolved once and kept: `generateGuide` resolves
 * its own otherwise, and a site whose `channels` is a function would make a
 * request on every poll.
 */
function keysFor(sites: AnySiteConfig[], days: string[]): ChannelDayKey[] {
  const keys: ChannelDayKey[] = [];

  for (const site of sites) {
    for (const channel of site.channels as GrabberChannel[]) {
      for (const day of days) {
        keys.push({ site: site.site, channelId: channel.xmltvId, day });
      }
    }
  }

  return keys;
}

/**
 * Read the window's metadata and say what it amounts to.
 *
 * Metadata only — no payloads, no parsing, no serializing. That is the whole
 * economy of the thing: this is the same number of cache lookups the merge
 * begins with, and none of the work that follows them.
 */
async function fingerprintOf(
  cache: CacheStore,
  keys: ChannelDayKey[],
  window: string,
): Promise<Fingerprint> {
  const metas = await cache.getMetas(keys);
  let newest = 0;
  let present = 0;

  for (const meta of metas) {
    if (meta === undefined) {
      continue;
    }

    present++;
    const at = Date.parse(meta.grabbedAt);

    if (Number.isFinite(at) && at > newest) {
      newest = at;
    }
  }

  // Truncated to the second, because `Last-Modified` has no more than that and
  // the two must agree: a validator finer than the header it travels in would
  // make every conditional request a miss.
  const lastModified = new Date(Math.floor(newest / 1000) * 1000);

  // Weak, because two responses that mean the same guide are not required to be
  // byte-identical — a different `Accept-Encoding` alone changes the bytes.
  return { etag: `W/"${present}-${newest}-${window}"`, lastModified };
}

/** Whether the client already has this, by either validator. */
function unchanged(request: IncomingMessage, print: Fingerprint): boolean {
  const noneMatch = request.headers['if-none-match'];

  if (noneMatch !== undefined) {
    // Whatever else it holds, the client is entitled to send back several, and
    // `*` means "anything you have". Weak comparison is the only one defined
    // for a conditional GET, so both sides lose their `W/` before matching.
    const weak = (tag: string): string => tag.trim().replace(/^W\//, '');
    const mine = weak(print.etag);

    return noneMatch.split(',').some((tag) => tag.trim() === '*' || weak(tag) === mine);
  }

  const since = request.headers['if-modified-since'];

  if (since !== undefined) {
    const asked = Date.parse(since);

    // Not `>=` by accident: the header means "if it changed after this", and
    // both sides are already whole seconds.
    return Number.isFinite(asked) && print.lastModified.getTime() <= asked;
  }

  return false;
}

/** The format to answer in, if the client accepts one we would use. */
function encodingFor(
  request: IncomingMessage,
  compress: CompressionFormat | false,
): CompressionFormat | undefined {
  if (compress === false) {
    return undefined;
  }

  const accepted = String(request.headers['accept-encoding'] ?? '')
    .split(',')
    .map((part) => part.split(';')[0]!.trim().toLowerCase());

  const name = compress === 'brotli' ? 'br' : compress === 'zstd' ? 'zstd' : 'gzip';

  return accepted.includes(name) || accepted.includes('*') ? compress : undefined;
}

/**
 * Serve the guide a config describes.
 *
 * Resolves once it is listening; the guide itself is generated per request, and
 * never held in memory — `generateGuide` streams into the response, so what the
 * server needs is flat in the size of the guide however large it is.
 */
export async function serveGuide(
  source: ConfigSource,
  options: ServeOptions = {},
): Promise<GuideServer> {
  const config = await resolveConfigSource(source);
  const emit = emitter(options);
  const path = options.path ?? config.serve?.path ?? DEFAULT_SERVE_PATH;
  const compress = options.compress ?? config.serve?.compress ?? 'gzip';
  const revalidateMs = options.revalidateMs ?? DEFAULT_REVALIDATE_MS;

  const opened = options.cache === undefined;
  const cache = options.cache ?? (await createCacheStore(config, options.signal));

  /**
   * What the cache amounted to when it was last looked at, and the channel
   * lists that grid was built from.
   *
   * The two travel together on purpose. They were once separate, and the bug
   * that produced is worth remembering: invalidating the sites on a changed
   * fingerprint left the very request that noticed the change serving a guide
   * with no channels in it — an empty document, exactly once, immediately after
   * every grab, which is the moment a consumer is most likely to be asking.
   */
  interface Snapshot {
    print: Fingerprint;
    sites: AnySiteConfig[];
  }

  let snapshot: Snapshot | undefined;
  let checkedAt = 0;
  let inFlight: Promise<Snapshot> | undefined;

  const windowOf = (now: Date): { days: string[]; startDay: string; id: string } => {
    const today = toDayString(now);
    const startDay = options.offset ? addDays(today, options.offset) : today;
    const days = [...dayRange(startDay, config.days ?? 7)];

    return { days, startDay, id: `${startDay}+${days.length}` };
  };

  /** One reading of the cache: the sites it is keyed by, and what it amounts to. */
  const take = async (now: Date, known?: AnySiteConfig[]): Promise<Snapshot> => {
    const window = windowOf(now);
    const sites =
      known ??
      (await resolveSites(config.sites, {
        ...(config.siteConcurrency !== undefined ? { concurrency: config.siteConcurrency } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        store: cache,
        now,
      }));

    return { print: await fingerprintOf(cache, keysFor(sites, window.days), window.id), sites };
  };

  /**
   * What the cache amounts to now — read at most once per `revalidateMs`, and
   * by one caller at a time.
   *
   * The `inFlight` promise is the part that matters under load: without it, ten
   * polls arriving together would each sweep the same thousands of keys, which
   * is the storm this whole design exists to avoid.
   */
  const current = async (now: Date): Promise<Snapshot> => {
    if (snapshot !== undefined && Date.now() - checkedAt < revalidateMs) {
      return snapshot;
    }

    inFlight ??= (async () => {
      // Over the grid already in hand: a channel list only changes when a grab
      // has been, and a grab is exactly what the fingerprint detects.
      const next = await take(now, snapshot?.sites);

      // And if it has been, the list may have changed with it — so the sites
      // are resolved again *now*, and the fingerprint taken over what results,
      // rather than leaving this request with a grid that is out of date.
      const fresh =
        snapshot !== undefined && next.print.etag !== snapshot.print.etag ? await take(now) : next;

      snapshot = fresh;
      checkedAt = Date.now();

      return fresh;
    })().finally(() => {
      inFlight = undefined;
    });

    return inFlight;
  };

  const guides = new PQueue({
    concurrency: Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY),
  });

  const guideOptions = (now: Date, sites: AnySiteConfig[]): BuildGuideOptions => {
    const window = windowOf(now);

    return {
      sites,
      cache,
      startDay: window.startDay,
      now,
      ...(config.days !== undefined ? { days: config.days } : {}),
      ...(config.siteConcurrency !== undefined ? { siteConcurrency: config.siteConcurrency } : {}),
      ...(config.localConcurrency !== undefined ? { readAhead: config.localConcurrency } : {}),
      ...(config.merge ? { merge: config.merge } : {}),
      ...(config.meta ? { meta: config.meta } : {}),
      ...(config.indent !== undefined ? { indent: config.indent } : {}),
      ...(config.extensions !== undefined ? { extensions: config.extensions } : {}),
    };
  };

  const server = createServer((request, response) => {
    void answer(request, response);
  });

  async function answer(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const began = Date.now();
    const url = request.url ?? '/';
    const [requestPath] = url.split('?') as [string];

    const done = (status: number): void => {
      emit({
        type: 'serve:response',
        method: request.method ?? 'GET',
        path: requestPath,
        status,
        ms: Date.now() - began,
      });
    };

    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { allow: 'GET, HEAD' }).end();

        return done(405);
      }

      if (requestPath !== path) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found\n');

        return done(404);
      }

      const now = options.now ?? new Date();
      const { print: fingerprint, sites } = await current(now);

      /** What is true of the guide whether or not a body goes with it. */
      const validators: Record<string, string> = {
        etag: fingerprint.etag,
        'last-modified': fingerprint.lastModified.toUTCString(),
        // "Use it, but ask first" — which is exactly what a poller should do,
        // and what makes the 304 below possible at all.
        'cache-control': 'no-cache',
        vary: 'Accept-Encoding',
      };

      if (unchanged(request, fingerprint)) {
        // The validators and nothing else: a 304 sends no body, so a
        // `content-type` on it would be describing something that is not there.
        response.writeHead(304, validators).end();

        return done(304);
      }

      const encoding = encodingFor(request, compress);
      const headers: Record<string, string> = {
        ...validators,
        'content-type': 'application/xml; charset=utf-8',
        ...(encoding === undefined
          ? {}
          : { 'content-encoding': encoding === 'brotli' ? 'br' : encoding }),
      };

      if (request.method === 'HEAD') {
        response.writeHead(200, headers).end();

        return done(200);
      }

      // A slot for the whole response, so a burst of polls cannot each start a
      // merge — and taken only now, after the cheap answers have been given.
      await guides.add(async () => {
        // The client going away is what stops the merge: a generator abandoned
        // half way is a merge that carries on reading the cache for a guide
        // nobody is left to receive.
        const gone = new AbortController();

        response.on('close', () => {
          if (!response.writableEnded) {
            gone.abort(new Error('the client closed the connection'));
          }
        });

        response.writeHead(200, headers);

        const guide = generateGuide({ ...guideOptions(now, sites), signal: gone.signal });
        const chain =
          encoding === undefined
            ? ([Readable.from(guide), response] as const)
            : ([Readable.from(guide), compressor(encoding), response] as const);

        await pipeline(chain, { signal: gone.signal });
      });

      done(200);
    } catch (error) {
      emit({ type: 'serve:failed', path: requestPath, error });

      if (!response.headersSent) {
        response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end('Failed\n');
      } else {
        // Part of a guide has already gone out, and there is no way to unsay
        // it: destroying the socket is what tells a consumer the document it
        // received is not whole, which a clean end would not.
        response.destroy();
      }

      done(500);
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(
      options.port ?? config.serve?.port ?? DEFAULT_SERVE_PORT,
      options.host ?? config.serve?.host ?? DEFAULT_SERVE_HOST,
      () => {
        server.removeListener('error', reject);
        resolve();
      },
    );
  });

  const address = server.address() as AddressInfo;
  const host = address.address === '::' ? '[::]' : address.address;
  const url = `http://${host}:${address.port}${path}`;

  let closing: Promise<void> | undefined;

  const close = async (): Promise<void> => {
    closing ??= (async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });

      // Every open connection, not just the idle ones: a consumer part way
      // through a guide would otherwise hold the process open for as long as it
      // took to finish reading one nobody is waiting for.
      server.closeAllConnections();
      guides.clear();

      if (opened) {
        await cache.close();
      }

      emit({ type: 'serve:stopped' });
    })();

    return closing;
  };

  options.signal?.addEventListener('abort', () => void close(), { once: true });

  emit({ type: 'serve:started', url });

  return {
    url,
    port: address.port,
    close,
    closed: new Promise<void>((resolve) => {
      server.once('close', () => resolve());
    }),
  };
}

export type { EpgServeConfig } from './config.js';
