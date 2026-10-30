/**
 * The `epg` command.
 *
 * Shaped like {@link runXmltvGrabber}: it *returns* an exit code rather than
 * assigning `process.exitCode`, and takes the streams it writes to. Only the
 * bin decides what to do with either, which is what makes a command a thing a
 * test can run — argv in, code and text out, no process state touched.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { access } from 'node:fs/promises';
import type { Writable } from 'node:stream';
import {
  resolveConfigSource,
  type ConfigSource,
  type EpgConfig,
  type ResolvedConfig,
} from '../config.js';
import { build, createCacheStore, runGrab, runMerge } from '../build.js';
import { CACHE_DRIVER_NAMES } from '../cache/main.js';
import { fellShort, resolveAllowance } from '../grabber/main.js';
import { earliestDay } from '../grabber/site.js';
import { grabEvery, resolveInterval, resolveTimeOfDay } from '../serve/schedule.js';
import type { MissingAllowance } from '../grabber/main.js';
import { GrabberError } from '../core/error.js';
import { OptionError, parseOptions } from '../core/options.js';
import { dayIn, dayToDate, resolveTimeZone, toDayString } from '../core/days.js';
import {
  reportingTo,
  ReporterError,
  RunFailedError,
  silent,
  stamped,
  LEVELS,
  type Emit,
  type EventLevel,
} from '../core/events.js';
import { combineReporters, FAILURE_MODES, reporterFor, REPORTER_NAMES } from '../core/reporters.js';
import { drain, writeFlushed, writeLines } from '../core/streams.js';
import { initGrabber } from './scaffold.js';
import { REPORT_FORMATS, type ReportFormat } from './format.js';
import { EXPLAINABLE, explainCommands, explanations } from './explain.js';
import { OUTPUT_PROFILE_NAMES } from '../xmltv/profile.js';
import type { OutputProfileName } from '../xmltv/profile.js';
import { outputOptions } from '../xmltv/serialize.js';
import { renderReport, validateFile } from './validate.js';
import type { CompressionFormat } from '../core/output.js';
import type { GrabSummary } from '../grabber/types.js';
import type { CacheCommand } from './cache.js';
import { count } from '../core/count.js';

export const USAGE = `Usage: epg <command> [options]

Commands:
  build         Grab all sites into the cache, then generate the merged guide (default)
  grab          Grab all sites into the cache only
  merge         Generate the merged guide from the cache only
  validate      Read a guide and report what is wrong with it
  filter        Write a guide with only the channels you asked for
  channels      Report which wanted channels will get no guide, and why
  serve         Hold the merged guide behind HTTP for a consumer that polls
  try           Put one site, channel and day through, showing every step
  cache         Look inside the cache — show, stats, state — or prune it
  init-grabber  Write a tv_grab_* executable for the config, next to it

Options:
  -c, --config <path>   Config file (default: epg.config.ts|js|mjs in cwd)
  -d, --days <n>        Override the number of days
      --offset <n>      Start the window n days from today (may be negative)
      --timezone <zone> Whose calendar says which day is today, e.g.
                        Europe/Bratislava (default: the process's, from TZ)
  -o, --output <path>   Override the output file, or a Unix socket to write into
      --cache-dir <dir> Override the cache directory
      --cache-driver <name>  Override where cached days are kept: ndjson, xmltv,
                        sqlite or memory
      --refresh         Refetch every day in the window, ignoring what is cached
      --threads[=n]     Run the sites in worker threads, so one site's parsing
                        cannot hold up another's: one per core, or at most n.
                        build/grab/serve. --no-threads runs them in one,
                        whatever the config says
      --allow-missing <n>   Exit 0 with up to this much of the guide missing:
                        a number of channel-days, or a share like 5%
      --dry-run         grab/build only: say what a run would fetch, and stop.
                        --format json for a machine-readable one
      --explain <what>  Once the run is done, list on stderr what it said of
                        one thing, and what that most likely means. Repeatable.
                        build/merge: unmatched — the programmes that nearly
                        merged with another source's, and what would join them.
                        build/grab: empty — the channel-days a source answered
                        with nothing, and why; requests — each site's requests
                        and where its time went; held — the sites a source told
                        to slow down, and the pace that earned it. Its events
                        as JSON: --reporter json --log-level debug
      --extensions <names>  build/merge/serve/filter: keep only these provider
                        extensions, comma-separated (e.g. lcn,uniqueID)
      --no-extensions   build/merge/serve/filter: leave every provider
                        extension out, for a guide that validates against the DTD
      --indent <n|str>  build/merge/serve/filter/cache show: pretty-print with
                        this indentation
      --profile <name>  Shape the guide for one consumer: tvheadend or jellyfin.
                        build/merge/serve/filter. Changes the guide, never the
                        cache, so switching it refetches nothing
      --channels <what> keep only these channels, and fetch nothing for the
                        rest. Ids, or a file naming them — a playlist, a
                        *.channels.xml, a guide, or a plain list. Repeatable.
                        build/grab/merge/serve/filter
      --against <file>  channels only: what you want a guide for — an M3U
                        playlist, a *.channels.xml, or an XMLTV guide
      --check           channels only: exit 1 unless every wanted channel
                        matched by id, for a CI step
      --write           channels only: write the ids the report suggested back
                        into --against, in place — a *.channels.xml, a playlist
                        or a guide. With -o, writes there and leaves the
                        original alone
      --log-level <l>   How much to report: error, warn, info (default) or debug
  -v, --verbose         Same as --log-level debug
  -q, --quiet           Same as --log-level error. Beats --verbose if both are given
      --reporter <name> How to report it: progress (default, a live line on a
                        terminal and text elsewhere), text or json
      --failures <how>  block (default) — one capped block at the end; or inline
  -V, --version         Print this package's version
  -h, --help            Show this help

try options:
      --raw             Print the whole payload, not the first 2000 characters

serve options:
      --port <n>        Port to listen on (default: 8080)
      --host <h>        Address to bind (default: 127.0.0.1 — loopback only)
      --serve-path <p>  Path that answers with the guide (default: /guide.xml)
      --health <p>      Path that answers a health check (default: /health)
      --no-health       Do not answer one at all
      --grab-every <d>  Also grab on this interval — 6h, 30m, 1d (default: never)
      --grab-at <t>     Local time of day to line it up with, as 04:00. On its
                        own it means once a day, at that time

validate options:
      --format <how>    text (default) or json
      --strict          Count warnings as failures too

cache commands:
  epg cache show <site> [channel] [day]   What is cached, as an XMLTV document,
                        or a programme per line with --format json
  epg cache stats [site]                  How much is cached, per site
  epg cache state <site> [group]          What a site remembers between runs:
                        its groups, or what one holds
  epg cache prune                         Remove cached days older than today
      --format <how>    show, stats, state: text (default) or json
      --keys            state with a group: only the keys it holds
      --before <day>    prune: remove days before YYYY-MM-DD (default: today)

init-grabber options:
      --description <s> What --description prints (default: the country and name)
      --grabber-version <v>  The grabber's own version, as its --version
                        reports it (default: the project's package.json
                        version, else 0.1.0)
      --force           Replace an existing file
`;

/**
 * A `YYYY-MM-DD` day, and a real one.
 *
 * The shape alone would accept `2026-99-99`, which as a string comparison
 * cutoff would prune far more than was asked for.
 */
