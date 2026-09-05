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
import { renderReport, REPORT_FORMATS, validateFile } from './validate.js';
import type { ReportFormat } from './validate.js';
import type { CompressionFormat } from '../core/output.js';
import type { GrabSummary } from '../grabber/types.js';

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
      --indent <n|str>  build/merge/filter: pretty-print with this indentation
      --channels <what> keep only these channels, and fetch nothing for the
                        rest. Ids, or a file naming them — a playlist, a
                        *.channels.xml, a guide, or a plain list. Repeatable.
                        build/grab/merge/serve, and required by filter
      --against <file>  channels only: what you want a guide for — an M3U
                        playlist, a *.channels.xml, or an XMLTV guide
      --check           channels only: exit 1 unless every wanted channel
                        matched by id, for a CI step
      --before <day>    prune only: remove days before YYYY-MM-DD (default: today)
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

validate options:
      --format <how>    text (default) or json
      --strict          Count warnings as failures too

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

/** The commands `--channels` narrows. The rest are told so rather than ignoring it. */
const SELECTABLE = ['build', 'grab', 'merge', 'serve'];

/** `2 channels`, `1 channel` — a count is read, so it should read. */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
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
  'prune',
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
  await writeFlushed(stdout, renderReport(report, file, values.format ?? 'text'));

  return report.ok ? 0 : EXIT_FAILED;
}

/** `epg filter <file>` — write the guide again with only some of its channels. */
async function filterCommand(
  file: string | undefined,
  values: {
    channels?: string[];
    output?: string;
    extensions?: string[] | null;
    indent?: string | number;
  },
  stdout: Writable,
  stderr: Writable,
  signal: AbortSignal | undefined,
): Promise<number> {
  if (file === undefined) {
    throw new UsageError('epg filter needs a guide: epg filter <guide.xml> --channels <what>');
  }

  if (values.channels === undefined) {
    // Without one this is `cp`, and silently copying is a worse answer than
    // saying what was left out.
    throw new UsageError('epg filter needs --channels: without it there is nothing to filter');
  }

  const { wantedIds } = await import('./wanted.js');
  const { filterGuide } = await import('./filter.js');
  const channels = new Set<string>();

  for (const value of values.channels) {
    for (const id of await wantedIds(value)) {
      channels.add(id);
    }
  }

  if (channels.size === 0) {
    throw new UsageError(`--channels named no channels: ${values.channels.join(' ')}`);
  }

  const report = await filterGuide(file, {
    channels,
    // The caller's stdout when nothing was named, so it pipes — and so a test
    // reads it rather than the process's.
    output: values.output ?? stdout,
    ...(values.extensions !== undefined ? { extensions: values.extensions ?? false } : {}),
    ...(values.indent !== undefined ? { indent: values.indent } : {}),
    stderr,
    ...(signal ? { signal } : {}),
  });

  // On stderr, always: stdout may be the guide itself, and a summary in the
  // middle of a document would be the one thing worse than no summary.
  if (report.missing.length > 0) {
    stderr.write(
      `${report.missing.length} of ${channels.size} channels are not in ${file}: ${report.missing.join(', ')}\n`,
    );
  }

  stderr.write(`${plural(report.kept, 'channel')}, ${plural(report.programmes, 'programme')}\n`);

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
  options: CliOptions,
): Promise<number> {
  const { signal } = options;

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
      port: { type: 'number', min: 0, max: 65_535 },
      host: { type: 'string' },
      'serve-path': { type: 'string' },
      raw: { type: 'boolean' },
      format: { type: 'string', choices: REPORT_FORMATS },
      strict: { type: 'boolean' },
      // `epg channels` only: the file naming the channels somebody wants a
      // guide for, and whether a mismatch should fail a CI step.
      against: { type: 'string' },
      check: { type: 'boolean' },
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

  if (
    values.port !== undefined ||
    values.host !== undefined ||
    values['serve-path'] !== undefined
  ) {
    config = {
      ...config,
      serve: {
        ...config.serve,
        ...(values.port !== undefined ? { port: values.port } : {}),
        ...(values.host !== undefined ? { host: values.host } : {}),
        ...(values['serve-path'] !== undefined ? { path: values['serve-path'] } : {}),
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

    const { wantedIds } = await import('./wanted.js');
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

  if (values.indent !== undefined) {
    config = { ...config, indent: values.indent };
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
          ...(signal ? { signal } : {}),
        },
        stdout,
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
    case 'prune': {
      const before = values.before ?? toDayString(new Date());

      await using cache = await createCacheStore(config, signal);
      const removed = await cache.prune({ before });

      emit({ type: 'prune:done', removed, before });

      return 0;
    }
    default: {
      // Unreachable: `COMMANDS` is checked above, so a command with no case
      // here fails to compile rather than silently pruning the cache — which
      // is what the old `default:` would have done with it.
      const named: never = command as never;

      throw new UsageError(`Unknown command: ${String(named)}`);
    }
  }
}
