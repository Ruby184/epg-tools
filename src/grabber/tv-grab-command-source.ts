/**
 * An XMLTV grabber as a source: `tv_grab_fi`, `tv_grab_uk_freeview`, and the
 * handful of others still working.
 *
 * {@link defineCommandSite} with its arguments written for it. The interface
 * those programs answer to is one this package already implements from the
 * other side — `epg init-grabber` writes a `tv_grab_*` for a config of your own
 * — so the option names, and which capability each belongs to, are read from
 * `src/tv-grab/options.ts` rather than guessed.
 *
 * **It asks the program what it supports**, once, because the answer decides
 * what may be passed: `--days`, `--offset`, `--config-file` and `--quiet` are
 * `baseline`, `--list-channels` is `apiconfig`, and `--cache` is `cache`.
 * Passing one a grabber does not have gets "unknown option" and a failed site,
 * which is a poor way to find out.
 *
 * What it does not attempt is configuration. The `.conf` file is the user's to
 * write — there are three dialects of it among six working grabbers, and nobody
 * has automated the walk in twenty years. `--configure` is theirs to run.
 */

import { createHash } from 'node:crypto';
import type { XmltvChannel } from '../xmltv/types.js';
import {
  defineCommandSite,
  runCommand,
  type CommandArgsContext,
  type CommandSiteOptions,
} from './command-source.js';
import type { SiteState, StreamSiteConfig } from './types.js';

/** Where the answer to `--capabilities` is kept, with what it was asked of. */
const CAPABILITIES = 'capabilities';

/**
 * What a grabber may say it supports.
 *
 * XMLTV's own set, and the same names this package answers `--capabilities`
 * with — see `KNOWN_CAPABILITIES` and the option tables in
 * `src/tv-grab/options.ts`. Open, because a grabber may advertise something
 * neither of us knows and that is its business.
 */
export type TvGrabCapability =
  | 'baseline'
  | 'manualconfig'
  | 'apiconfig'
  | 'cache'
  | 'preferredmethod'
  | 'lineups'
  | 'newchannels'
  | (string & {});

export interface TvGrabCommandSiteOptions<TData = XmltvChannel> extends Omit<
  CommandSiteOptions<TData>,
  'args' | 'channelsArgs'
> {
  /**
   * Its configuration file, passed as `--config-file`.
   *
   * Yours to write, or the grabber's own `--configure` to write. Left out, the
   * grabber falls back to `~/.xmltv/<name>.conf`, which is where its own
   * `--configure` puts one.
   */
  configFile?: string;
  /** A cache file for the grabber's own use, passed as `--cache`. */
  cache?: string;
  /** Pass `--quiet`, so only its errors are reported. On by default. */
  quiet?: boolean;
  /**
   * What it supports, when you would rather say than have it asked.
   *
   * Saves one spawn a day and is the way out if a grabber's `--capabilities`
   * answer cannot be believed. `[]` means "none of them", which passes nothing
   * but the arguments below.
   */
  capabilities?: readonly TvGrabCapability[];
  /** Anything else it takes, added after the arguments worked out here. */
  extraArgs?: readonly string[];
}

/** What a grabber answered `--capabilities` with, and what it was asked. */
interface Remembered {
  /** A fingerprint of the command, so a changed one is asked again. */
  of: string;
  names: string[];
}