function dayString(raw: string, flag: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || !isRealDay(raw)) {
    throw new OptionError(`Invalid ${flag} value: ${raw} (expected YYYY-MM-DD)`);
  }

  return raw;
}

/**
 * A flag checked by whatever reads the config field behind it.
 *
 * Four flags mean exactly what a config field means — `--allow-missing` is
 * `allowMissing`, `--timezone` is `timeZone`, `--grab-every` and `--grab-at`
 * are the two halves of `grabEvery` — so each is read by the function that
 * defines the meaning, and
 * a value that cannot work is refused where somebody typed it rather than on
 * the night it would first have mattered. What changes is only the reporting:
 * an {@link OptionError} is what puts the usage on screen and exits 2.
 */
function reader(resolve: (raw: string, label: string) => unknown) {
  return (raw: string, flag: string): string => {
    try {
      resolve(raw, flag);
    } catch (error) {
      throw new OptionError(error instanceof Error ? error.message : String(error));
    }

    return raw;
  };
}

const allowance = reader(resolveAllowance);
const timeZone = reader(resolveTimeZone);
const interval = reader(resolveInterval);
const timeOfDay = reader(resolveTimeOfDay);

/**
 * The extension names of `--extensions a,b`, and at least one of them.
 *
 * An empty list would be `--no-extensions` said the long way round, and far
 * more likely a shell that expanded a variable to nothing — which would
 * silently strip every extension from the guide.
 */
function extensionNames(raw: string, flag: string): string[] {
  const names = raw
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');

  if (names.length === 0) {
    throw new OptionError(`Invalid ${flag} value: ${raw} (expected names, or --no-extensions)`);
  }

  return names;
}

/** Something the user typed: the usage goes with it, as the grabber does. */
const EXIT_USAGE = 2;

/** The run failed, or finished with data missing. */
const EXIT_FAILED = 1;

/**
 * Cancelled — what a shell reports for a process killed by `SIGINT` (128 + 2),
 * so a script reading `$?` sees the interruption for what it is rather than as
 * a failed grab.
 */
const EXIT_CANCELLED = 130;

const CONFIG_CANDIDATES = ['epg.config.ts', 'epg.config.js', 'epg.config.mjs'];

/** The commands `--channels` narrows. The rest are told so rather than ignoring it. */
const SELECTABLE = ['build', 'grab', 'merge', 'serve'];

/** `--threads`: bare for one per core, or how many at most. */
function poolSize(raw: string, flag: string): true | number {
  if (raw === 'true') {
    return true;
  }

  // Digits and nothing else. A word that is not a count is refused rather than
  // taken: an optional value claims the word after it, so `epg --threads build`
  // would otherwise read the command as how many threads — and `--threads=`,
  // from an unset `$N`, is not a quiet way of saying none.
  if (!/^\d+$/.test(raw)) {
    throw new OptionError(
      `Invalid ${flag} value: ${raw} (expected a number of threads, or nothing for one per core)`,
    );
  }

  return Number(raw);
}

