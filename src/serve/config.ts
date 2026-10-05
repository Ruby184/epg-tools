/**
 * What a config says about serving.
 *
 * Its own file so `config.ts` can name it without importing the server: a
 * `tv_grab_*` shim and every command that is not `serve` would otherwise pull
 * in `node:http` and the merge behind it to read a config field.
 */

import type { Server } from 'node:http';
import type { Server as TlsServer } from 'node:https';
import type { CompressionFormat } from '../core/output.js';
import type { NextGrab } from './schedule.js';
import type { GuideHandler, GuideRequest } from './handler.js';

/**
 * What {@link EpgServeConfig.server} hands back: the server it is listening on,
 * and how to stop it where stopping is more than closing a socket.
 *
 * A bare `Server` is the common case — express's `app.listen()` returns one and
 * `node:http` is one; `node:https` is the other, for a guide served over TLS
 * without a proxy in front to terminate it. Give a `close` too wherever the
 * thing listening has a
 * lifecycle of its own, fastify above all: `app.close()` is what runs its
 * `onClose` hooks and lets its plugins put themselves away, and closing the
 * socket underneath it would skip every one of them.
 *
 * A fastify instance already *is* this shape — a `server` and a `close()` — so
 * `return app` is the whole of it there.
 */
export type GuideListening =
  | Server
  | TlsServer
  | {
      /** The one actually bound, for the port and the url the command reports. */
      server: Server | TlsServer;
      /**
       * Stop listening, your way — awaited while the handler stops.
       *
       * Called after the scheduled grab has been called off and before the
       * cache is let go of, which is the only window where requests are still
       * being answered and the cache is still there to answer them from.
       * Whatever is still listening afterwards is closed and its connections
       * cut, so this is free to be the graceful half.
       *
       * It is also the half that can hang: a guide takes as long as a consumer
       * takes to read it, and a close that waits for every request will wait
       * for that one. Fastify's `forceCloseConnections: true` is the answer
       * there.
       */
      close?: () => void | Promise<void>;
    };

