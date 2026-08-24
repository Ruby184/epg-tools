/**
 * The filesystem side of a cache, without an opinion about what an entry looks
 * like inside.
 *
 * Layout: `<dir>/<site>/<channelId>/<day>.<ext>`, one file per channel-day
 * holding its own meta as well as its programmes. Site and channel path
 * segments are sanitized with `encodeURIComponent`.
 *
 * Where a driver puts entries and what it keeps them *as* are separate
 * problems, so the second one belongs to a subclass: `FsNdjsonCacheDriver` and
 * `FsXmltvCacheDriver` say what one entry is — including where its meta goes —
 * and everything else, the layout and cancellation and deleting and pruning, is
 * the same either way and lives here. Which is also what keeps the xmltv module
 * out of a run that does not use it: the driver that needs it is the one that
 * imports it.
 *
 * Neither of them stamps or checks a meta: what one is worth is the
 * {@link CacheManager}'s judgement, made the same way for every driver there is.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { writeFileAtomic } from '../core/atomic.js';
import { CacheDriverBase } from './driver.js';
import type {
  CacheDriver,
  CacheEntryMeta,
  ChannelDayKey,
  FoundEntry,
  FoundMeta,
  FsCacheDriverOptions,
  StoredProgramme,
} from './types.js';

/** How much of a prune's directory walk is in flight at once. */
const PRUNE_CONCURRENCY = 8;

/**
 * How much of an entry is read at a time while looking for its meta. A
 * granularity rather than a limit: whoever is reading takes another chunk only
 * if it needs one, and any meta this package writes fits in the first — an
 * ndjson entry's meta line ends by byte 60, an xmltv entry's instruction by
 * byte 180, so this is an order of magnitude of room for either to grow.
 *
 * One read costs the same syscall whatever it asks for, and 2,000 `getMeta`
 * calls measure the same at 512, 2,048 and 4,096 bytes — so the size is chosen
 * for headroom rather than speed. Not 4,096 itself: that is the first size Node
 * will not carve out of its shared buffer pool (`Buffer.poolSize >>> 1`), which
 * buys an allocation per read for nothing.
 */
const READ_CHUNK = 2048;