/** `--indent`: spaces if it is a number, the string itself otherwise. */
function indentation(raw: string): string | number {
  const spaces = Number(raw);

  return Number.isInteger(spaces) && spaces >= 0 ? spaces : raw;
}

const COMMANDS = [
  'build',
  'grab',
  'merge',
  'serve',
  'try',
  'validate',
  'channels',
  'filter',
  'cache',
  'init-grabber',
];

export interface CliOptions {
  /** Defaults to `process.stdout` — progress, and the help. */
  stdout?: Writable;
  /** Defaults to `process.stderr` — failures. */
  stderr?: Writable;
  /**
   * Cancel the command. The bin fires this on `SIGINT` and `SIGTERM`; nothing
   * here listens for a signal itself, which is what keeps a command something a
   * test can run.
   */
  signal?: AbortSignal;
  /**
   * Reload on demand — the repeatable counterpart to {@link signal}, which
   * fires once and is over. The bin points `SIGHUP` at one.
   *
   * A command with something to reload listens for `'reload'` and calls
   * `preventDefault()` to say it took it; today that is `serve` and nothing
   * else. A command that ends by itself has nothing to reload, leaves the event
   * alone, and the bin then does what `SIGHUP` has always meant — which is why
   * this is handed in rather than the bin deciding from what was typed.
   */
  reloadOn?: EventTarget;
}

/** Anything the user can be told about and can fix. Not for programming errors. */
class UsageError extends Error {
  override readonly name = 'UsageError';
}

async function findConfig(explicit: string | undefined): Promise<string> {
  if (explicit) {
    return path.resolve(explicit);
  }

  for (const candidate of CONFIG_CANDIDATES) {
    const file = path.resolve(candidate);

    try {
      await access(file);
      return file;
    } catch {
      // keep looking
    }
  }

  throw new GrabberError(
    `No config file found (looked for ${CONFIG_CANDIDATES.join(', ')}). Use --config.`,
  );
}

async function loadConfig(file: string): Promise<ResolvedConfig> {
  const module = await import(pathToFileURL(file).href);
  const exported: ConfigSource | undefined = module.default;

  // A configuration whose values are answered elsewhere is a function until it
  // is called. There are no sources to offer it here, so it falls back to
  // whatever else it was defined with — normally the environment.
  const config = exported === undefined ? undefined : await resolveConfigSource(exported);

  if (!config || !Array.isArray(config.sites)) {
    throw new GrabberError(
      `Config file ${file} must default-export an EpgConfig, or a defineConfig() factory.`,
    );
  }

  return config;
}

function isRealDay(day: string): boolean {
  try {
    return toDayString(dayToDate(day)) === day;
  } catch {
    return false;
  }
}

/**
 * Whether a grab counts as a failure: a channel-day that could not be fetched
 * leaves the guide short, which is news even though the rest of it was written.
 *
 * Only the code. What the run *came to* — the summary line, and the failures
 * under it — is a `grab:done` event, and the reporter's business: it used to be
 * assembled here and the failures printed a second time in a format of their
 * own, which is how the same failure came to be said twice and differently.
 *
 * How much missing is too much is `fellShort`'s to say, and it says the same
 * thing for a `tv_grab_*` shim — one rule, two front doors.
 */
function exitCode(summary: GrabSummary, allowMissing: MissingAllowance | undefined): number {
  return fellShort(summary, allowMissing) ? EXIT_FAILED : 0;
}

/** `epg init-grabber <name>` — write the executable and say what to do with it. */
async function writeGrabber(
  values: { description?: string; 'grabber-version'?: string; force?: boolean },
  name: string | undefined,
  configFile: string,
  stdout: Writable,
  stderr: Writable,
): Promise<number> {
  if (name === undefined) {
    throw new UsageError('init-grabber needs a name, e.g. epg init-grabber tv_grab_sk_example');
  }

  const result = await initGrabber({
    name,
    configFile,
    ...(values.description === undefined ? {} : { description: values.description }),
    ...(values['grabber-version'] === undefined ? {} : { version: values['grabber-version'] }),
    ...(values.force === undefined ? {} : { force: values.force }),
  });

  await writeLines(stderr, ...result.warnings);
  await writeLines(stdout, `Wrote ${result.file}`, ...result.hints);

  return 0;
}

/**
 * What a config says its guide was written compressed with, if it says.
 *
 * `undefined` leaves the extension to decide, exactly as the writing side does
 * when `compress` is absent.
 */
function compressionOf(config: EpgConfig): CompressionFormat | false | undefined {
  const compress = config.compress;

  if (compress === undefined || compress === false) {
    return compress;
  }

  return typeof compress === 'object' ? compress.format : compress;
}

/** `epg validate [file]` — read a guide, write the report, say whether it passed. */
async function validateGuide(
  file: string,
  values: { format?: ReportFormat; strict?: boolean },
  stdout: Writable,
  signal: AbortSignal | undefined,
  compression?: CompressionFormat | false,
): Promise<number> {
  const report = await validateFile(file, {
    ...(values.strict === undefined ? {} : { strict: values.strict }),
    ...(signal ? { signal } : {}),
    ...(compression === undefined ? {} : { compression }),
  });

  // On stdout, both formats: the report *is* this command's output, the way a
  // guide is `merge`'s, so it goes where a shell can redirect it.
  await writeLines(stdout, renderReport(report, file, values.format ?? 'text'));

  return report.ok ? 0 : EXIT_FAILED;
}

