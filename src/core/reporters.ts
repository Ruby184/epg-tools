/**
 * The reporters this package ships, and how a config names one.
 *
 * A reporter is a function — `(event) => void`, nothing more — so anything that
 * wants the events can be one. What is here is the three worth not writing
 * yourself, each *built* by a function that takes options, so naming one in a
 * config is the same act as configuring it:
 *
 * ```ts
 * reporter: 'text',
 * reporter: ({ stdout, level }) => textReporter({ stream: stdout, level, failures: 'inline' }),
 * reporter: () => (event) => metrics.count(event.type),
 * ```
 *
 * Which mirrors `cache.driver` deliberately: a name for one of ours, a factory
 * for anything else, handed the same things ours are given.
 */

import type { Writable } from 'node:stream';
import {
  atLevel,
  silent,
  stamped,
  type Emit,
  type EpgEvent,
  type EventLevel,
  type GrabCounts,
  type Reporter,
} from './events.js';
import { errorMessage } from './error.js';
import { queueLine } from './streams.js';

/** A reporter this package ships, by name — what a config can ask for. */
export const REPORTER_NAMES = ['text', 'json', 'progress'] as const;

export type ReporterName = (typeof REPORTER_NAMES)[number];

/**
 * What the run knows and a reporter cannot: where it may write, and how much it
 * is being asked for.
 *
 * The same two streams the command itself was given, so a reporter never
 * reaches for `process.stdout` — which is what keeps a command something a test
 * can run.
 */
export interface ReporterRuntime {
  /** Progress. Stdout for `epg`; stderr for a `tv_grab_*`, whose stdout is the guide. */
  stdout: Writable;
  /** Failures, and anything `--quiet` must not eat. */
  stderr: Writable;
  level: EventLevel;
}

/** A reporter that wants those before it can be built. */
export type ReporterFactory = (runtime: ReporterRuntime) => Reporter;

/** `N thing` / `N things`, since almost every line here counts something. */
function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** What a run or a site came to, in the one form both say it. */
function counts({ fetched, empty, fromCache, unchanged, failed }: GrabCounts): string {
  // A day that came back with nothing is not a failure — a channel with no
  // listings is a legitimate answer — but it is the one thing a run cannot
  // otherwise see, so it is named beside the fetches it is part of. What the
  // source said was unchanged is named only when there is any, so a site that
  // never asks does not read a nought about it every run.
  return [
    empty > 0 ? `${fetched} fetched (${empty} empty)` : `${fetched} fetched`,
    `${fromCache} from cache`,
    ...(unchanged > 0 ? [`${unchanged} unchanged`] : []),
    `${failed} failed`,
  ].join(', ');
}

/**
 * How a request is named: the channel-day it is, or the span it covers.
 *
 * Rendering rather than structure, which is why it is here and not on the event
 * — a JSON reporter wants the two arrays, not this.
 */
function describeSpan(channels: string[], days: string[]): string {
  const channelPart = channels.length === 1 ? channels[0]! : count(channels.length, 'channel');
  const dayPart =
    days.length === 1
      ? days[0]!
      : `${days[0]}..${days[days.length - 1]} (${count(days.length, 'day')})`;

  return `${channelPart} ${dayPart}`;
}

/** `[site] ` unless a reporter was told not to. */
function at(site: string, prefix: boolean): string {
  return prefix ? `[${site}] ` : '';
}

/**
 * One event as a line of text, or nothing when it has no line to be.
 *
 * Exported because the string form is still the useful one for a caller who
 * only ever wanted `logger: console.log`:
 *
 * ```ts
 * await build(config, { reporter: (event) => console.log(render(event)) });
 * ```
 *
 * Failures are not here: what to do with one is a policy — inline, or a block
 * at the end — and {@link textReporter} owns it. {@link renderFailure} is that
 * half.
 */
