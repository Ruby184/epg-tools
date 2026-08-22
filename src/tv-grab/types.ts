import type { Readable, Writable } from 'node:stream';
import type { CapabilityEntry } from './capability.js';
import type { ConfigStage } from './stages.js';

export type { GrabberConf } from './config-file.js';

/**
 * What the grabber takes, which is what every entry point takes.
 *
 * `defineConfig(factory, …)` produces the callable form, and is what a
 * configuration shared with `epg build` should be: the grabber hands it a
 * reader over the loaded `.conf`, so credentials collected by `--configure`
 * reach the site configs without the configuration file knowing they came from
 * there.
 */
export type { ConfigSource } from '../config.js';

export interface XmltvGrabberOptions {
  /**
   * One line saying which region the grabber covers, printed by
   * `--description`. Convention is `"Slovakia"`, or `"Slovakia (example.tv)"`
   * when several grabbers cover the same country.
   */
  description: string;
  /** The grabber's own version: `x`, `x.y` or `x.y.z`, optionally `_NNN`. */
  version: string;
  /** Defaults to the name the grabber was invoked as. */
  grabberName?: string;
  /**
   * Defaults to `['baseline', 'manualconfig', 'apiconfig', 'cache',
   * 'preferredmethod', 'newchannels']`.
   *
   * Entries may also be capabilities of your own, built with
   * `defineCapability` — they contribute their name to `--capabilities`, their
   * options to the command line, and their handlers to the dispatch.
   */
  capabilities?: readonly CapabilityEntry[];
  /**
   * Questions to ask before channel selection — credentials, a region, and so
   * on. The first stage must be named `start` and the last must set
   * `next: 'select-channels'`. Answers reach the config through
   * {@link ConfigSource}. Defaults to channel selection alone.
   */
  stages?: ConfigStage[];
  /** Set false to serve purely from cache, leaving grabbing to a separate cron. */
  grab?: boolean;
  /** "Now" reference, for tests. Defaults to `new Date()`. */
  now?: Date;

  /** Defaults to `process.argv.slice(2)`. */
  argv?: string[];
  /** Defaults to `process.stdout` — carries the XMLTV document, nothing else. */
  stdout?: Writable;
  /** Defaults to `process.stderr` — carries progress and errors. */
  stderr?: Writable;
  /** Defaults to `process.stdin`. */
  stdin?: Readable;
  /**
   * Cancel the run — `SIGINT` or `SIGTERM` in the generated shim, which is what
   * a service manager stopping a grabber sends. The grab keeps what reached the
   * cache and no document is written, since half of one is not a guide the
   * caller can use.
   */
  signal?: AbortSignal;
}
