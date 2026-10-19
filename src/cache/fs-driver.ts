/**
 * The filesystem side of a cache, without an opinion about what an entry looks
 * like inside.
 *
 * Layout: `<dir>/<site>/<channelId>/<day>.<ext>`, one file per channel-day
 * holding its own meta as well as its programmes, and `<dir>/<site>/<key>.json`
 * for each group of what the site remembers between runs. Site, channel and key
 * path segments are sanitized with `encodeURIComponent`.
 *
 * A prune only ever looks at the day files, so a site's state outlives every
 * listing it has — including a site dropped from the config, whose directory
 * stays behind holding nothing else.
 *
 * Where a driver puts entries and what an entry looks like are separate
 * problems, so the second one belongs to a subclass: `FsNdjsonCacheDriver` and
 * `FsXmltvCacheDriver` say how an entry's bytes are framed with its meta, and
 * name the codec that makes those bytes — and everything else, the layout and
 * cancellation and deleting and pruning, is the same either way and lives
 * here. Which is also what keeps the xmltv module
 * out of a run that does not use it: the driver that needs it is the one that
 * imports it.
 *
 * Neither of them stamps or checks a meta: what one is worth is the
 * {@link CacheManager}'s judgement, made the same way for every driver there is.
 */

import type { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { writeFileAtomic } from '../core/atomic.js';
import { inParallel } from '../core/parallel.js';
import type { CacheCodec, CodecName } from './codec.js';
import type {
  CacheDriver,
  CachedKey,
  CacheListOptions,
  ChannelDayKey,
  FoundEntry,
  FoundMeta,
  FoundState,
  FsCacheDriverOptions,
  StoredEntryMeta,
  StoredStateMeta,
} from './types.js';

/** How much of a walk of the cache directory — a prune's, a listing's — is in flight at once. */
const WALK_CONCURRENCY = 8;

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

export abstract class FsCacheDriver implements CacheDriver {
  protected readonly dir: string;
  protected readonly signal: AbortSignal | undefined;

  constructor(options: FsCacheDriverOptions) {
    this.dir = options.dir;
    this.signal = options.signal;
  }

  abstract readonly codec: CodecName | CacheCodec;

  /** The extension one entry is written with, without the dot. */
  protected abstract get extension(): string;

  /**
   * What one entry's file holds, in the order it is written — atomically,
   * here. An entry carries its own meta, so a format has to have somewhere to
   * put it; and pieces rather than one buffer, so the body goes out as it came
   * rather than being copied in behind its meta first.
   */
  protected abstract entry(body: Uint8Array, meta: StoredEntryMeta): Uint8Array[];

  /**
   * What one entry's file held: what it says about itself, and the bytes its
   * codec reads. The meta comes along because the read has it in hand — a
   * second pass to find something already in front of us would be work for
   * nothing.
   */
  protected abstract parseEntry(content: Buffer): FoundEntry | Promise<FoundEntry>;

  /**
   * The meta an entry begins with, read from the front of it — or nothing, when
   * the entry does not begin with one it can make sense of.
   *
   * What the staleness sweep asks for, thousands of times a run and mostly
   * about entries it then leaves alone — so it is given the entry to pull from
   * rather than the whole of it to read. Taking one chunk and stopping is the
   * ordinary case; taking more is what makes the front of an entry however long
   * it needs to be.
   *
   * Bytes, as they were read, and a chunk is good until the next is asked for:
   * every read goes into the same buffer, so one worth keeping past that is
   * copied. A chunk ends wherever the read did, a character's bytes included,
   * so what turns them into text has to see the next chunk before the end of
   * this one — a streaming decoder, or one decode of the chunks joined.
   */
  protected abstract parseMeta(
    chunks: AsyncIterable<Uint8Array>,
  ): Promise<Partial<StoredEntryMeta> | undefined>;

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
   * An open file, a chunk at a time and none of it before it is asked for.
   *
   * Node has readier tools for this — a `ReadStream` iterates chunks too — but a
   * stream is a heavy object to build per file, and this is the hottest thing a
   * cache does: 2,000 of these cost 178ms against a stream's 262ms, and against
   * 236ms for reading whole entries that only the front of is wanted.
   */
  async *#chunksOf(handle: fs.FileHandle): AsyncGenerator<Uint8Array> {
    const buffer = Buffer.allocUnsafe(READ_CHUNK);
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
      yield buffer.subarray(0, bytesRead);
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

  /**
   * A path segment as the name it was made from, or nothing for one this
   * driver could not have made: a name it would have made as another segment —
   * a mount's `lost+found`, whose `+` it would have escaped, or a `%2f` it
   * would have written `%2F` — or one whose `%` is not an escape at all.
   * Somebody's own directory, which no key this driver writes is in.
   */
  #named(segment: string): string | undefined {
    let name: string;

    try {
      name = decodeURIComponent(segment);
    } catch {
      return undefined;
    }

    return this.#segment(name) === segment ? name : undefined;
  }

  /**
   * What this driver's own entry files are called, the day captured. Built when
   * asked rather than in the constructor, where a subclass has yet to say what
   * its extension is.
   */
  #entryFile(): RegExp {
    return new RegExp(`^(\\d{4}-\\d{2}-\\d{2})\\.${this.extension}$`);
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

  async read(key: ChannelDayKey): Promise<FoundEntry | undefined> {
    let content: Buffer;

    try {
      // Bytes, not text: what the codec reads, decoded once and by it.
      content = await fs.readFile(this.#entryFilePath(key), { signal: this.signal });
    } catch (error) {
      if (this.#isNotFound(error)) {
        return;
      }

      throw error;
    }

    return this.parseEntry(content);
  }

  async write(key: ChannelDayKey, body: Uint8Array, meta: StoredEntryMeta): Promise<void> {
    // One file, so an entry is either there with its meta or not there at all:
    // two writes left a window where it had already been written and could not
    // yet be told apart from one that had never been grabbed.
    await this.#writeFile(this.#entryFilePath(key), this.entry(body, meta));
  }

  /**
   * Write a file atomically, making its directory only if that turns out to be
   * what was missing.
   *
   * Written before the directory is made sure of, rather than after, which is
   * what keeps a grab from asking for a directory that has been there since its
   * first day — 7,000 entries is a quarter of a second of learning what we
   * already knew. A missing path component is the only thing `ENOENT` can mean
   * here, so the recovery is to make it and write again: the same answer whether
   * this is the channel's first day or another process took the directory away
   * since its last.
   *
   * Asked before making anything, so that a write cancelled in the moment
   * between the two leaves no directory behind either.
   */
  async #writeFile(file: string, data: string | Iterable<Uint8Array>): Promise<void> {
    try {
      await writeFileAtomic(file, data, this.signal);
    } catch (error) {
      if (!this.#isNotFound(error)) {
        throw error;
      }

      this.signal?.throwIfAborted();
      await fs.mkdir(path.dirname(file), { recursive: true });
      await writeFileAtomic(file, data, this.signal);
    }
  }

  async delete(key: ChannelDayKey): Promise<void> {
    await fs.rm(this.#entryFilePath(key), { force: true });
  }

  /** The file one group of a site's state is kept in. */
  #stateFilePath(site: string, key: string): string {
    return path.join(this.dir, this.#segment(site), `${this.#segment(key)}.json`);
  }

  async readState(site: string, key: string): Promise<FoundState | undefined> {
    let content: string;

    try {
      content = await fs.readFile(this.#stateFilePath(site, key), this.readOptions());
    } catch (error) {
      if (this.#isNotFound(error)) {
        return;
      }

      throw error;
    }

    try {
      // Whatever is in there, at its word: judging the envelope belongs to the
      // manager, which does it the same way for every store there is.
      const { meta, data } = JSON.parse(content) as FoundState;

      return { meta, data };
    } catch {
      // A file that is there and holds nothing anybody can read — the second
      // kind of nothing, and the only one worth removing.
      return { meta: undefined, data: undefined };
    }
  }

  async writeState(site: string, key: string, data: unknown, meta: StoredStateMeta): Promise<void> {
    // Compact, unlike an xmltv entry: a group is written for this code rather
    // than for a reader, and one of them can hold thousands of records. `jq .`
    // is what to point at it.
    await this.#writeFile(this.#stateFilePath(site, key), JSON.stringify({ meta, data }));
  }

  async deleteState(site: string, key: string): Promise<void> {
    await fs.rm(this.#stateFilePath(site, key), { force: true });
  }

  async prune(options: { before: string }): Promise<number> {
    let removed = 0;
    const entryFile = this.#entryFile();
    // Walked as a listing walks it, so what is listed is what is pruned: a site
    // moved to another disk and linked back included, and beside the sites a
    // directory this process may not read — a mount's `.Trash-0` — or could
    // not have named — its `lost+found` — passed over.
    const sites = (await this.#children(this.dir, 'named')).filter(
      (entry) => entry.directory && this.#named(entry.name) !== undefined,
    );

    for (const site of sites) {
      // Between sites, and between channels below: `readdir` and `rm` take no
      // signal of their own, and a prune is a walk rather than one long
      // operation — so this is where it stops, having removed whole days.
      this.signal?.throwIfAborted();

      const sitePath = path.join(this.dir, site.name);
      const channels = (await this.#children(sitePath, 'found')).filter(
        (entry) => entry.directory && this.#named(entry.name) !== undefined,
      );

      await inParallel(channels, WALK_CONCURRENCY, async (channel) => {
        this.signal?.throwIfAborted();

        const channelPath = path.join(sitePath, channel.name);
        // Counted after the await, not `+= await`: that reads the total
        // before waiting and writes it back after, so two of these running
        // together would each add to the same stale number.
        const pruned = await this.#pruneChannelDir(channelPath, options.before, entryFile);

        removed += pruned;

        // A link is left in place, emptied or not: `rmdir` does not follow
        // one, and where it points was somebody's choice.
        if (!channel.link) {
          await this.#removeIfEmpty(channelPath);
        }
      });

      if (!site.link) {
        await this.#removeIfEmpty(sitePath);
      }
    }

    return removed;
  }

  /**
   * A walk of the cache directory, a site at a time: each channel directory
   * holds a site's entries, and each `<key>.json` beside them a group of its
   * state. A file of anything else — one being written, one somebody put there
   * — is passed over, as is a name this driver could not have made.
   *
   * Only a directory found beside the sites is passed over when it cannot be
   * read — a mount's `.Trash-0` holds nothing this process wrote. Inside a site
   * everything is this driver's, so a channel that cannot be read says so, as
   * a run reading it would, rather than be listed as holding nothing.
   */
  async *list(options: CacheListOptions = {}): AsyncIterable<CachedKey> {
    const entryFile = this.#entryFile();
    const sites =
      options.site === undefined
        ? (await this.#children(this.dir, 'named'))
            .filter((entry) => entry.directory)
            .map((entry) => entry.name)
        : [this.#segment(options.site)];

    for (const segment of sites) {
      // Between sites and between channels, as a prune is: `readdir` takes no
      // signal of its own.
      this.signal?.throwIfAborted();

      const site = this.#named(segment);

      if (site === undefined) {
        continue;
      }

      const sitePath = path.join(this.dir, segment);

      // One channel's directory, where its site was named too, and none of the
      // rest of the site. In a walk of every site it is looked for among what
      // each holds below: a site found unreadable has none to look in.
      if (options.channelId !== undefined && options.site !== undefined) {
        if (options.kind !== 'state') {
          yield* this.#entriesIn(
            path.join(sitePath, this.#segment(options.channelId)),
            site,
            options.channelId,
            entryFile,
          );
        }

        continue;
      }

      for (const child of await this.#children(
        sitePath,
        options.site === undefined ? 'found' : 'named',
      )) {
        if (child.file && child.name.endsWith('.json')) {
          // A group is a site's, and no channel's.
          const key =
            options.kind === 'entry' || options.channelId !== undefined
              ? undefined
              : this.#named(child.name.slice(0, -'.json'.length));

          if (key !== undefined) {
            yield { kind: 'state', site, key };
          }

          continue;
        }

        // Only groups asked for, and the channel directories are not read.
        const channelId =
          child.directory && options.kind !== 'state' ? this.#named(child.name) : undefined;

        if (
          channelId !== undefined &&
          (options.channelId === undefined || channelId === options.channelId)
        ) {
          yield* this.#entriesIn(path.join(sitePath, child.name), site, channelId, entryFile);
        }
      }
    }
  }

  /** The entries one channel directory holds. */
  async *#entriesIn(
    channelPath: string,
    site: string,
    channelId: string,
    entryFile: RegExp,
  ): AsyncGenerator<CachedKey> {
    this.signal?.throwIfAborted();

    for (const file of await this.#children(channelPath, 'named')) {
      const day = file.file ? entryFile.exec(file.name)?.[1] : undefined;

      if (day !== undefined) {
        yield { kind: 'entry', key: { site, channelId, day } };
      }
    }
  }

  /**
   * What a directory holds, and what each is — a symbolic link as what it
   * points at, since a read follows one: a site moved to another disk and
   * linked back is listed as it is read.
   *
   * Nothing where there is no such directory. Nothing, too, where it cannot be
   * read and was `found` beside the sites in walking the cache — a mount's
   * `.Trash-0` holds nothing this process wrote. Any other that cannot be read
   * says so: one asked for by name, and anything inside a site, all of it this
   * driver's.
   */
  async #children(
    dir: string,
    how: 'named' | 'found',
  ): Promise<Array<{ name: string; directory: boolean; file: boolean; link: boolean }>> {
    let entries: Dirent[];

    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      const code = this.#code(error);

      if (
        code === 'ENOENT' ||
        code === 'ENOTDIR' ||
        (how === 'found' && (code === 'EACCES' || code === 'EPERM'))
      ) {
        return [];
      }

      throw error;
    }

    const children = entries.map((entry) => ({
      name: entry.name,
      directory: entry.isDirectory(),
      file: entry.isFile(),
      link: false,
    }));

    // A link is the one thing the entry cannot say, and is asked — only the
    // links, a few at a time: a link to nothing is neither.
    const links = entries.flatMap((entry, index) => (entry.isSymbolicLink() ? [index] : []));

    await inParallel(links, WALK_CONCURRENCY, async (index) => {
      const { name } = entries[index]!;
      const target = await fs.stat(path.join(dir, name)).catch(() => undefined);

      children[index] = {
        name,
        directory: target?.isDirectory() === true,
        file: target?.isFile() === true,
        link: true,
      };
    });

    return children;
  }

  /** Remove all entries in one channel directory older than `before`. */
  async #pruneChannelDir(channelPath: string, before: string, entryFile: RegExp): Promise<number> {
    const staleDays = new Set<string>();

    for (const file of await this.#children(channelPath, 'named')) {
      const day = file.file ? entryFile.exec(file.name)?.[1] : undefined;

      // String comparison works for YYYY-MM-DD day strings.
      if (day !== undefined && day < before) {
        staleDays.add(day);
      }
    }

    // A day's files together, and the days a few at a time: the entries of one
    // channel are the smallest pieces here, and waiting for each in turn is
    // most of what a prune used to spend its time on.
    await inParallel([...staleDays], WALK_CONCURRENCY, async (day) =>
      fs.rm(path.join(channelPath, `${day}.${this.extension}`), { force: true }),
    );

    return staleDays.size;
  }
}