export abstract class FsCacheDriver<TStored = StoredProgramme>
  extends CacheDriverBase<TStored>
  implements CacheDriver<TStored>
{
  protected readonly dir: string;
  protected readonly signal: AbortSignal | undefined;

  constructor(options: FsCacheDriverOptions) {
    super();
    this.dir = options.dir;
    this.signal = options.signal;
  }

  /** The extension one entry is written with, without the dot. */
  protected abstract get extension(): string;

  /**
   * What one entry holds — written atomically, here. An entry carries its own
   * meta, so a format has to have somewhere to put it.
   */
  protected abstract entryData(programmes: TStored[], meta: CacheEntryMeta): string;

  /**
   * What one entry held: its programmes, and what it says about itself. The file
   * is read out here, and the meta comes along because the read has it in hand
   * — a second pass to find something already in front of us would be work for
   * nothing.
   */
  protected abstract parseEntry(content: string): FoundEntry<TStored>;

  /**
   * The meta an entry begins with, read from the front of it — or nothing, when
   * the entry does not begin with one it can make sense of.
   *
   * What the staleness sweep asks for, thousands of times a run and mostly
   * about entries it then leaves alone — so it is given the entry to pull from
   * rather than the whole of it to read. Taking one chunk and stopping is the
   * ordinary case; taking more is what makes the front of an entry however long
   * it needs to be.
   */
  protected abstract parseMeta(
    chunks: AsyncIterable<string>,
  ): Promise<Partial<CacheEntryMeta> | undefined>;

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

  /** Whether an `fs` call failed because what it was pointed at is not there. */
  #isNotFound(error: unknown): boolean {
    return this.#code(error) === 'ENOENT';
  }

  #code(error: unknown): string | undefined {
    return typeof error === 'object' && error !== null
      ? (error as NodeJS.ErrnoException).code
      : undefined;
  }

  /**
   * Remove a directory if it is empty, without asking first.
   *
   * Asking is the race: a grab in another process writes the day it is grabbing
   * a moment after the answer comes back and before the removal goes out, and a
   * prune that checked then fails on what it was told was safe. `rmdir` already
   * refuses a directory with anything in it — POSIX allows either `ENOTEMPTY` or
   * `EEXIST` for that — so the refusal *is* the check, and a directory somebody
   * else removed first (`ENOENT`) is equally fine by us.
   */
  async #removeIfEmpty(dir: string): Promise<void> {
    try {
      await fs.rmdir(dir);
    } catch (error) {
      if (!['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes(this.#code(error) ?? '')) {
        throw error;
      }
    }
  }

  /**
   * Run `work` over `items`, `limit` of them at a time.
   *
   * A prune is thousands of small operations that only wait on the disk, so
   * doing them one after another spends the whole time waiting — while doing
   * them all at once is the file descriptor storm the rest of this package is
   * careful to avoid. Node's own file operations run on a threadpool of four by
   * default, so there is little to gain past a handful in flight.
   */
  async #inParallel<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
    let next = 0;

    const worker = async (): Promise<void> => {
      while (next < items.length) {
        await work(items[next++]!);
      }
    };

    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  }

  /**
   * An open file as text, a chunk at a time and none of it before it is asked
   * for.
   *
   * Node has readier tools for this — a `ReadStream` iterates chunks too — but a
   * stream is a heavy object to build per file, and this is the hottest thing a
   * cache does: 2,000 of these cost 178ms against a stream's 262ms, and against
   * 236ms for reading whole entries that only the front of is wanted.
   *
   * The decoder is what makes chunking at arbitrary byte counts safe: a
   * character split across two reads is held until the rest of it arrives,
   * rather than becoming a replacement one.
   */
  async *#chunksOf(handle: fs.FileHandle): AsyncGenerator<string> {
    const buffer = Buffer.allocUnsafe(READ_CHUNK);
    const decoder = new TextDecoder();
    let position = 0;

    while (true) {
      // Per chunk, not once before the first: `parseMeta` decides how many it
      // takes, and a document whose root tag never arrives has it reading up to
      // the scan limit. Neither `open` nor a read from a handle takes a signal
      // of its own, so this is where a cancelled run stops reading.
      this.signal?.throwIfAborted();

      const { bytesRead } = await handle.read(buffer, 0, READ_CHUNK, position);

      if (bytesRead === 0) {
        return;
      }

      position += bytesRead;
      yield decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
    }
  }

  /**
   * One segment of a key's path, made safe to join.
   *
   * `encodeURIComponent` deals with separators — a `/` becomes `%2F` and stays
   * one segment — but it leaves a dot alone, because a dot is legal in both a
   * URI and a filename. `.` and `..` are the exceptions: they are the
   * filesystem's own words for "here" and "one level up", so a channel id of
   * `..` off a site's channel list would put an entry above the cache directory
   * and one of `.` would put it beside the sites rather than under one. Encoded,
   * they are ordinary names the kernel reads as themselves and `path.join` does
   * not resolve away.
   *
   * Only a segment that is nothing but dots is rewritten, so every ordinary
   * `example.com` keeps the path it already has and no cache is invalidated by
   * this.
   */
  #segment(value: string): string {
    const encoded = encodeURIComponent(value);

    return /^\.+$/.test(encoded) ? encoded.replaceAll('.', '%2E') : encoded;
  }

  #channelDir(key: ChannelDayKey): string {
    return path.join(this.dir, this.#segment(key.site), this.#segment(key.channelId));
  }

  /** The file one channel-day is kept in. */
  #entryFilePath(key: ChannelDayKey): string {
    return path.join(this.#channelDir(key), `${key.day}.${this.extension}`);
  }

  async readMeta(key: ChannelDayKey): Promise<FoundMeta | undefined> {
    // Asked outright, since neither `open` nor a read from a handle takes a
    // signal of its own the way `readFile` does.
    this.signal?.throwIfAborted();

    const file = this.#entryFilePath(key);
    let handle;

    try {
      handle = await fs.open(file, 'r');
    } catch (error) {
      if (this.#isNotFound(error)) {
        return;
      }

      throw error;
    }

    try {
      // The file is there, whatever its front turns out to say — which is the
      // difference the wrapper carries: an entry nobody can read is one to
      // remove, a day never grabbed is one to grab.
      return { meta: await this.parseMeta(this.#chunksOf(handle)) };
    } finally {
      await handle.close();
    }
  }

  async read(key: ChannelDayKey): Promise<FoundEntry<TStored> | undefined> {
    try {
      return this.parseEntry(await fs.readFile(this.#entryFilePath(key), this.readOptions()));
    } catch (error) {
      if (this.#isNotFound(error)) {
        return;
      }

      throw error;
    }
  }

  async write(key: ChannelDayKey, programmes: TStored[], meta: CacheEntryMeta): Promise<void> {
    const file = this.#entryFilePath(key);
    // One file, so an entry is either there with its meta or not there at all:
    // two writes left a window where it had already been written and could not
    // yet be told apart from one that had never been grabbed.
    const data = this.entryData(programmes, meta);

    try {
      await writeFileAtomic(file, data, this.signal);
    } catch (error) {
      if (!this.#isNotFound(error)) {
        throw error;
      }

      // Written before the directory is made sure of, rather than after, which
      // is what keeps a grab from asking for a directory that has been there
      // since its first day — 7,000 entries is a quarter of a second of
      // learning what we already knew. A missing path component is the only
      // thing `ENOENT` can mean here, so the recovery is to make it and write
      // again: the same answer whether this is the channel's first day or
      // another process took the directory away since its last.
      //
      // Asked before making anything, so that a write cancelled in the moment
      // between the two leaves no directory behind either.
      this.signal?.throwIfAborted();
      await fs.mkdir(this.#channelDir(key), { recursive: true });
      await writeFileAtomic(file, data, this.signal);
    }
  }

  async delete(key: ChannelDayKey): Promise<void> {
    await fs.rm(this.#entryFilePath(key), { force: true });
  }

  async prune(options: { before: string }): Promise<number> {
    let removed = 0;
    let sites;

    try {
      sites = await fs.readdir(this.dir, { withFileTypes: true });
    } catch (error) {
      if (this.#isNotFound(error)) {
        return 0;
      }

      throw error;
    }

    // This driver's own entry files. Built here rather than in the constructor,
    // where a subclass has yet to say what its extension is, and a prune is
    // once a run either way.
    const entryFile = new RegExp(`^(\\d{4}-\\d{2}-\\d{2})\\.${this.extension}$`);

    for (const site of sites.filter((entry) => entry.isDirectory())) {
      // Between sites, and between channels below: `readdir` and `rm` take no
      // signal of their own, and a prune is a walk rather than one long
      // operation — so this is where it stops, having removed whole days.
      this.signal?.throwIfAborted();

      const sitePath = path.join(this.dir, site.name);
      const channels = await fs.readdir(sitePath, { withFileTypes: true });

      await this.#inParallel(
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

          await this.#removeIfEmpty(channelPath);
        },
      );

      await this.#removeIfEmpty(sitePath);
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
    await this.#inParallel([...staleDays], PRUNE_CONCURRENCY, async (day) =>
      fs.rm(path.join(channelPath, `${day}.${this.extension}`), { force: true }),
    );

    return staleDays.size;
  }
}
