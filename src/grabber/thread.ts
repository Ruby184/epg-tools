/**
 * Sites in worker threads — `threads: true`, or `threads: 4`.
 *
 * A run's sites share one thread by default, and with it everything a site's
 * own code does on it: a parse that holds the thread holds every other site's
 * reads with it, and a big document parsed as it streams leaves the others what
 * is left over. A pool of workers spreads the sites over threads of their own —
 * one each when there are as many threads as sites, and shared otherwise.
 *
 * What a worker cannot be handed is the site itself — a config is functions,
 * and a function cannot be copied to another thread. So the worker imports the
 * config module again (`configModule`, which the `epg` command fills in with
 * the file it loaded), finds its site there by name, and runs that site's whole
 * turn: its client, its queue, its state and every `parseDay` stay on its side.
 * Only the edges of the run cross:
 *
 * - **the cache**, answered on the main thread: one store for every site, which
 *   is the one writer a database wants and the only place a memory cache or a
 *   driver of the config's own exists. The thread encodes a channel-day with
 *   the codec its store keeps entries with — see `cache/codec.ts` —
 *   as UTF-8 bytes it transfers rather than copies, and the main thread only
 *   stamps and saves them: measured for 3,500 programmes of Slovak text, about
 *   1ms of the main thread's time, against 12 for the same bytes sent as a
 *   string, which the main thread copies and a file write encodes again. A store that keeps
 *   something no thread can make is sent lines — each programme's record as
 *   JSON, because a `Date` copied to another thread loses the offset and the
 *   precision this package keeps on it — and handed programmes read back from
 *   them.
 * - **events**, said on the main thread, where the reporter is — an error made
 *   plain on the way, since copying one keeps neither its name nor anything a
 *   library hung on it.
 * - **cancelling**, as a message the worker turns back into an abort.
 * - **the counts**, in memory both threads see rather than as messages: a
 *   site that never finishes has still counted what it did, and a thread
 *   that dies cannot take any of it with it — nor leave the run unsure whether
 *   it had begun, or had counted itself failed.
 *
 * What a worker runs is `thread-worker.ts`, a file of its own and an entry of
 * the build of its own: started by its URL, so it runs that and nothing a
 * bundler happened to put beside the code that starts it.
 */

import { availableParallelism } from 'node:os';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { inspect } from 'node:util';
import { MessageChannel, Worker } from 'node:worker_threads';
import PQueue from 'p-queue';
import { CacheManager } from '../cache/manager.js';
import { CODECS, fromLine, toLine, type CodecName } from '../cache/codec.js';
import type { CacheStore, ChannelDayKey } from '../cache/types.js';
import { resolveConfigSource, type ConfigSource, type EpgConfig } from '../config.js';
import { errorMessage, MAX_CAUSE_DEPTH } from '../core/error.js';
import {
  emitOf,
  noCounts,
  noRequests,
  type EpgEventInput,
  type EpgEventType,
  type GrabCounts,
  type RequestCounts,
} from '../core/events.js';
import type { XmltvProgramme } from '../xmltv/types.js';
import { assertPlainData } from './channels.js';
import { addedTime, measuredOf, type SiteClock } from './clock.js';
import {
  addRequests,
  mergedRequests,
  requestsObject,
  siteDone,
  tellAll,
  type SiteSession,
} from './session.js';
import { CountReader, CountWriter, type SlotName } from './shared-counts.js';
import { SiteRun, type Enqueue, type Run } from './site-run.js';
import type { AnySiteConfig, GrabberChannel } from './types.js';

/** What a site is handed to a worker with: everything a run lends it, as data. */
export interface SiteThreadData {
  /** The config module, as a URL — what the worker imports to find its site. */
  module: string;
  /** Which of its sites. */
  site: string;
  /**
   * The channels, when the run has settled them already — selected, or left to
   * another site by `cover`. Left out, the site resolves its own.
   */
  channels?: GrabberChannel[];
  now: string;
  grabbedAt: string;
  startDay: string;
  /** The run's zone, for which day is today — see `GrabOptions.timeZone`. */
  timeZone: string;
  defaults: Run['defaults'];
  localConcurrency: number;
  /** The codec the run's store keeps its entries with, when a thread has it — see `CacheManager.codecName`. */
  codec?: CodecName;
  /** The memory its request counts go in, which the run's thread reads — see `shared-counts.ts`. */
  counts: SharedArrayBuffer;
  /**
   * The kinds of event the run's reporter wants, as the run took them when it
   * began — its own `Emit.hears` — so that what nobody reads is neither made
   * nor sent.
   */
  hears: EpgEventType[];
}

/** Either end of the conversation: a worker, its `parentPort`, or a channel's port. */
export interface SitePort {
  /** With what it hands over rather than copies — none, as often as not. */
  postMessage(value: unknown, transfer: ArrayBuffer[]): void;
  on(event: 'message', listener: (value: any) => void): unknown;
  /**
   * Its other end gone — after every message it sent, which a port hands over
   * before it says so: measured for a thread that threw, exited, was stopped
   * or ran out of memory.
   */
  on(event: 'close', listener: () => void): unknown;
  off(event: 'message', listener: (value: any) => void): unknown;
  off(event: 'close', listener: () => void): unknown;
}

/**
 * A site a thread never ran — refused before it began: a config its thread
 * could not read, a site that could not be resolved, a list no thread can be
 * handed — and why, as its `cause`. So the run can say of it what it says of
 * such a site on its own thread, which a thread that dies part way through a
 * site cannot be taken for.
 */
