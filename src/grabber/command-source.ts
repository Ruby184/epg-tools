/**
 * A program that writes XMLTV to stdout, as a source.
 *
 * `tv_grab_fi`, a Python scraper someone already has, a WebGrab+Plus run, a
 * `curl` through something odd, `cat yesterday.xml`. The command line is the
 * user's — this makes no attempt to configure anybody's grabber, which is a
 * problem nobody has solved in twenty years and not one worth solving here.
 *
 * What it is: {@link splitXmltvDocument} over a child's stdout instead of a
 * response body. Reading the document, reckoning the days and cutting it into
 * channel-days are the same code the published-guide adapter uses, so a program
 * writing a `.xml.gz` works for the same reason a server serving one does.
 *
 * **The exit code is what decides whether the document finished.** A child's
 * stdout ends *cleanly* when the process dies, and a Perl grabber that fails a
 * fetch part way `die`s — XMLTV's own `Get_nice.pm` does — so its `end()` never
 * runs and stdout holds a truncated, unclosed document. Nothing in those bytes
 * says so. A pass that ended quietly there would have every unreached
 * channel-day cached as "nothing on", which is why a bad exit throws.
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { GrabberError } from '../core/error.js';
import type { Says } from '../core/events.js';
import { toDayString } from '../core/days.js';
import type { CompressionFormat } from '../core/output.js';
import { parseXmltvStream } from '../xmltv/main.js';
import type { XmltvChannel, XmltvParseOptions } from '../xmltv/types.js';
import {
  asGrabberChannel,
  splitXmltvDocument,
  streamBytes,
  xmltvChannelInfo,
  type XmltvDayZone,
} from './xmltv-document.js';
import {
  defineStreamSiteConfig,
  type ChannelsSource,
  type GrabberChannel,
  type SiteState,
  type StreamedChannelDay,
  type StreamSiteConfig,
} from './types.js';

/** How many lines of stderr are kept for the message a failure carries. */
const STDERR_TAIL = 20;

/** How long a killed program has to go quietly before it is killed properly. */
const GRACE_MS = 2000;

/** What the window looks like to a program that has to be told about it. */
export interface CommandWindow {
  /** The days wanted, `YYYY-MM-DD`, in order. */
  days: readonly string[];
  /** The first of them, which is what an offset is counted from. */
  startDay: string;
  /** How many days from today `startDay` is: 0 today, negative for the past. */
  offset: number;
}

/** What an argument list is worked out from: the window, and what the site knows. */
export interface CommandArgsContext extends CommandWindow {
  /**
   * The site's own state — see {@link SiteState}.
   *
   * For an argument that has to be found out rather than written down, and is
   * worth finding out once: what a program says it supports, a token, a path it
   * reported. {@link defineTvGrabCommandSite} keeps a grabber's capabilities
   * here for exactly that reason.
   */
  state: SiteState;
  signal?: AbortSignal;
  /** Where a note about working the arguments out goes. */
  warn: Says['warn'];
}

/**
 * The argument list, or how to work it out.
 *
 * The function form may be `async`, which is what lets it ask the program
 * something first — `--capabilities`, say — and remember the answer in `state`.
 */
export type CommandArgs =
  | readonly string[]
  | ((context: CommandArgsContext) => readonly string[] | Promise<readonly string[]>);

export interface CommandSiteOptions<TData = XmltvChannel> extends Omit<
  StreamSiteConfig<TData>,
  'stream' | 'channels' | 'conditionalGet'
