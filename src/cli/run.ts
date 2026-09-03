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
import { resolveConfigSource, type ConfigSource, type EpgConfig } from '../config.js';
import { build, createCacheStore, runGrab, runMerge } from '../build.js';
import { CACHE_DRIVER_NAMES } from '../cache/main.js';
import { fellShort, resolveAllowance } from '../grabber/main.js';
import type { MissingAllowance } from '../grabber/main.js';
import { GrabberError } from '../core/error.js';
import { OptionError, parseOptions } from '../core/options.js';
import { dayToDate, toDayString } from '../core/days.js';
import { silent, stamped, LEVELS, type EventLevel } from '../core/events.js';
import { FAILURE_MODES, reporterFor, REPORTER_NAMES } from '../core/reporters.js';
import { drain, writeFlushed, writeLines } from '../core/streams.js';
import { initGrabber } from './scaffold.js';
import type { GrabSummary } from '../grabber/types.js';

export const USAGE = `Usage: epg <command> [options]

Commands:
  build         Grab all sites into the cache, then generate the merged guide (default)
  grab          Grab all sites into the cache only
  merge         Generate the merged guide from the cache only
  prune         Remove cached days older than a given day
  init-grabber  Write a tv_grab_* executable for the config, next to it

Options:
  -c, --config <path>   Config file (default: epg.config.ts|js|mjs in cwd)
  -d, --days <n>        Override the number of days
      --offset <n>      Start the window n days from today (may be negative)
  -o, --output <path>   Override the output file, or a Unix socket to write into
      --cache-dir <dir> Override the cache directory
      --cache-driver <name>  Override where cached days are kept: ndjson, xmltv,
                        sqlite or memory
      --refresh         Refetch every day in the window, ignoring what is cached
      --allow-missing <n>   Exit 0 with up to this much of the guide missing:
                        a number of channel-days, or a share like 5%
      --extensions <names>  build/merge only: keep only these provider
                        extensions, comma-separated (e.g. lcn,uniqueID)
      --no-extensions   build/merge only: leave every provider extension out,
                        for a guide that validates against the DTD
      --before <day>    prune only: remove days before YYYY-MM-DD (default: today)
      --log-level <l>   How much to report: error, warn, info (default) or debug
  -v, --verbose         Same as --log-level debug
  -q, --quiet           Same as --log-level error. Beats --verbose if both are given
      --reporter <name> How to report it: progress (default, a live line on a
                        terminal and text elsewhere), text or json
      --failures <how>  block (default) — one capped block at the end; or inline
  -V, --version         Print this package's version
  -h, --help            Show this help

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
 * An `--allow-missing` value, checked before the run rather than after it.
 *
 * The same reading the config field gets, so `20`, `5%` and the ways of getting
 * either wrong mean one thing wherever they are written — but reported as
 * something typed, which is what puts the usage on screen and exits 2.
 */
function allowance(raw: string, flag: string): string {
  try {
    resolveAllowance(raw, flag);
  } catch (error) {
    throw new OptionError(error instanceof Error ? error.message : String(error));
  }

  return raw;
}

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

const COMMANDS = ['build', 'grab', 'merge', 'prune', 'init-grabber'];

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

async function loadConfig(file: string): Promise<EpgConfig> {
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
 * Run the `epg` command line. Resolves to the exit code; nothing here reads or
 * writes `process`, so a test drives it exactly as a shell does.
 */
export async function runCli(argv: string[], options: CliOptions = {}): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  try {
    return await execute(argv, stdout, stderr, options.signal);
  } catch (error) {
    // Whatever the interruption surfaced as — a merge's own abort, a request
    // dropped mid-flight — a cancelled run is not a failure to describe.
    if (options.signal?.aborted) {
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
  signal: AbortSignal | undefined,
): Promise<number> {
  const { values, positionals } = parseOptions(
    argv,
    {
      config: { type: 'string', short: 'c' },
      days: { type: 'number', short: 'd', min: 1 },
      offset: { type: 'number' },
      // Resolved as they are read, so what reaches the config is already
      // absolute — a grabber runs from wherever it was called.
      output: { type: 'string', short: 'o', transform: (raw) => path.resolve(raw) },
      'cache-dir': { type: 'string', transform: (raw) => path.resolve(raw) },
      // Only a name for the driver and the reporter: a config can point at one
      // of its own by passing a function, which is not something a command line
      // can do.
      'cache-driver': { type: 'string', choices: CACHE_DRIVER_NAMES },
      refresh: { type: 'boolean' },
      'allow-missing': { type: 'string', transform: allowance },
      // A list of names, or `--no-extensions` for none of them. A config can
      // point at a filter of its own by passing a function, which is not
      // something a command line can do.
      extensions: { type: 'string', negatable: true, transform: extensionNames },
      before: { type: 'string', transform: dayString },
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

  if (!COMMANDS.includes(command)) {
    throw new UsageError(`Unknown command: ${command}`);
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

  if (values.output !== undefined) {
    config = { ...config, output: values.output };
  }

  if (values['cache-dir'] !== undefined) {
    config = { ...config, cache: { ...config.cache, dir: values['cache-dir'] } };
  }

  if (values['cache-driver'] !== undefined) {
    config = { ...config, cache: { ...config.cache, driver: values['cache-driver'] } };
  }

  // `null` is `--no-extensions` — the third state a negatable option has, and
  // the one that means "none" rather than "the config decides".
  if (values.extensions !== undefined) {
    config = { ...config, extensions: values.extensions ?? false };
  }

  if (values['allow-missing'] !== undefined) {
    config = { ...config, allowMissing: values['allow-missing'] };
  }

  if (values.refresh) {
    // The reading of the cache is what this turns off, not the writing: the days
    // still land in it for the run after this one.
    config = {
      ...config,
      cache: { ...config.cache, staleness: { ...config.cache?.staleness, refetchAll: true } },
    };
  }

  // `--log-level` is the explicit answer and wins; between the two shorthands
  // the quieter one does, so `-qv` in a script cannot turn silence into fourteen
  // thousand lines.
  const level: EventLevel =
    values['log-level'] ?? (values.quiet ? 'error' : values.verbose ? 'debug' : 'info');
  // `progress` rather than `text` by default, and it is the text one on anything
  // that is not a terminal — a pipe, a file, a CI log — so what a script reads
  // is unchanged and only an interactive run gets the line.
  const reporter = reporterFor(values.reporter ?? config.reporter ?? 'progress', {
    stdout,
    stderr,
    level,
    ...(values.failures ? { failures: values.failures } : {}),
  });
  const emit = reporter ? stamped(reporter) : silent;
  const runOptions = {
    ...(reporter ? { reporter } : {}),
    ...(values.offset !== undefined ? { offset: values.offset } : {}),
    ...(signal ? { signal } : {}),
  };

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

      return exitCode(summary, config.allowMissing);
    }
    case 'grab': {
      const summary = await runGrab(config, runOptions);

      return signal?.aborted ? EXIT_CANCELLED : exitCode(summary, config.allowMissing);
    }
    case 'merge': {
      await runMerge(config, runOptions);
      emit({ type: 'merge:done', output: String(config.output) });

      return 0;
    }
    default: {
      const before = values.before ?? toDayString(new Date());

      await using cache = await createCacheStore(config, signal);
      const removed = await cache.prune({ before });

      emit({ type: 'prune:done', removed, before });

      return 0;
    }
  }
}
