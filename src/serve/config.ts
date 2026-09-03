/**
 * What a config says about serving.
 *
 * Its own file so `config.ts` can name it without importing the server: a
 * `tv_grab_*` shim and every command that is not `serve` would otherwise pull
 * in `node:http` and the merge behind it to read a config field.
 */

import type { CompressionFormat } from '../core/output.js';

export interface EpgServeConfig {
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
