import path from 'node:path';
import type { Writable } from 'node:stream';
import { resolveConfigSource, type EpgConfig } from '../config.js';
import { guideStream, runGrab } from '../build.js';
import { OptionError } from '../core/options.js';
import { OutputError, writeOutput } from '../core/output.js';
import { drain, queueLine, writeFlushed, writeLines } from '../core/streams.js';
import {
  capabilityNames,
  definedCapabilities,
  runAdjustTasks,
  runCapabilities,
  runConfigLoadedTasks,
} from './capability.js';
import type { AdjustTask, CapabilityContext, ConfigLoadedTask } from './capability.js';
import { DEFAULT_CAPABILITIES } from './capabilities/main.js';
import {
  defaultConfigFile,
  grabberConfReader,
  loadGrabberConfig,
  saveGrabberConfig,
  serializeGrabberConfig,
  type GrabberConf,
} from './config-file.js';
import { GrabberError } from '../core/error.js';
import { atLevel, type EventLevel } from '../core/events.js';
import { textReporter } from '../core/reporters.js';
import { help, parseGrabberOptions, usage, type GrabberValues } from './options.js';
import { applyChannelSelection } from './select.js';
import { appendStage, resolveStages, type ConfigStage } from './stages.js';
import type { ConfigSource, XmltvGrabberOptions } from './types.js';

// What XMLTV::Options accepts: "x", "x.y", "x.y.z", optionally with an
// underscore suffix. It croaks on anything else, so catch it at startup.
const VERSION = /^\d+(\.\d+){0,2}(_\d*)?$/;

/** Cancelled — 128 + SIGINT, what a shell reports for a process it stops. */
const EXIT_CANCELLED = 130;

/** The name the grabber was invoked as — what its config file is keyed by. */
function grabberNameOf(options: XmltvGrabberOptions): string {
  return options.grabberName ?? path.basename(process.argv[1] ?? 'tv_grab');
}

async function resolveConfig(source: ConfigSource, conf: GrabberConf): Promise<EpgConfig> {
  // The configuration is *offered* the file rather than handed it: it asks its
  // context for a value and never learns which source answered, so it may rank
  // the environment above this and nothing here has to know.
  return resolveConfigSource(source, grabberConfReader(conf));
}

/**
 * The stages to configure with: the grabber's own, or — since a configuration
 * that declares questions already carries them — the ones that came with it,
 * so a shim cannot pass a config and forget its stages.
 */
function stagesOf(source: ConfigSource, options: XmltvGrabberOptions): ConfigStage[] | undefined {
  if (options.stages !== undefined || typeof source !== 'function') {
    return options.stages;
  }

  return source.stages as ConfigStage[] | undefined;
}

/**
 * Run an XMLTV grabber command line against an {@link EpgConfig}.
 *
 * Resolves to the process exit code rather than exiting, so it can be driven
 * from a test. The XMLTV document is the only thing written to stdout; all
 * progress and errors go to stderr, which `--quiet` reduces to errors alone.
 *
 * A {@link GrabberError} thrown anywhere inside — by a capability, or by the
 * grab itself — becomes its message on stderr and its code here.
 */
export async function runXmltvGrabber(
  source: ConfigSource,
  options: XmltvGrabberOptions,
): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  // Registered from inside, run out here, so that a capability claiming the
  // run cannot skip a configuration write or leave a scratch directory behind.
  const cleanups: (() => void | Promise<void>)[] = [];

  try {
    return await execute(source, options, stdout, stderr, cleanups);
  } catch (error) {
    // Anything the cancel itself raised — an aborted prompt, a write that
    // stopped, a request dropped in flight — is the interruption rather than a
    // failure to describe, and every one of them arrives here as an AbortError.
    if (options.signal?.aborted) {
      await writeLines(stderr, 'cancelled');
      return EXIT_CANCELLED;
    }

    // An output that cannot be written is the same kind of news as any other
    // failure a capability reports: one line, and a code.
    const failure =
      error instanceof GrabberError
        ? error
        : error instanceof OutputError
          ? new GrabberError(error.message)
          : undefined;

    if (failure === undefined) {
      throw error;
    }

    await writeLines(stderr, failure.message);
    return failure.code;
  } finally {
    for (const cleanup of cleanups) {
      await cleanup();
    }

    // Whatever the outcome, the caller is free to exit once we resolve.
    await Promise.all([drain(stdout), drain(stderr)]);
  }
}