export class SiteNotRunError extends Error {
  override readonly name = 'SiteNotRunError';

  constructor(cause: unknown) {
    super(errorMessage(cause), { cause });
  }
}

/** The cache's methods, which is all the worker's store asks the main thread. */
type CacheOp = Exclude<keyof CacheStore, 'close'> | 'writeEncoded';

/**
 * Whether the run's thread answers `op` through a slot of its `localWork` —
 * every call but what a site remembers, which is small and read once a turn.
 * The one rule both sides keep to: the run's thread, to say how long a call
 * waited for its slot, and a site's, to tell its clock it is waiting there.
 */
function throughLocalWork(op: CacheOp): boolean {
  return op !== 'getState' && op !== 'setState';
}

type ToHost =
  | { kind: 'event'; event: EpgEventInput }
  | { kind: 'cache'; id: number; op: CacheOp; args: unknown[] }
  /** What a slot of the site's shared counts counts, said once — see `shared-counts.ts`. */
  | { kind: 'slot'; index: number; slot: SlotName }
  /** Counts there was no slot left for, said instead. */
  | { kind: 'requested'; label: string; done: RequestCounts }
  | { kind: 'done' }
  /** Whether any of it ran first is in its shared counts — see `CountWriter.begin`. */
  | { kind: 'failed'; error: unknown };

type ToWorker =
  /**
   * A cache call answered — with how long it waited for a slot of the run's
   * `localWork` first, where it did, which is time the site's clock otherwise
   * gives to its work: see `SiteClock.back`.
   */
  | { kind: 'answer'; id: number; value?: unknown; error?: unknown; queuedMs?: number }
  | { kind: 'abort'; reason: unknown };

/** An error as it crosses: what the reporters read, and nothing a clone would lose. */
interface PlainError {
  kind: 'error';
  name: string;
  message: string;
  stack?: string;
  code?: string | number;
  cause?: unknown;
}

/**
 * An error as plain data, its `cause` chain with it.
 *
 * A copy of an `Error` keeps its message, its stack and its cause, but its name
 * only when it is one of the language's own — so ky's `HTTPError` would arrive
 * as `Error` — and nothing else a library put on it. Anything that is not an
 * error crosses as it is — or, where no thread can be handed it, as
 * {@link send} makes it.
 */
function plain(error: unknown, depth = 0): unknown {
  try {
    if (!(error instanceof Error)) {
      return error;
    }

    const { code } = error as { code?: unknown };

    return {
      kind: 'error',
      name: error.name,
      message: error.message,
      ...(error.stack === undefined ? {} : { stack: error.stack }),
      ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}),
      ...(error.cause === undefined || depth >= MAX_CAUSE_DEPTH
        ? {}
        : { cause: plain(error.cause, depth + 1) }),
    } satisfies PlainError;
  } catch {
    // An error that cannot be read — a revoked proxy, a getter that throws —
    // crosses as what can be said of it, rather than failing what says it.
    return {
      kind: 'error',
      name: 'Error',
      message: errorMessage(error),
    } satisfies PlainError;
  }
}

/** The error a {@link plain} one stands for, on this side. */
function revived(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || (value as PlainError).kind !== 'error') {
    return value;
  }

  const { name, message, stack, code, cause } = value as PlainError;
  const error = new Error(message, cause === undefined ? undefined : { cause: revived(cause) });

  error.name = name;

  if (stack !== undefined) {
    error.stack = stack;
  }

  if (code !== undefined) {
    (error as Error & { code?: string | number }).code = code;
  }

  return error;
}

/** An event as it crosses, its error made plain. */
function plainEvent(event: EpgEventInput): EpgEventInput {
  return 'error' in event ? ({ ...event, error: plain(event.error) } as EpgEventInput) : event;
}

/**
 * Send something to the other side, whatever a site put in it.
 *
 * A site's `log` and `warn` take fields of its own, which may hold something no
 * thread can be handed — a function, a socket — and what it throws, or what a
 * run is cancelled with, may hold one too, as itself or as an error's `cause`.
 * As the JSON reporter does with them: what survives JSON goes as JSON, and
 * what does not is named in place of its value (see `SaidFields`) — never a
 * throw into the site's own code, where a log line would fail the channel-day
 * it was about, nor into a listener, where it would end the process. Made so
 * only once the message has been refused, so what crosses as it is is copied
 * once.
 */
function send(port: SitePort, message: ToHost | ToWorker, transfer: ArrayBuffer[] = []): void {
  try {
    port.postMessage(message, transfer);
  } catch (error) {
    const handable = handableOf(message);

    if (handable === undefined) {
      throw error;
    }

    port.postMessage(handable, []);
  }
}

/**
 * `message` with what of a site's — or a caller's — no thread can be handed
 * made into what one can, as {@link send} says; nothing, for one that carries
 * nothing of theirs.
 */