> {
  /** The program to run. Looked up on `PATH` unless it is a path. */
  command: string;
  /**
   * What to pass it, or a function given the window.
   *
   * Nothing is added for you: `--days` and `--offset` are a convention that
   * half the programs anyone will point this at spell differently, and guessing
   * would be a silently wrong window. {@link defineTvGrabCommandSite} is the
   * one that knows the spelling, because a grabber advertising `baseline` has
   * said so.
   */
  args?: CommandArgs;
  /**
   * What to pass when only the channel list is wanted.
   *
   * A program with a cheap answer — `--list-channels`, as XMLTV's own grabbers
   * have — makes the channel pass one fast run instead of a whole grab.
   * Without it the list is read out of the head of a normal run, exactly as the
   * published-guide adapter reads it out of the head of a document, and with
   * the same `cacheChannels` default so it happens once a day.
   */
  channelsArgs?: CommandArgs;
  /** Where to run it. Defaults to the process's own directory. */
  cwd?: string;
  /** Added to this process's environment, not instead of it — `PATH` matters. */
  env?: Record<string, string>;
  /**
   * Run it through a shell. **Off**, and worth leaving off.
   *
   * A config that builds a command line out of anything it did not write —
   * a channel name, a path from a playlist — is a command injection with extra
   * steps. The array form needs no quoting and cannot be tricked.
   */
  shell?: boolean;
  /** Kill it after this long. No limit by default: a grab of a fortnight is slow. */
  timeoutMs?: number;
  /**
   * Exit codes to accept besides `0`.
   *
   * For a program that reports partial success that way. Everything else
   * **fails the site**, which is the point: a truncated document is otherwise
   * indistinguishable from a short one.
   */
  okExitCodes?: readonly number[];
  /** A channel list of your own, in place of reading one from the program. */
  channels?: ChannelsSource<TData>;
  /** What the document is compressed with. Sniffed by default. */
  compression?: CompressionFormat | false;
  /** Which day a programme belongs to. Defaults to `source`. */
  dayZone?: XmltvDayZone;
  /** Whether the document groups each channel's programmes together. */
  order?: 'grouped' | 'any';
  /** Passed to the parser: `timezones` for named zones, `tolerateMissingId`. */
  parse?: XmltvParseOptions;
}

/** What to run, and what to do while it runs. */
export interface RunCommandOptions {
  command: string;
  args: readonly string[];
  cwd?: string;
  env?: Record<string, string>;
  shell?: boolean;
  timeoutMs?: number;
  okExitCodes?: readonly number[];
  /** Where each line of stderr goes as it arrives. */
  warn?: Says['warn'];
  /** The run's own signal: aborting it kills the program. */
  signal?: AbortSignal;
}

/** A program, running. */
export interface RunningCommand {
  /** What it is writing to stdout. */
  bytes: ReadableStream<Uint8Array>;
  /** The command line, for a message. */
  said: string;
  /**
   * Wait for it to finish, and throw unless it finished well.
   *
   * Call it **after** stdout has been read to the end: a program whose output
   * nobody is reading blocks on a full pipe, so waiting first would wait for
   * ever.
   */
  finished: () => Promise<void>;
  /** Stop it: `SIGTERM`, then `SIGKILL` if it does not go. */
  stop: (why: string) => void;
}

/**
 * Run a program and hand back its output, its exit and a way to stop it.
 *
 * Exported because {@link defineTvGrabCommandSite} is this adapter with its
 * arguments written for it, and a second copy of the killing, the stderr tail
 * and the exit verdict would be a second set of answers.
 */
