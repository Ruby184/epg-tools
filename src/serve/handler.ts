/**
 * The guide as an answer to a request, with nothing of the transport in it.
 *
 * Everything a served guide does is here — the snapshot the whole design is
 * built around, conditional GETs, compression, the concurrency limit and the
 * scheduled grab — expressed as "this request, that answer". What a socket is
 * and how bytes reach it belongs to the adapters at the bottom of this file
 * and to `serveGuide` next door.
 *
 * Which is not an abstraction for its own sake. A guide served by `epg serve`
 * and a guide served from a route in somebody's own express or fastify app are
 * the same answer, and the only way to be sure of that is for it to be the
 * same code — the alternative is two servers that agree about ETags until the
 * day they do not.
 */

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Http2ServerRequest, Http2ServerResponse } from 'node:http2';
import type { TLSSocket } from 'node:tls';
import { Readable, pipeline as pipe } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import PQueue from 'p-queue';
import { resolveConfigSource, type ConfigSource, type EpgConfig } from '../config.js';
import { createCacheStore } from '../build.js';
import type { CacheEntryMeta, CacheStore, ChannelDayKey } from '../cache/types.js';
import { dayRange, toDayString, addDays } from '../core/days.js';
import { emitter, type Reporter, type Says } from '../core/events.js';
import { compressor, type CompressionFormat } from '../core/output.js';
import { covered, resolveSites } from '../grabber/channels.js';
import type { AnySiteConfig, GrabberChannel } from '../grabber/types.js';
import { generateGuide } from '../merge/guide.js';
import { channelSelection, configured } from '../merge/select.js';
import type { BuildGuideOptions, DerivedChannel, GuideContext } from '../merge/types.js';
import type { XmltvDocumentMeta } from '../xmltv/types.js';
import { outputOptions } from '../xmltv/serialize.js';
import type { GuideOutputOptions } from '../xmltv/serialize.js';
import type { NextGrab } from './schedule.js';

/** Where the guide is served from when nothing says otherwise. */
export const DEFAULT_SERVE_PATH = '/guide.xml';

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

/**
 * Where a health check is answered, when nothing says otherwise.
 *
 * `serve.health: false` switches it off, as `serve.path` does not — a guide has
 * to be somewhere, a health check does not have to exist.
 */
export const DEFAULT_HEALTH_PATH = '/health';

/** How many guides are generated at once, when nothing says. */
const DEFAULT_CONCURRENCY = 2;

/**
 * The shortest gap allowed *between* two scheduled grabs.
 *
 * A schedule is asked again only once a grab has finished, so a working one
 * paces itself and never reaches this. It is here for the one that does not — a
 * function that always answers with a time already past — which without a floor
 * would grab back to back for as long as the server ran.
 *
 * A second rather than a few milliseconds because a grab already costs tens of
 * them, and a floor under that throttles nothing. It is not charged to the
 * first call: a schedule asking to run at startup is asking for something it
 * cannot repeat, since there is no run behind it to loop with.
 */
const MIN_GRAB_GAP_MS = 1000;

/**
 * What answering a request for the guide takes, wherever the request came from.
 *
 * {@link ServeOptions} is this plus a socket to listen on — everything here is
 * about the answer rather than about the listening, which is what lets
 * {@link createGuideHandler} hand the same answer to an app of your own.
 */
export interface GuideHandlerOptions {
  /**
   * The one path that answers with a guide. Defaults to `/guide.xml`.
   *
   * Only the routing handler reads it — {@link GuideHandler.guide} answers
   * whatever path an app of your own sent it to.
   */
  path?: string;
  /** Where the health check answers. Defaults to `/health`; `false` is off. */
  health?: string | false;
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
  /**
   * Grab on a schedule as well as serving — see {@link EpgServeConfig.grab}.
   * Overrides the config's, as every other option here does.
   */
  grab?: NextGrab;
  /**
   * Run while stopping: after the scheduled grab has been called off and
   * before the cache is let go of.
   *
   * That is the one place a server of your own can be shut down safely — a
   * request still being answered is reading the cache this is about to close,
   * so whatever ends those requests belongs here rather than after
   * {@link GuideHandler.close} has resolved. It is where `serveGuide` closes
   * its own socket.
   */
  shutdown?: () => void | Promise<void>;
}

/**
 * What a Node request handler is handed.
 *
 * Both shapes, because HTTP/2's compatibility API is the same request in
 * everything that matters here — a method, a url, headers and a socket that
 * knows whether it is encrypted — and is nonetheless a different class. A
 * handler that takes either is one `http.createServer`,
 * `https.createServer` and `http2.createSecureServer` all accept.
 */
export type NodeRequest = IncomingMessage | Http2ServerRequest;

/** What it answers through — see {@link NodeRequest}. */
export type NodeResponse = ServerResponse | Http2ServerResponse;

/**
 * Which of the two answers a request is for.
 *
 * Named because it travels: a route decided where an app mounted the guide is
 * carried to {@link GuideHandler.answer} and read back out in `GuideRequest`.
 */
export type GuideRoute = 'guide' | 'health';

/**
 * One request, in the terms answering it actually needs.
 *
 * Node's `IncomingMessage`, a `Request`, a fastify request and whatever comes
 * next all answer these questions; none of the rest of them is used here, and
 * asking for a particular one would be the reason this could not be mounted on
 * an app of your own.
 */
export interface GuideRequest {
  /** Defaults to `GET`. */
  method?: string | undefined;
  /**
   * The url asked for, whatever the transport means by that.
   *
   * A request target — `/guide.xml?days=3`, which is what Node, express and
   * fastify all call `url` — or a whole url, which is what a `Request`
   * carries. Either way only its path is read, and only when {@link route} is
   * left out: an app that has already routed has nothing left to say with it.
   */
  url?: string | undefined;
  /**
   * Lower-cased names, as every server hands them over.
   *
   * HTTP/2's pseudo-headers belong in here too, which is where Node's
   * compatibility API puts them: `:authority` is the host a request over one
   * names, there being no `Host` header, and `:scheme` is what
   * `X-Forwarded-Proto` is over HTTP/1. Nothing needs to know which version it
   * is answering — a request over HTTP/1 carrying either is one Node has
   * already refused, `:` not being a character a header name may contain.
   */
  headers: Record<string, string | string[] | undefined>;
  /** Answer this, whatever the path says — for an app that routed already. */
  route?: GuideRoute | undefined;
  /**
   * The consumer went away.
   *
   * Aborting it stops the merge mid-document, which is the point: a generator
   * abandoned half way is a merge still reading the cache for a guide nobody
   * is left to receive.
   */
  signal?: AbortSignal | undefined;
  /**
   * Whatever the transport was handed, untouched.
   *
   * `IncomingMessage` from {@link GuideHandler.node}, a `Request` from
   * {@link GuideHandler.fetch}, and whatever a caller of
   * {@link GuideHandler.answer} puts here. Nothing in answering reads it —
   * that is the point of the fields above — but a `baseUrl` function written
   * for one particular server knows what it is mounted on, and should not have
   * to go without:
   *
   * ```ts
   * serve: { baseUrl: ({ raw }) => (raw as IncomingMessage).socket.localAddress }
   * ```
   */
  raw?: unknown;
  /**
   * Whether this request arrived over TLS, where the transport knows.
   *
   * No header can say so truthfully — `X-Forwarded-Proto` is what a proxy
   * claims — so the one thing that does know is asked for here. See
   * {@link EpgServeConfig.baseUrl}.
   */
  encrypted?: boolean | undefined;
}