/**
 * The flags each `epg cache` subcommand acts on, beyond {@link EVERY_CACHE_COMMAND}.
 * `prune`'s default day is today, which the `--timezone` says.
 */
const CACHE_FLAGS: Record<CacheCommand, ReadonlySet<string>> = {
  show: new Set(['format', 'indent']),
  stats: new Set(['format']),
  state: new Set(['format', 'keys']),
  prune: new Set(['before', 'timezone']),
};

/** What every `epg cache` subcommand takes: where the config and cache are, and how much to say. */
const EVERY_CACHE_COMMAND: ReadonlySet<string> = new Set([
  'config',
  'cache-dir',
  'cache-driver',
  'log-level',
  'quiet',
  'verbose',
  'reporter',
  'failures',
]);

/**
 * `epg cache <show|stats|state|prune>`: looking inside the cache, and pruning
 * it. The three that look are loaded only when asked for, and change nothing.
 */
async function cacheCommand(
  config: ResolvedConfig,
  [subcommand, ...args]: string[],
  values: Record<string, unknown> & {
    format?: ReportFormat;
    keys?: boolean;
    before?: string;
    indent?: string | number;
  },
  emit: Emit,
  stdout: Writable,
  stderr: Writable,
  signal: AbortSignal | undefined,
): Promise<number> {
  const { CACHE_COMMANDS, showCache, showState, writeCacheStats } = await import('./cache.js');

  if (!CACHE_COMMANDS.includes(subcommand as CacheCommand)) {
    throw new UsageError(
      subcommand === undefined
        ? `cache needs one of ${CACHE_COMMANDS.join(', ')}`
        : `Unknown cache command: ${subcommand}`,
    );
  }

  const command = subcommand as CacheCommand;
  const takes = { show: 3, stats: 1, state: 2, prune: 0 }[command];
  const [site, second, third] = args;

  // Everything a command line can get wrong, before the cache is opened: a
  // mistake is said with the usage, and a store is not opened for nothing.
  if (args.length > takes) {
    throw new UsageError(`cache ${command} takes at most ${count(takes, 'argument')}`);
  }

  if ((command === 'show' || command === 'state') && site === undefined) {
    throw new UsageError(
      command === 'show'
        ? 'cache show needs a site, e.g. cache show example.tv one.example.tv'
        : 'cache state needs a site, e.g. cache state example.tv',
    );
  }

  if (values.keys && (command !== 'state' || second === undefined)) {
    throw new UsageError(
      '--keys is for cache state with a group, e.g. cache state example.tv state',
    );
  }

  // A flag a subcommand would ignore is refused rather than ignored: `cache
  // show --before …` would otherwise show every day with nothing said, and
  // `cache stats --days 3` the whole cache.
  for (const [flag, value] of Object.entries(values)) {
    if (value !== undefined && !EVERY_CACHE_COMMAND.has(flag) && !CACHE_FLAGS[command].has(flag)) {
      throw new UsageError(`--${flag} is not for cache ${command}`);
    }
  }

  // XMLTV is what is indented; a record per line has nothing to indent.
  if (values.indent !== undefined && values.format === 'json') {
    throw new UsageError('--indent is for cache show as XMLTV, not --format json');
  }

  const day = command === 'show' && third !== undefined ? dayString(third, 'day') : undefined;

  await using cache = await createCacheStore(config, signal);
  const reading = {
    // The manager the config makes, which carries its `invalidate`: an entry a
    // run would void is reported as void.
    cache,
    ...(values.format ? { format: values.format } : {}),
    stdout,
    stderr,
    ...(signal ? { signal } : {}),
  };

  // Awaited before returning, each: the cache is closed on the way out of this
  // block, and a look handed back still running would read a closed one.
  switch (command) {
    case 'show':
      return await showCache(reading, site!, second, day, values.indent);
    case 'stats':
      return await writeCacheStats(reading, site);
    case 'state':
      return await showState(reading, site!, second, values.keys === true);
    case 'prune': {
      // Today, or the day before it for a site keeping a calendar whose window
      // starts there — which the guide still reads once it has been grabbed.
      const before =
        values.before ??
        earliestDay(config.sites, dayIn(new Date(), config.timeZone), config.timeZone);
      const removed = await cache.prune({ before });

      emit({ type: 'prune:done', removed, before });

      return 0;
    }
  }
}

