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
 *   driver of the config's own exists. Programmes cross in the form a store
 *   keeps them in, and as text: a `Date` copied to another thread loses the
 *   offset and the precision this package keeps on it, and the main thread
 *   pays a twentieth for a string of what it pays for the objects.
 * - **events**, said on the main thread, where the reporter is — an error made
 *   plain on the way, since copying one keeps neither its name nor anything a
 *   library hung on it.
 * - **cancelling**, as a message the worker turns back into an abort.
 * - **the counts**, which arrive on `site:done` and are added to the run's.
 *
 * Both halves are here, so a worker is started on this module's own file —
 * which is why it is an entry of the build of its own, whatever the bundler
 * makes of the rest.
 */

import { availableParallelism } from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  isMainThread,
  MessageChannel,
  parentPort,
  Worker,
  workerData,
  type MessagePort,
} from 'node:worker_threads';
import PQueue from 'p-queue';
import { CacheDriverBase } from '../cache/driver.js';
import type { CacheStore, ChannelDayKey, StoredProgramme } from '../cache/types.js';
import { resolveConfigSource, type ConfigSource, type EpgConfig } from '../config.js';
import { MAX_CAUSE_DEPTH } from '../core/error.js';
import type { EpgEventInput, GrabCounts } from '../core/events.js';
import type { XmltvProgramme } from '../xmltv/types.js';
import { SiteRun, type Enqueue, type Run } from './site-run.js';
import type { AnySiteConfig, GrabberChannel } from './types.js';

/** The `workerData` key a site's worker is started with. */
const SITE_THREAD = 'epg-tools/site-thread';

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
  defaults: Run['defaults'];
  localConcurrency: number;
}

/** Either end of the conversation: a worker, its `parentPort`, or a channel's port. */
export interface SitePort {
  postMessage(value: unknown): void;
  on(event: 'message', listener: (value: any) => void): unknown;
  off(event: 'message', listener: (value: any) => void): unknown;
}

/** The cache's methods, which is all the worker's store asks the main thread. */
type CacheOp = Exclude<keyof CacheStore, 'close'>;

type ToHost =
  | { kind: 'event'; event: EpgEventInput }
  | { kind: 'cache'; id: number; op: CacheOp; args: unknown[] }
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
 * What a store keeps a programme as, which is what crosses: dates in their
 * XMLTV form, where the offset and the precision survive.
 */
const records = new (class extends CacheDriverBase {})();

const packed = (programmes: XmltvProgramme[]): string =>
  JSON.stringify(programmes.map((programme) => records.toStored(programme)));

const unpacked = (text: string): XmltvProgramme[] =>
  (JSON.parse(text) as StoredProgramme[]).map((record) => records.fromStored(record));

/**
 * Send something to the other side, whatever a site put in it.
 *
 * A site's `log` and `warn` take data of its own, which may hold something no
 * thread can be handed — a function, a socket. Rather than lose the event, it
 * goes as JSON, which says what it can of it.
 */
function send(port: SitePort, message: ToHost | ToWorker): void {
  try {
    port.postMessage(message);
  } catch {
    port.postMessage(JSON.parse(JSON.stringify(message)));
  }
}

// ── the main thread's half ──────────────────────────────────────────────────

/**
 * How many threads `threads` asks for: none when it is off, one per core for
 * `true`, and otherwise the number it names — `0` being off too.
 */
export function threadCount(threads: boolean | number | undefined): number {
  if (threads === undefined || threads === false) {
    return 0;
  }

  if (threads === true) {
    return availableParallelism();
  }

  if (!Number.isInteger(threads) || threads < 0) {
    throw new TypeError(
      `threads is true, false or a whole number of threads (got ${String(threads)})`,
    );
  }

  return threads;
}

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
 * A run's threads: at most `size` of them, each running every site it is
 * handed at once.
 *
 * At once, whatever the size, because most of what a site does is wait — a
 * pool smaller than the sites shares threads between them rather than queueing
 * them. A site goes to whichever worker is running fewest, and another worker
 * is started only when every one there is busy, so a pool at least as large as
 * the sites gives each one its own and starts no more than it uses.
 *
 * Each site is handed over with a port of its own, so a worker of several
 * sites holds the same conversation for each as a worker of one.
 */
export class SiteThreads {
  readonly #size: number;
  readonly #module: string;
  readonly #workers: PooledWorker[] = [];

  constructor(size: number, configModule: string | URL) {
    this.#size = size;
    this.#module = moduleUrl(configModule);
  }

  /**
   * Run one site on a worker, and answer for it on this side.
   *
   * Resolves when the site is done, as `new SiteRun(config, run).run()` would;
   * rejects when it never got going — its config could not be imported, did
   * not have it, or did not resolve — which the run reports as a site that
   * failed.
   */
  async run(config: AnySiteConfig, run: Run): Promise<void> {
    const data: SiteThreadData = {
      module: this.#module,
      site: config.site,
      // Only a list the run is holding: a function is the site's own, and the
      // worker has that from its own import.
      ...(Array.isArray(config.channels) ? { channels: config.channels } : {}),
      now: run.now.toISOString(),
      grabbedAt: run.grabbedAt,
      startDay: run.startDay,
      defaults: run.defaults,
      localConcurrency: run.localWork.concurrency,
    };
    const { port1, port2 } = new MessageChannel();
    const pooled = this.#pick();

    try {
      pooled.worker.postMessage({ data, port: port2 }, [port2]);
    } catch (error) {
      port1.close();
      port2.close();

      if (!(error instanceof Error) || error.name !== 'DataCloneError') {
        throw error;
      }

      throw new TypeError(
        `Site "${config.site}" cannot run in a thread: its channel list holds something a ` +
          `thread cannot be handed, such as a function in a channel's data`,
        { cause: error },
      );
    }

    pooled.sites++;

    try {
      await Promise.race([hostSite(port1, run), pooled.lost]);
    } finally {
      pooled.sites--;
      port1.close();
    }
  }