function handableOf(message: ToHost | ToWorker): ToHost | ToWorker | undefined {
  switch (message.kind) {
    case 'event': {
      const event = message.event as EpgEventInput & { data?: unknown; error?: unknown };

      return {
        ...message,
        event: {
          ...event,
          ...('data' in event ? { data: asJson(event.data) } : {}),
          ...('error' in event ? { error: handableError(event.error) } : {}),
        } as EpgEventInput,
      };
    }
    case 'failed':
      return { ...message, error: handableError(message.error) };
    case 'answer':
      // An answer the store gave that no thread can be handed — something of
      // a store of the config's own — is the call failing, said as such,
      // rather than a call never answered.
      return message.error === undefined
        ? {
            kind: 'answer',
            id: message.id,
            ...(message.queuedMs === undefined ? {} : { queuedMs: message.queuedMs }),
            error: plain(
              new TypeError("The run's cache answered with what no thread can be handed"),
            ),
          }
        : { ...message, error: handableError(message.error) };
    case 'abort':
      return { ...message, reason: handableError(message.reason) };
    default:
      return undefined;
  }
}

/**
 * A {@link plain} error with what of it is no error — a `cause` holding a
 * function, a thrown object holding a socket — as JSON keeps it.
 */
function handableError(error: unknown): unknown {
  if (typeof error === 'object' && error !== null && (error as PlainError).kind === 'error') {
    const { cause } = error as PlainError;

    return cause === undefined ? error : { ...(error as PlainError), cause: handableError(cause) };
  }

  return asJson(error);
}

/** `value` as JSON keeps it, or named where JSON cannot have it. */
function asJson(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return '[unserializable]';
  }
}

// ── the main thread's half ──────────────────────────────────────────────────

/**
 * How many threads `threads` asks for: none when it is off, one per core for
 * `true`, and otherwise the number it names — `0` being off too.
 *
 * And whether they can be had, which is the other half of the same question:
 * threads need the module the config came from. Asked where a run starts, as
 * well as by `grab`, so a run that cannot start them says so before it has
 * fetched a single channel list.
 */
export function threadCount(
  threads: boolean | number | undefined,
  configModule: string | URL | undefined,
): number {
  if (threads === undefined || threads === false) {
    return 0;
  }

  const count = threads === true ? availableParallelism() : threads;

  if (!Number.isInteger(count) || count < 0) {
    throw new TypeError(
      `threads is true, false or a whole number of threads (got ${String(threads)})`,
    );
  }

  if (count > 0 && configModule === undefined) {
    throw new TypeError(
      'threads needs the module the config came from: pass configModule, ' +
        'or run it with the epg command',
    );
  }

  return count;
}

/** Where a pool's workers start: the source beside this one, or the built file beside its chunk. */
const WORKER = new URL(
  import.meta.url.endsWith('.ts') ? './thread-worker.ts' : './thread-worker.js',
  import.meta.url,
);

/** This process's pools, by config module — see {@link SiteThreads.for}. */
const pools = new Map<string, SiteThreads>();

/** One worker of a run's pool, and how many sites it is running now. */
interface PooledWorker {
  worker: Worker;
  sites: number;
  /**
   * Who is told when the thread dies — out of memory, or an error nothing
   * caught — which fails every site it was running: the conversation would
   * simply stop. A site's host is in it while its site runs, and no longer: the
   * thread outlives the run, and a listener left would keep the run with it.
   */
  losing: Set<(error: unknown) => void>;
  /** Why it died, once it has — so its `exit` after its `error` is not said again. */
  lostWith?: Error;
}

/**
 * The threads sites run in: at most `size` of them, each running every site it
 * is handed at once.
 *
 * At once, whatever the size, because most of what a site does is wait — a
 * pool smaller than the sites shares threads between them rather than queueing
 * them. A site goes to whichever worker is running fewest, and another worker
 * is started only when every one there is busy, so a pool at least as large as
 * the sites gives each one its own and starts no more than it uses.
 *
 * Each site is handed over with a port of its own, so a worker of several
 * sites holds the same conversation for each as a worker of one.
 *
 * One pool per config module for the life of the process, and its workers kept
 * between runs. A worker reads the config module once, when its first site
 * arrives — as the main thread read it once — so a server grabbing every night
 * grabs with the code it started with, rather than with whatever the file says
 * by then while its channel lists and its merge are still the old one's. Kept
 * without holding the process open: a worker running nothing does not keep it.
 */
export class SiteThreads {
  #size = 0;
  readonly #module: string;
  readonly #workers: PooledWorker[] = [];

  private constructor(module: string) {
    this.#module = module;
  }

  /** The pool for this config module, at most `size` threads from now on. */
  static for(size: number, configModule: string | URL): SiteThreads {
    const module = moduleUrl(configModule);
    let pool = pools.get(module);

    if (pool === undefined) {
      pool = new SiteThreads(module);
      pools.set(module, pool);
    }

    pool.#size = size;

    return pool;
  }