/**
 * One answer, before anything has been sent.
 *
 * Nothing here has written a byte: the body is pulled by whoever is sending
 * it, so a consumer that reads slowly is a merge that runs slowly rather than
 * a guide held in memory.
 */
export interface GuideAnswer {
  status: number;
  /** Ready to send as they are — lower-cased, single values. */
  headers: Record<string, string>;
  /**
   * Absent for a `304`, a `204` and every `HEAD`.
   *
   * A string for the small answers — the health check, a 404 — and an async
   * iterable for the guide, already compressed if `content-encoding` says so.
   * Abandoning that iterable is allowed and is the cheap way to stop: it ends
   * the merge and gives back the slot it was holding.
   */
  body?: string | AsyncIterable<Uint8Array> | undefined;
}

/**
 * The half of a request a reply-shaped framework hands over — `FastifyRequest`
 * fits it, and so does anything else that names these.
 */
export interface ReplyingRequest {
  method?: string | undefined;
  url?: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  /** Node's own, where the framework keeps it — fastify calls it `raw`. */
  raw?: IncomingMessage | undefined;
}

/**
 * The half of a reply this writes through — `FastifyReply` fits it.
 *
 * Writing through the framework rather than around it is the whole point:
 * `reply.raw` works and is what `node()` would take, but a reply hijacked that
 * way leaves every `onSend` and `onResponse` hook unrun, and a plugin that
 * logs, times or counts responses stops seeing the guide at all.
 */
export interface Replying {
  status(code: number): Replying;
  headers(values: Record<string, string>): Replying;
  send(payload?: unknown): unknown;
  /** Only to know when the consumer went away, never to write to. */
  raw: ServerResponse;
}

/**
 * The guide, ready to answer requests, for an app that is already listening.
 *
 * `serveGuide` is this plus a socket. Mounting it instead gives you the same
 * guide on a server of your own, with the same ETags, the same snapshot and
 * the same scheduled grab:
 *
 * ```ts
 * const handler = await createGuideHandler(config, { grab: grabEvery('4h') });
 *
 * app.get(handler.guidePath, handler.node('guide'));              // express, fastify, http
 * hono.get('/epg.xml', (c) => handler.fetch('guide')(c.req.raw)); // a fetch-style app
 *
 * await handler.close();                                          // when the app stops
 * ```
 */
export interface GuideHandler {
  /**
   * What to answer one request with — the whole of this, in one call.
   *
   * Never rejects: a failure is a `500` with the reason already reported,
   * since a caller that has to decide what a thrown merge means is a caller
   * reimplementing this.
   */
  answer(request: GuideRequest): Promise<GuideAnswer>;
  /**
   * Build a Node request handler — what express, fastify and `http` itself all
   * take. Express passes these objects as they are; fastify has them as
   * `request.raw` and `reply.raw`.
   *
   * Given a route it answers that one wherever it is mounted, which is how the
   * guide ends up at a path of your app's choosing:
   *
   * ```ts
   * app.get('/epg.xml', handler.node('guide'));
   * app.get('/healthz', handler.node('health'));
   * ```
   *
   * Given nothing it routes by path instead, answering
   * {@link GuideHandler.guidePath} with the guide,
   * {@link GuideHandler.healthPath} with the health check and anything else
   * with a 404 — which is what makes `createServer(handler.node())` a whole
   * server, and what makes `app.use(handler.node())` wrong for an app that has
   * routes of its own.
   *
   * A handler rather than a method on purpose: a framework calls what it is
   * given with whatever arguments it likes — express's third is `next` — and a
   * route named when it is mounted cannot be mistaken for one of those.
   */
  node(route?: GuideRoute): (request: NodeRequest, response: NodeResponse) => Promise<void>;
  /** The same for a fetch-style app — hono, elysia, bun, a worker. */
  fetch(route?: GuideRoute): (request: Request) => Promise<Response>;
  /**
   * The same for fastify, written through the reply rather than around it:
   *
   * ```ts
   * app.get(handler.guidePath, handler.fastify('guide'));
   * ```
   *
   * `node()` over `request.raw`/`reply.raw` works too, but only after
   * `reply.hijack()` — and a hijacked reply runs none of fastify's `onSend` or
   * `onResponse` hooks, so a plugin that logs, times or counts responses stops
   * seeing the guide. This hands fastify the status, the headers and the body
   * and lets it do what it does with them.
   *
   * Compression is this package's by then: the answer is already encoded and
   * says so, so set `serve.compress: false` if the app compresses for itself.
   */
  fastify(route?: GuideRoute): (request: ReplyingRequest, reply: Replying) => Promise<unknown>;
  /** Where the guide answers when it routes for itself — `serve.path`. */
  readonly guidePath: string;
  /** Where the health check answers, or `false` — `serve.health`. */
  readonly healthPath: string | false;
  /** The config this resolved, so an app can read what it is serving. */
  readonly config: EpgConfig;
  /**
   * Resolve the channel lists again on the next request, whatever the clocks
   * say — see {@link GuideServer.reload}.
   */
  reload(): void;
  /**
   * Stop the scheduled grab and let go of the cache, if this opened one.
   *
   * An app that mounts this has to call it: a handler left open holds a cache,
   * and with a schedule a timer that keeps the process alive. Idempotent, and
   * {@link GuideHandlerOptions.shutdown} is where ending the requests still in
   * flight belongs.
   */
  close(): Promise<void>;
}