export function render(event: EpgEvent, prefix = true): string | undefined {
  switch (event.type) {
    case 'run:cancelled':
      return event.fetched === undefined
        ? 'Cancelled.'
        : `Cancelled. ${event.fetched} channel-day(s) reached the cache; no guide was written.`;
    case 'grab:done':
      return `Grab done: ${counts(event)}`;
    case 'site:started':
      return (
        `${at(event.site, prefix)}${event.channels} channel(s) × ${event.days} day(s): ` +
        `${event.requests} request(s)`
      );
    case 'site:done':
      return `${at(event.site, prefix)}${counts(event)}`;
    case 'site:note':
    case 'site:warning':
      return `${at(event.site, prefix)}${event.message}`;
    case 'entry:cached':
      return `${at(event.site, prefix)}${event.channelId} ${event.day}: fresh in cache, skipping`;
    case 'entry:fetched':
      return (
        `${at(event.site, prefix)}${event.channelId} ${event.day}: ` +
        count(event.programmes, 'programme')
      );
    case 'entry:appended':
      return (
        `${at(event.site, prefix)}${event.channelId} ${event.day}: ` +
        `${count(event.added, 'more programme')}, ${event.total} in all`
      );
    case 'entry:unchanged':
      return (
        `${at(event.site, prefix)}${event.channelId} ${event.day}: ` +
        `unchanged, keeping what is cached`
      );
    case 'stream:gaps':
      return (
        `${at(event.site, prefix)}${event.count} channel-day(s) not in the document: ` +
        `caching them empty`
      );
    case 'stream:ignored':
      return `${at(event.site, prefix)}ignored ${event.count} channel-day(s) it was not asked for`;
    case 'pacing:held':
      return `${at(event.site, prefix)}HTTP ${event.status}: holding requests for ${event.ms}ms`;
    case 'pacing:slowed':
      return `${at(event.site, prefix)}concurrency down to ${event.concurrency}`;
    case 'pacing:recovered':
      return `${at(event.site, prefix)}concurrency back up to ${event.concurrency}`;
    case 'pacing:rateLimit':
      return event.waiting
        ? `${at(event.site, prefix)}rate limit reached, waiting for the window`
        : `${at(event.site, prefix)}rate limit window open again`;
    case 'merge:channel':
      return `merge: channel ${event.channelId} done`;
    case 'merge:done':
      return `Guide written to ${event.output}`;
    case 'prune:done':
      // One wording where there were two: a prune after a grab used to say
      // "Pruned N cached day(s) older than X" and `epg prune` "Pruned N cached
      // entr(y|ies) before X", for the same act on the same store.
      return (
        `Pruned ${event.removed} cached entr${event.removed === 1 ? 'y' : 'ies'} ` +
        `before ${event.before}`
      );
    default:
      // A failure, which has no line of its own — see `renderFailure`.
      return undefined;
  }
}

/** The three events that are a failure, and what one reads as. */
export type FailureEvent = Extract<
  EpgEvent,
  { type: 'entry:failed' | 'request:failed' | 'site:failed' }
>;

/** Whether this is one of those, so a reporter can hold it back. */
export function isFailure(event: EpgEvent): event is FailureEvent {
  return (
    event.type === 'entry:failed' || event.type === 'request:failed' || event.type === 'site:failed'
  );
}

/**
 * One failure as a line — unindented, since whether it is part of a block is
 * the block's business.
 *
 * A request failure is one line and not one per channel-day it covered, which
 * is the whole reason `request:failed` carries `entries`: a site that is down
 * says so once, where it used to say it seven thousand times.
 */
export function renderFailure(event: FailureEvent, prefix = true): string {
  const where = prefix ? `[${event.site}] ` : '';

  switch (event.type) {
    case 'entry:failed':
      return `FAILED ${where}${event.channelId} ${event.day}: ${errorMessage(event.error)}`;
    case 'request:failed': {
      // The count only when there is more than one: a site that fetches one
      // channel-day per request comes through here for every failure, and
      // "(1 channel-day(s))" on each of them says nothing.
      const covered = event.entries === 1 ? '' : ` (${event.entries} channel-day(s))`;

      return (
        `FAILED ${where}${describeSpan(event.channels, event.days)}${covered}: ` +
        errorMessage(event.error)
      );
    }
    default:
      return `FAILED ${where}site failed: ${errorMessage(event.error)}`;
  }
}