  /**
   * Run one site on a worker, and answer for it on this side.
   *
   * Resolves when the site is done, as `new SiteRun(config, run).run()` would,
   * with what hangs up on it, which the run calls once it is done with every
   * site — see {@link hostSite}. Rejects with a
   * {@link SiteNotRunError} when it never got going — no thread to start, a config
   * its thread could not import, did not have it, or did not resolve, or a
   * channel list no thread can be handed as it is.
   */
  async run(
    config: AnySiteConfig,
    run: Run,
    /** The session its list was settled through on this thread — see {@link hostSite}. */
    settled?: SiteSession,
  ): Promise<() => void> {
    // Before a worker is asked for, so a site that cannot go starts nothing: a
    // copy would hand the thread something else without saying so, and a
    // function could not be copied at all.
    if (Array.isArray(config.channels)) {
      try {
        assertPlainData(config.site, config.channels);
      } catch (error) {
        throw new SiteNotRunError(error);
      }
    }

    const reader = new CountReader();
    const data: SiteThreadData = {
      module: this.#module,
      site: config.site,
      // Only a list the run is holding: a function is the site's own, and the
      // worker has that from its own import.
      ...(Array.isArray(config.channels) ? { channels: config.channels } : {}),
      now: run.now.toISOString(),
      grabbedAt: run.grabbedAt,
      startDay: run.startDay,
      timeZone: run.timeZone,
      defaults: run.defaults,
      localConcurrency: run.localWork.concurrency,
      ...(run.cache instanceof CacheManager && run.cache.codecName !== undefined
        ? { codec: run.cache.codecName }
        : {}),
      counts: reader.buffer,
      hears: [...run.emit.hears],
    };
    const { port1, port2 } = new MessageChannel();
    let pooled: PooledWorker;

    try {
      pooled = this.#pick();
      pooled.worker.postMessage({ data, port: port2 }, [port2]);
    } catch (error) {
      port1.close();
      port2.close();

      // Never handed over, so never run.
      throw new SiteNotRunError(error);
    }

    pooled.sites++;

    try {
      const hangUp = await hostSite(port1, run, {
        site: config.site,
        counts: reader,
        ...(settled === undefined ? {} : { settled }),
        // A worker picked is one still in the pool, and nothing between the
        // pick and this can hear it go: it is listened to from here.
        whenLost: (lose) => {
          pooled.losing.add(lose);

          return () => pooled.losing.delete(lose);
        },
      });

      // Open until the run hangs up, to hear what a request the site did not
      // wait for still counts — without holding the process open for it.
      port1.unref();

      return () => {
        hangUp();
        port1.close();
      };
    } catch (error) {
      port1.close();

      throw error;
    } finally {
      pooled.sites--;
    }
  }

  /** The worker running fewest sites — a new one, while there is room and none is idle. */
  #pick(): PooledWorker {
    const idlest = this.#workers.reduce<PooledWorker | undefined>(
      (best, pooled) => (best === undefined || pooled.sites < best.sites ? pooled : best),
      undefined,
    );

    if (idlest !== undefined && (idlest.sites === 0 || this.#workers.length >= this.#size)) {
      return idlest;
    }

    const worker = new Worker(WORKER);
    const pooled: PooledWorker = { worker, sites: 0, losing: new Set() };

    /**
     * Fail what it was running, and leave the pool — at the first sign, since
     * `exit` follows `error` a turn later, and a site started in between must
     * not be handed a thread that is going: a dead one runs nothing, and would
     * be the idlest of them for ever.
     */
    const gone = (thrown: unknown): void => {
      if (pooled.lostWith !== undefined) {
        return;
      }

      // An error whatever was thrown — a site's code may throw anything, even
      // `undefined`, which would read here as a thread that never died — and
      // what it was with it, an object's fields and all.
      const error =
        thrown instanceof Error
          ? thrown
          : new Error(
              `A site's thread threw ${inspect(thrown, { depth: 2, breakLength: Infinity })}`,
            );

      pooled.lostWith = error;

      // Out of the pool before anyone is told: a site started by what they
      // say must not be handed a thread that is going.
      const at = this.#workers.indexOf(pooled);

      if (at !== -1) {
        this.#workers.splice(at, 1);
      }

      for (const tell of pooled.losing) {
        tell(error);
      }

      pooled.losing.clear();
    };

    worker.once('error', gone);
    worker.once('exit', (code) => {
      gone(new Error(`A site's thread stopped (exit code ${code})`));
    });
    // Kept between runs without keeping the process: while a site runs, its
    // port is what holds the process open.
    worker.unref();
    this.#workers.push(pooled);

    return pooled;
  }
}

/** A config module named any way a caller might, as the URL a worker imports. */
function moduleUrl(configModule: string | URL): string {
  if (configModule instanceof URL) {
    return configModule.href;
  }

  // A URL already, or a path — absolute, or from the working directory.
  return /^[a-z][a-z0-9+.-]*:/i.test(configModule) && !/^[a-z]:[\\/]/i.test(configModule)
    ? configModule
    : pathToFileURL(configModule).href;
}

/**
 * How long a site whose thread is gone waits for its port to say it closed —
 * after everything the thread sent, which is how the run knows it has heard
 * it all — before it is decided without, on what its memory holds. Measured, a
 * port closes at once, for a thread that threw, exited, was stopped or ran out
 * of memory — save one handed to a thread already gone, which never does; this
 * is for that, and for one that goes some way that was not measured, which
 * must not hold the run for ever.
 */
const LOST_PORT_GRACE_MS = 5_000;

/** What a site's host is told beside its port and the run — see {@link hostSite}. */
export interface Hosting {
  /** The site's name, for what is said of it should its thread go. */
  site: string;
  /**
   * The session its list was settled through on this thread before it was
   * handed over, which its `site:done` from over there could not know of: what
   * it asked, and how long that took, are added as the event passes. The run
   * was told of them when they were asked.
   */
  settled?: SiteSession;
  /**
   * Listen for the thread going, for as long as the site runs — handed what to
   * call, and answering what stops it.
   */
  whenLost?: (lose: (error: unknown) => void) => () => void;
  /** What the site's thread counts in — over the {@link SiteThreadData}'s memory. */
  counts: CountReader;
}

