/**
 * Where a configuration's *answers* come from.
 *
 * A grabber and a build are the same configuration reached two ways: a grabber
 * has a `.conf` file written by `--configure`, a build has environment
 * variables, and both are answering the same questions. So they are not two
 * mechanisms but two sources, asked in order.
 *
 * Nothing here knows what a grabber configuration is. A source is just a named
 * lookup, so the *consumer* contributes its own — the grabber hands in a reader
 * over the file it loaded — and a config file that never runs as a grabber
 * never mentions one. That is also what makes a fourth source (a secrets file,
 * a vault export) nothing special.
 */

import { GrabberError } from './error.js';

/** One source of answers. */
export interface ConfigReader {
  /** Named for messages, and so a config can recognize one it was handed. */
  readonly name: string;
  /** The values for a question, or `undefined` when this source has none. */
  read(id: string): string[] | undefined;
  /**
   * How a user would supply this answer here — "set `EPG_PASSWORD`". Left out
   * by a source there is no point directing anyone to, such as stage defaults.
   */
  describe?(id: string): string;
}

/** What a config factory is handed: the answers, however they were sourced. */
export interface ConfigContext {
  /** The first value, or `undefined` if no source has one. */
  get(id: string): string | undefined;
  /** Every value, for a question that can be answered more than once. */
  all(id: string): string[];
  /** The first value, or a failure naming every place it could have come from. */
  require(id: string): string;
}

/** Just enough of a stage to take its defaults; a `ConfigStage` satisfies it. */
export interface StageDefaults {
  fields: readonly { id: string; default?: string }[];
}

/** `username` → `<prefix>USERNAME`. */
function envName(prefix: string, id: string): string {
  return `${prefix}${id.toUpperCase().replaceAll('-', '_')}`;
}

/**
 * The environment, under a prefix.
 *
 * Single-valued on purpose: splitting on a separator would be a guess, and the
 * one place it would matter — a channel selection — belongs to a configuration
 * file anyway. An empty variable counts as unset, which is what an unset
 * variable usually looks like by the time a shell has finished with it.
 */
export function envReader(prefix: string, env: NodeJS.ProcessEnv = process.env): ConfigReader {
  return {
    name: 'env',
    read: (id) => {
      const value = env[envName(prefix, id)];
      return value === undefined || value === '' ? undefined : [value];
    },
    describe: (id) => `set ${envName(prefix, id)}`,
  };
}

/**
 * The `default` a stage already declares, so it is written once and serves the
 * prompt, the stage document and this.
 */
export function defaultsReader(stages: readonly StageDefaults[]): ConfigReader {
  const defaults = new Map<string, string>();

  for (const stage of stages) {
    for (const field of stage.fields) {
      if (field.default !== undefined && !defaults.has(field.id)) {
        defaults.set(field.id, field.default);
      }
    }
  }

  return {
    name: 'stage-default',
    read: (id) => {
      const value = defaults.get(id);
      return value === undefined ? undefined : [value];
    },
  };
}

/** Ask each source in turn; the first with an answer wins. */
export function createConfigContext(readers: readonly ConfigReader[]): ConfigContext {
  const all = (id: string): string[] => {
    for (const reader of readers) {
      const values = reader.read(id);

      if (values !== undefined) {
        return values;
      }
    }

    return [];
  };

  return {
    all,
    get: (id) => all(id)[0],
    require(id: string): string {
      const value = all(id)[0];

      if (value !== undefined) {
        return value;
      }

      // Say where it could go, in the order it would be looked for — "why is
      // this not configured" has one answer per source, and the user should
      // not have to know which sources this configuration was built with.
      const places = readers
        .map((reader) => reader.describe?.(id))
        .filter((place): place is string => place !== undefined);

      throw new GrabberError(
        places.length === 0
          ? `No value for "${id}"`
          : `No value for "${id}": ${places.join(', or ')}`,
      );
    },
  };
}
