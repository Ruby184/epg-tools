/**
 * The filesystem side of a cache, without an opinion about what an entry looks
 * like inside.
 *
 * Layout: `<dir>/<site>/<channelId>/<day>.<ext>`, plus a sidecar
 * `<day>.meta.json` holding {@link CacheEntryMeta}. Site and channel path
 * segments are sanitized with `encodeURIComponent`.
 *
 * What a store keeps and what it keeps it *as* are separate problems, so the
 * second one belongs to a subclass: `FsNdjsonCacheStore` and `FsXmltvCacheStore` say
 * what one entry is, and everything else — the layout, the sidecar,
 * cancellation, deleting, pruning — is the same either way and lives here.
 * Which is also what keeps the xmltv module out of a run that does not use it:
 * the store that needs it is the one that imports it.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { writeFileAtomic } from '../core/atomic.js';
import type { XmltvProgramme } from '../xmltv/types.js';
import type { CacheEntryMeta, CacheStore, ChannelDayKey, FsCacheStoreOptions } from './types.js';

function isNotFound(error: unknown): boolean {
  return code(error) === 'ENOENT';
}

function code(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

/**
 * Remove a directory if it is empty, without asking first.
 *
 * Asking is the race: a grab in another process writes the day it is grabbing a
 * moment after the answer comes back and before the removal goes out, and a
 * prune that checked then fails on what it was told was safe. `rmdir` already
 * refuses a directory with anything in it — POSIX allows either `ENOTEMPTY` or
 * `EEXIST` for that — so the refusal *is* the check, and a directory somebody
 * else removed first (`ENOENT`) is equally fine by us.
 */