/**
 * This side of the conversation: answer the worker's cache, say what it says,
 * count what it counted, and tell it when the run is cancelled.
 *
 * The worker's cache work goes through the run's `localWork`, so every
 * thread's reads and writes together keep to the bound one thread's would
 * have — a write ahead of a sweep, as in a run of one. Without the run's
 * signal, though: what is waiting in a worker is cancelled by the worker's own
 * queue, and what reaches this side is answered, as a store in the same thread
 * would be. A site cancelled part way still finishes the write it started and
 * saves its state, and a site's state is read and saved straight through, as
 * it is in-process.
 *
 * Resolves when the site is done, with what hangs up on it — which tells the
 * run what the site counted, from its shared memory. Not before the run is done
 * with every site, as a site on the run's own thread is counted until then: a
 * request a parse sent and did not wait for can be answered after its site's
 * `site:done`, and is counted, cancelled with the run and said as it would be
 * there.
 *
 * A site that throws out of its turn, which a site that finishes it does not,
 * or whose thread goes part way through it, is said here as a site that fails
 * says itself: `site:failed`, then `site:done` with what it did, from what it
 * counted — once, should it have counted itself failed already. A thread that
 * went is said of once its port has closed, which is after everything it sent:
 * so whether the site had said its own `site:done` is known, not guessed. One
 * the thread never began on rejects with a {@link SiteNotRunError}, for the run to
 * say as a site that never ran.
 */
export function hostSite(port: SitePort, run: Run, hosting: Hosting): Promise<() => void> {
  const { cache, emit, localWork, signal, tally, requested } = run;
  const { site, settled, whenLost, counts: reader } = hosting;

  return new Promise<() => void>((resolve, reject) => {
    /** How far the site's turn has got, each of them once. */
    const turn = {
      /**
       * Its `site:done` heard — which is whether it was said, by the time
       * anything after it is: a port hands over what it was sent in order,
       * and says it closed after all of it.
       */
      said: false,
      /** Over — see {@link ended}: only the first of a done, a failure and a lost thread. */
      ended: false,
      /** Hung up on — see {@link hangUp}. */
      hungUp: false,
    };
    /**
     * Its thread going, as it is heard of — see {@link lost}: why, once it
     * has; whether its port has said it closed, which it does after all the
     * thread sent; and what gives up waiting for that.
     */
    const going: {
      why?: { error: unknown };
      closed: boolean;
      givingUp?: ReturnType<typeof setTimeout>;
    } = { closed: false };
    /** What there was no slot for, said as it went — and told the run as it was. */
    const unslotted = new Map<string, RequestCounts>();
    // Before anything can be heard: a port may hand over what it holds as soon
    // as it is listened to.
    let stopListening: (() => void) | undefined;

    const abort = (): void => {
      send(port, { kind: 'abort', reason: plain(signal?.reason) });
    };

    /** Stop listening, and tell the run what the site's slots hold — once. */
    const hangUp = (): void => {
      if (turn.hungUp) {
        return;
      }

      turn.hungUp = true;
      port.off('message', listen);
      port.off('close', close);
      signal?.removeEventListener('abort', abort);
      tellAll(requested, reader.read());
    };

    /**
     * The site's turn over — done, thrown out of, or lost with its thread — or
     * never begun. Settled before anything is said of it.
     */
    const ended = (end?: { error: unknown; how: 'threw' | 'went' }): void => {
      if (turn.ended) {
        return;
      }

      turn.ended = true;
      stopListening?.();
      clearTimeout(going.givingUp);

      // A thread that went sends nothing more, and what it sent is heard —
      // or given up on: nothing heard from here could be the site's own.
      if (end?.how === 'went') {
        port.off('message', listen);
      }

      const began = reader.began();
      const counted = reader.tally();

      // Its channel-days into the run's as its turn ends, as a site on the
      // run's thread has added them by then: none comes after.
      for (const [field, n] of Object.entries(counted) as Array<[keyof GrabCounts, number]>) {
        tally[field] += n;
      }

      if (end !== undefined && began === undefined) {
        hangUp();
        reject(new SiteNotRunError(end.error));

        return;
      }

      resolve(hangUp);

      if (end === undefined) {
        return;
      }

      const went = end.how === 'went' ? 'its thread went' : 'it threw';

      // All of it said, and nothing left but what was thrown after — or the
      // thread's going, which is nothing of this site's.
      if (turn.said) {
        if (end.how === 'threw') {
          emit({
            type: 'site:warning',
            site,
            message: `it threw after it was done: ${errorMessage(end.error)}`,
          });
        }

        return;
      }

      const by = reader.read();

      for (const [label, done] of unslotted) {
        addRequests(by, label, done);
      }

      const done = siteDone(
        site,
        Date.now() - began!,
        requestsObject(by),
        { ...counted, sitesFailed: 1 },
        // Where its time went, as far as its thread said before it went.
        reader.spent(),
      );

      // Once: a site that failed has counted it, and said why.
      if (counted.sitesFailed === 0) {
        tally.sitesFailed++;
        emit({ type: 'site:failed', site, error: end.error });
      } else {
        emit({
          type: 'site:warning',
          site,
          message: `${went} before it was done: ${errorMessage(end.error)}`,
        });
      }

      emit(settled === undefined ? done : withSettled(done, settled));
    };

    /**
     * Its thread gone, and everything it sent heard — see {@link SitePort}:
     * for a site it never began on too, which may have said why it never
     * could just before its thread went for another site's sake.
     */
    const lost = (): void => {
      if (going.why !== undefined && going.closed) {
        ended({ error: going.why.error, how: 'went' });
      }
    };

    /**
     * Half of its thread going heard — word that it went, or its port closing
     * — and the other waited for a while, then taken as heard: see
     * {@link LOST_PORT_GRACE_MS}. A port closed with no word of its thread is
     * a host with no thread to hear from, or a thread gone some way that says
     * nothing.
     */
    const giveUpLater = (): void => {
      if (turn.ended || going.givingUp !== undefined) {
        return;
      }

      going.givingUp = setTimeout(() => {
        going.closed = true;
        going.why ??= { error: new Error("The site's thread hung up without a word") };
        lost();
      }, LOST_PORT_GRACE_MS);
    };

    const close = (): void => {
      going.closed = true;
      lost();
      giveUpLater();
    };

    const listen = (message: ToHost): void => {
      switch (message.kind) {
        case 'event': {
          const event = message.event;

          if ('error' in event) {
            (event as { error: unknown }).error = revived(event.error);
          }

          turn.said ||= event.type === 'site:done';
          emit(
            event.type === 'site:done' && settled !== undefined
              ? withSettled(event, settled)
              : event,
          );
          break;
        }
        case 'slot':
          reader.named(message.index, message.slot);

          // Its place among the run's labels taken now, when it was first
          // sent, rather than when the run hangs up.
          if (message.slot.failure === undefined) {
            requested(message.slot.label, noRequests());
          }
          break;
        case 'requested':
          requested(message.label, message.done);
          addRequests(unslotted, message.label, message.done);
          break;
        case 'cache': {
          const { id, op, args } = message;
          /** How long it waited for a slot of `localWork` — none, for what never asks for one. */
          let queuedMs: number | undefined;
          const asked = performance.now();
          const answering = !throughLocalWork(op)
            ? answer(cache, op, args)
            : localWork.add(
                () => {
                  queuedMs = performance.now() - asked;

                  return answer(cache, op, args);
                },
                {
                  // A channel-day written — encoded already, for a store
                  // with a codec — or read to be added to, ahead of a sweep.
                  priority: op === 'write' || op === 'writeEncoded' || op === 'read' ? 1 : 0,
                },
              );
          const waited = (): { queuedMs?: number } => (queuedMs === undefined ? {} : { queuedMs });

          void answering.then(
            (value) => {
              send(port, { kind: 'answer', id, value, ...waited() });
            },
            (error: unknown) => {
              send(port, { kind: 'answer', id, error: plain(error), ...waited() });
            },
          );
          break;
        }
        case 'done':
          ended();
          break;
        case 'failed':
          ended({ error: revived(message.error), how: 'threw' });
          break;
      }
    };

    port.on('message', listen);
    port.on('close', close);

    if (signal?.aborted) {
      abort();
    } else {
      signal?.addEventListener('abort', abort, { once: true });
    }

    // Last, since a thread already gone ends the site here and now — and
    // hanging up lets go of everything listened to before.
    stopListening = whenLost?.((error) => {
      going.why = { error };
      lost();
      giveUpLater();
    });
  });
}