/** `epg filter <file>` — write the guide again with only some of its channels. */
async function filterCommand(
  file: string | undefined,
  values: {
    channels?: string[];
    output?: string;
    extensions?: string[] | null;
    indent?: string | number;
    profile?: OutputProfileName;
  },
  stdout: Writable,
  stderr: Writable,
  signal: AbortSignal | undefined,
): Promise<number> {
  if (file === undefined) {
    throw new UsageError('epg filter needs a guide: epg filter <guide.xml> --channels <what>');
  }

  // Something has to change, or this is `cp` — and silently copying is a worse
  // answer than saying so. Narrowing the channels is the usual reason, but
  // reshaping the document is a real one too: `--no-extensions` on somebody
  // else's guide is what makes it validate, and that needs no `--channels`.
  if (
    values.channels === undefined &&
    values.profile === undefined &&
    values.extensions === undefined &&
    values.indent === undefined
  ) {
    throw new UsageError(
      'epg filter needs something to do: --channels, --profile, --extensions/--no-extensions or --indent',
    );
  }

  const { wantedIds } = await import('./lists.js');
  const { filterGuide } = await import('./filter.js');
  const channels = values.channels === undefined ? undefined : new Set<string>();

  for (const value of values.channels ?? []) {
    for (const id of await wantedIds(value)) {
      channels!.add(id);
    }
  }

  if (channels !== undefined && channels.size === 0) {
    throw new UsageError(`--channels named no channels: ${values.channels!.join(' ')}`);
  }

  const report = await filterGuide(file, {
    ...(channels ? { channels } : {}),
    // The caller's stdout when nothing was named, so it pipes — and so a test
    // reads it rather than the process's.
    output: values.output ?? stdout,
    ...outputOptions(values),
    stderr,
    ...(signal ? { signal } : {}),
  });

  // On stderr, always: stdout may be the guide itself, and a summary in the
  // middle of a document would be the one thing worse than no summary.
  await writeLines(
    stderr,
    ...(report.missing.length > 0
      ? [
          `${report.missing.length} of ${channels?.size ?? 0} channels are not in ${file}: ${report.missing.join(', ')}`,
        ]
      : []),
    `${count(report.kept, 'channel')}, ${count(report.programmes, 'programme')}`,
  );

  return 0;
}

/**
 * Run the `epg` command line. Resolves to the exit code; nothing here reads or
 * writes `process`, so a test drives it exactly as a shell does.
 */
export async function runCli(argv: string[], options: CliOptions = {}): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  try {
    return await execute(argv, stdout, stderr, options);
  } catch (thrown) {
    // A run that failed, whose reporter threw as well: its own failure is what
    // it exits on, and the reporter's is said before it — cancelled or not.
    const [error, reporting] =
      thrown instanceof RunFailedError ? [thrown.error, thrown.reporter] : [thrown, undefined];

    if (reporting !== undefined) {
      await writeLines(stderr, reporting.message);
    }

    // Whatever the interruption surfaced as — a merge's own abort, a request
    // dropped mid-flight — a cancelled run is not a failure to describe.
    if (options.signal?.aborted) {
      // Though what a reporter threw at the run, before it was cancelled, is
      // still said.
      if (error instanceof ReporterError) {
        await writeLines(stderr, error.message);
      }

      await writeLines(stderr, 'Cancelled.');
      return EXIT_CANCELLED;
    }

    if (error instanceof OptionError || error instanceof UsageError) {
      // What was typed was wrong, so the usage goes with the message.
      await writeFlushed(stderr, `${error.message}\n\n${USAGE}`);
      return EXIT_USAGE;
    }

    if (error instanceof GrabberError) {
      // Includes anything a configuration threw while answering itself.
      await writeLines(stderr, error.message);
      return error.code;
    }

    // Including whatever a config file threw on its way to being loaded, and
    // the odd `throw 'string'` — a bin reports and exits rather than letting
    // one become an unhandled rejection with a stack.
    await writeLines(stderr, error instanceof Error ? error.message : String(error));

    return EXIT_FAILED;
  } finally {
    // Everything this writes itself is awaited; the reporter's lines are not,
    // because a reporter is synchronous and a grab must not wait on one. So the
    // run ends by draining, which is what lets a caller exit the moment it
    // resolves — `process.exit()` discards whatever is still buffered, and a run
    // at `--log-level debug` outgrows a pipe's 64 KB.
    await Promise.all([drain(stdout), drain(stderr)]);
  }
}

