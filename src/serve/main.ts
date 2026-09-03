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

/**
 * How long a resolved channel list is kept before it is asked for again.
 *
 * Much longer than {@link DEFAULT_REVALIDATE_MS} on purpose. Rereading the
 * cache's metadata is cheap and happens per second; resolving the *sites* can
 * mean a request per site, so a poll must never drive one. Between the two, a
 * changed fingerprint still re-resolves immediately — this is only the floor
 * under the case the fingerprint cannot see, a grab that adds a channel and
 * touches nothing already in the grid.
 */
export const DEFAULT_SITES_MAX_AGE_MS = 10 * 60 * 1000;

/** How many guides are generated at once, when nothing says. */
const DEFAULT_CONCURRENCY = 2;

/**
 * How long an idle connection is held open, and how long a request's headers
 * may take — both well above what a reverse proxy in front of this is likely
 * to use.
 *
 * Node's own default is five seconds, which is *below* the sixty a proxy such
 * as nginx or Traefik keeps by default. That ordering is the whole problem: the
 * proxy believes a pooled socket is still good, sends a request down it at the
 * moment Node is tearing it down, and the client sees an occasional `502` that
 * reproduces for nobody. Holding longer than whatever is in front means the
 * proxy is always the one to decide a connection is finished.
 *
 * The headers timeout sits a second above the keep-alive, as Node's own docs
 * advise, so that a connection at the very end of its life is not cut off
 * mid-request-line.
 */
export const DEFAULT_KEEP_ALIVE_MS = 65_000;

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
  /** See {@link DEFAULT_SITES_MAX_AGE_MS}. */
  sitesMaxAgeMs?: number;
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
  /** See {@link DEFAULT_KEEP_ALIVE_MS}. Raise it above whatever proxies this. */
  keepAliveMs?: number;
  /**
   * Let a browser read the guide, by naming who may: `true` for any origin, or
   * one origin to allow it alone. Off by default.
   *
   * Off, because loopback is not the boundary it looks like. A page in a
   * browser on this machine can reach `127.0.0.1`, so `true` lets any site the
   * viewer happens to open read which channels they watch — the same thing
   * {@link DEFAULT_SERVE_HOST} declines to publish. It is a fair trade for a
   * dashboard you wrote, and one to make on purpose.
   *
   * Turning it on does the whole job rather than the one header: `OPTIONS` is
   * answered, `If-None-Match` and `If-Modified-Since` are allowed through, and
   * `ETag` is exposed — without which a browser cannot read the validator and
   * the conditional GET this server exists for does not happen.
   */
  cors?: boolean | string;
  /** Stop serving. The returned promise resolves once the server has closed. */
  signal?: AbortSignal;
  /**
   * Where a `'reload'` event means {@link GuideServer.reload}.
   *
   * The repeatable counterpart to {@link signal}, which fires once and is over:
   * an `EventTarget` can say the same thing again next week, which is what a
   * server that outlives its own start needs. The `epg` bin points `SIGHUP` at
   * one.
   *
   * The listener calls `preventDefault()`, which is how a caller dispatching a
   * cancelable event learns the reload was taken by someone.
   */
  reloadOn?: EventTarget;
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
  /**
   * Resolve the channel lists again on the next poll, whatever the clocks say.
   *
   * The ceiling under {@link ServeOptions.sitesMaxAgeMs} is a guess at how long
   * a new channel may stay invisible; this is the operator saying they know.
   * The `epg` bin wires `SIGHUP` to it, which is the shape a long-lived server
   * usually takes: `kill -HUP` after adding a channel, rather than waiting out
   * a timer or restarting.
   *
   * Lazy on purpose — it marks, and the next request does the work. There is no
   * consumer to serve in between, and doing it eagerly would make a signal cost
   * a request per site whether or not anyone was still asking.
   */
  reload(): void;
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

/**
 * What a browser needs to be allowed to read the guide, or nothing at all.
 *
 * `Vary: Origin` goes with a named origin because the answer then depends on
 * who asked, and a cache in between must not hand one origin's response to
 * another. `*` is the same for everybody, so it does not.
 */