export interface EpgServeConfig {
  /**
   * Grab on a schedule as well as serving, instead of leaving that to cron.
   *
   * A function saying when the next run is due — `grabEvery('6h', { at: '04:00' })`
   * builds the usual one, and anything that can produce a next timestamp works,
   * which is how a cron expression gets in without this package carrying a cron
   * parser. See {@link NextGrab}.
   *
   * Off by default: without it a server serves what is in the cache and never
   * fetches, which is what it has always done.
   *
   * A scheduled grab shares this server's cache rather than opening its own, so
   * what it writes is what the very next request is served. It does **not**
   * share the server's resolved channel lists: those may be `sitesMaxAgeMs`
   * old, and a grab that reused them would miss a channel added since.
   */
  grab?: NextGrab;
  /** Defaults to 8080. */
  port?: number;
  /**
   * Defaults to `127.0.0.1`.
   *
   * Loopback deliberately: a guide is not a secret, but which sites you grab
   * and which channels you watch is not nothing, and a command that listened on
   * every interface because a flag was left off would be the wrong default to
   * have chosen once. `0.0.0.0` is one word, and is a decision.
   */
  host?: string;
  /** The one path that answers with a guide. Defaults to `/guide.xml`. */
  path?: string;
  /**
   * Where a container's healthcheck can ask whether this is serving anything.
   *
   * Defaults to `/health`; `false` switches it off. It answers **503** only
   * when nothing at all is cached — the one unambiguous "cannot do its job" —
   * so a healthcheck fails until the first grab lands and passes after. How
   * stale is too stale is a judgement this server does not make: the age and
   * the share of the window that is present are reported, and what to alert on
   * is yours.
   *
   * Aggregates only, never a site or channel name — the same line
   * {@link EpgServeConfig.host} draws by binding to loopback.
   */
  health?: string | false;
  /**
   * What to compress a served guide with, when the client accepts it.
   * Defaults to `'gzip'`; `false` never compresses.
   */
  compress?: CompressionFormat | false;
  /**
   * Let a browser read the guide: `true` for any origin, or one origin to
   * allow it alone. Off by default.
   *
   * Off because loopback is not the boundary it looks like — a page in a
   * browser on this machine can reach `127.0.0.1`, so `true` lets any site the
   * viewer opens read which channels they watch. Worth turning on for a
   * dashboard of your own, and worth doing on purpose.
   */
  cors?: boolean | string;
  /**
   * Resolve relative urls in the guide against this, overriding `baseUrl` on
   * the configuration — see `SerializeOptions.baseUrl`.
   *
   * A url for a fixed one. `true` builds it from the request: the forwarded
   * protocol and host where something in front says so, the `Host` header
   * otherwise. That is what a box reachable by two names needs, since neither
   * of them is the one to write down. A function decides for itself, and
   * falling back to the configured base by answering `undefined`.
   *
   * It is given the request as {@link GuideRequest} describes it — the method,
   * the path, the headers, and whether this one arrived over TLS — so that it
   * answers the same wherever the guide is mounted. What the transport itself
   * was handed is there as `raw`, for a function that knows which server it is
   * running on and wants more than the shape above.
   *
   * ```ts
   * serve: { baseUrl: true }
   * serve: {
   *   baseUrl: ({ headers, encrypted }) =>
   *     `${encrypted === true ? 'https' : 'http'}://${String(headers.host ?? 'pi.local')}/`,
   * }
   * ```
   *
   * What it costs: a guide that differs by who asked for it. The validators
   * carry the base, so a consumer is told the document changed when it did, and
   * the response says it varies on the headers the base was read from — without
   * which a cache in between would hand one host another's document.
   */
  baseUrl?: string | URL | true | ((request: GuideRequest) => string | URL | undefined);
  /**
   * Listen with a server of your own, instead of the one `epg serve` makes.
   *
   * Given the guide as a handler and where the command was told to listen, and
   * returning the `http.Server` it is listening on — which is what `express`,
   * `fastify` and `node:http` all have — or that server with a `close` of your
   * own beside it, which is how an app with shutdown hooks keeps them. See
   * {@link GuideListening}. `epg serve` carries on around it: the reporter,
   * `SIGHUP` to reload, a scheduled grab, and a stop that cuts the connections
   * still open before it lets go of the cache.
   *
   * ```ts
   * serve: {
   *   server: ({ node, guidePath, healthPath }, { port, host }) => {
   *     const app = express();
   *
   *     app.get(guidePath, node('guide'));
   *     app.get('/my/own/route', mine);
   *
   *     if (healthPath !== false) {
   *       app.get(healthPath, node('health'));
   *     }
   *
   *     return app.listen(port, host);
   *   },
   * }
   * ```
   *
   * The paths come from the handler on purpose: they are what `serve.path`,
   * `serve.health` and `--path` settled on, and an app that writes its own
   * instead has quietly taken those away from whoever runs the command. Mount
   * something else only when you mean to — `node('guide')` answers wherever it
   * is mounted.
   *
   * Nothing is mounted on your behalf, the health check included. `app.use`
   * is not the shortcut it looks like either: `node()` with no route answers a
   * path it does not know with a 404, so it would swallow the rest of your app.
   *
   * Fastify has a handler of its own — `handler.fastify`, which writes through
   * the reply so that its `onSend` and `onResponse` hooks still see the guide —
   * and its `close` is what runs the `onClose` hooks a plugin registered:
   *
   * ```ts
   * serve: {
   *   server: async ({ fastify: route, guidePath }, { port, host }) => {
   *     const app = Fastify({ forceCloseConnections: true });
   *
   *     app.get(guidePath, route('guide'));
   *     await app.listen({ port, host });
   *
   *     // Already a `server` and a `close()`, which is all this asks for.
   *     return app;
   *   },
   * }
   * ```
   *
   * For a program that owns its own process, `createGuideHandler` is this
   * without the command around it. This is for keeping the command.
   *
   * `keepAliveMs` is not applied to a server it did not make — see
   * {@link DEFAULT_KEEP_ALIVE_MS} for the timeouts worth setting on your own.
   */
  server?: (
    handler: GuideHandler,
    where: { port: number; host: string },
  ) => GuideListening | Promise<GuideListening>;
}