async function removeIfEmpty(dir: string): Promise<void> {
  try {
    await fs.rmdir(dir);
  } catch (error) {
    if (!['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes(code(error) ?? '')) {
      throw error;
    }
  }
}

/**
 * Run `work` over `items`, `limit` of them at a time.
 *
 * A prune is thousands of small operations that only wait on the disk, so doing
 * them one after another spends the whole time waiting — while doing them all at
 * once is the file descriptor storm the rest of this package is careful to
 * avoid. Node's own file operations run on a threadpool of four by default, so
 * there is little to gain past a handful in flight.
 */
async function inParallel<T>(items: T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < items.length) {
      await work(items[next++]!);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** How much of a prune's directory walk is in flight at once. */
const PRUNE_CONCURRENCY = 8;

export abstract class FsCacheStore implements CacheStore {
  protected readonly dir: string;
  protected readonly signal: AbortSignal | undefined;
  /**
   * Channel directories this store has already made. A grab writes every day of
   * a channel in turn, so without this each of them asks the filesystem to make
   * a directory that has been there since the first — 7,000 entries is a
   * quarter of a second of learning what we already knew.
   */
  readonly #ensured = new Set<string>();

  constructor(options: FsCacheStoreOptions) {
    this.dir = options.dir;
    this.signal = options.signal;
  }

  /** The extension one entry is written with, without the dot. */
  protected abstract get extension(): string;

  /**
   * What one entry holds — written atomically, and with its sidecar, here. The
   * meta comes along for a format with somewhere to put it.
   */
  protected abstract entryData(programmes: XmltvProgramme[], meta: CacheEntryMeta): string;

  /** The programmes one entry held. The file is read out here. */
  protected abstract parseEntry(content: string): XmltvProgramme[];

  /**
   * Reading options for `fs`: the encoding, and the signal when there is one.
   *
   * A store belongs to a run, so the signal lives here rather than on every
   * method — which is also what keeps the {@link CacheStore} interface something
   * anyone can implement with three arguments and no ceremony.
   */
  protected readOptions(): { encoding: BufferEncoding; signal: AbortSignal | undefined } {
    return { encoding: 'utf8', signal: this.signal };
  }

  #channelDir(key: ChannelDayKey): string {
    return path.join(this.dir, encodeURIComponent(key.site), encodeURIComponent(key.channelId));
  }

  /** The channel's directory, made once per store however many days it holds. */
  async #ensureDir(dir: string): Promise<void> {
    if (this.#ensured.has(dir)) {
      return;
    }

    await fs.mkdir(dir, { recursive: true });
    this.#ensured.add(dir);
  }

  /** Path prefix of an entry, without the file extension. */
  #entryBase(key: ChannelDayKey): string {
    return path.join(this.#channelDir(key), key.day);
  }

  async getMeta(key: ChannelDayKey): Promise<CacheEntryMeta | undefined> {
    let content: string;

    try {
      content = await fs.readFile(`${this.#entryBase(key)}.meta.json`, this.readOptions());
    } catch (error) {
      if (isNotFound(error)) {
        return;
      }

      throw error;
    }

    try {
      const meta = JSON.parse(content) as Partial<CacheEntryMeta>;

      if (typeof meta.grabbedAt !== 'string' || typeof meta.programmeCount !== 'number') {
        throw new TypeError('invalid cache meta shape');
      }

      return meta as CacheEntryMeta;
    } catch {
      // Corrupt sidecar: treat the whole entry as missing and remove it.
      await this.delete(key);
    }
  }

  async read(key: ChannelDayKey): Promise<XmltvProgramme[] | undefined> {
    try {
      return this.parseEntry(
        await fs.readFile(`${this.#entryBase(key)}.${this.extension}`, this.readOptions()),
      );
    } catch (error) {
      if (isNotFound(error)) {
        return;
      }

      throw error;
    }
  }

  async write(
    key: ChannelDayKey,
    programmes: XmltvProgramme[],
    meta?: Partial<CacheEntryMeta>,
  ): Promise<void> {
    await this.#ensureDir(this.#channelDir(key));

    const base = this.#entryBase(key);
    const fullMeta: CacheEntryMeta = {
      grabbedAt: meta?.grabbedAt ?? new Date().toISOString(),
      programmeCount: programmes.length,
    };

    await writeFileAtomic(
      `${base}.${this.extension}`,
      this.entryData(programmes, fullMeta),
      this.signal,
    );
    await writeFileAtomic(`${base}.meta.json`, `${JSON.stringify(fullMeta)}\n`, this.signal);
  }

  async delete(key: ChannelDayKey): Promise<void> {
    const base = this.#entryBase(key);

    await Promise.all([
      fs.rm(`${base}.${this.extension}`, { force: true }),
      fs.rm(`${base}.meta.json`, { force: true }),
    ]);
  }

  async prune(options: { before: string }): Promise<number> {
    let removed = 0;
    let sites;

    try {
      sites = await fs.readdir(this.dir, { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) {
        return 0;
      }

      throw error;
    }

    // This store's own entry files and the sidecars beside them. Built here
    // rather than in the constructor, where a subclass has yet to say what its
    // extension is, and a prune is once a run either way.
    const entryFile = new RegExp(`^(\\d{4}-\\d{2}-\\d{2})\\.(?:${this.extension}|meta\\.json)$`);

    for (const site of sites.filter((entry) => entry.isDirectory())) {
      // Between sites, and between channels below: `readdir` and `rm` take no
      // signal of their own, and a prune is a walk rather than one long
      // operation — so this is where it stops, having removed whole days.
      this.signal?.throwIfAborted();

      const sitePath = path.join(this.dir, site.name);
      const channels = await fs.readdir(sitePath, { withFileTypes: true });

      await inParallel(
        channels.filter((entry) => entry.isDirectory()),
        PRUNE_CONCURRENCY,
        async (channel) => {
          this.signal?.throwIfAborted();

          const channelPath = path.join(sitePath, channel.name);
          // Counted after the await, not `+= await`: that reads the total
          // before waiting and writes it back after, so two of these running
          // together would each add to the same stale number.
          const pruned = await this.#pruneChannelDir(channelPath, options.before, entryFile);

          removed += pruned;

          await removeIfEmpty(channelPath);
          // Whether it went or not, this store no longer knows: a write to this
          // channel makes sure of the directory again.
          this.#ensured.delete(channelPath);
        },
      );

      await removeIfEmpty(sitePath);
    }

    return removed;
  }

  /** Remove all entries in one channel directory older than `before`. */
  async #pruneChannelDir(channelPath: string, before: string, entryFile: RegExp): Promise<number> {
    const files = await fs.readdir(channelPath);
    const staleDays = new Set<string>();

    for (const file of files) {
      const day = entryFile.exec(file)?.[1];

      // String comparison works for YYYY-MM-DD day strings.
      if (day !== undefined && day < before) {
        staleDays.add(day);
      }
    }

    // A day's files together, and the days a few at a time: the entries of one
    // channel are the smallest pieces here, and waiting for each in turn is
    // most of what a prune used to spend its time on.
    await inParallel([...staleDays], PRUNE_CONCURRENCY, async (day) => {
      const base = path.join(channelPath, day);

      await Promise.all([
        fs.rm(`${base}.${this.extension}`, { force: true }),
        fs.rm(`${base}.meta.json`, { force: true }),
      ]);
    });

    return staleDays.size;
  }
}