/**
 * The events that did not exist while `logger` did, so the bridge below leaves
 * them out — a caller who passed `logger: console.log` should read what it read
 * before, not a summary line its own CLI already prints.
 */
const NEWER_THAN_LOGGER = new Set<EpgEvent['type']>([
  'run:cancelled',
  'grab:done',
  'site:started',
  'site:done',
  'merge:done',
]);

/**
 * A reporter that hands finished lines to a plain function.
 *
 * The bridge under the `logger` option this package used to take, so nothing
 * that passed one has to change while the events settle. Unfiltered and inline,
 * which is what `logger` was: one level, and a failure said where it happened.
 *
 * @deprecated Pass a reporter instead — `textReporter` for the same lines with
 * a level, or a function of your own for the events themselves.
 */
export function lineReporter(logger: (message: string) => void): Reporter {
  return (event) => {
    if (NEWER_THAN_LOGGER.has(event.type)) {
      return;
    }

    const line = isFailure(event) ? renderFailure(event) : render(event);

    if (line !== undefined) {
      logger(line);
    }
  };
}

/** What a run has finished doing, whatever it finished as — when a block is flushed. */
function isTerminal(event: EpgEvent): boolean {
  return event.type === 'grab:done' || event.type === 'run:cancelled';
}

export interface TextReporterOptions {
  /** Where progress goes. */
  stream: Writable;
  /** Failures. Defaults to {@link stream}. */
  errorStream?: Writable;
  /** Anything below this is not written. Defaults to `info`. */
  level?: EventLevel;
  /**
   * What to do with a failure.
   *
   * `block` (the default) holds them and writes one capped block when the run
   * finishes, which keeps a site that is down from burying the progress it
   * interleaved with. `inline` writes each where it happens and holds nothing —
   * for a CI log, where interleaving is the point and a block at the end has
   * already scrolled past.
   */
  failures?: 'block' | 'inline';
  /** How many the block shows before saying how many more there were. `0` for all. */
  failureCap?: number;
  /** The `[site]` prefix. Off for a grabber that only ever has one. */
  prefix?: boolean;
}

/** How many failures a block shows before counting the rest. */
export const DEFAULT_FAILURE_CAP = 20;

/**
 * Lines of text, which is what a person reads and what a CI log keeps.
 *
 * Two things happen here regardless of `level`, and they are the reason this is
 * a closure rather than a `render` and a filter: failures are **collected** and
 * the block is **flushed**. `--quiet` is `level: 'error'`, and it must still end
 * with the failures — so the level decides what is *written*, never what the
 * reporter notices.
 */
export function textReporter(options: TextReporterOptions): Reporter {
  const {
    stream,
    errorStream = stream,
    level = 'info',
    failures = 'block',
    failureCap = DEFAULT_FAILURE_CAP,
    prefix = true,
  } = options;

  const held: string[] = [];
  let dropped = 0;

  const flush = (): void => {
    for (const line of held) {
      // Indented, so a run of them reads as one block under the summary.
      queueLine(errorStream, `  ${line}`);
    }

    if (dropped > 0) {
      queueLine(errorStream, `  … ${held.length} shown, ${dropped} more`);
    }

    held.length = 0;
    dropped = 0;
  };

  return (event) => {
    if (isFailure(event)) {
      const line = renderFailure(event, prefix);

      if (failures === 'inline') {
        queueLine(errorStream, line);
      } else if (failureCap === 0 || held.length < failureCap) {
        // Capped rather than kept: the point of counting failures instead of
        // keeping them is that a run stays flat in the size of the guide, and a
        // reporter holding every line back would put the growth straight back.
        held.push(line);
      } else {
        dropped++;
      }

      return;
    }

    if (isTerminal(event)) {
      // Before its own line, so the failures read as part of what the run came
      // to rather than as an afterthought — and whether that line is written at
      // all depends on the level, while this does not.
      flush();
    }

    if (!atLevel(event.level, level)) {
      return;
    }

    const line = render(event, prefix);

    if (line !== undefined) {
      queueLine(event.level === 'error' || event.level === 'warn' ? errorStream : stream, line);
    }
  };
}

