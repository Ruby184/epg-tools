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
 * - **the counts**, as they are counted, so a site that never finishes has
 *   still said what it did.
 *
 * What a worker runs is `thread-worker.ts`, a file of its own and an entry of
 * the build of its own: started by its URL, so it runs that and nothing a
 * bundler happened to put beside the code that starts it.
 */

import { availableParallelism } from 'node:os';
import { pathToFileURL } from 'node:url';
import { MessageChannel, Worker } from 'node:worker_threads';
import PQueue from 'p-queue';
import { CacheManager } from '../cache/manager.js';
import { CODECS, fromLine, toLine, type CodecName } from '../cache/codec.js';
import type { CacheStore, ChannelDayKey } from '../cache/types.js';
import { resolveConfigSource, type ConfigSource, type EpgConfig } from '../config.js';
import { MAX_CAUSE_DEPTH } from '../core/error.js';
import type { EpgEventInput, GrabCounts } from '../core/events.js';
import type { XmltvProgramme } from '../xmltv/types.js';
import { assertPlainData } from './channels.js';
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
  /** The run's zone, for which day is today — see `GrabOptions.timezone`. */
  timeZone?: string;
  defaults: Run['defaults'];
  localConcurrency: number;
  /** The codec the run's store keeps its entries with, when a thread has it — see `CacheManager.codecName`. */
  codec?: CodecName;
}

/** Either end of the conversation: a worker, its `parentPort`, or a channel's port. */
export interface SitePort {
  /** With what it hands over rather than copies — none, as often as not. */
  postMessage(value: unknown, transfer: ArrayBuffer[]): void;
  on(event: 'message', listener: (value: any) => void): unknown;
  off(event: 'message', listener: (value: any) => void): unknown;
}

/** The cache's methods, which is all the worker's store asks the main thread. */
type CacheOp = Exclude<keyof CacheStore, 'close'> | 'writeEncoded';

type ToHost =
  | { kind: 'event'; event: EpgEventInput }
  | { kind: 'cache'; id: number; op: CacheOp; args: unknown[] }
  | { kind: 'count'; field: keyof GrabCounts; delta: number }
  | { kind: 'done' }
  | { kind: 'failed'; error: unknown };

type ToWorker =
  | { kind: 'answer'; id: number; value?: unknown; error?: unknown }
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
 * error crosses as it is.
 */
