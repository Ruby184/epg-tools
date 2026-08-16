/**
 * The XMLTV grabber configuration file: plain line-oriented text, not XML.
 *
 * Format and semantics follow `XMLTV::Configure` so a config written by any
 * other tool (or by hand, as the `manualconfig` capability promises) is
 * readable here and vice versa.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ConfigReader } from '../core/answers.js';

/**
 * Configuration values, keyed by field id. Every key is multi-valued because
 * a `selectmany` writes one line per selection.
 *
 * Deselected options are collected under the key prefixed with `no_`, so a
 * `selectmany` with id `channel` produces `channel` and `no_channel`.
 */
export type GrabberConf = Record<string, string[]>;

/**
 * A loaded configuration as a source of answers for `defineConfig`.
 *
 * This is the direction the dependency runs: an `epg.config.ts` asks its
 * context for a value and never learns where it came from, and the grabber —
 * the only thing that knows this file format exists — hands the answers in.
 * A config that is only ever built with `epg build` never sees one.
 */
export function grabberConfReader(conf: GrabberConf): ConfigReader {
  return {
    name: 'grabber-config',
    read: (id) => {
      // `username=` is a question that was asked and not answered — a line
      // `--configure` writes for every field it offered. Treating it as an
      // answer would let it outrank the environment with nothing, which is the
      // same reason an empty variable counts as unset.
      const values = (conf[id] ?? []).filter((value) => value !== '');
      return values.length > 0 ? values : undefined;
    },
    describe: () => 'run --configure to be asked for it',
  };
}

// Key, then '=' (selected) or '!' (deselected), then the value. No space is
// allowed before the sign; space after it is part of the value, except at the
// end of the line. A trailing `# comment` is stripped.
const LINE = /^(\S+?)([=!])(.*?)\s*(#.*)?$/;

/**
 * Parse a configuration file's text.
 *
 * Returns `undefined` if any line fails to parse — the reference treats a
 * malformed file as no configuration at all, and callers rely on that to tell
 * the user to run `--configure`.
 */
export function parseGrabberConfig(text: string): GrabberConf | undefined {
  const conf: GrabberConf = {};

  for (const raw of text.split('\n')) {
    const line = raw.replace(/[\n\r]/g, '');

    if (/^\s*$/.test(line) || /^\s*#/.test(line)) {
      continue;
    }

    const match = LINE.exec(line);

    if (!match) {
      return undefined;
    }

    const [, key, sign, value] = match as unknown as [string, string, string, string];
    const target = sign === '=' ? key : `no_${key}`;

    (conf[target] ??= []).push(value);
  }

  return conf;
}

/**
 * Render a configuration back to text.
 *
 * `no_x` keys are written as `x!value`, the form they were read from, so a
 * parse/serialize round-trip is lossless. (The reference `SaveConfig` writes
 * them literally as `no_x=value`, which does not round-trip.)
 */
export function serializeGrabberConfig(conf: GrabberConf): string {
  let out = '';

  for (const [key, values] of Object.entries(conf)) {
    const deselected = key.startsWith('no_');
    const name = deselected ? key.slice(3) : key;
    const sign = deselected ? '!' : '=';

    for (const value of values) {
      out += `${name}${sign}${value}\n`;
    }
  }

  return out;
}

/** Where a grabber keeps its configuration when `--config-file` is not given. */
export function defaultConfigFile(grabberName: string): string {
  // The reference falls back to a `.xmltv` directory in the working directory
  // when HOME is unset.
  const home = homedir() || process.cwd();
  return path.join(home, '.xmltv', `${grabberName}.conf`);
}

/** Read a configuration, or `undefined` when it is missing or malformed. */
export async function loadGrabberConfig(file: string): Promise<GrabberConf | undefined> {
  let text: string;

  try {
    text = await readFile(file, 'utf8');
  } catch {
    return undefined;
  }

  return parseGrabberConfig(text);
}

/** Write a configuration, atomically, creating the directory if needed. */
export async function saveGrabberConfig(file: string, conf: GrabberConf): Promise<void> {
  const tmp = `${file}.TMP`;

  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(tmp, serializeGrabberConfig(conf), 'utf8');
  await rename(tmp, file);
}