/** How deep an `error.cause` chain is followed before it is called a cycle. */
const MAX_CAUSE_DEPTH = 8;

/** An error as JSON keeps it, `cause` chain and all. */
function errorJson(error: unknown, depth = 0): unknown {
  if (!(error instanceof Error)) {
    // Including the odd `throw 'nope'`: a log should not be where that becomes
    // a crash, and `String` is the only honest thing left.
    return { message: String(error) };
  }

  return {
    name: error.name,
    message: error.message,
    ...(error.stack === undefined ? {} : { stack: error.stack }),
    ...(error.cause === undefined || depth >= MAX_CAUSE_DEPTH
      ? {}
      : { cause: errorJson(error.cause, depth + 1) }),
  };
}

export interface JsonReporterOptions {
  stream: Writable;
  level?: EventLevel;
  /** One indented object per event instead of one line each. */
  pretty?: boolean;
}

/**
 * One JSON object per line — the form a pipeline reads.
 *
 * Which is the whole argument for events over strings: `jq 'select(.level ==
 * "error")'` over a run is not something a formatted line can be asked.
 *
 * Everything goes to one stream, `error` events included: a reader that splits
 * on lines cannot also be reading two files, and a `level` field says what a
 * second stream would have.
 */
export function jsonReporter(options: JsonReporterOptions): Reporter {
  const { stream, level = 'debug', pretty = false } = options;

  return (event) => {
    if (!atLevel(event.level, level)) {
      return;
    }

    // An `Error` stringifies to `{}`, so the one field that is not plain data
    // is replaced rather than left to disappear.
    const payload: Record<string, unknown> =
      'error' in event ? { ...event, error: errorJson(event.error) } : { ...event };

    queueLine(stream, JSON.stringify(payload, undefined, pretty ? 2 : undefined));
  };
}

/** The two options a caller could answer "where do the events go?" with. */
export interface ReportedOptions {
  reporter?: Reporter;
  /** @deprecated See {@link lineReporter}. */
  logger?: (message: string) => void;
}

/**
 * Where a run's events go, from what it was given.
 *
 * Passing both is a mistake worth naming rather than silently resolving: they
 * are two answers to one question, and picking one for the caller would mean a
 * reporter that quietly never runs.
 */
export function emitter(options: ReportedOptions): Emit {
  if (options.reporter !== undefined && options.logger !== undefined) {
    throw new TypeError('Pass either reporter or logger, not both');
  }

  if (options.reporter !== undefined) {
    return stamped(options.reporter);
  }

  return options.logger === undefined ? silent : stamped(lineReporter(options.logger));
}

/**
 * A reporter for what a config asked for.
 *
 * Shaped like `driverFor` in `build.ts`: a name is one of ours, anything else
 * is a factory and is handed exactly what ours are handed.
 */
export function reporterFor(
  reporter: ReporterName | ReporterFactory | undefined,
  runtime: ReporterRuntime,
): Reporter | undefined {
  if (reporter === undefined) {
    return undefined;
  }

  if (typeof reporter === 'function') {
    return reporter(runtime);
  }

  switch (reporter) {
    case 'text':
      return textReporter({
        stream: runtime.stdout,
        errorStream: runtime.stderr,
        level: runtime.level,
      });
    case 'json':
      return jsonReporter({ stream: runtime.stdout, level: runtime.level });
    case 'progress':
      // Until the progress reporter exists, the honest answer is the one that
      // does — and the fallback it will have anyway on a stream that is not a
      // terminal.
      return textReporter({
        stream: runtime.stdout,
        errorStream: runtime.stderr,
        level: runtime.level,
      });
    default: {
      // Unreachable from TypeScript, which is what the `never` says: a name
      // added without a case here fails to compile. A config written in
      // JavaScript can still ask for one that does not exist, and is told so
      // rather than quietly given the default.
      const named: never = reporter;

      throw new TypeError(
        `Unknown reporter: ${String(named)} (expected ${REPORTER_NAMES.join(', ')})`,
      );
    }
  }
}