/** What `--capabilities` said, asked once and remembered in the site's bag. */
async function capabilitiesOf(
  command: string,
  context: CommandArgsContext,
  options: { cwd?: string; env?: Record<string, string>; shell?: boolean; timeoutMs?: number },
): Promise<Set<string>> {
  const of = createHash('sha1')
    .update(JSON.stringify([command, options.cwd ?? '', options.env ?? {}, options.shell ?? false]))
    .digest('hex')
    .slice(0, 16);
  const held = read(context.state, of);

  if (held !== undefined) {
    return new Set(held);
  }

  const run = runCommand({
    command,
    args: ['--capabilities'],
    ...options,
    warn: context.warn,
    ...(context.signal ? { signal: context.signal } : {}),
  });
  const names: string[] = [];

  for await (const chunk of run.bytes) {
    for (const line of Buffer.from(chunk).toString('utf8').split('\n')) {
      const name = line.trim();

      if (name !== '') {
        names.push(name);
      }
    }
  }

  // One capability per line, and a program that cannot answer this is one
  // nothing else about is worth guessing at.
  await run.finished();
  context.state.set(CAPABILITIES, { of, names } satisfies Remembered);

  return new Set(names);
}

/** What a previous run remembered, if it was asked of the same command. */
function read(state: SiteState, of: string): string[] | undefined {
  const held = state.get(CAPABILITIES);

  if (held === null || typeof held !== 'object') {
    return undefined;
  }

  const { of: asked, names } = held as Partial<Remembered>;

  // It comes back out of a cache file, and a changed command is a different
  // program however the file is spelled.
  return asked === of && Array.isArray(names) && names.every((one) => typeof one === 'string')
    ? names
    : undefined;
}

/** An XMLTV grabber as a site. */
export function defineTvGrabCommandSite<TData = XmltvChannel>(
  options: TvGrabCommandSiteOptions<TData>,
): StreamSiteConfig<TData> {
  const {
    command,
    configFile,
    cache,
    quiet = true,
    capabilities,
    extraArgs = [],
    cwd,
    env,
    shell,
    timeoutMs,
    ...site
  } = options;

  const how = {
    ...(cwd === undefined ? {} : { cwd }),
    ...(env === undefined ? {} : { env }),
    ...(shell === undefined ? {} : { shell }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };

  /** What it says it supports — asked once, or said in the config. */
  const supported = async (context: CommandArgsContext): Promise<Set<string>> =>
    capabilities === undefined
      ? capabilitiesOf(command, context, how)
      : new Set<string>(capabilities);

  /** The options `baseline` promises, which are the window and the config file. */
  const baseline = (has: Set<string>, context: CommandArgsContext): string[] =>
    has.has('baseline')
      ? [
          ...(configFile === undefined ? [] : ['--config-file', configFile]),
          // `--days` is a count and `--offset` is where it starts, both in the
          // grabber's own idea of today. See `CommandWindow.offset`: the two
          // "today"s are its timezone's and this machine's, and nothing here
          // can make them agree.
          '--days',
          String(context.days.length),
          '--offset',
          String(context.offset),
          ...(quiet ? ['--quiet'] : []),
        ]
      : [];

  return defineCommandSite<TData>({
    command,
    ...how,
    ...site,

    args: async (context) => {
      const has = await supported(context);

      return [
        ...baseline(has, context),
        ...(cache === undefined || !has.has('cache') ? [] : ['--cache', cache]),
        ...extraArgs,
      ];
    },

    channelsArgs: async (context) => {
      const has = await supported(context);

      if (!has.has('apiconfig')) {
        // No cheap answer to ask for, so the list comes out of the head of a
        // normal run — which is what the generic layer does with no
        // `channelsArgs` at all, and what the published-guide adapter does with
        // a document. `cacheChannels` keeps it to once a day either way.
        return [
          ...baseline(has, context),
          ...(cache === undefined || !has.has('cache') ? [] : ['--cache', cache]),
          ...extraArgs,
        ];
      }

      return [
        // `--list-channels` belongs to `apiconfig`, not to `baseline` — read
        // from this package's own implementation of the interface, where it
        // sits in `capabilities/apiconfig.ts`. It writes a document of
        // channels and no programmes, so it costs one fast run rather than a
        // whole grab.
        ...(configFile === undefined || !has.has('baseline') ? [] : ['--config-file', configFile]),
        '--list-channels',
        ...(quiet && has.has('baseline') ? ['--quiet'] : []),
        ...extraArgs,
      ];
    },
  });
}