  /** Let every worker go, once the run has no more sites for them. */
  async close(): Promise<void> {
    await Promise.all(this.#workers.map(({ worker }) => worker.terminate()));
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

    const worker = new Worker(new URL(import.meta.url), { workerData: { [SITE_THREAD]: true } });
    const lost = new Promise<never>((_resolve, reject) => {
      worker.once('error', reject);
      worker.once('exit', (code) => {
        reject(new Error(`A site's thread stopped (exit code ${code})`));
      });
    });

    // Heard by the sites racing it, if there are any when it happens — and the
    // exit `close` causes, when there are none, is nobody's business.
    lost.catch(() => {});

    const pooled = { worker, sites: 0, lost };

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
 * The worker's cache work goes through the run's `localWork`, so every site's
 * reads and writes together keep to the bound one thread's would have.
 */
export function hostSite(port: SitePort, run: Run): Promise<void> {
  const { cache, emit, enqueue, localWork, signal, tally } = run;

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

          if (event.type === 'site:done') {
            // The site's own counts, which is what its thread added to a run
            // of its own: the run this side is reporting is where they belong.
            for (const field of COUNTS) {
              tally[field] += event[field];
            }
          }

          emit(event);
          break;
        }
        case 'cache': {
          const { id, op, args } = message;

          void enqueue(localWork, () => answer(cache, op, args)).then(
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

/** What `site:done` carries that the run adds up. */
const COUNTS: ReadonlyArray<keyof GrabCounts> = [
  'fetched',
  'empty',
  'fromCache',
  'unchanged',
  'failed',
  'sitesFailed',
];

/** One cache call the worker made, made here — programmes as text both ways. */
async function answer(cache: CacheStore, op: CacheOp, args: unknown[]): Promise<unknown> {
  switch (op) {
    case 'write': {
      const [key, text, meta] = args as [ChannelDayKey, string, Parameters<CacheStore['write']>[2]];

      return cache.write(key, unpacked(text), meta);
    }
    case 'read': {
      const found = await cache.read(args[0] as ChannelDayKey);

      return found === undefined ? undefined : packed(found);
    }
    default:
      return (cache[op] as (...given: unknown[]) => Promise<unknown>).apply(cache, args);
  }
}

// ── the worker's half ───────────────────────────────────────────────────────

/** The run's cache, as the main thread answers it. */
class RemoteCache implements CacheStore {
  readonly #port: SitePort;
  readonly #waiting = new Map<
    number,
    { resolve(value: unknown): void; reject(error: unknown): void }
  >();
  #next = 0;

  constructor(port: SitePort) {
    this.#port = port;
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

  #ask(op: CacheOp, ...args: unknown[]): Promise<any> {
    const id = this.#next++;

    return new Promise((resolve, reject) => {
      this.#waiting.set(id, { resolve, reject });
      send(this.#port, { kind: 'cache', id, op, args });
    });
  }

  getMeta(key: ChannelDayKey): ReturnType<CacheStore['getMeta']> {
    return this.#ask('getMeta', key);
  }

  getMetas(keys: readonly ChannelDayKey[]): ReturnType<CacheStore['getMetas']> {
    return this.#ask('getMetas', keys);
  }

  async read(key: ChannelDayKey): Promise<XmltvProgramme[] | undefined> {
    const text = (await this.#ask('read', key)) as string | undefined;

    return text === undefined ? undefined : unpacked(text);
  }

  write(...[key, programmes, meta]: Parameters<CacheStore['write']>): Promise<void> {
    return this.#ask('write', key, packed(programmes), meta);
  }

  delete(key: ChannelDayKey): Promise<void> {
    return this.#ask('delete', key);
  }

  prune(options: { before: string }): Promise<number> {
    return this.#ask('prune', options);
  }

  getState(...args: Parameters<CacheStore['getState']>): ReturnType<CacheStore['getState']> {
    return this.#ask('getState', ...args);
  }

  setState(...args: Parameters<CacheStore['setState']>): Promise<void> {
    return this.#ask('setState', ...args);
  }

  /** The main thread's store, which is the main thread's to close. */
  async close(): Promise<void> {}
}

/**
 * Run one site in this thread, saying everything to `port`.
 *
 * Exported so the conversation can be held over a `MessageChannel` in one
 * thread: what a worker adds to it is only that it runs somewhere else.
 */
export async function workSite(port: SitePort, data: SiteThreadData): Promise<void> {
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
      cache: new RemoteCache(port),
      now: new Date(data.now),
      grabbedAt: data.grabbedAt,
      startDay: data.startDay,
      emit: (event) => {
        send(port, { kind: 'event', event: plainEvent(event) });
      },
      signal: stop.signal,
      localWork: new PQueue({ concurrency: data.localConcurrency }),
      enqueue,
      tally: { fetched: 0, empty: 0, fromCache: 0, unchanged: 0, failed: 0, sitesFailed: 0 },
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

// A worker of a run's pool: run each site it is handed, on the port it came
// with. The main thread closes that port when the site is done, and lets the
// worker go when the run is.
if (!isMainThread && parentPort !== null) {
  if ((workerData as Record<string, unknown> | null)?.[SITE_THREAD] === true) {
    parentPort.on('message', ({ data, port }: { data: SiteThreadData; port: MessagePort }) => {
      void workSite(port, data);
    });
  }
}
