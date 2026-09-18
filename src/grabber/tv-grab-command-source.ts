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
import type { Says } from '../core/events.js';
import type { XmltvChannel } from '../xmltv/types.js';
import {
  commandWindow,
  defineCommandSite,
  runCommand,
  type CommandArgsContext,
  type CommandSiteOptions,
  type CommandWindow,
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
  /** What `--description` said: one line about what it covers. */
  description?: string;
  /**
   * What `--preferredmethod` said, where it was asked.
   *
   * `allatonce` is the only response XMLTV defines, and its own instruction is
   * that anything else be treated as though the capability were absent — so
   * this is kept as it came and understood only where it is understood.
   */
  method?: string;
}

/** Every line one invocation wrote to stdout, and nothing if it would not. */
async function saidBy(run: ReturnType<typeof runCommand>, tolerate = false): Promise<string[]> {
  let text = '';

  for await (const chunk of run.bytes) {
    text += Buffer.from(chunk).toString('utf8');
  }

  try {
    await run.finished();
  } catch (error) {
    if (!tolerate) {
      throw error;
    }

    return [];
  }

  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/**
 * What the program says about itself, asked once and kept in the site's bag.
 *
 * Two or three invocations rather than one, the interface having no way to ask
 * more than one question at a time — and none at all on later runs, the answers
 * being remembered against a fingerprint of the command.
 *
 * Only `--capabilities` may fail the site: it decides what can be passed, so a
 * program that cannot answer it is one nothing else about is worth guessing at.
 * A grabber that will not say what it covers still grabs.
 */
async function askAbout(
  command: string,
  context: CommandArgsContext,
  options: { cwd?: string; env?: Record<string, string>; shell?: boolean; timeoutMs?: number },
): Promise<Remembered> {
  const of = createHash('sha1')
    .update(JSON.stringify([command, options.cwd ?? '', options.env ?? {}, options.shell ?? false]))
    .digest('hex')
    .slice(0, 16);
  const held = read(context.state, of);

  if (held !== undefined) {
    return held;
  }

  const ask = (what: string) =>
    runCommand({
      command,
      args: [what],
      ...options,
      warn: context.warn,
      ...(context.signal ? { signal: context.signal } : {}),
    });

  // One capability per line, as its own documentation has it.
  const names = await saidBy(ask('--capabilities'));
  const description = (await saidBy(ask('--description'), true))[0];
  // Asked only where it is advertised, since that is what advertising it means
  // — and one spawn is one spawn.
  const method = names.includes('preferredmethod')
    ? (await saidBy(ask('--preferredmethod'), true))[0]
    : undefined;
  const remembered: Remembered = {
    of,
    names,
    ...(description === undefined ? {} : { description }),
    ...(method === undefined ? {} : { method }),
  };

  context.state.set(CAPABILITIES, remembered);

  return remembered;
}

/** What a previous run remembered, if it was asked of the same command. */
function read(state: SiteState, of: string): Remembered | undefined {
  const held = state.get(CAPABILITIES);

  if (held === null || typeof held !== 'object') {
    return undefined;
  }

  const { of: asked, names, description, method } = held as Partial<Remembered>;

  // It comes back out of a cache file, and a changed command is a different
  // program however the file is spelled.
  return asked === of && Array.isArray(names) && names.every((one) => typeof one === 'string')
    ? {
        of,
        names,
        ...(typeof description === 'string' ? { description } : {}),
        ...(typeof method === 'string' ? { method } : {}),
      }
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

  /** What it says about itself — asked once, or said in the config. */
  const about = async (context: CommandArgsContext): Promise<Remembered> =>
    capabilities === undefined
      ? askAbout(command, context, how)
      : { of: 'said', names: [...capabilities] };

  /** The days, cut where they stop being consecutive. */
  const stretches = (window: CommandWindow): string[][] => {
    const groups: string[][] = [];
    let last: number | undefined;

    for (const day of window.days) {
      const at = Math.round(Date.parse(`${day}T00:00:00Z`) / 86_400_000);

      if (last !== undefined && at === last + 1) {
        groups.at(-1)!.push(day);
      } else {
        groups.push([day]);
      }

      last = at;
    }

    return groups;
  };

  /**
   * The day the window's own offset was counted from.
   *
   * Worked back out rather than read from a clock again, so every window a run
   * makes counts from the same today — a grab that crosses midnight would
   * otherwise have one stretch counted from each side of it.
   */
  const todayOf = (window: CommandWindow): Date =>
    new Date(Date.parse(`${window.startDay}T00:00:00Z`) - window.offset * 86_400_000);

  /** Said once a run, where the grabber said anything: which grabber this is. */
  const introduce = (known: Remembered, log: Says['log']): void => {
    if (known.description !== undefined) {
      log(`${command}: ${known.description}`);
    }
  };

  /** The options `baseline` promises, which are the window and the config file. */
  const baseline = (has: Set<string>, context: CommandArgsContext): string[] => {
    if (!has.has('baseline')) {
      if (configFile !== undefined) {
        // Said, because the alternative is a grab that quietly reads somebody
        // else's listings: without `baseline` there is no `--config-file` to
        // pass, so the grabber falls back to `~/.xmltv/<name>.conf` and the
        // file named here is simply ignored.
        context.warn(
          `this grabber does not advertise baseline, so it cannot be told to use ${configFile} — it will read its own default configuration`,
        );
      }

      return [];
    }

    return [
      ...(configFile === undefined ? [] : ['--config-file', configFile]),
      // `--offset` is where the stretch starts and `--days` is **how long it
      // is** — `span`, not how many days were asked for. A run wanting the 1st
      // and the 5th needs five: asking for two would come back without the
      // 5th, and a day the document says nothing about is cached as "nothing
      // on". Both are in the grabber's own idea of today, which is its
      // timezone's rather than this machine's; nothing here can make the two
      // agree.
      '--days',
      String(context.span),
      '--offset',
      String(context.offset),
      ...(quiet ? ['--quiet'] : []),
    ];
  };

  return defineCommandSite<TData>({
    command,
    ...how,
    ...site,

    /**
     * One invocation, or one per stretch of days.
     *
     * XMLTV's own advice, and the whole point of the capability: a grabber that
     * answers `allatonce` "downloads data in a single chunk and filters out the
     * requested days", so asking it twice costs twice for nothing — while one
     * that does not advertise `preferredmethod` is to be assumed proportional
     * to the days asked for, where a run wanting the 1st and the 5th is better
     * off asking twice for a day each than once for five.
     *
     * Anything other than `allatonce` is treated as though the capability were
     * absent, which its documentation asks for in as many words.
     */
    runs: async (context) => {
      const { method } = await about(context);

      return method === 'allatonce' || context.days.length === 0
        ? [context]
        : stretches(context).map((days) => commandWindow(days, todayOf(context)));
    },

    args: async (context) => {
      const known = await about(context);
      const has = new Set(known.names);

      introduce(known, context.log);

      return [
        ...baseline(has, context),
        ...(cache === undefined || !has.has('cache') ? [] : ['--cache', cache]),
        ...extraArgs,
      ];
    },

    channelsArgs: async (context) => {
      const has = new Set((await about(context)).names);

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
