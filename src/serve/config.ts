/**
 * What a config says about serving.
 *
 * Its own file so `config.ts` can name it without importing the server: a
 * `tv_grab_*` shim and every command that is not `serve` would otherwise pull
 * in `node:http` and the merge behind it to read a config field.
 */

import type { CompressionFormat } from '../core/output.js';
import type { NextGrab } from './schedule.js';

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
   * it is the *same* cache being served — and it shares the resolved channel
   * lists, so it does not ask every site for one that the server already has.
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
}