/**
 * One cache call the worker made, made here: a channel-day already encoded for
 * the store, or programmes as lines for one that keeps something else.
 */
async function answer(cache: CacheStore, op: CacheOp, args: unknown[]): Promise<unknown> {
  switch (op) {
    case 'writeEncoded': {
      const [key, body, programmeCount, meta] = args as [
        ChannelDayKey,
        Uint8Array,
        number,
        Parameters<CacheStore['write']>[2],
      ];

      // Only ever asked of the store whose codec the thread was handed.
      return (cache as CacheManager).writeEncoded(key, body, programmeCount, meta);
    }
    case 'write': {
      const [key, lines, meta] = args as [
        ChannelDayKey,
        string[],
        Parameters<CacheStore['write']>[2],
      ];

      return cache.write(key, lines.map(fromLine), meta);
    }
    case 'read': {
      const found = await cache.read(args[0] as ChannelDayKey);

      return found?.map(toLine);
    }
    default:
      return (cache[op] as (...given: unknown[]) => Promise<unknown>).apply(cache, args);
  }
}

// ── the worker's half ───────────────────────────────────────────────────────

/**
 * The run's cache, as the main thread answers it. Exported to be tried without
 * a site to run.
 */
export class RemoteCache implements CacheStore {
  readonly #port: SitePort;
  /** The codec the run's store keeps its entries with, run here when there is one. */
  readonly #codec: CodecName | undefined;
  /** Each call not yet answered — and the clock told it went to the run's thread, where one was. */
  readonly #waiting = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: unknown): void;
      /** The clock told it went to the run's thread, and when. */
      clock: SiteClock | undefined;
      since: number;
    }
  >();
  /** The clock of the site this asks for — see {@link timeWith}. */
  #clock: SiteClock | undefined;
  /** What {@link close} is waiting on, told once no call is left waiting — a turn later. */
  #drained: (() => void) | undefined;
  /** Whether {@link close} is done, after which nothing is answered. */
  #closed = false;
  #next = 0;

  constructor(port: SitePort, codec: CodecName | undefined) {
    this.#port = port;
    this.#codec = codec;
    port.on('message', this.#answered);
    port.on('close', this.#hungUp);
  }

  /**
   * The run hung up, or the thread is going: nothing waiting will be answered,
   * so each is told so — and whatever waits on it lets go — rather than left
   * waiting for ever. Listened for until {@link close}.
   */
  readonly #hungUp = (): void => {
    // Nothing asked from here is answered either: refused, rather than sent.
    this.#closed = true;

    for (const { reject, clock, since } of this.#waiting.values()) {
      clock?.back(since, 0);
      reject(new Error('The run stopped answering its cache before this call was answered'));
    }

    this.#waiting.clear();
    this.#drained?.();
  };

  /** What the main thread answered, to the call that asked it — listened for until {@link close}. */
  readonly #answered = (message: ToWorker): void => {
    if (message.kind !== 'answer') {
      return;
    }

    const waiting = this.#waiting.get(message.id);

    // Back, with what of it was a wait for a slot on the run's thread.
    waiting?.clock?.back(waiting.since, message.queuedMs ?? 0);

    // Its caller told first, so one asking again as it goes on is still waited
    // for by a close that is waiting.
    if (message.error === undefined) {
      waiting?.resolve(message.value);
    } else {
      waiting?.reject(revived(message.error));
    }

    this.#forget(message.id);
  };

  /** Let go of call `id`, and tell {@link close} once no call is left waiting. */
  #forget(id: number): void {
    this.#waiting.delete(id);

    if (this.#waiting.size === 0) {
      this.#drained?.();
    }
  }

  /** One cache call, answered by the main thread — and the buffers it hands over rather than copies. */
  #ask(op: CacheOp, args: unknown[], transfer: ArrayBuffer[] = []): Promise<any> {
    // Refused rather than sent: nothing is listening for its answer.
    if (this.#closed) {
      return Promise.reject(new Error('The run’s cache was asked after the site was done with it'));
    }

    const id = this.#next++;
    // What the run's thread answers through a slot of its local work: the
    // site's work waits on it there, where the clock is told.
    const clock = throughLocalWork(op) ? this.#clock : undefined;
    const since = clock?.elsewhere() ?? 0;

    return new Promise((resolve, reject) => {
      this.#waiting.set(id, { resolve, reject, clock, since });

      try {
        send(this.#port, { kind: 'cache', id, op, args }, transfer);
      } catch (error) {
        // Never sent — what no thread can be handed, as what a site keeps may
        // hold — so never to be answered.
        clock?.back(since, 0);
        this.#forget(id);
        throw error;
      }
    });
  }

  /**
   * Tell `clock` how long each call waits for a slot on the run's thread: time
   * the site's own work is said to have taken otherwise, where it is the run's
   * `localConcurrency` that held it up.
   */
  timeWith(clock: SiteClock): void {
    this.#clock = clock;
  }

  getMeta(key: ChannelDayKey): ReturnType<CacheStore['getMeta']> {
    return this.#ask('getMeta', [key]);
  }

  getMetas(keys: readonly ChannelDayKey[]): ReturnType<CacheStore['getMetas']> {
    return this.#ask('getMetas', [keys]);
  }

  async read(key: ChannelDayKey): Promise<XmltvProgramme[] | undefined> {
    const lines = (await this.#ask('read', [key])) as string[] | undefined;

    return lines?.map(fromLine);
  }

  write(...[key, programmes, meta]: Parameters<CacheStore['write']>): Promise<void> {
    if (this.#codec === undefined) {
      return this.#ask('write', [key, programmes.map(toLine), meta]);
    }

    // Transferred, not copied: the bytes are the store's, and this thread is
    // done with them.
    const body = CODECS[this.#codec].encode(programmes);

    return this.#ask(
      'writeEncoded',
      [key, body, programmes.length, meta],
      [body.buffer as ArrayBuffer],
    );
  }

  delete(key: ChannelDayKey): Promise<void> {
    return this.#ask('delete', [key]);
  }

  prune(options: { before: string }): Promise<number> {
    return this.#ask('prune', [options]);
  }

  getState(...args: Parameters<CacheStore['getState']>): ReturnType<CacheStore['getState']> {
    return this.#ask('getState', args);
  }

  setState(...args: Parameters<CacheStore['setState']>): Promise<void> {
    return this.#ask('setState', args);
  }

  /**
   * The main thread's store, which is the main thread's to close: this lets go
   * of the port it was asked through, which outlives it.
   *
   * Once what is still asked is answered: a call a cancel let go of, or one
   * beside a read that failed, is still the main thread's to answer, and what
   * waits on it holds a slot of the thread's `localWork` — which every site the
   * thread runs shares, in this run and the next — until it is.
   */
  async close(): Promise<void> {
    // Until none is left, and none asked by what the last answer let go on —
    // a read, then the write it was for: that goes on in the turn it was
    // answered in, and a turn waited for comes after all of it.
    do {
      await new Promise<void>((resolve) => {
        this.#drained = () => setImmediate(resolve);

        if (this.#waiting.size === 0) {
          this.#drained();
        }
      });
    } while (this.#waiting.size > 0);

    this.#drained = undefined;
    this.#closed = true;
    this.#port.off('message', this.#answered);
    this.#port.off('close', this.#hungUp);
  }
}

/**
 * Run one site in this thread, saying everything to `port`.
 *
 * `localWork` is the thread's, shared by every site it runs as a run's is by
 * every site in it — so with threads, `localConcurrency` bounds each thread's
 * parsing rather than the whole run's.
 *
 * Exported so the conversation can be held over a `MessageChannel` in one
 * thread: what a worker adds to it is only that it runs somewhere else.
 */
export async function workSite(
  port: SitePort,
  data: SiteThreadData,
  localWork = new PQueue({ concurrency: data.localConcurrency }),
): Promise<void> {
  const stop = new AbortController();
  /**
   * Where the site's request counts go: memory the run's thread reads, so none
   * is held here for a thread that dies to lose, and none crosses as a message
   * but a count's name, once. Measured for 10,050 requests a millisecond each,
   * one at a time: four messages and 74ms of the main thread, against 20,100
   * messages and 958ms said each time, and 10,100 and 857ms gathered a turn at
   * a time — which also lost what a thread that died was holding.
   */
  const writer = new CountWriter(data.counts, (index, slot) => {
    send(port, { kind: 'slot', index, slot });
  });
  /** The run's store, asked through the port — closed once the site's turn is over. */
  const cache = new RemoteCache(port, data.codec);

  /**
   * The run cancelled — listened for until it hangs up, so a request the site
   * did not wait for is cancelled with it — and let go of then.
   */
  const cancelled = (message: ToWorker): void => {
    if (message.kind === 'abort') {
      stop.abort(revived(message.reason));
    }
  };
  const hungUp = (): void => {
    port.off('message', cancelled);
    port.off('close', hungUp);
  };

  port.on('message', cancelled);
  port.on('close', hungUp);

  try {
    // Once per worker however many of its sites are in it: a config function
    // then runs once a thread, not once a site.
    // Read out of `data` rather than through it in what follows: a closure
    // that names it keeps all of it — the site's channels among it — for as
    // long as this conversation's listeners, which is the rest of the run.
    const { module, site: name } = data;
    let reading = configs.get(module);

    if (reading === undefined) {
      reading = import(module).then((imported: { default?: ConfigSource }) => {
        if (imported.default === undefined) {
          throw new TypeError(`${module} has no default export, so there is no config to run`);
        }

        return resolveConfigSource(imported.default);
      });
      configs.set(module, reading);

      // Not kept, should it fail: a config that fetches, or reads what it is
      // run with, may answer the next site it is asked for — in this run or a
      // later one — where a failure kept would fail every one for good.
      const failing = reading;

      failing.catch(() => {
        if (configs.get(module) === failing) {
          configs.delete(module);
        }
      });
    }

    const config = await reading;
    const found = config.sites.find((site) => site.site === name);

    if (found === undefined) {
      throw new TypeError(
        `The config at ${module} has no site "${name}" when a thread imports it — ` +
          `every site has to be there each time the module is read for threads to find it`,
      );
    }

    // As the run's own queues are: the run's signal handed to every task — see `grab`.
    const enqueue: Enqueue = (queue, task, options = {}) =>
      queue.add(task, { ...options, signal: stop.signal });
    const run: Run = {
      defaults: data.defaults,
      cache,
      now: new Date(data.now),
      grabbedAt: data.grabbedAt,
      startDay: data.startDay,
      timeZone: data.timeZone,
      // The run's own set, so a site asks here what it would ask there.
      emit: emitOf((event) => {
        send(port, { kind: 'event', event: plainEvent(event) });
      }, new Set(data.hears)),
      signal: stop.signal,
      localWork,
      enqueue,
      // Each count into the memory both threads see, as `SiteRun` counts into
      // the run's tally in-process — see `writer`: a site whose thread dies,
      // or that is cancelled before it can say `site:done`, has still counted
      // what it did.
      tally: new Proxy<GrabCounts>(noCounts(), {
        set(counts, field: keyof GrabCounts, value: number) {
          writer.count(field, value - counts[field]);
          counts[field] = value;

          return true;
        },
      }),
      // Into the memory both threads see — see `writer` — and what there is
      // no room for, said instead.
      requested: (label, done) => {
        const left = writer.add(label, done);

        if (left !== undefined) {
          send(port, { kind: 'requested', label, done: left });
        }
      },
      // Into the memory both threads see, as each stretch is spent — see `writer`.
      spent: (part, ms) => {
        writer.spend(part, ms);
      },
    };

    const site = new SiteRun(
      data.channels === undefined ? found : { ...found, channels: data.channels },
      run,
    );

    cache.timeWith(site.clock);

    // Into memory rather than said, so the run's thread knows it the moment it
    // is so: a thread that dies a moment later may have run some of the site,
    // and a message saying so may not arrive before word that it died.
    writer.begin();
    await site.run();

    send(port, { kind: 'done' });
  } catch (error) {
    send(port, { kind: 'failed', error: plain(error) });
  } finally {
    await cache.close();
  }
}

/** Each config module this thread has read, resolved — see {@link workSite}. */
const configs = new Map<string, Promise<EpgConfig>>();

/**
 * A thread's `site:done`, with what its list was settled with on this thread
 * added in — first, since it was asked first — and the time that took.
 */
function withSettled(
  event: Extract<EpgEventInput, { type: 'site:done' }>,
  settled: SiteSession,
): EpgEventInput {
  // Everything it said kept — what is added to here is what is changed.
  return {
    ...event,
    ...siteDone(
      event.site,
      // The site's list was its turn too, though another thread's.
      event.ms + settled.spanMs,
      mergedRequests(settled.requestsBy, event.requestsBy),
      event,
      addedTime(measuredOf(event.msBy), settled.clock.spent()),
    ),
  };
}