function corsHeaders(cors: boolean | string): Record<string, string> {
  if (cors === false) {
    return {};
  }

  const origin = cors === true ? '*' : cors;

  return {
    'access-control-allow-origin': origin,
    // Without this a browser hides the validator from the page, and a
    // conditional GET — the entire point of this server — cannot be made.
    'access-control-expose-headers': 'ETag, Last-Modified',
    ...(origin === '*' ? {} : { vary: 'Accept-Encoding, Origin' }),
  };
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

  // `gzip;q=0` is a refusal, not an offer — the token alone would read it as
  // the opposite of what it says.
  const accepted = new Set(
    String(request.headers['accept-encoding'] ?? '')
      .split(',')
      .map((part) => {
        const [token, ...params] = part.split(';');
        const q = params.map((p) => /^\s*q=([\d.]+)\s*$/i.exec(p)).find((match) => match !== null);

        return q !== undefined && Number.parseFloat(q[1]!) === 0
          ? undefined
          : token!.trim().toLowerCase();
      })
      .filter((name) => name !== undefined && name !== ''),
  );

  const name = compress === 'brotli' ? 'br' : compress === 'zstd' ? 'zstd' : 'gzip';

  return accepted.has(name) || accepted.has('*') ? compress : undefined;
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
  const cors = options.cors ?? config.serve?.cors ?? false;
  const sitesMaxAgeMs = options.sitesMaxAgeMs ?? DEFAULT_SITES_MAX_AGE_MS;

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
  let resolvedAt = 0;
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
      // Over the grid already in hand: a channel list mostly changes when a
      // grab has been, and a grab is what the fingerprint detects.
      //
      // Mostly, not always — which is the second condition. A grab that adds a
      // channel and refreshes nothing else touches no key the held grid names,
      // so the fingerprint over that grid is identical and the new channel
      // would stay invisible until the day window rolled at midnight. Ageing
      // the grid out puts a ceiling on that, without letting a poll drive a
      // request the way resolving on every revalidation would.
      const held = snapshot;
      const stale = held === undefined || Date.now() - resolvedAt >= sitesMaxAgeMs;
      const next = stale ? await take(now) : await take(now, held.sites);

      // And if a grab has been, the list may have changed with it — so the
      // sites are resolved again *now*, and the fingerprint taken over what
      // results, rather than leaving this request with a grid that is out of
      // date.
      const fresh =
        !stale && held !== undefined && next.print.etag !== held.print.etag
          ? await take(now)
          : next;

      snapshot = fresh;
      checkedAt = Date.now();

      if (fresh !== next || stale) {
        resolvedAt = checkedAt;
      }

      return fresh;
    })().finally(() => {
      inFlight = undefined;
    });

    return inFlight;
  };

  /** Taken rather than ignored, which is what tells the bin not to fall back. */
  const onReload = (event: Event): void => {
    event.preventDefault();
    reload();
  };

  /** See {@link GuideServer.reload}. */
  const reload = (): void => {
    // Both clocks, and nothing else. What is held stays the answer until the
    // next poll asks for one, and if resolving then finds the same channels the
    // fingerprint is the same and a poller still gets its 304 — a reload asks a
    // question rather than asserting that anything changed. Dropping the
    // snapshot instead would turn every stray signal into a full re-send.
    resolvedAt = 0;
    checkedAt = 0;
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

  // See DEFAULT_KEEP_ALIVE_MS: above whatever is in front of this, so the proxy
  // is always the one that decides a pooled connection is finished.
  server.keepAliveTimeout = Math.max(0, options.keepAliveMs ?? DEFAULT_KEEP_ALIVE_MS);
  server.headersTimeout = server.keepAliveTimeout + 1000;

  async function answer(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const began = Date.now();
    const url = request.url ?? '/';
    const [requestPath] = url.split('?') as [string];
    /**
     * What stops the guide when the consumer goes away, kept in scope so the
     * `catch` can tell that apart from a fault.
     *
     * Asked of the signal rather than of the error, because the error is
     * whichever of several won a race: the pipeline's own `AbortError` usually,
     * but a write to a socket the client already destroyed can arrive first as
     * an `EPIPE` or a premature close. The signal is the one thing that says it
     * was *our* abort.
     */
    let gone: AbortController | undefined;

    const done = (status: number): void => {
      emit({
        type: 'serve:response',
        method: request.method ?? 'GET',
        path: requestPath,
        status,
        ms: Date.now() - began,
      });
    };

    const allowed = corsHeaders(cors);

    try {
      // A browser asks before it fetches, whenever the fetch carries a header
      // that is not on the safelist — `If-None-Match` is not, so every
      // conditional GET from a page begins here.
      if (cors !== false && request.method === 'OPTIONS') {
        response
          .writeHead(204, {
            ...allowed,
            'access-control-allow-methods': 'GET, HEAD, OPTIONS',
            'access-control-allow-headers': 'If-None-Match, If-Modified-Since',
            'access-control-max-age': '86400',
          })
          .end();

        return done(204);
      }

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response
          .writeHead(405, { allow: cors === false ? 'GET, HEAD' : 'GET, HEAD, OPTIONS' })
          .end();

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
        // In the validators rather than beside them, so a 304 carries it too:
        // a browser refused the headers on a revalidation would treat every
        // conditional poll as a failure.
        ...allowed,
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
        const stops = new AbortController();

        gone = stops;

        response.on('close', () => {
          if (!response.writableEnded) {
            stops.abort(new Error('the client closed the connection'));
          }
        });

        response.writeHead(200, headers);

        const guide = generateGuide({ ...guideOptions(now, sites), signal: stops.signal });
        const chain =
          encoding === undefined
            ? ([Readable.from(guide), response] as const)
            : ([Readable.from(guide), compressor(encoding), response] as const);

        await pipeline(chain, { signal: stops.signal });
      });

      done(200);
    } catch (error) {
      if (gone?.signal.aborted === true) {
        // Normal, and not ours to answer for: a reader that had seen enough, a
        // proxy that timed out, a tab that closed. Calling it a failure — and
        // returning the 500 below — is how a log fills with alarms about the
        // ordinary, and how somebody ends up paged for a browser refresh.
        emit({ type: 'serve:disconnected', path: requestPath, ms: Date.now() - began });
        response.destroy();

        return;
      }

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
  // Any literal IPv6, not just the wildcard: `::1` unbracketed makes an
  // address no client can parse.
  const host = address.address.includes(':') ? `[${address.address}]` : address.address;
  const url = `http://${host}:${address.port}${path}`;

  let closing: Promise<void> | undefined;

  const close = async (): Promise<void> => {
    closing ??= (async () => {
      const shut = new Promise<void>((resolve) => {
        server.close(() => resolve());
      });

      // Every open connection, not just the idle ones: a consumer part way
      // through a guide would otherwise hold the process open for as long as it
      // took to finish reading one nobody is waiting for.
      //
      // Before the await, not after: `close` only calls back once the last
      // response has ended, so a stalled consumer would hold this promise open
      // forever and the cut-off would never be reached.
      server.closeAllConnections();

      await shut;
      guides.clear();
      // A target is the caller's and may outlive this server — one left
      // listening would hold the whole closure, cache and all.
      options.reloadOn?.removeEventListener('reload', onReload);

      if (opened) {
        await cache.close();
      }

      emit({ type: 'serve:stopped' });
    })();

    return closing;
  };

  // Listened for before anything can close, or a server stopped during its own
  // startup would leave this promise waiting on an event that has already been
  // and gone.
  const closed = new Promise<void>((resolve) => {
    server.once('close', () => resolve());
  });

  emit({ type: 'serve:started', url });

  options.reloadOn?.addEventListener('reload', onReload);

  // One or the other, because a listener answers only a signal that fires
  // *after* it is added: one already aborted never emits again, and one that
  // fired while the port was being bound has emitted already. Asking first is
  // what keeps a server from listening for good on a run that had been called
  // off, and nothing can slip between the question and the answer — there is no
  // await between them for an abort to arrive in.
  //
  // Not `listen({ signal })`, which Node offers and which looks like the
  // answer. All it does on abort is `server.close()` — the smallest quarter of
  // what stopping this means. It cuts no connection, so a consumer part way
  // through a guide holds the port open; it releases no cache; and it says
  // nothing. Two owners of one lifecycle, the lesser racing the greater.
  if (options.signal?.aborted === true) {
    await close();
  } else {
    options.signal?.addEventListener('abort', () => void close(), { once: true });
  }

  return { url, port: address.port, reload, close, closed };
}

export type { EpgServeConfig } from './config.js';