function plain(error: unknown, depth = 0): unknown {
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
 * thread can be handed — a function, a socket. As the JSON reporter does with
 * them: what survives JSON goes as JSON, and what does not is named in place of
 * its value (see `SaidFields`) — never a throw into the site's own code, where
 * a log line would fail the channel-day it was about.
 */
function send(port: SitePort, message: ToHost | ToWorker, transfer: ArrayBuffer[] = []): void {
  try {
    port.postMessage(message, transfer);
  } catch (error) {
    if (message.kind !== 'event' || !('data' in message.event)) {
      throw error;
    }

    let data: unknown;

    try {
      data = JSON.parse(JSON.stringify(message.event.data)) as unknown;
    } catch {
      data = '[unserializable]';
    }

    port.postMessage({ ...message, event: { ...message.event, data } }, []);
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
   * Rejects when the thread dies — out of memory, or an error nothing caught —
   * which fails every site it was running: the conversation would simply stop.
   */
  lost: Promise<never>;
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
   * Resolves when the site is done, as `new SiteRun(config, run).run()` would;
   * rejects when it never got going — its config could not be imported, did
   * not have it, or did not resolve, or it has a channel list no thread can be
   * handed as it is — which the run reports as a site that failed.
   */
  async run(config: AnySiteConfig, run: Run): Promise<void> {
    // Before a worker is asked for, so a site that cannot go starts nothing: a
    // copy would hand the thread something else without saying so, and a
    // function could not be copied at all.
    if (Array.isArray(config.channels)) {
      assertPlainData(config.site, config.channels);
    }

    const data: SiteThreadData = {
      module: this.#module,
      site: config.site,
      // Only a list the run is holding: a function is the site's own, and the
      // worker has that from its own import.
      ...(Array.isArray(config.channels) ? { channels: config.channels } : {}),
      now: run.now.toISOString(),
      grabbedAt: run.grabbedAt,
      startDay: run.startDay,
      ...(run.timeZone === undefined ? {} : { timeZone: run.timeZone }),
      defaults: run.defaults,
      localConcurrency: run.localWork.concurrency,
      ...(run.cache instanceof CacheManager && run.cache.codecName !== undefined
        ? { codec: run.cache.codecName }
        : {}),
    };
    const { port1, port2 } = new MessageChannel();
    const pooled = this.#pick();

    try {
      pooled.worker.postMessage({ data, port: port2 }, [port2]);
    } catch (error) {
      port1.close();
      port2.close();

      throw error;
    }

    pooled.sites++;

    try {
      await Promise.race([hostSite(port1, run), pooled.lost]);
    } finally {
      pooled.sites--;
      port1.close();
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
    let stopped: (error: unknown) => void = () => {};
    const pooled: PooledWorker = {
      worker,
      sites: 0,
      lost: new Promise<never>((_resolve, reject) => {
        stopped = reject;
      }),
    };

    /**
     * Fail what it was running, and leave the pool — at the first sign, since
     * `exit` follows `error` a turn later, and a site started in between must
     * not be handed a thread that is going: a dead one runs nothing, and would
     * be the idlest of them for ever.
     */
    const gone = (error: unknown): void => {
      stopped(error);

      const at = this.#workers.indexOf(pooled);

      if (at !== -1) {
        this.#workers.splice(at, 1);
      }
    };

    // Heard by the sites racing it, if there are any when it happens.
    pooled.lost.catch(() => {});
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
 */
export function hostSite(port: SitePort, run: Run): Promise<void> {
  const { cache, emit, localWork, signal, tally } = run;

  return new Promise<void>((resolve, reject) => {
    const abort = (): void => {
      send(port, { kind: 'abort', reason: plain(signal?.reason) });
    };

    const listen = (message: ToHost): void => {
      switch (message.kind) {
        case 'event': {
          const event = message.event;

          if ('error' in event) {
            (event as { error: unknown }).error = revived(event.error);
          }

          emit(event);
          break;
        }
        case 'count':
          tally[message.field] += message.delta;
          break;
        case 'cache': {
          const { id, op, args } = message;
          const answering =
            op === 'getState' || op === 'setState'
              ? answer(cache, op, args)
              : localWork.add(() => answer(cache, op, args), {
                  priority: op === 'write' || op === 'read' ? 1 : 0,
                });

          void answering.then(
            (value) => {
              send(port, { kind: 'answer', id, value });
            },
            (error: unknown) => {
              send(port, { kind: 'answer', id, error: plain(error) });
            },
          );
          break;
        }
        case 'done':
          finish();
          resolve();
          break;
        case 'failed':
          finish();
          reject(revived(message.error));
          break;
      }
    };

    const finish = (): void => {
      port.off('message', listen);
      signal?.removeEventListener('abort', abort);
    };

    port.on('message', listen);

    if (signal?.aborted) {
      abort();
    } else {
      signal?.addEventListener('abort', abort, { once: true });
    }
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

/** The run's cache, as the main thread answers it. */
class RemoteCache implements CacheStore {
  readonly #port: SitePort;
  /** The codec the run's store keeps its entries with, run here when there is one. */
  readonly #codec: CodecName | undefined;
  readonly #waiting = new Map<
    number,
    { resolve(value: unknown): void; reject(error: unknown): void }
  >();
  #next = 0;

  constructor(port: SitePort, codec: CodecName | undefined) {
    this.#port = port;
    this.#codec = codec;
    port.on('message', (message: ToWorker) => {
      if (message.kind !== 'answer') {
        return;
      }

      const waiting = this.#waiting.get(message.id);

      this.#waiting.delete(message.id);

      if (message.error === undefined) {
        waiting?.resolve(message.value);
      } else {
        waiting?.reject(revived(message.error));
      }
    });
  }

  /** One cache call, answered by the main thread — and the buffers it hands over rather than copies. */
  #ask(op: CacheOp, args: unknown[], transfer: ArrayBuffer[] = []): Promise<any> {
    const id = this.#next++;

    return new Promise((resolve, reject) => {
      this.#waiting.set(id, { resolve, reject });
      send(this.#port, { kind: 'cache', id, op, args }, transfer);
    });
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

  /** The main thread's store, which is the main thread's to close. */
  async close(): Promise<void> {}
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

  port.on('message', (message: ToWorker) => {
    if (message.kind === 'abort') {
      stop.abort(revived(message.reason));
    }
  });

  try {
    // Once per worker however many of its sites are in it: a config function
    // then runs once a thread, not once a site.
    let reading = configs.get(data.module);

    if (reading === undefined) {
      reading = import(data.module).then((imported: { default?: ConfigSource }) => {
        if (imported.default === undefined) {
          throw new TypeError(`${data.module} has no default export, so there is no config to run`);
        }

        return resolveConfigSource(imported.default);
      });
      configs.set(data.module, reading);
    }

    const config = await reading;
    const found = config.sites.find((site) => site.site === data.site);

    if (found === undefined) {
      throw new TypeError(
        `The config at ${data.module} has no site "${data.site}" when a thread imports it — ` +
          `every site has to be there each time the module is read for threads to find it`,
      );
    }

    // As the run's own queues are: the run's signal handed to every task — see `grab`.
    const enqueue: Enqueue = (queue, task, options = {}) =>
      queue.add(task, { ...options, signal: stop.signal });

    const run: Run = {
      defaults: data.defaults,
      cache: new RemoteCache(port, data.codec),
      now: new Date(data.now),
      grabbedAt: data.grabbedAt,
      startDay: data.startDay,
      ...(data.timeZone === undefined ? {} : { timeZone: data.timeZone }),
      emit: (event) => {
        send(port, { kind: 'event', event: plainEvent(event) });
      },
      signal: stop.signal,
      localWork,
      enqueue,
      // Each count sent as it is counted, as `SiteRun` counts into the run's
      // tally in-process: a site whose thread dies, or that is cancelled
      // before it can say `site:done`, has still said what it did.
      tally: new Proxy<GrabCounts>(
        { fetched: 0, empty: 0, fromCache: 0, unchanged: 0, failed: 0, sitesFailed: 0 },
        {
          set(counts, field: keyof GrabCounts, value: number) {
            send(port, { kind: 'count', field, delta: value - counts[field] });
            counts[field] = value;

            return true;
          },
        },
      ),
    };

    await new SiteRun(
      data.channels === undefined ? found : { ...found, channels: data.channels },
      run,
    ).run();

    send(port, { kind: 'done' });
  } catch (error) {
    send(port, { kind: 'failed', error: plain(error) });
  }
}

/** Each config module this thread has read, resolved — see {@link workSite}. */
const configs = new Map<string, Promise<EpgConfig>>();