async function execute(
  argv: string[],
  stdout: Writable,
  stderr: Writable,
  options: CliOptions,
): Promise<number> {
  const { signal } = options;

  const { values, positionals } = parseOptions(
    argv,
    {
      config: { type: 'string', short: 'c' },
      days: { type: 'number', short: 'd', min: 1 },
      offset: { type: 'number' },
      timezone: { type: 'string', transform: timeZone },
      // Resolved as they are read, so what reaches the config is already
      // absolute — a grabber runs from wherever it was called.
      output: { type: 'string', short: 'o', transform: (raw) => path.resolve(raw) },
      'cache-dir': { type: 'string', transform: (raw) => path.resolve(raw) },
      // Only a name for the driver and the reporter: a config can point at one
      // of its own by passing a function, which is not something a command line
      // can do.
      'cache-driver': { type: 'string', choices: CACHE_DRIVER_NAMES },
      refresh: { type: 'boolean' },
      // A count, or bare for one per core. Negatable, because a config can turn
      // them on: `--no-threads` is how a run says otherwise without editing it.
      threads: { type: 'string', optionalValue: 'true', negatable: true, transform: poolSize },
      'dry-run': { type: 'boolean' },
      'allow-missing': { type: 'string', transform: allowance },
      port: { type: 'number', min: 0, max: 65_535 },
      host: { type: 'string' },
      'serve-path': { type: 'string' },
      // Negatable, because a health check is a thing a deployment may not want
      // at all — unlike the guide path, which has to be somewhere.
      health: { type: 'string', negatable: true },
      'grab-every': { type: 'string', transform: interval },
      'grab-at': { type: 'string', transform: timeOfDay },
      raw: { type: 'boolean' },
      format: { type: 'string', choices: REPORT_FORMATS },
      // Repeatable, and each for the commands whose run it is about: what a
      // run said of one thing, explained once it is done.
      explain: { type: 'string', choices: EXPLAINABLE, multiple: true },
      strict: { type: 'boolean' },
      // `epg channels` only: the file naming the channels somebody wants a
      // guide for, and whether a mismatch should fail a CI step.
      against: { type: 'string' },
      check: { type: 'boolean' },
      // `epg channels` only: put the ids the report suggested back into the
      // file it read them from.
      write: { type: 'boolean' },
      // Repeatable, and the union of what each names: a list kept in git plus
      // the one id being tried out is a normal thing to want, and overwriting
      // would make the order of two flags matter.
      channels: { type: 'string', multiple: true },
      // A number of spaces or a literal string, mirroring `JSON.stringify` — so
      // `--indent 2` and `--indent '\t'` both mean what they look like.
      indent: { type: 'string', transform: indentation },
      // A list of names, or `--no-extensions` for none of them. A config can
      // point at a filter of its own by passing a function, which is not
      // something a command line can do.
      extensions: { type: 'string', negatable: true, transform: extensionNames },
      // A shipped name only. A config can pass a profile of its own, which is
      // not something a command line can do — the same limit as `extensions`.
      profile: { type: 'string', choices: OUTPUT_PROFILE_NAMES },
      before: { type: 'string', transform: dayString },
      // `epg cache state` only: a group's keys rather than what it holds.
      keys: { type: 'boolean' },
      quiet: { type: 'boolean', short: 'q' },
      verbose: { type: 'boolean', short: 'v' },
      'log-level': { type: 'string', choices: LEVELS },
      reporter: { type: 'string', choices: REPORTER_NAMES },
      failures: { type: 'string', choices: FAILURE_MODES },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'V' },
      description: { type: 'string' },
      'grabber-version': { type: 'string' },
      force: { type: 'boolean' },
    },
    { allowPositionals: true },
  );

  if (values.help) {
    await writeFlushed(stdout, USAGE);
    return 0;
  }

  if (values.version) {
    await writeLines(stdout, `${__PKG_NAME__} ${__PKG_VERSION__}`);
    return 0;
  }

  const command = positionals[0] ?? 'build';

  // Moved, and said where to, so a job that ran it learns more than that it
  // is gone.
  if (command === 'prune') {
    throw new UsageError('Unknown command: prune — it is epg cache prune now');
  }

  if (!COMMANDS.includes(command)) {
    throw new UsageError(`Unknown command: ${command}`);
  }

  // Before anything a command does: an option it would only pass over is a
  // mistake to say rather than to swallow.
  if (values.explain !== undefined) {
    for (const name of values.explain) {
      const commands = explainCommands(name);

      if (!commands.includes(command)) {
        throw new UsageError(`--explain ${name} is for ${commands.join(', ')}, not ${command}`);
      }
    }

    if (values['dry-run']) {
      throw new UsageError('--explain is for a run, not --dry-run');
    }

    // On stderr, beside what else a run says there: what reads it is a person.
    // A program has every one of them as an event of its own.
    if (values.format === 'json') {
      throw new UsageError(
        '--explain is for reading — for its events as JSON: --reporter json --log-level debug',
      );
    }
  }

  // Before the config is even looked for: a guide named on the command line is
  // the whole of what this needs, and refusing to read one because there is no
  // project in the working directory would be absurd. Without a name it is the
  // config's own `output`, and the config is then exactly what says where.
  if (command === 'validate' && positionals[1] !== undefined) {
    return validateGuide(positionals[1], values, stdout, signal);
  }

  // For the same reason, and always: a guide to subset is named on the command
  // line or there is nothing to do, so this never wants a config at all.
  if (command === 'filter') {
    return filterCommand(positionals[1], values, stdout, stderr, signal);
  }

  const configFile = await findConfig(values.config);

  // Before the config is *loaded*: scaffolding only needs to know where it is,
  // and asking for a site's password to write a file next to it would be absurd.
  if (command === 'init-grabber') {
    return writeGrabber(values, positionals[1], configFile, stdout, stderr);
  }

  let config = await loadConfig(configFile);

  if (values.days !== undefined) {
    config = { ...config, days: values.days };
  }

  if (values.timezone !== undefined) {
    config = { ...config, timeZone: values.timezone };
  }

  if (values.output !== undefined) {
    config = { ...config, output: values.output };
  }

  if (values['cache-dir'] !== undefined) {
    config = { ...config, cache: { ...config.cache, dir: values['cache-dir'] } };
  }

  if (values['cache-driver'] !== undefined) {
    config = { ...config, cache: { ...config.cache, driver: values['cache-driver'] } };
  }

  if (
    values.port !== undefined ||
    values.host !== undefined ||
    values['serve-path'] !== undefined ||
    values.health !== undefined ||
    values['grab-every'] !== undefined ||
    values['grab-at'] !== undefined
  ) {
    config = {
      ...config,
      serve: {
        ...config.serve,
        ...(values.port !== undefined ? { port: values.port } : {}),
        ...(values.host !== undefined ? { host: values.host } : {}),
        ...(values['serve-path'] !== undefined ? { path: values['serve-path'] } : {}),
        // `null` is `--no-health`, which is off — not the "let the config
        // decide" that `undefined` means.
        ...(values.health !== undefined ? { health: values.health ?? false } : {}),
        // Through the shipped helper rather than a second reading of the same
        // words: the flags and `grabEvery` cannot drift if one builds the other.
        //
        // A time of day on its own is a daily grab, which is what naming one
        // and no interval means — and the commonest of the two to want.
        ...(values['grab-every'] !== undefined || values['grab-at'] !== undefined
          ? {
              grab: grabEvery(values['grab-every'] ?? '1d', {
                ...(values['grab-at'] !== undefined ? { at: values['grab-at'] } : {}),
              }),
            }
          : {}),
      },
    };
  }

  if (values['allow-missing'] !== undefined) {
    config = { ...config, allowMissing: values['allow-missing'] };
  }

  // Up front, whichever it came from. `fellShort` only resolves it when
  // something has already failed, so a config with `allowMissing: '5 percent'`
  // in it would otherwise throw after the guide was written, on the nights a
  // day happened to be lost and not on the others.
  if (config.allowMissing !== undefined) {
    resolveAllowance(config.allowMissing, 'allowMissing');
  }

  if (values.channels !== undefined) {
    // Only where narrowing a run means something. `epg channels --against x
    // --channels y` would make the availability report *lie* — every excluded
    // channel reading as "nothing produces this", which is the exact failure
    // that command exists to find — and `try` would call its own channel
    // unknown.
    if (!SELECTABLE.includes(command)) {
      throw new UsageError(`--channels is for ${SELECTABLE.join(', ')}, not ${command}`);
    }

    const { wantedIds } = await import('./lists.js');
    const selected = new Set<string>();

    for (const value of values.channels) {
      for (const id of await wantedIds(value)) {
        selected.add(id);
      }
    }

    if (selected.size === 0) {
      throw new UsageError(`--channels named no channels: ${values.channels.join(' ')}`);
    }

    config = { ...config, channels: [...selected] };
  }

  // The three that shape the document, overlaid by the one helper that knows
  // how — including that a `null` from `--no-extensions` means "none" rather
  // than "the config decides", which is the third state a negatable option has.
  config = { ...config, ...outputOptions(values) };

  if (values.refresh) {
    // The reading of the cache is what this turns off, not the writing: the days
    // still land in it for the run after this one.
    config = {
      ...config,
      cache: { ...config.cache, staleness: { ...config.cache?.staleness, refetchAll: true } },
    };
  }

  if (values.threads !== undefined) {
    // `null` is `--no-threads`.
    config = { ...config, threads: values.threads ?? false };
  }

  // `--log-level` is the explicit answer and wins; between the two shorthands
  // the quieter one does, so `-qv` in a script cannot turn silence into fourteen
  // thousand lines.
  const level: EventLevel =
    values['log-level'] ?? (values.quiet ? 'error' : values.verbose ? 'debug' : 'info');
  // `progress` rather than `text` by default, and it is the text one on anything
  // that is not a terminal — a pipe, a file, a CI log — so what a script reads
  // is unchanged and only an interactive run gets the line.
  const chosen = reporterFor(values.reporter ?? config.reporter ?? 'progress', {
    stdout,
    stderr,
    level,
    ...(values.failures ? { failures: values.failures } : {}),
  });
  // `config.events` is added here only for what this file says itself — the
  // library entries below add it to what *they* say, and adding it twice would
  // have an emitter hear every run's events twice over. The two sets are
  // disjoint: `merge:done` is the command's, everything inside a run is not.
  const { reporter: said } = reportingTo(chosen ? { reporter: chosen } : {}, config.events);
  const emit = said ? stamped(said) : silent;

  // What `--explain` asked for, kept as the run says it.
  const { reporter: collector, render: renderExplanations } = explanations(values.explain ?? []);
  const reporter = collector ? combineReporters(chosen, collector) : chosen;
  const runOptions = {
    ...(reporter ? { reporter } : {}),
    ...(values.offset !== undefined ? { offset: values.offset } : {}),
    ...(signal ? { signal } : {}),
    // The file this loaded, which is what a site's thread imports to find its
    // site. What the flags above changed stays here, and reaches a thread as
    // the run does — the cache it answers, the window and staleness it is
    // handed, the channels already settled — so nothing is lost by its
    // reading the file as written.
    configModule: pathToFileURL(configFile).href,
  };

  if (values['dry-run']) {
    if (command !== 'grab' && command !== 'build') {
      throw new UsageError(`--dry-run is for grab, build, not ${command}`);
    }

    // The real cache, not a `NoCacheDriver` as `epg try` uses: what is already
    // cached is half of what this report is about, and a site with a fresh
    // `cacheChannels` list should be read rather than asked.
    const { createCacheStore } = await import('../build.js');
    const { planRun, writePlanReport } = await import('./plan.js');
    const { channelSelection } = await import('../merge/select.js');
    const cache = await createCacheStore(config, signal);
    // What the run itself would select, `grab` as much as `build`: a channel
    // left out is never fetched by either.
    // Only what is written down: a `derived` function is a function of the
    // channel lists, and a report that is not going to fetch anything has no
    // lists to ask it about. What that costs is a plan whose narrowing misses
    // the sources a declared shift would have kept — visible only under
    // `--channels` with a `derived` function, and a count either way.
    const selection = channelSelection({
      ...(config.channels ? { channels: config.channels } : {}),
      ...(Array.isArray(config.derived) ? { derived: config.derived } : {}),
    });

    try {
      const report = await planRun(config, cache, {
        ...(values.offset !== undefined ? { offset: values.offset } : {}),
        ...(signal ? { signal } : {}),
        ...(selection ? { select: selection.select } : {}),
      });

      await writePlanReport(report, stdout, values.format ?? 'text');

      // A site that could not be planned is a site a run would have reported as
      // answering nothing, and that exits 1 — a report of the same config should
      // not be the quieter of the two.
      return report.totals.failed > 0 ? 1 : 0;
    } finally {
      await cache.close();
    }
  }

  switch (command) {
    case 'build': {
      const summary = await build(config, runOptions);

      // A cancelled grab resolves with what it managed rather than throwing, so
      // the interruption is noticed here — the grab has already said so as a
      // `run:cancelled`, which is also what tells a reporter to drop the
      // failures the cancel itself caused.
      if (signal?.aborted) {
        return EXIT_CANCELLED;
      }

      emit({ type: 'merge:done', output: String(config.output) });
      await renderExplanations(stderr, config);

      return exitCode(summary, config.allowMissing);
    }
    case 'grab': {
      const summary = await runGrab(config, runOptions);

      if (signal?.aborted) {
        return EXIT_CANCELLED;
      }

      await renderExplanations(stderr, config);

      return exitCode(summary, config.allowMissing);
    }
    case 'merge': {
      await runMerge(config, runOptions);

      emit({ type: 'merge:done', output: String(config.output) });
      await renderExplanations(stderr, config);

      return 0;
    }
    case 'validate':
      // Only the no-file form reaches here; the other is answered above, before
      // a config was needed. Validating what this project writes is what the
      // command is usually for, so its `output` is the default.
      //
      // With the config's own `compress`, which outranks the extension the
      // same way it does on the way out — otherwise `output: 'guide.xml'`
      // plus `compress: 'gzip'` would be read back as XML it is not.
      return validateGuide(String(config.output), values, stdout, signal, compressionOf(config));
    case 'channels': {
      // Loaded here rather than at the top: it pulls in the matcher and three
      // readers, and no other command has any use for them.
      const { reportChannelsCommand } = await import('./channels.js');

      return reportChannelsCommand(
        config,
        {
          against: values.against,
          format: values.format,
          check: values.check,
          write: values.write,
          output: values.output,
          ...(signal ? { signal } : {}),
        },
        stdout,
        stderr,
      );
    }
    case 'serve': {
      const { serveGuide } = await import('../serve/main.js');
      // `runOptions` already carries the reporter, the offset and the signal —
      // the same three a grab or a merge is given, and for the same reasons.
      // The reload target goes with them, and only here: it is the one command
      // that can act on one, which is what keeps `SIGHUP` meaning what it
      // always did everywhere else.
      const server = await serveGuide(config, {
        ...runOptions,
        ...(options.reloadOn ? { reloadOn: options.reloadOn } : {}),
      });

      // The one command that outlives its own work: everything else has
      // finished by the time it returns, and this has only started.
      await server.closed;

      // A server that was asked to stop did what it was asked. Nothing failed,
      // and nothing was left half done — which is why this is 0 and not the
      // 130 a cancelled grab answers with.
      return 0;
    }
    case 'try': {
      const [, siteName, channelName, when] = positionals;

      if (siteName === undefined || channelName === undefined) {
        throw new UsageError(
          'try needs a site and a channel, e.g. epg try example.tv one.example.tv',
        );
      }

      const { tryChannelDay } = await import('./try.js');

      return tryChannelDay(config, siteName, channelName, stdout, {
        ...(when === undefined ? {} : { day: dayString(when, 'day') }),
        ...(values.raw === undefined ? {} : { raw: values.raw }),
        ...(signal ? { signal } : {}),
      });
    }
    case 'cache':
      return cacheCommand(config, positionals.slice(1), values, emit, stdout, stderr, signal);
    default: {
      // Unreachable: `COMMANDS` is checked above, so a command with no case
      // here fails to compile rather than silently pruning the cache — which
      // is what the old `default:` would have done with it.
      const named: never = command as never;

      throw new UsageError(`Unknown command: ${String(named)}`);
    }
  }
}
