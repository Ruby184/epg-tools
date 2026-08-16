/**
 * Grabber capabilities.
 *
 * A capability is a name, the options it adds, and one {@link
 * GrabberCapability.run} that hooks it up. Every advertised capability this
 * package ships is built with this API — the only things left in the core are
 * the always-on information options and `baseline`, which is not a plug-in but
 * the thing capabilities plug into.
 *
 * Every `run` is called at the same point, before the configuration file is
 * read, because `--capabilities` and `--preferredmethod` must answer without
 * one. Anything that has to happen later is *registered* there rather than
 * declared as a hook of its own:
 *
 * - {@link CapabilityContext.onConfigLoaded} — once the configuration has been
 *   read, while a missing one is still allowed. The only place
 *   `--configure-api --stage start` can live.
 * - {@link CapabilityContext.onAdjust} — change the config or the channel
 *   selection and let the grab proceed.
 * - {@link CapabilityContext.onFinish} — cleanup, once the guide is written.
 *
 * {@link CapabilityContext.addStage} is the one that is not a callback: a
 * question to ask while configuring is data, and both renderers of the stage
 * model — `--configure` and `--configure-api` — pick it up from there.
 *
 * So the dispatch order stays load bearing without the capability having to
 * pick a slot, and one whose options straddle a line — `--list-lineups` needs
 * no configuration, `--get-lineup` does — stays one capability.
 */

import type { Writable } from 'node:stream';
import type { EpgConfig } from '../config.js';
import type { OptionSpec, ParsedValues } from '../core/options.js';
import type { GrabberConf } from './config-file.js';
import type { ConfigStage } from './stages.js';

/**
 * Returning a number claims the run and becomes the exit code. Returning
 * nothing means "not mine", and the next capability — or the normal grab —
 * proceeds, which is what a `run` that only registers does.
 */
export type CapabilityResult = number | void;

/**
 * Work deferred until the configuration file has been read.
 *
 * `conf` is `undefined` when there is none, which is not yet an error at this
 * point — so an option that cannot do without one says so itself, by throwing
 * a `GrabberError` naming what it needed, the way the reference words it
 * ("…before you can list the channels") rather than generically.
 */
export type ConfigLoadedTask = (
  conf: GrabberConf | undefined,
) => CapabilityResult | Promise<CapabilityResult>;

/** What is new by the time the grab is being shaped; `ctx` is in scope already. */
export interface AdjustContext {
  /**
   * The configuration file's contents — present, this far in, and live: a
   * replacement by an earlier task is what a later one reads here.
   */
  readonly conf: GrabberConf;
  /** Channel ids that will be grabbed. A capability may add or remove. */
  selection: Set<string>;
}

/** Work that shapes the grab instead of claiming the run. */
export type AdjustTask = (
  config: EpgConfig,
  ctx: AdjustContext,
) => EpgConfig | Promise<EpgConfig>;

export interface CapabilityContext<V = unknown> {
  /** The parsed command line, including this capability's own options. */
  values: V;
  /** The name the grabber was invoked as. */
  grabberName: string;
  /** Path of the configuration file, whether or not it exists — for messages. */
  configFile: string;
  /** The XMLTV document's stream. Prefer {@link emit}, which honours `--output`. */
  stdout: Writable;
  /** Progress and errors. */
  stderr: Writable;
  /**
   * Write a document to `--output`, or to stdout when it was not given.
   * Resolves once it has actually been written, either way.
   */
  emit(text: string): Promise<void>;
  /** Progress logger, absent under `--quiet`. */
  log?: (message: string) => void;
  /**
   * Warn on stderr — one line, terminated for you.
   *
   * Unlike {@link log} this is always present, because a warning is a signal
   * and not progress: `--quiet` reduces stderr to what the user must see, and
   * "these channels are no longer offered" is one of those things. Use
   * `GrabberError` instead when the run should also fail.
   */
  warn(line: string): void;
  /** The configuration stages, for a capability that drives configuration. */
  readonly stages: ConfigStage[];
  /**
   * Ask a question of your own while configuring.
   *
   * The stage goes last: whatever finished before now leads to it, so it is
   * reached whichever route the answers took, and its own `next` says how
   * configuration ends — `select-channels` to go on and choose channels, or
   * `end` when its answer settles them, as a lineup does. Checked as the
   * grabber's own stages are, so a stage that would not finish is a `TypeError`
   * from the capability that added it rather than a stalled `--configure`.
   */
  addStage(stage: ConfigStage): void;
  /** Standard input, for a capability that prompts. */
  stdin?: NodeJS.ReadableStream;
  /** Resolve the grabber's `EpgConfig` from a configuration. */
  resolveConfig(conf: GrabberConf): Promise<EpgConfig>;
  /**
   * Ask for a non-zero exit without ending the run — an advisory signal such
   * as "new channels are available". A genuine failure still outranks it.
   */
  setExitCode(code: number): void;
  /**
   * Register work for once the configuration file has been read. Registering
   * does not claim the run; the task's return value does, exactly as `run`'s.
   *
   * This is the only way to read the configuration, and there is deliberately
   * no other: a capability that read the file itself would be reading it at a
   * point of its own choosing, and would miss what another capability had
   * changed.
   */
  onConfigLoaded(task: ConfigLoadedTask): void;
  /**
   * Change the configuration.
   *
   * There is no "save": the file is written once, before the run ends, and
   * only if what the run now holds differs from what was read — so replacing
   * it with an equal configuration leaves the file untouched. Later tasks see
   * the replacement, not what was loaded.
   */
  replaceConfig(conf: GrabberConf): void;
  /** Register a change to the config or the channel selection. */
  onAdjust(task: AdjustTask): void;
  /** Register cleanup to run once the guide has been written. */
  onFinish(task: () => void | Promise<void>): void;
}