/** What the cache says the guide would be, without generating it. */
interface Fingerprint {
  etag: string;
  /** The newest `grabbedAt` in the window, to the second. */
  lastModified: Date;
  /**
   * How many of the window's channel-days the cache actually holds, against how
   * many it would hold if every site had answered for every day.
   *
   * Counted here because the sweep has them in hand and nothing else does — and
   * a share is the one thing a health check can say about a guide without
   * generating it. See {@link ServeOptions.health}.
   */
  present: number;
  expected: number;
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
 * How many channel-days go in one question to the cache, and how many of those
 * questions are asked at once.
 *
 * A batch is one piece of work by the store's own contract, and the *caller* is
 * what decides how many to have in flight — precisely so a store cannot
 * multiply somebody else's bound into a descriptor storm. This is that
 * decision, made here because this is the caller holding thousands of keys: a
 * grab asks about one channel's window at a time, a dozen keys, and has nothing
 * to gain from it.
 *
 * Measured over 3,500 channel-days, five rounds, median: **384ms** as a single
 * question against **228ms** at 64 × 8. The floor is per-file syscall cost
 * rather than the thread pool — `UV_THREADPOOL_SIZE=16` barely moves it — which
 * is why the win here is modest and why the real answer for a served guide is
 * the sqlite driver, where the same sweep is one query and **32ms**.
 */
const SWEEP_KEYS_PER_ASK = 64;

const SWEEP_ASKS_IN_FLIGHT = 8;

/** Every key's metadata, asked for in bounded batches. */
async function metasOf(
  cache: CacheStore,
  keys: ChannelDayKey[],
): Promise<Array<CacheEntryMeta | undefined>> {
  if (keys.length <= SWEEP_KEYS_PER_ASK) {
    return cache.getMetas(keys);
  }

  const asks: ChannelDayKey[][] = [];

  for (let at = 0; at < keys.length; at += SWEEP_KEYS_PER_ASK) {
    asks.push(keys.slice(at, at + SWEEP_KEYS_PER_ASK));
  }

  const found: Array<Array<CacheEntryMeta | undefined>> = Array.from({ length: asks.length });
  let next = 0;

  // Workers over a shared cursor rather than one promise per batch: what is
  // bounded is how many are in flight, not how many there are. Each writes to
  // its own slot, so the answers come back in the order they were asked.
  await Promise.all(
    Array.from({ length: Math.min(SWEEP_ASKS_IN_FLIGHT, asks.length) }, async () => {
      for (let mine = next++; mine < asks.length; mine = next++) {
        found[mine] = await cache.getMetas(asks[mine]!);
      }
    }),
  );

  return found.flat();
}

/**
 * A value as a string that is the same every run for the same value.
 *
 * `JSON.stringify` will not do: object key order is insertion order, so two
 * structurally identical configs can serialize differently, and a function
 * stringifies to nothing at all — which would silently drop a category mapper
 * out of the fingerprint below.
 *
 * A function becomes its source, which is stable for a given build and changes
 * exactly when the behaviour does. Array order is kept, because for
 * `episodeNum.systems` the order *is* the meaning.
 */
function canonical(value: unknown): string {
  if (typeof value === 'function') {
    return `fn(${value.toString()})`;
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }

  if (typeof value === 'object' && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${key}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }

  return String(value);
}

/**
 * What the served document's *shape* amounts to, for the validators.
 *
 * Without this a profile is invisible to a polling consumer: the fingerprint
 * below counts cache entries and their ages, so switching profile and
 * restarting leaves the etag byte-identical and every client is told 304
 * forever. Latent for `indent` and `extensions` already; fatal for a knob whose
 * whole purpose is to be changed and observed.
 *
 * Computed once, where the options are resolved — never per request.
 */
export function outputFingerprint(options: GuideOutputOptions): string {
  // A list of extension names is a set, so its order is not part of the answer
  // — unlike everything else here.
  const extensions = Array.isArray(options.extensions)
    ? [...options.extensions].sort()
    : options.extensions;

  return createHash('sha1')
    .update(
      canonical({
        indent: options.indent,
        extensions,
        profile: options.profile,
        // A guide whose urls point somewhere else is a different guide, and a
        // base changed in the config between two runs of the server would
        // otherwise leave every poller on a validator that still matches.
        baseUrl: options.baseUrl === undefined ? undefined : String(options.baseUrl),
      }),
    )
    .digest('base64url')
    .slice(0, 10);
}

/**
 * Ends one entry's contribution to the content digest below, so the digest is a
 * run of terminated fields and an empty one means "nothing cached here".
 *
 * A character that cannot occur in either field it follows: `grabbedAt` is an
 * ISO timestamp and `programmeCount` a number, so no entry can run into the
 * next and two different windows cannot digest alike.
 */
const END_OF_ENTRY = '|';

/**
 * Read the window's metadata and say what it amounts to.
 *
 * Metadata only — no payloads, no parsing, no serializing. How much that saves
 * depends on the driver, and by more than one might guess: see
 * {@link SWEEP_KEYS_PER_ASK}.
 */
async function fingerprintOf(
  cache: CacheStore,
  keys: ChannelDayKey[],
  window: string,
  shape: string,
): Promise<Fingerprint> {
  const metas = await metasOf(cache, keys);
  /**
   * Every entry's own state, rather than the newest of them.
   *
   * The newest alone is not a validator. A grab stamps one `grabbedAt`, taken
   * once at the start, onto every entry it writes — so the maximum reaches its
   * final, post-grab value the moment the **first** entry lands, while the rest
   * of the window is still last night's. A poll in that gap would be handed a
   * half-updated guide wearing the finished grab's tag, and every poll after it
   * answered 304 against that tag until the next grab moved it: not a moment's
   * skew, a consumer pinned to half a guide for a day.
   *
   * Digesting each entry instead means the tag settles only when the content
   * does. The sweep already visits all of them, so this costs a hash and no
   * extra reads.
   */
  const content = createHash('sha1');
  let newest = 0;
  let present = 0;

  for (const meta of metas) {
    if (meta === undefined) {
      // An empty field, so the gap keeps its place — which is what carries how
      // many entries there are and which ones they were. One appearing as
      // another disappears leaves the count unmoved and only the order differs.
      content.update(END_OF_ENTRY);
      continue;
    }

    content.update(`${meta.grabbedAt}:${meta.programmeCount}${END_OF_ENTRY}`);
    present++;

    const at = Date.parse(meta.grabbedAt);

    if (Number.isFinite(at) && at > newest) {
      newest = at;
    }
  }

  // Truncated to the second, because `Last-Modified` has no more than that and
  // the two must agree: a validator finer than the header it travels in would
  // make every conditional request a miss.
  //
  // Still the newest, because a date is what this header is. It is the weaker
  // of the two validators for exactly the reason above — a client sending only
  // `If-Modified-Since` can still be told 304 mid-grab — and HTTP prefers the
  // etag whenever both are present, which is whenever this server answered.
  const lastModified = new Date(Math.floor(newest / 1000) * 1000);

  // Weak, because two responses that mean the same guide are not required to be
  // byte-identical — a different `Accept-Encoding` alone changes the bytes.
  return {
    etag: `W/"${content.digest('base64url').slice(0, 16)}-${window}-${shape}"`,
    lastModified,
    present,
    expected: metas.length,
  };
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

/**
 * The headers a base read off the request is built from.
 *
 * `Forwarded` and the `X-Forwarded-*` pair because something in front may be
 * terminating TLS or answering on another name, and `Host` because that is what
 * the request says when nothing is. Any of them changing changes the document,
 * which is what `Vary` is for.
 */
const FORWARDED = ['Host', 'X-Forwarded-Host', 'X-Forwarded-Proto', 'Forwarded'] as const;

/** One header, where it is a single value. */
const header = (request: GuideRequest, name: string): string | undefined => {
  const value = request.headers[name];

  return Array.isArray(value) ? value[0] : value;
};

/**
 * Where this request reached us, as a url to resolve the guide's own against.
 *
 * Read outermost first, because what a guide's urls should say is how the
 * *client* reached this rather than how the last hop did: what a proxy says it
 * was asked for, then what this request says about itself, then what the
 * connection underneath actually is. `https` only when something says so — a
 * server on loopback behind a proxy sees plain HTTP, and guessing the scheme
 * would write urls nobody can fetch.
 */
function requestBase(request: GuideRequest): string | undefined {
  const host =
    header(request, 'x-forwarded-host') ??
    // Before `Host`, not after: over HTTP/2 the authority is this one, there is
    // no `Host` header to speak of, and a client sending `:authority` is told
    // by RFC 9113 not to send one. Over HTTP/1 there is no `:authority` and
    // this costs a lookup.
    header(request, ':authority') ??
    header(request, 'host');

  if (host === undefined || host === '') {
    // HTTP/1.0 without a `Host`, which is allowed and leaves nothing to build
    // from. The configured base stands, as it does when there is none.
    return undefined;
  }

  // The same order, and here it is load-bearing rather than tidy: a proxy that
  // terminates TLS and forwards cleartext HTTP/2 sends `:scheme: http` with
  // `X-Forwarded-Proto: https`, and `https` is the one the client used. Last is
  // the socket, which is all there is for a handler mounted on an HTTPS server
  // of somebody's own, where nothing is claiming anything.
  //
  // Both claims are the client's word in the end — a request reaching this
  // directly can put anything in either — and both are taken for the same
  // reason: whatever terminated TLS is the only thing that knows it did.
  const proto =
    [header(request, 'x-forwarded-proto')?.split(',')[0], header(request, ':scheme')]
      .map((claimed) => claimed?.trim().toLowerCase())
      // Only the two, and never what a header merely said: an empty
      // `X-Forwarded-Proto` or a word nobody has heard of would otherwise be
      // written into a base — and `://host/` is a url that throws when the
      // guide is already half sent.
      .find((claimed) => claimed === 'http' || claimed === 'https') ??
    (request.encrypted === true ? 'https' : 'http');

  try {
    // Parsed here rather than trusted downstream, because the authority is a
    // header too: a `Host` with a space in it is a request anyone can send, and
    // the alternative to refusing it here is a 200 whose body throws.
    return `${new URL(`${proto}://${host}`).origin}/`;
  } catch {
    return undefined;
  }
}

/**
 * The path a request asked for, however its transport spells a url.
 *
 * Against a base, which is what makes one reading do for both: a request
 * target — `/guide.xml?days=3`, what Node and fastify hand over — resolves
 * against it, and a whole url, which is what a `Request` carries, ignores it.
 * Only the path decides anything here.
 */
function pathOf(url: string | undefined): string {
  try {
    return new URL(url ?? '/', 'http://request.invalid').pathname;
  } catch {
    // A target nothing can parse is one nothing routes to — `http://[` is a
    // request anyone can send, and a 404 is the answer to it rather than a
    // throw where every answer is decided.
    return url ?? '/';
  }
}

/** An etag of the same guide written for somewhere else — see `serve.baseUrl`. */
function taggedWith(etag: string, base: string): string {
  const digest = createHash('sha256').update(base).digest('base64url').slice(0, 8);

  // Inside the quotes, so it stays one opaque validator: a client compares the
  // whole string and never reads this.
  return etag.replace(/"$/, `-${digest}"`);
}

/** Whether the client already has this, by either validator. */
function unchanged(request: GuideRequest, print: Fingerprint): boolean {
  const noneMatch = header(request, 'if-none-match');

  if (noneMatch !== undefined) {
    // Whatever else it holds, the client is entitled to send back several, and
    // `*` means "anything you have". Weak comparison is the only one defined
    // for a conditional GET, so both sides lose their `W/` before matching.
    const weak = (tag: string): string => tag.trim().replace(/^W\//, '');
    const mine = weak(print.etag);

    return noneMatch.split(',').some((tag) => tag.trim() === '*' || weak(tag) === mine);
  }

  const since = header(request, 'if-modified-since');

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
  request: GuideRequest,
  compress: CompressionFormat | false,
): CompressionFormat | undefined {
  if (compress === false) {
    return undefined;
  }

  // `gzip;q=0` is a refusal, not an offer — the token alone would read it as
  // the opposite of what it says.
  const accepted = new Set(
    String(header(request, 'accept-encoding') ?? '')
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
 * Build the guide as a request handler, for a server of your own.
 *
 * Everything `serveGuide` does except the listening — it is built on this, so
 * that the guide an app serves and the guide `epg serve` serves cannot drift
 * apart. The cache is opened here, unless one is handed over, and a schedule
 * starts here, which is why {@link GuideHandler.close} is not optional.
 */
export async function createGuideHandler(
  source: ConfigSource,
  options: GuideHandlerOptions = {},
): Promise<GuideHandler> {
  const config = await resolveConfigSource(source);
  const emit = emitter(options);
  const path = options.path ?? config.serve?.path ?? DEFAULT_SERVE_PATH;
  const health = options.health ?? config.serve?.health ?? DEFAULT_HEALTH_PATH;
  const compress = options.compress ?? config.serve?.compress ?? 'gzip';
  const revalidateMs = options.revalidateMs ?? DEFAULT_REVALIDATE_MS;
  const cors = options.cors ?? config.serve?.cors ?? false;
  const sitesMaxAgeMs = options.sitesMaxAgeMs ?? DEFAULT_SITES_MAX_AGE_MS;
  const schedule = options.grab ?? config.serve?.grab;
  const declaredBase = config.serve?.baseUrl;

  /**
   * Where this request's guide says its urls are, or nothing for the config's
   * own — see `baseUrl` on the serve config.
   *
   * A function may decline by answering `undefined`, which is what makes "the
   * host that asked, except for this one caller" a line rather than a branch.
   */
  const baseFor = (request: GuideRequest): string | URL | undefined => {
    if (declaredBase === undefined) {
      return undefined;
    }

    if (declaredBase === true) {
      return requestBase(request);
    }

    return typeof declaredBase === 'function' ? declaredBase(request) : declaredBase;
  };

  /**
   * What the answer depends on besides the encoding.
   *
   * Only where the base is read off the request: a fixed one is the same
   * document for everybody, and naming headers that change nothing would cost a
   * shared cache its hit rate for no reason.
   */
  const varyOn = [
    'Accept-Encoding',
    ...(declaredBase === true || typeof declaredBase === 'function' ? FORWARDED : []),
    // What `corsHeaders` would say on its own, said here instead: this is the
    // one that goes out with the validators, and a `vary` naming only the
    // origin would let a shared cache hand one host the guide written for
    // another.
    ...(cors !== false && cors !== true ? ['Origin'] : []),
  ].join(', ');

  const opened = options.cache === undefined;
  const cache = options.cache ?? (await createCacheStore(config, options.signal));

  /** Where a `derived` function says things, which is where a merge's do. */
  const mergeSays: Says = {
    log: (message, data) => emit({ type: 'merge:note', message, ...(data ? { data } : {}) }),
    warn: (message, data) => emit({ type: 'merge:warning', message, ...(data ? { data } : {}) }),
  };

  /**
   * What the served document's shape amounts to, in the validators.
   *
   * Once, here — a config cannot change under a running server, and this is
   * the only thing the fingerprint cannot read off the cache.
   *
   * `meta` and `derived` are in it as they were *written*, not as they answer:
   * `canonical` hashes a function by its source, so changing what either one
   * says moves every validator, while a function that answers differently for
   * reasons of its own — a `date` of the moment, most obviously — does not,
   * and a poll stays the cheap thing this server exists for. A document that
   * really did change because the lineup did is caught by the fingerprint
   * instead, new channels being new keys.
   *
   * They have to be here because nothing else covers them. A changed
   * `source-info-name` is a changed document that no cache entry knows about,
   * and a derived channel has no entry of its own at all — it is written out of
   * its source's. `channels` needs no entry here: narrowing the sites changes
   * which keys are swept, which the fingerprint reads directly.
   */
  const shape = createHash('sha1')
    .update(
      canonical({
        output: outputFingerprint(outputOptions(config)),
        meta: config.meta,
        derived: config.derived,
        // Every merge option, `cover` above all: which sites a channel is
        // taken from is as much what the document says as how they are
        // combined, and neither is anything a cache key knows.
        merge: config.merge,
      }),
    )
    .digest('base64url')
    .slice(0, 10);

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
    /**
     * What `derived` declared about *these* lists.
     *
     * Resolved with the sites rather than per request, for the two reasons the
     * sites are: a function asked twice may answer twice, and a server answers
     * a poll every few seconds. So a declaration follows a lineup that changes
     * — which is the whole point of the function form — at the pace the lists
     * themselves are re-read.
     */
    derived: DerivedChannel[] | undefined;
    /**
     * What `meta` said about them, for the same reason and at the same pace.
     *
     * What it *says* is in the etag — see `shape` — but not what it answers:
     * a timestamp of its own making would otherwise move every validator on
     * every snapshot, and a poll would never be cheap again. A `meta` that
     * follows the lineup still moves the tag, the lineup being in the
     * fingerprint.
     */
    meta: XmltvDocumentMeta | undefined;
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
    const resolved =
      known ??
      // `cover` before anything is counted: a channel this run leaves to
      // another site has no entry of its own, and sweeping for one would have
      // the grid expecting what nobody was asked to grab.
      (await covered(
        await resolveSites(config.sites, {
          emit,
          ...(config.siteConcurrency !== undefined ? { concurrency: config.siteConcurrency } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
          store: cache,
          now,
        }),
        config.merge?.cover,
        { now, ...mergeSays },
      ));

    // After the lists, because a `derived` function is a function of them — and
    // the selection after that, since a shift declared here is what decides
    // whether a source nobody asked for has to be kept.
    const guideContext: GuideContext = {
      channels: resolved.flatMap((site) => site.channels as GrabberChannel[]),
      now,
      ...mergeSays,
    };
    const derived = await configured(config.derived, guideContext);
    const meta = await configured(config.meta, guideContext);
    const selection = channelSelection({
      ...(config.channels ? { channels: config.channels } : {}),
      ...(derived ? { derived } : {}),
    });
    const sites =
      selection === undefined
        ? resolved
        : resolved.map((site) => ({
            ...site,
            channels: (site.channels as GrabberChannel[]).filter((channel) =>
              selection.select.has(channel.xmltvId),
            ),
          }));

    return {
      print: await fingerprintOf(cache, keysFor(sites, window.days), window.id, shape),
      sites,
      derived: selection?.derived ?? derived,
      meta,
    };
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

  const guideOptions = (
    now: Date,
    sites: AnySiteConfig[],
    /**
     * What the snapshot resolved `derived` to — a list, however the config
     * spelled it, so a function is asked once per snapshot rather than once per
     * request. A poll every few seconds is not a reason to ask again what the
     * lineup should be shifted into.
     */
    derived: DerivedChannel[] | undefined,
    /** Likewise what `meta` answered for them — see {@link Snapshot.meta}. */
    meta: XmltvDocumentMeta | undefined,
  ): BuildGuideOptions => {
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
      ...(derived ? { derived } : {}),
      ...(config.channels ? { channels: config.channels } : {}),
      ...(meta ? { meta } : {}),
      ...outputOptions(config),
    };
  };

  /**
   * What to answer one request with.
   *
   * In the order the answers get more expensive: the ones a method or a path
   * decides, then the health check, then the validators — and only a request
   * that got past all of those is worth a guide. Nothing here writes a byte,
   * and the body is a generator, so the merge does not begin until whoever is
   * sending the answer asks for its first chunk.
   */
  const answer = async (request: GuideRequest): Promise<GuideAnswer> => {
    const began = Date.now();
    const method = request.method ?? 'GET';
    const requestPath = pathOf(request.url);

    const done = (status: number): void => {
      emit({ type: 'serve:response', method, path: requestPath, status, ms: Date.now() - began });
    };

    const allowed = corsHeaders(cors);

    try {
      // A browser asks before it fetches, whenever the fetch carries a header
      // that is not on the safelist — `If-None-Match` is not, so every
      // conditional GET from a page begins here.
      if (cors !== false && method === 'OPTIONS') {
        done(204);

        return {
          status: 204,
          headers: {
            ...allowed,
            'access-control-allow-methods': 'GET, HEAD, OPTIONS',
            'access-control-allow-headers': 'If-None-Match, If-Modified-Since',
            'access-control-max-age': '86400',
          },
        };
      }

      if (method !== 'GET' && method !== 'HEAD') {
        done(405);

        return {
          status: 405,
          headers: { allow: cors === false ? 'GET, HEAD' : 'GET, HEAD, OPTIONS' },
        };
      }

      // An app that routed this itself has already said which answer it wants,
      // and is not asked to spell its paths the way this one does.
      const route = request.route ?? routeFor(requestPath);

      if (route === 'none') {
        done(404);

        return {
          status: 404,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
          body: 'Not found\n',
        };
      }

      // One reading of the clock, not two: the window and the sweep that counts
      // it must be the same window, and two `new Date()` either side of
      // midnight would not be.
      const now = options.now ?? new Date();

      if (route === 'health') {
        // `current` rather than a stored snapshot: a server whose only traffic
        // is its own health check would otherwise never take one and would
        // report unhealthy for as long as it ran. It is throttled and
        // single-flighted, and reads metadata only.
        const { print } = await current(now);
        const window = windowOf(now);
        // The one unambiguous "cannot do its job": nothing at all is cached, so
        // there is no guide to serve. How stale is too stale is the operator's
        // judgement and not this server's, so age is reported and not ruled on.
        const ok = print.present > 0;
        const body = `${JSON.stringify(
          {
            ok,
            // Not 1970: with nothing cached the newest `grabbedAt` is zero, and
            // a date is a worse answer than saying there is none.
            grabbedAt: ok ? print.lastModified.toISOString() : null,
            ageSeconds: ok
              ? Math.max(0, Math.round((now.getTime() - print.lastModified.getTime()) / 1000))
              : null,
            window: { startDay: window.startDay, days: window.days.length },
            // Coverage, not a bare count — the share of the grid that answered
            // is the thing worth alerting on, and the sweep has both numbers.
            counts: { present: print.present, expected: print.expected },
            // No site or channel names, which is the same line
            // `DEFAULT_SERVE_HOST` draws. Aggregates only.
            shape,
          },
          undefined,
          2,
        )}\n`;

        done(ok ? 200 : 503);

        return {
          status: ok ? 200 : 503,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            // No etag and no compression: the body changes every second by
            // construction, so a validator would never match and a few hundred
            // bytes are not worth a compressor.
            'cache-control': 'no-store',
            'content-length': String(Buffer.byteLength(body)),
            ...allowed,
          },
          // HEAD reaches here too, the method gate being above the routing —
          // and a body on one is a protocol error, not a waste.
          ...(method === 'HEAD' ? {} : { body }),
        };
      }

      const { print: snapshot, sites, derived, meta } = await current(now);
      // Where this document says its urls are, which may be read off this very
      // request — see `baseUrl` on the serve config.
      const base = baseFor(request);
      const fingerprint =
        base === undefined
          ? snapshot
          : // In the etag, because it is in the document: two hosts are served
            // two guides, and a consumer polling with the other one's validator
            // has to be told it changed.
            { ...snapshot, etag: taggedWith(snapshot.etag, String(base)) };

      /** What is true of the guide whether or not a body goes with it. */
      const validators: Record<string, string> = {
        etag: fingerprint.etag,
        'last-modified': fingerprint.lastModified.toUTCString(),
        // "Use it, but ask first" — which is exactly what a poller should do,
        // and what makes the 304 below possible at all.
        'cache-control': 'no-cache',
        // In the validators rather than beside them, so a 304 carries it too:
        // a browser refused the headers on a revalidation would treat every
        // conditional poll as a failure.
        ...allowed,
        // After them, not before: `corsHeaders` names `Origin` for an allowed
        // origin, and whatever a per-request base was read from has to be in
        // here too — `varyOn` is the one that carries both.
        vary: varyOn,
      };

      if (unchanged(request, fingerprint)) {
        done(304);

        // The validators and nothing else: a 304 sends no body, so a
        // `content-type` on it would be describing something that is not there.
        return { status: 304, headers: validators };
      }

      const encoding = encodingFor(request, compress);
      const headers: Record<string, string> = {
        ...validators,
        'content-type': 'application/xml; charset=utf-8',
        ...(encoding === undefined
          ? {}
          : { 'content-encoding': encoding === 'brotli' ? 'br' : encoding }),
      };

      if (method === 'HEAD') {
        done(200);

        return { status: 200, headers };
      }

      return {
        status: 200,
        headers,
        body: guideBody(
          request,
          {
            ...guideOptions(now, sites, derived, meta),
            // As a `URL`, which is what keeps a base read off the request out
            // of the serializer's parse cache: that cache is keyed by the
            // string, and the string here is a `Host` header.
            ...(base === undefined ? {} : { baseUrl: new URL(String(base)) }),
          },
          encoding,
          { path: requestPath, began, done },
        ),
      };
    } catch (error) {
      // Before a byte of it went out, so there is still an answer to give. What
      // goes wrong after that is the body's to report — see `guideBody`.
      emit({ type: 'serve:failed', path: requestPath, error });
      done(500);

      return {
        status: 500,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body: 'Failed\n',
      };
    }
  };

  /**
   * Which answer a path asks for.
   *
   * The guide first, so an operator who pointed `serve.path` at `/health` gets
   * the guide there — the path they named explicitly beats the one that
   * defaulted.
   */
  function routeFor(requestPath: string): GuideRoute | 'none' {
    if (requestPath === path) {
      return 'guide';
    }

    if (requestPath === health) {
      return 'health';
    }

    return 'none';
  }

  /**
   * The guide itself, generated as it is pulled.
   *
   * The concurrency slot is taken at the first chunk rather than when the
   * headers were worked out: a burst of polls must not each start a merge, and
   * a slot taken earlier would be one held through every 304 as well. It is
   * given back when the body ends, however it ends — a consumer that stops
   * reading stops the merge and frees the slot in the same breath.
   */
  async function* guideBody(
    request: GuideRequest,
    build: BuildGuideOptions,
    encoding: CompressionFormat | undefined,
    report: { path: string; began: number; done: (status: number) => void },
  ): AsyncGenerator<Uint8Array> {
    /**
     * What stops the merge: the consumer going away, or this body being
     * dropped half way by whoever was sending it.
     */
    const stops = new AbortController();
    const away = (): void => stops.abort(new Error('the client closed the connection'));

    if (request.signal?.aborted === true) {
      away();
    } else {
      request.signal?.addEventListener('abort', away, { once: true });
    }

    /** Lets the slot go. Replaced once the queue has handed one over. */
    let release = (): void => {};

    await new Promise<void>((taken, failed) => {
      void guides
        .add(async () => {
          taken();

          // The task *is* the response: holding the slot until the last chunk
          // is what makes the limit mean "guides being generated" rather than
          // "guides begun".
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        })
        .catch(failed);
    });

    try {
      const guide = Readable.from(generateGuide({ ...build, signal: stops.signal }));
      // Compressed here rather than by whoever sends it, because the answer
      // already said `content-encoding` — the transport's job is to pass bytes
      // along, not to decide what they are. The callback form of `pipeline` is
      // what keeps the two ends tied together: a merge that throws destroys the
      // compressor, so this loop sees the error rather than a truncated guide
      // that ended cleanly.
      const bytes: AsyncIterable<Buffer | string> =
        encoding === undefined ? guide : pipe(guide, compressor(encoding), () => {});

      for await (const chunk of bytes) {
        // `Readable.from` keeps whatever the merge yielded, which is strings;
        // a body is bytes, and saying so here is what lets a `Response` take
        // this as it is.
        yield typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      }

      report.done(200);
    } catch (error) {
      if (stops.signal.aborted) {
        // Normal, and not ours to answer for: a reader that had seen enough, a
        // proxy that timed out, a tab that closed. Calling it a failure is how
        // a log fills with alarms about the ordinary, and how somebody ends up
        // paged for a browser refresh.
        emit({ type: 'serve:disconnected', path: report.path, ms: Date.now() - report.began });

        return;
      }

      emit({ type: 'serve:failed', path: report.path, error });
      // Counted as the failure it is, and not left out: a reporter that sees
      // every other request end would otherwise under-count by exactly the
      // ones worth knowing about.
      report.done(500);

      // Part of a guide has already gone out and there is no way to unsay it.
      // Throwing is what tells the transport the document is not whole —
      // ending quietly would leave a consumer caching half a guide.
      throw error;
    } finally {
      request.signal?.removeEventListener('abort', away);
      // A body dropped half way ends the merge too: an app that stopped
      // sending would otherwise leave one reading the cache for nobody.
      stops.abort(new Error('the guide was not read to the end'));
      release();
    }
  }

  /**
   * The scheduled grab, if there is one.
   *
   * Started with the handler rather than with the listening, so a mounted one
   * grabs too. Whoever made the handler owns closing it — a `listen` that
   * rejects after this would otherwise leave a timer nobody can reach, which
   * is why `serveGuide` closes the handler on its way out of a failed start.
   */
  let timer: NodeJS.Timeout | undefined;
  /** Aborts a grab in flight, so stopping does not wait for one to finish. */
  let grabbing: AbortController | undefined;
  /** The grab now running, so `close` can let it unwind before the cache shuts. */
  let running: Promise<void> | undefined;
  let runs = 0;
  let stopped = false;

  /**
   * Run one, then ask when the next should be.
   *
   * Wrapped whole, because `runGrab` can reject for reasons a grab's own counts
   * never cover — a config factory that could not get a token, a cache that
   * would not open, a prune that failed — and an unhandled rejection out of a
   * timer ends the process. A server that cannot grab tonight should still be
   * serving what it already has.
   */
  const grabNow = async (): Promise<void> => {
    // Before the import, not after it: `close` aborts whatever `grabbing`
    // holds, and on the first run that import is a real module load. A
    // controller published only afterwards leaves a window in which stopping
    // the server aborts nothing and then waits out the whole grab.
    const stops = new AbortController();

    grabbing = stops;

    const { runGrab } = await import('../build.js');

    try {
      // `close` may have happened while that import was resolving, and an
      // aborted signal is not enough on its own: `runGrab` opens the cache and
      // resolves the config before it looks at one.
      if (stopped) {
        return;
      }

      await runGrab(config, {
        // This server's own store rather than one of its own: `RunOptions.cache`
        // is the caller's and is left open. A second store would be wasteful for
        // a file cache and silently useless for `memory`, where the grab would
        // fill a different cache than the one being served.
        cache,
        ...(options.reporter ? { reporter: options.reporter } : {}),
        ...(options.offset === undefined ? {} : { offset: options.offset }),
        signal: stops.signal,
      });
    } catch (error) {
      emit({ type: 'serve:grabFailed', error });
    } finally {
      grabbing = undefined;
      runs++;
      // The held snapshot predates everything this wrote, so the next poll has
      // to sweep rather than trust it.
      checkedAt = 0;
    }
  };

  /**
   * Ask the schedule when to run, and set the timer it asks for.
   *
   * Only ever called once nothing is running — at startup, and from the
   * `finally` of the grab before — so two can never overlap and there is no
   * overlap to detect. A grab that overruns its own interval simply pushes the
   * next question later, and the schedule answers from the finish time.
   */
  const planNext = (from: Date): void => {
    if (schedule === undefined || stopped) {
      return;
    }

    const next = schedule(from, runs);

    if (next === undefined) {
      return;
    }

    const at = typeof next === 'number' ? next : next.getTime();
    const delay = Math.max(runs === 0 ? 0 : MIN_GRAB_GAP_MS, at - from.getTime());

    // Not `unref`'d: a server whose only remaining work is the next grab is
    // still a server that should be running.
    timer = setTimeout(() => {
      running = grabNow().finally(() => {
        running = undefined;
        planNext(new Date());
      });
    }, delay);
  };

  planNext(options.now ?? new Date());

  let closing: Promise<void> | undefined;

  const close = async (): Promise<void> => {
    if (closing === undefined) {
      // Published *before* any of the stopping starts, which `closing ??= …()`
      // would not do: the promise an async function returns is only handed
      // back at its first await, and the first thing this does is call
      // `shutdown` — which aborts a signal this very handler is listening to.
      // A second `close` arriving in that window has to find the first one
      // rather than start another, or everything here happens twice.
      let began!: (done: Promise<void>) => void;

      closing = new Promise<void>((resolve) => {
        began = resolve;
      });
      began(stop());
    }

    return closing;
  };

  /** The stopping itself — only ever entered once, through `close`. */
  async function stop(): Promise<void> {
    {
      // Before anything else: `planNext` schedules from a grab's `finally`, so
      // a stop that did not say so first would have the run in flight plan
      // another on its way out.
      stopped = true;
      clearTimeout(timer);
      grabbing?.abort();

      // Where a server of one's own stops listening and lets go of the
      // connections it still holds — after the grab has been called off, and
      // before the cache those requests are reading is taken away.
      await options.shutdown?.();

      // Aborted above, awaited here: a grab still unwinding would otherwise be
      // reading a store that `cache.close()` is about to take away.
      await running;
      guides.clear();
      // A target is the caller's and may outlive this handler — one left
      // listening would hold the whole closure, cache and all.
      options.reloadOn?.removeEventListener('reload', onReload);

      if (opened) {
        await cache.close();
      }

      emit({ type: 'serve:stopped' });
    }
  }

  /**
   * A Node request handler, which is what express, fastify and `http` itself
   * all take.
   *
   * Everything transport-shaped is here and nowhere else: what aborts the
   * merge when the socket goes, backpressure, and the one thing a stream can
   * do that a return value cannot — destroying a response whose guide failed
   * after its headers had already gone out.
   */
  const node =
    (route?: GuideRoute) =>
    async (request: NodeRequest, response: NodeResponse): Promise<void> => {
      const gone = new AbortController();

      response.on('close', () => {
        if (!response.writableEnded) {
          gone.abort(new Error('the client closed the connection'));
        }
      });

      const result = await answer({
        method: request.method,
        url: request.url,
        headers: request.headers,
        raw: request,
        ...(route === undefined ? {} : { route }),
        signal: gone.signal,
        // What this connection itself is, where a forwarded header does not say:
        // a handler mounted on an HTTPS server of somebody's own.
        encrypted: (request.socket as TLSSocket).encrypted === true,
      });

      // One spelling, two unrelated declarations of it: HTTP/1 and HTTP/2's
      // compatibility API both have `writeHead(status, headers)` and TypeScript
      // will not call it across the union of their overloads.
      (response as ServerResponse).writeHead(result.status, result.headers);

      if (result.body === undefined) {
        response.end();

        return;
      }

      if (typeof result.body === 'string') {
        response.end(result.body);

        return;
      }

      try {
        await pipeline(Readable.from(result.body), response, { signal: gone.signal });
      } catch {
        // Reported already, by whoever knew what it was. All that is left is to
        // say it on the wire: a destroyed socket is what tells a consumer the
        // document it received is not whole, which a clean end would not.
        response.destroy();
      }
    };

  /** The same answer for a fetch-style app — hono, elysia, bun, a worker. */
  const fetch =
    (route?: GuideRoute) =>
    async (request: Request): Promise<Response> => {
      const url = new URL(request.url);
      const result = await answer({
        method: request.method,
        url: request.url,
        // The url's authority first, because a `Request` carries no `Host` of
        // its own — the transport adds that on the way out, and here there is
        // no way out. Anything the request does carry still wins, forwarded
        // headers included.
        headers: { host: url.host, ...Object.fromEntries(request.headers) },
        raw: request,
        ...(route === undefined ? {} : { route }),
        signal: request.signal,
        encrypted: url.protocol === 'https:',
      });

      if (result.body === undefined || typeof result.body === 'string') {
        return new Response(result.body ?? null, {
          status: result.status,
          headers: result.headers,
        });
      }

      const chunks = result.body[Symbol.asyncIterator]();

      return new Response(
        // Pulled one chunk at a time rather than `ReadableStream.from`, so that a
        // cancelled response is a cancelled merge: `cancel` returns the iterator,
        // which is what ends the generator and gives its slot back.
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            const next = await chunks.next();

            if (next.done === true) {
              controller.close();
            } else {
              controller.enqueue(next.value);
            }
          },
          async cancel() {
            await chunks.return?.();
          },
        }),
        { status: result.status, headers: result.headers },
      );
    };

  /** See {@link GuideHandler.fastify}. */
  const fastify =
    (route?: GuideRoute) =>
    async (request: ReplyingRequest, reply: Replying): Promise<unknown> => {
      const gone = new AbortController();

      reply.raw.on('close', () => {
        if (!reply.raw.writableEnded) {
          gone.abort(new Error('the client closed the connection'));
        }
      });

      const result = await answer({
        method: request.method,
        url: request.url,
        headers: request.headers,
        raw: request,
        ...(route === undefined ? {} : { route }),
        signal: gone.signal,
        encrypted: (request.raw?.socket as TLSSocket | undefined)?.encrypted === true,
      });

      reply.status(result.status).headers(result.headers);

      // A stream, so that the framework's own backpressure and its hooks both
      // apply — and so that a reply abandoned half way ends the merge, which is
      // what destroying the stream does to the generator behind it.
      return reply.send(
        result.body === undefined || typeof result.body === 'string'
          ? result.body
          : Readable.from(result.body),
      );
    };

  options.reloadOn?.addEventListener('reload', onReload);

  // One or the other, because a listener answers only a signal that fires
  // *after* it is added: one already aborted never emits again. `serveGuide`
  // passes a signal of its own here and keeps the caller's for itself, so that
  // a server called off before it started still says so in the order it
  // happened.
  if (options.signal?.aborted === true) {
    await close();
  } else {
    options.signal?.addEventListener('abort', () => void close(), { once: true });
  }

  return {
    answer,
    node,
    fetch,
    fastify,
    guidePath: path,
    healthPath: health,
    config,
    reload,
    close,
  };
}
