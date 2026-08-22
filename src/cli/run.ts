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
import { GrabberError } from '../core/error.js';
import { OptionError, parseOptions } from '../core/options.js';
import { dayToDate, toDayString } from '../core/days.js';
import { drain, queueLine, writeFlushed, writeLines } from '../core/streams.js';
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
      --before <day>    prune only: remove days before YYYY-MM-DD (default: today)
  -q, --quiet           Suppress progress output
  -v, --version         Print this package's version
  -h, --help            Show this help

init-grabber options:
      --description <s> What --description prints (default: the country and name)
      --grabber-version <v>  The grabber's own version, as its --version
                        reports it (default: the project's package.json
                        version, else 0.1.0)
      --force           Replace an existing file
`;

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
 * Report a grab, and say whether it counts as a failure: a channel-day that
 * could not be fetched leaves the guide short, which is news even though the
 * rest of it was written.
 */
async function report(
  summary: GrabSummary,
  log: ((message: string) => void) | undefined,
  stderr: Writable,
): Promise<number> {
  // A day that came back with nothing is not a failure — a channel with no
  // listings is a legitimate answer — but it is the one thing a run cannot
  // otherwise see, so it is named beside the fetches it is part of.
  const fetched =
    summary.empty > 0
      ? `${summary.fetched} fetched (${summary.empty} empty)`
      : `${summary.fetched} fetched`;

  log?.(`Grab done: ${fetched}, ${summary.fromCache} from cache, ${summary.failed.length} failed`);

  // Failures, so they are reported even under --quiet.
  await writeLines(
    stderr,
    ...summary.failed.map((failure) => {
      const message =
        failure.error instanceof Error ? failure.error.message : String(failure.error);
      return `  FAILED [${failure.site}] ${failure.channelId} ${failure.day}: ${message}`;
    }),
  );

  return summary.failed.length > 0 ? EXIT_FAILED : 0;
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
    // Everything this writes itself is awaited; the progress lines are not,
    // because `RunOptions.logger` is synchronous and a grab must not wait on
    // one. So the run ends by draining, which is what lets a caller exit the
    // moment it resolves — `process.exit()` discards whatever is still
    // buffered, and a run logging every channel-day outgrows a pipe's 64 KB.
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
      output: { type: 'string', short: 'o' },
      'cache-dir': { type: 'string' },
      before: { type: 'string' },
      quiet: { type: 'boolean', short: 'q' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
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
    config = { ...config, output: path.resolve(values.output) };
  }

  if (values['cache-dir'] !== undefined) {
    config = { ...config, cache: { ...config.cache, dir: path.resolve(values['cache-dir']) } };
  }

  const log = values.quiet ? undefined : (message: string) => queueLine(stdout, message);
  const runOptions = {
    ...(log ? { logger: log } : {}),
    ...(values.offset !== undefined ? { offset: values.offset } : {}),
    ...(signal ? { signal } : {}),
  };

  /**
   * What a cancelled grab amounts to: it resolves with what it managed rather
   * than throwing, so the interruption has to be noticed here — and it outranks
   * the failures, which are mostly requests the cancel itself dropped.
   */
  const cancelled = async (summary: GrabSummary): Promise<number> => {
    await writeLines(
      stderr,
      `Cancelled. ${summary.fetched} channel-day(s) reached the cache; no guide was written.`,
    );

    return EXIT_CANCELLED;
  };

  switch (command) {
    case 'build': {
      const summary = await build(config, runOptions);

      if (signal?.aborted) {
        return cancelled(summary);
      }

      const code = await report(summary, log, stderr);
      log?.(`Guide written to ${config.output}`);
      return code;
    }
    case 'grab': {
      const summary = await runGrab(config, runOptions);

      return signal?.aborted ? cancelled(summary) : await report(summary, log, stderr);
    }
    case 'merge': {
      await runMerge(config, runOptions);
      log?.(`Guide written to ${config.output}`);
      return 0;
    }
    default: {
      const before = values.before ?? toDayString(new Date());

      // The regex alone would accept "2026-99-99", which as a string
      // comparison cutoff would prune far too much — verify it is a real day.
      if (!/^\d{4}-\d{2}-\d{2}$/.test(before) || !isRealDay(before)) {
        throw new UsageError(`Invalid --before value: ${before} (expected YYYY-MM-DD)`);
      }

      const removed = await createCacheStore(config).prune({ before });
      log?.(`Pruned ${removed} cached entr${removed === 1 ? 'y' : 'ies'} before ${before}`);

      return 0;
    }
  }
}
