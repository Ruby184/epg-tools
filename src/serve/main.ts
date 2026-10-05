/**
 * `epg serve`: the guide on a port of its own.
 *
 * The answering is next door in `handler.ts` and has no transport in it; this
 * is the socket around it — binding a port, keep-alive, and stopping in the
 * order that lets a consumer part way through a guide be cut off rather than
 * hold the process open.
 *
 * What a consumer actually gets, and why a poll is cheap, is documented there:
 * one metadata sweep decides the ETag, and a guide is generated only for a
 * request that has no matching one.
 */

import { createServer } from 'node:http';
import type { ServerHttp2Session } from 'node:http2';
import type { AddressInfo } from 'node:net';
import type { ListeningServer } from './config.js';
import { emitter } from '../core/events.js';
import type { ConfigSource } from '../config.js';
import type { GuideListening } from './config.js';
import {
  createGuideHandler,
  DEFAULT_SERVE_PATH,
  type GuideHandler,
  type GuideHandlerOptions,
} from './handler.js';

/** Where the guide is served from when nothing says otherwise. */
export { DEFAULT_SERVE_PATH };

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

export interface ServeOptions extends GuideHandlerOptions {
  port?: number;
  /** Defaults to `127.0.0.1` — see {@link DEFAULT_SERVE_HOST}. */
  host?: string;
  /** See {@link DEFAULT_KEEP_ALIVE_MS}. Raise it above whatever proxies this. */
  keepAliveMs?: number;
  /**
   * Listen with a server of your own — see {@link EpgServeConfig.server},
   * which this overrides as every other option here does.
   */
  server?: (
    handler: GuideHandler,
    where: { port: number; host: string },
  ) => GuideListening | Promise<GuideListening>;
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

/**
 * How to disconnect everyone still connected, worked out once.
 *
 * One name for two things, which is the whole reason this exists: what HTTP/1
 * is holding is connections and `closeAllConnections` ends them, while HTTP/2
 * is holding sessions — long-lived by design, and cut by nothing wholesale, so
 * they are kept as they arrive and destroyed here. Either way the caller ends
 * up with one function and nothing to decide at the moment of stopping.
 */
function disconnectAllFor(server: ListeningServer): () => void {
  if ('closeAllConnections' in server) {
    return () => server.closeAllConnections();
  }

  const sessions = new Set<ServerHttp2Session>();

  server.on('session', (session) => {
    sessions.add(session);
    // Ended, errored or destroyed: `close` is the one event all three arrive
    // at, so nothing stays in here longer than it is open.
    session.once('close', () => sessions.delete(session));
  });

  return () => {
    for (const session of sessions) {
      session.destroy();
    }

    // Destroying says `close` and empties this by itself, though not until the
    // loop is over — and a session that somehow never says so is not worth
    // holding on to either.
    sessions.clear();
  };
}

/** Resolved once the server is listening, or rejected if it never will be. */
async function listening(
  server: ListeningServer,
  start: (listen: () => void) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const failed = (error: Error): void => reject(error);

    server.once('error', failed);
    start(() => {
      server.removeListener('error', failed);
      resolve();
    });
  });
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
  const emit = emitter(options);
  /**
   * What the work in flight is stopped by, which is not the caller's signal.
   *
   * The handler closes itself for a signal that has already fired, and a
   * `serveGuide` called off before it began must still bind, say it started
   * and say it stopped — in that order, rather than reporting the end of
   * something that never had a beginning. So the caller's signal is wired up
   * below, after `listen`, and this one carries the cancelling.
   */
  const work = new AbortController();
  let server: ListeningServer | undefined;
  /** How a server of somebody's own stops, where it has a way of its own. */
  let stopListening: (() => void | Promise<void>) | undefined;
  /** Lets go of everyone still connected — see {@link disconnectAllFor}. */
  let disconnectAll: (() => void) | undefined;

  const handler = await createGuideHandler(source, {
    ...options,
    signal: work.signal,
    shutdown: async () => {
      // Whatever is still resolving or being read, before the cache it reads
      // is taken away.
      work.abort();
      await options.shutdown?.();
      // First, and awaited: `fastify.close()` is what runs the `onClose` hooks
      // a plugin registered, and closing the socket under it would skip every
      // one of them. What is left listening afterwards is still closed below —
      // this is the graceful half, not the whole of it.
      await stopListening?.();

      if (server === undefined) {
        return;
      }

      const shut = new Promise<void>((resolve) => {
        server?.close(() => resolve());
      });

      // Every open connection, not just the idle ones: a consumer part way
      // through a guide would otherwise hold the process open for as long as it
      // took to finish reading one nobody is waiting for.
      //
      // Before the await, not after: `close` only calls back once the last
      // response has ended, so a stalled consumer would hold this promise open
      // forever and the cut-off would never be reached.
      //
      disconnectAll?.();

      await shut;
    },
  });

  const where = {
    port: options.port ?? handler.config.serve?.port ?? DEFAULT_SERVE_PORT,
    host: options.host ?? handler.config.serve?.host ?? DEFAULT_SERVE_HOST,
  };
  const own = options.server ?? handler.config.serve?.server;

  try {
    if (own === undefined) {
      server = createServer(handler.node());

      // See DEFAULT_KEEP_ALIVE_MS: above whatever is in front of this, so the
      // proxy is always the one that decides a pooled connection is finished.
      // Only on a server this made — somebody else's timeouts are theirs.
      server.keepAliveTimeout = Math.max(0, options.keepAliveMs ?? DEFAULT_KEEP_ALIVE_MS);
      server.headersTimeout = server.keepAliveTimeout + 1000;

      await listening(server, (listen) => {
        server?.listen(where.port, where.host, listen);
      });
    } else {
      // Already listening, usually: `app.listen()` returns before the socket is
      // bound, and `fastify.listen()` after. Waiting on both is one line and
      // saves a url reported before there is a port to report.
      const listener = await own(handler, where);

      // By what it has rather than by what it is: a `Server` has no `server` of
      // its own, and `instanceof` would have to name both `node:http`'s and
      // `node:https`'s — which are unrelated classes.
      if ('server' in listener) {
        server = listener.server;
        // Called *on* the listener rather than lifted off it: `app.close` is a
        // method, and a method taken off its object is a method whose `this` is
        // gone — which is most of what a framework's close has to work with.
        stopListening = async () => listener.close?.();
      } else {
        server = listener;
      }

      await listening(server, (listen) => {
        if (server?.listening === true) {
          listen();
        } else {
          server?.once('listening', listen);
        }
      });
    }
  } catch (error) {
    // A port already taken, usually. The handler is holding a cache and may
    // have a grab scheduled, and nobody downstream has anything to close it
    // with — this call is the last place that can.
    await handler.close();

    throw error;
  }

  // Before the url rather than at the stop, because the HTTP/2 half of it has
  // to be watching from the first session onwards.
  disconnectAll = disconnectAllFor(server);

  const address = server.address();
  // A unix socket, or a server of someone's own that is bound to something
  // else again: there is no authority to build a url from, so what the command
  // was told to listen on is the best this can say.
  const bound =
    typeof address === 'object' && address !== null
      ? address
      : ({ address: where.host, port: where.port } as AddressInfo);
  // Any literal IPv6, not just the wildcard: `::1` unbracketed makes an
  // address no client can parse.
  const host = bound.address.includes(':') ? `[${bound.address}]` : bound.address;
  const url = `http://${host}:${bound.port}${handler.guidePath}`;

  // Listened for before anything can close, or a server stopped during its own
  // startup would leave this promise waiting on an event that has already been
  // and gone.
  const closed = new Promise<void>((resolve) => {
    server?.once('close', () => resolve());
  });

  emit({ type: 'serve:started', url });

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
    await handler.close();
  } else {
    options.signal?.addEventListener('abort', () => void handler.close(), { once: true });
  }

  return {
    url,
    port: bound.port,
    reload: () => handler.reload(),
    close: () => handler.close(),
    closed,
  };
}

export {
  createGuideHandler,
  outputFingerprint,
  DEFAULT_HEALTH_PATH,
  DEFAULT_REVALIDATE_MS,
  DEFAULT_SITES_MAX_AGE_MS,
} from './handler.js';
export type {
  GuideAnswer,
  GuideHandler,
  GuideHandlerOptions,
  GuideRequest,
  GuideRoute,
  Replying,
  ReplyingRequest,
} from './handler.js';
export type { EpgServeConfig, GuideListening } from './config.js';
export { grabEvery } from './schedule.js';
export type { GrabEveryOptions, NextGrab } from './schedule.js';