/**
 * A capability's share of the usage synopsis, as **option names** — not text.
 *
 * How an option prints is already in its spec: whether it takes a value, what
 * that value is called (`placeholder`), whether there is a `--no-` form. What
 * a spec cannot say is which options make up one invocation, so that is all
 * this declares. Names may be another capability's or the framework's, since a
 * form usually accepts `config-file` or `output` alongside its own.
 */
export interface CapabilityUsage {
  /** Options that are a query in themselves, listed with `--capabilities`. */
  info?: string[];
  /** Options added to the plain grab form, when `baseline` is advertised. */
  grab?: string[];
  /** Invocations of its own: the mode option first, then what it accepts. */
  modes?: string[][];
}

export interface GrabberCapability<
  S extends Record<string, OptionSpec> = Record<string, OptionSpec>,
> {
  /** Advertised by `--capabilities`. */
  name: string;
  /** Options this capability adds. Must not shadow an existing option. */
  options?: S;
  /** What this capability adds to the usage synopsis. */
  usage?: CapabilityUsage;
  /**
   * Hook the capability up: claim the run by returning an exit code, register
   * what has to wait, or both.
   */
  run(ctx: CapabilityContext<ParsedValues<S>>): CapabilityResult | Promise<CapabilityResult>;
}

/** A capability list entry: a built-in name, or a definition. */
export type CapabilityEntry = string | GrabberCapability<any>;

/** Identity helper, for inference of a capability's own option types. */
export function defineCapability<S extends Record<string, OptionSpec>>(
  capability: GrabberCapability<S>,
): GrabberCapability<S> {
  return capability;
}

/** The names to advertise, in the order they were declared. */
export function capabilityNames(entries: readonly CapabilityEntry[]): string[] {
  return entries.map((entry) => (typeof entry === 'string' ? entry : entry.name));
}

/** Just the defined capabilities, in declaration order. */
export function definedCapabilities(entries: readonly CapabilityEntry[]): GrabberCapability<any>[] {
  return entries.filter((entry): entry is GrabberCapability<any> => typeof entry !== 'string');
}

/**
 * Offer the run to every capability, in declaration order. The first to return
 * an exit code wins; `undefined` means none of them claimed it, and whatever
 * they registered is now waiting.
 */
export async function runCapabilities(
  capabilities: readonly GrabberCapability<any>[],
  ctx: CapabilityContext<any>,
): Promise<number | undefined> {
  for (const capability of capabilities) {
    const code = await capability.run(ctx);

    if (typeof code === 'number') {
      return code;
    }
  }
}

/**
 * Run what was registered with {@link CapabilityContext.onConfigLoaded}, in
 * registration order — which is the capabilities' declaration order, since
 * `run` is what registers.
 */
export async function runConfigLoadedTasks(
  tasks: readonly ConfigLoadedTask[],
  conf: () => GrabberConf | undefined,
): Promise<number | undefined> {
  for (const task of tasks) {
    // Read per task, not once: whatever a task before it replaced is what the
    // next one must see.
    const code = await task(conf());

    if (typeof code === 'number') {
      return code;
    }
  }
}

/** Fold what was registered with {@link CapabilityContext.onAdjust} over the config. */
export async function runAdjustTasks(
  tasks: readonly AdjustTask[],
  config: EpgConfig,
  ctx: AdjustContext,
): Promise<EpgConfig> {
  let adjusted = config;

  for (const task of tasks) {
    adjusted = await task(adjusted, ctx);
  }

  return adjusted;
}