export function runCommand(options: RunCommandOptions): RunningCommand {
  const { command, args, okExitCodes = [], warn, signal } = options;
  const said = [command, ...args].join(' ');
  const child = spawn(command, [...args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    // Added to this process's environment rather than replacing it: a program
    // spawned without `PATH` cannot find the things it shells out to.
    env: { ...process.env, ...options.env },
    ...(options.shell === undefined ? {} : { shell: options.shell }),
    // stdin closed, because a grabber reading from a terminal that is not there
    // would hang rather than fail; both other ends are ours to read.
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  /** The last lines it complained with, which is what a failure is worth reading. */
  const tail: string[] = [];
  /** Why it was stopped, where it was — which beats "killed by SIGTERM". */
  let stopped: string | undefined;
  let killer: NodeJS.Timeout | undefined;

  const stop = (why: string): void => {
    if (stopped !== undefined || child.exitCode !== null) {
      return;
    }

    stopped = why;
    child.kill('SIGTERM');
    // A program that ignores `SIGTERM` still has to end, or a run that was
    // asked to stop never does.
    killer = setTimeout(() => child.kill('SIGKILL'), GRACE_MS);
    killer.unref();
  };

  // Every line as it arrives, rather than at the end: it is progress while a
  // grabber works, and the only progress there is.
  const noise = createInterface({ input: child.stderr });

  noise.on('line', (line: string) => {
    if (line.trim() === '') {
      return;
    }

    warn?.(line);
    tail.push(line);

    if (tail.length > STDERR_TAIL) {
      tail.shift();
    }
  });

  /**
   * How it ended, however it ended.
   *
   * `close` rather than `exit`, so stdout and stderr have both been read to the
   * end by the time this settles — and `error` too, since a program that is not
   * there never exits at all.
   */
  const ended = Promise.race([
    once(child, 'close').then(([code, killedBy]) => ({
      code: code as number | null,
      killedBy: killedBy as NodeJS.Signals | null,
    })),
    once(child, 'error').then(([error]) => {
      throw error as Error;
    }),
  ]);

  ended.catch(() => {
    // Awaited by `finished` below, which is where it is reported. Said here so
    // a program that fails while nobody is looking is not an unhandled
    // rejection.
  });

  if (options.timeoutMs !== undefined) {
    const timer = setTimeout(
      () => stop(`it was still running after ${String(options.timeoutMs)}ms`),
      options.timeoutMs,
    );

    timer.unref();
    void ended.then(
      () => clearTimeout(timer),
      () => clearTimeout(timer),
    );
  }

  const onAbort = (): void => stop('the run was called off');

  signal?.addEventListener('abort', onAbort, { once: true });

  void ended.then(
    () => {
      clearTimeout(killer);
      signal?.removeEventListener('abort', onAbort);
      noise.close();
    },
    () => {
      clearTimeout(killer);
      signal?.removeEventListener('abort', onAbort);
      noise.close();
    },
  );

  return {
    // Web, because that is what the document reader takes — and what a `fetch`
    // body already is, so both sources arrive the same way.
    bytes: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    said,
    finished: async () => {
      const { code, killedBy } = await ended.catch((error: unknown) => {
        throw new GrabberError(
          `${said} could not be run: ${error instanceof Error ? error.message : String(error)}`,
        );
      });

      if (stopped !== undefined) {
        throw new GrabberError(`${said} was stopped: ${stopped}${complaint(tail)}`);
      }

      if (killedBy !== null) {
        throw new GrabberError(`${said} was killed by ${killedBy}${complaint(tail)}`);
      }

      if (code !== 0 && !okExitCodes.includes(code ?? -1)) {
        // The whole reason this is read. A document that stops half way through
        // an element looks exactly like one that had nothing more to say.
        throw new GrabberError(
          `${said} exited ${String(code)} — its output cannot be trusted to be a whole document${complaint(tail)}`,
        );
      }
    },
    stop,
  };
}

/** What it said on the way down, where it said anything. */
function complaint(tail: readonly string[]): string {
  return tail.length === 0 ? '' : `. It said: ${tail.join(' / ')}`;
}

/** How many whole days `day` is from `from`. */
function offsetOf(day: string, from: Date): number {
  const wanted = Date.parse(`${day}T00:00:00Z`);
  const today = Date.parse(`${toDayString(from)}T00:00:00Z`);

  return Number.isNaN(wanted) ? 0 : Math.round((wanted - today) / 86_400_000);
}

/** A program that writes XMLTV to stdout, as a site. */
export function defineCommandSite<TData = XmltvChannel>(
  options: CommandSiteOptions<TData>,
): StreamSiteConfig<TData> {
  const {
    command,
    args = [],
    channelsArgs,
    cwd,
    env,
    shell,
    timeoutMs,
    okExitCodes,
    channels,
    compression,
    dayZone = 'source',
    order,
    parse,
    ...site
  } = options;

  /** One run of it, with everything this site was configured with. */
  const running = async (
    which: CommandArgs,
    context: CommandArgsContext,
  ): Promise<RunningCommand> =>
    runCommand({
      command,
      args: typeof which === 'function' ? await which(context) : which,
      ...(cwd === undefined ? {} : { cwd }),
      ...(env === undefined ? {} : { env }),
      ...(shell === undefined ? {} : { shell }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(okExitCodes === undefined ? {} : { okExitCodes }),
      warn: context.warn,
      ...(context.signal ? { signal: context.signal } : {}),
    });

  /** The document a run is writing, decompressed if it is compressed. */
  const document = (run: RunningCommand): AsyncGenerator<Buffer> =>
    streamBytes(run.bytes, { name: run.said, compression });

  return defineStreamSiteConfig<TData>({
    // A program is a slow thing to run twice, and its channel list changes as
    // rarely as a published guide's. The same default, for the same reason.
    cacheChannels: true,
    ...site,

    channels:
      channels ??
      (async ({ state, warn, signal }): Promise<GrabberChannel<TData>[]> => {
        // The DTD puts every `<channel>` before the first `<programme>`, so the
        // head of the document is the whole channel list — and a program given
        // `--list-channels` writes nothing else at all. Either way this stops
        // reading there and stops the program with it.
        const today = toDayString(new Date());
        const run = await running(channelsArgs ?? args, {
          days: [today],
          startDay: today,
          offset: 0,
          state,
          warn,
          ...(signal ? { signal } : {}),
        });
        const found: GrabberChannel<XmltvChannel>[] = [];
        let enough = false;

        try {
          for await (const event of parseXmltvStream(document(run), {
            ...parse,
            ...(signal ? { signal } : {}),
          })) {
            if (event.type === 'channel') {
              found.push(asGrabberChannel(event.value));
            } else if (event.type === 'programme') {
              // The list is complete: the DTD puts every `<channel>` before the
              // first `<programme>`.
              enough = true;
              break;
            }
          }
        } catch (error) {
          // A program left writing into a pipe nobody reads would sit there for
          // ever, so it goes before the parse failure is raised.
          run.stop('the channel list could not be read');

          throw error;
        }

        if (enough) {
          // Stopped on purpose, with the list in hand: the rest of the document
          // is a grab's business and not this pass's, so its exit says nothing
          // about whether this succeeded.
          run.stop('the channel list had been read');

          return found as GrabberChannel<TData>[];
        }

        // It ended on its own, so its exit code is the only thing that says
        // whether that list is the whole list. Without this, a program that is
        // not there — or one the timeout had to kill — would be an empty
        // channel list and a site that quietly grabbed nothing.
        await run.finished();

        return found as GrabberChannel<TData>[];
      }),

    channelInfo: site.channelInfo ?? xmltvChannelInfo,

    async *stream(ctx): AsyncGenerator<StreamedChannelDay<TData>> {
      const { channelDays, days, state, signal, warn } = ctx;
      // Counted from this machine's today, because that is what a program means
      // by it: a grabber's `--offset 0` is its own idea of today, in its own
      // timezone, and no amount of arithmetic here makes the two agree. A
      // window that starts today gets 0, `--offset -1` gets -1, and a source
      // that files days differently has `dayZone` for it.
      const today = new Date();
      const startDay = days[0] ?? toDayString(today);
      const window: CommandWindow = { days, startDay, offset: offsetOf(startDay, today) };

      // Said out loud, because nothing else can say it: `epg try` and a
      // verbose run instrument the site's HTTP client, and a program makes no
      // request to instrument. A command line that carries a secret in an
      // argument will therefore appear in a verbose log — which is worth
      // knowing, and is the same bargain `epg try` makes with a url.
      ctx.log(`running ${command}`);

      // Through the queue, and only the spawn: the output arrives while the
      // document is read, so a slot held for all of that would be a slot held
      // for the whole pass — which is the deadlock `paced` was shaped around.
      const run = await ctx.paced(({ signal: taskSignal }) =>
        running(args, {
          ...window,
          state,
          warn,
          ...((taskSignal ?? signal) ? { signal: taskSignal ?? signal } : {}),
        }),
      );

      try {
        yield* splitXmltvDocument<TData>(document(run), {
          channelDays,
          warn,
          ...(signal ? { signal } : {}),
          dayZone,
          ...(order === undefined ? {} : { order }),
          ...(parse === undefined ? {} : { parse }),
        });
      } catch (error) {
        run.stop('the document could not be read');

        throw error;
      }

      // **After** the document, never before: a program whose output nobody is
      // reading blocks on a full pipe. And before this generator ends, because
      // ending quietly is what caches every unreached channel-day as "nothing
      // on" — which for a program that died half way through its document is
      // exactly wrong.
      await run.finished();
    },
  });
}
