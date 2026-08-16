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
import type { GrabSummary } from '../grabber/types.js';

export const USAGE = `Usage: epg <command> [options]

Commands:
  build   Grab all sites into the cache, then generate the merged guide (default)
  grab    Grab all sites into the cache only
  merge   Generate the merged guide from the cache only
  prune   Remove cached days older than a given day

Options:
  -c, --config <path>   Config file (default: epg.config.ts|js|mjs in cwd)
  -d, --days <n>        Override the number of days
      --offset <n>      Start the window n days from today (may be negative)
  -o, --output <path>   Override the output file, or a Unix socket to write into
      --cache-dir <dir> Override the cache directory
      --before <day>    prune only: remove days before YYYY-MM-DD (default: today)
  -q, --quiet           Suppress progress output
  -h, --help            Show this help
`;

/** Something the user typed: the usage goes with it, as the grabber does. */
const EXIT_USAGE = 2;

/** The run failed, or finished with data missing. */
const EXIT_FAILED = 1;

const CONFIG_CANDIDATES = ['epg.config.ts', 'epg.config.js', 'epg.config.mjs'];

export interface CliOptions {
  /** Defaults to `process.stdout` — progress, and the help. */
  stdout?: Writable;
  /** Defaults to `process.stderr` — failures. */
  stderr?: Writable;
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

/** One line, terminated. */
function line(stream: Writable, message: string): void {
  stream.write(`${message}\n`);
}

/**
 * Report a grab, and say whether it counts as a failure: a channel-day that
 * could not be fetched leaves the guide short, which is news even though the
 * rest of it was written.
 */
function report(summary: GrabSummary, log: ((message: string) => void) | undefined, stderr: Writable): number {
  log?.(`Grab done: ${summary.fetched} fetched, ${summary.fromCache} from cache, ${summary.failed.length} failed`);

  for (const failure of summary.failed) {
    const message = failure.error instanceof Error ? failure.error.message : String(failure.error);
    // A failure, so it is reported even under --quiet.
    line(stderr, `  FAILED [${failure.site}] ${failure.channelId} ${failure.day}: ${message}`);
  }

  return summary.failed.length > 0 ? EXIT_FAILED : 0;
}

/**
 * Run the `epg` command line. Resolves to the exit code; nothing here reads or
 * writes `process`, so a test drives it exactly as a shell does.
 */
export async function runCli(argv: string[], options: CliOptions = {}): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  try {
    return await execute(argv, stdout, stderr);
  } catch (error) {
    if (error instanceof OptionError || error instanceof UsageError) {
      // What was typed was wrong, so the usage goes with the message.
      stderr.write(`${error.message}\n\n${USAGE}`);
      return EXIT_USAGE;
    }

    if (error instanceof GrabberError) {
      // Includes anything a configuration threw while answering itself.
      line(stderr, error.message);
      return error.code;
    }

    // Including whatever a config file threw on its way to being loaded, and
    // the odd `throw 'string'` — a bin reports and exits rather than letting
    // one become an unhandled rejection with a stack.
    line(stderr, error instanceof Error ? error.message : String(error));

    return EXIT_FAILED;
  }
}

async function execute(argv: string[], stdout: Writable, stderr: Writable): Promise<number> {
  const { values, positionals } = parseOptions(argv, {
    config: { type: 'string', short: 'c' },
    days: { type: 'number', short: 'd', min: 1 },
    offset: { type: 'number' },
    output: { type: 'string', short: 'o' },
    'cache-dir': { type: 'string' },
    before: { type: 'string' },
    quiet: { type: 'boolean', short: 'q' },
    help: { type: 'boolean', short: 'h' },
  }, { allowPositionals: true });

  if (values.help) {
    stdout.write(USAGE);
    return 0;
  }

  const command = positionals[0] ?? 'build';

  if (!['build', 'grab', 'merge', 'prune'].includes(command)) {
    throw new UsageError(`Unknown command: ${command}`);
  }

  const configFile = await findConfig(values.config);
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

  const log = values.quiet ? undefined : (message: string) => line(stdout, message);
  const runOptions = {
    ...(log ? { logger: log } : {}),
    ...(values.offset !== undefined ? { offset: values.offset } : {}),
  };

  switch (command) {
    case 'build': {
      const code = report(await build(config, runOptions), log, stderr);
      log?.(`Guide written to ${config.output}`);
      return code;
    }
    case 'grab':
      return report(await runGrab(config, runOptions), log, stderr);
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