async function execute(
  source: ConfigSource,
  options: XmltvGrabberOptions,
  stdout: Writable,
  stderr: Writable,
  cleanups: (() => void | Promise<void>)[],
): Promise<number> {
  const capabilities = options.capabilities ?? DEFAULT_CAPABILITIES;
  const names = capabilityNames(capabilities);
  const extras = definedCapabilities(capabilities);
  const grabberName = grabberNameOf(options);

  if (!VERSION.test(options.version)) {
    throw new TypeError(`Invalid grabber version "${options.version}" (expected x, x.y or x.y.z)`);
  }

  let stages = resolveStages(stagesOf(source, options));
  let values: GrabberValues & Record<string, unknown>;

  try {
    values = parseGrabberOptions(options.argv ?? process.argv.slice(2), capabilities);
  } catch (error) {
    if (error instanceof OptionError) {
      // A grabber must reject an option it does not know; tv_validate_grabber
      // probes with a nonsense flag and reports `noparamcheck` if it passes.
      await writeFlushed(stderr, `${error.message}\n\n${usage(grabberName, capabilities)}`);
      return 1;
    }

    throw error;
  }

  // Answered before anything is loaded: these must not need a config file,
  // the network, or more than a moment.
  if (values.capabilities) {
    await writeLines(stdout, ...names);
    return 0;
  }

  if (values.version) {
    await writeLines(
      stdout,
      `XMLTV module version ${__PKG_VERSION__}`,
      `This is ${grabberName} version ${options.version}`,
    );
    return 0;
  }

  if (values.description) {
    await writeLines(stdout, options.description);
    return 0;
  }

  if (values.help) {
    await writeFlushed(stdout, help(grabberName, capabilities));
    // The reference exits 1 from its usage path, shared with option errors.
    return 1;
  }

  const configFile = values['config-file'] ?? defaultConfigFile(grabberName);
  // `--quiet` and `--debug` are this protocol's two words for a level, and they
  // now mean one: the run reports through the same reporter `epg` uses, on
  // stderr, because stdout is the guide.
  const level: EventLevel = values.quiet ? 'error' : values.debug ? 'debug' : 'info';
  const reporter = textReporter({ stream: stderr, level });
  const log = atLevel('info', level) ? (message: string) => queueLine(stderr, message) : undefined;

  // --output redirects stdout wholesale in the reference, so it applies to the
  // configuration documents a capability may print as well as to the guide.
  const emit = (text: string): Promise<void> =>
    writeOutput(values.output ?? stdout, [text], {
      ...(options.signal ? { signal: options.signal } : {}),
    });

  const configLoadedTasks: ConfigLoadedTask[] = [];
  const adjustTasks: AdjustTask[] = [];
  let advisory = 0;
  let conf: GrabberConf | undefined;

  const context: CapabilityContext<any> = {
    values,
    grabberName,
    configFile,
    stdout,
    stderr,
    emit,
    warn: (line) => queueLine(stderr, line),
    // A getter and not the array itself: a capability may add a stage, and
    // whoever reads this later — both renderers do — must see it.
    get stages(): ConfigStage[] {
      return stages;
    },
    addStage: (stage) => {
      stages = resolveStages(appendStage(stages, stage));
    },
    resolveConfig: (conf) => resolveConfig(source, conf),
    setExitCode: (code) => {
      advisory = Math.max(advisory, code);
    },
    onConfigLoaded: (task) => configLoadedTasks.push(task),
    onAdjust: (task) => adjustTasks.push(task),
    onFinish: (task) => cleanups.push(task),
    replaceConfig: (next: GrabberConf) => {
      conf = next;
    },
    ...(log ? { log } : {}),
    ...(options.stdin ? { stdin: options.stdin } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  };

  // One pass over the capabilities: each either claims the run here, or hooks
  // itself into a later point.
  const claimed = await runCapabilities(extras, context);

  if (claimed !== undefined) {
    return claimed;
  }

  conf = await loadGrabberConfig(configFile);

  // Saving is the framework's job, so that a capability changing the
  // configuration never has to know where it lives or when to write it. The
  // text is the comparison, so an equal replacement leaves the file alone.
  const loaded = conf === undefined ? undefined : serializeGrabberConfig(conf);

  cleanups.push(async () => {
    if (conf === undefined || serializeGrabberConfig(conf) === loaded) {
      return;
    }

    await saveGrabberConfig(configFile, conf);
    log?.(`Wrote ${configFile}`);
  });

  const deferred = await runConfigLoadedTasks(configLoadedTasks, () => conf);

  if (deferred !== undefined) {
    return deferred;
  }

  if (conf === undefined) {
    throw new GrabberError('You need to configure the grabber by running it with --configure');
  }

  let config = await resolveConfig(source, conf);

  if (values.days !== undefined) {
    config = { ...config, days: values.days };
  }

  const selection = new Set(conf.channel ?? []);

  config = await runAdjustTasks(adjustTasks, config, {
    // A getter, so a task replacing the configuration is visible to the tasks
    // after it — `conf` is the run's, not a copy taken when this was built.
    get conf(): GrabberConf {
      return conf as GrabberConf;
    },
    selection,
  });

  const selected = applyChannelSelection(config, selection);

  if (selected.sites.length === 0) {
    throw new GrabberError(`No channels selected in ${configFile}; run --configure`);
  }

  const runOptions = {
    offset: values.offset,
    ...(options.now ? { now: options.now } : {}),
    reporter,
    ...(options.signal ? { signal: options.signal } : {}),
  };

  let failed = 0;

  if (options.grab !== false) {
    // The summary line and the failures under it are the reporter's, which is
    // what stops this grabber saying both in a format of its own — and is why
    // it now mentions what a source said was unchanged, which its own line
    // silently dropped.
    failed = (await runGrab(selected, runOptions)).failed;
  }

  // A cancelled run writes nothing: the reference grabbers are read by a
  // consumer that takes whatever arrives on stdout as the whole guide, and half
  // a document would be taken for one.
  if (options.signal?.aborted) {
    queueLine(stderr, 'cancelled');

    return EXIT_CANCELLED;
  }

  await writeOutput(values.output ?? stdout, guideStream(selected, runOptions), {
    ...(options.signal ? { signal: options.signal } : {}),
  });

  // Partial data is reported as a failure, as the reference grabbers do, and
  // outranks any advisory code a capability asked for.
  return failed > 0 ? 1 : advisory;
}
