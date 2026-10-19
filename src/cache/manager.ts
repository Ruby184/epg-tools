/**
 * The cache a run talks to: everything true of every driver, in one place.
 *
 * A {@link CacheDriver} answers for one store and nothing more — put these
 * bytes there, hand them back, say what this entry claims about itself.
 * What is the same whatever the store is lives here instead of being written
 * again in each of them:
 *
 * - **the meta an entry carries.** Stamped on the way in, so a driver never
 *   invents a `grabbedAt` or miscounts programmes, and judged on the way out, so
 *   one answer to "is this an entry at all" covers every store there is.
 * - **what to do with a bad entry.** It goes, and the day reads as never
 *   grabbed, so the next run fetches it rather than serving something nothing
 *   here can vouch for.
 * - **when programmes become bytes, and when they come back.** *What* the bytes
 *   are is a codec's — one of {@link CODECS} the driver names, or one it brings.
 *   But the two moments are the same for every store, so they are here, and no
 *   driver has to remember to encode.
 *
 * This is a {@link CacheStore}, which is what the grab and the merge take, so
 * neither of them knows which driver is underneath.
 */

import { errorMessage } from '../core/error.js';
import type { XmltvProgramme } from '../xmltv/types.js';
import { codecOf, CorruptEntryError, type CacheCodec, type CodecName } from './codec.js';
import type {
  CacheDriver,
  CachedKey,
  CacheEntryMeta,
  CacheListOptions,
  CacheManagerOptions,
  CacheStore,
  ChannelDayKey,
  FoundMeta,
  Inspected,
  StateEntry,
  StoredEntryMeta,
  StoredStateMeta,
} from './types.js';

/**
 * The stored shape this code writes, and the only one it reads.
 *
 * Bump it whenever an entry stops meaning what it did — a field a staleness
 * check needs, a date written differently, programmes kept somewhere else in the
 * file. Every entry a previous number wrote is then void, and the days are
 * grabbed again, which is the whole of what a cache has to do about it. Nothing
 * migrates: a day of listings costs one request, and code to carry an old entry
 * forward would cost more than that forever.
 *
 * 1 — an entry holds its own meta: `grabbedAt`, `programmeCount`, and these
 *     two versions.
 */
export const CACHE_SCHEMA = 1;

/**
 * The envelope this code writes around a site's remembered state, and the only
 * one it reads back.
 *
 * Its own number rather than {@link CACHE_SCHEMA}, because it answers a smaller
 * question: what the *wrapper* looks like, not what is inside. What a group
 * holds is between the code that writes it and the code that reads it — a
 * channel list, a set of validators — and either can move on without voiding
 * cached listings, or the other group next to it.
 *
 * 1 — one blob per `(site, key)`, carrying `writtenAt` and these two versions.
 */
export const STATE_SCHEMA = 1;

export class CacheManager implements CacheStore, AsyncDisposable {
  readonly #driver: CacheDriver;
  readonly #invalidate: CacheManagerOptions['invalidate'];
  readonly #warn: CacheManagerOptions['warn'];
  /** What makes the driver's bytes, settled once: a named codec looked up, a driver's own taken as it is. */
  readonly #codec: CacheCodec;

  constructor(options: CacheManagerOptions) {
    this.#driver = options.driver;
    this.#invalidate = options.invalidate;
    this.#warn = options.warn;
    this.#codec = codecOf(options.driver.codec);
  }

  /** The store underneath, for anything that has to ask it something directly. */
  get driver(): CacheDriver {
    return this.#driver;
  }

  async getMeta(key: ChannelDayKey): Promise<StoredEntryMeta | undefined> {
    const found = await this.#driver.readMeta(key);

    return found === undefined ? undefined : this.#verified(key, found.meta);
  }

  /**
   * The metas of several keys, in the order they were asked for.
   *
   * What a grab uses to settle a whole channel's window at once. Whether that
   * is one question or many is the driver's business: a store that can answer a
   * batch says so with `readMetas`, and one that cannot is asked for each in
   * turn — here rather than in a driver, so no driver has to write the loop.
   *
   * One after another, not all at once: a driver reading files has a limit on
   * how many it may have open, and the caller has already decided how many of
   * these calls to run in parallel.
   */
  async getMetas(keys: readonly ChannelDayKey[]): Promise<Array<StoredEntryMeta | undefined>> {
    const found = await this.#readMetas(keys);

    // Judged the same way one at a time is, which includes removing an entry
    // that cannot answer for itself — so a batch is a shortcut in how the store
    // is asked, and in nothing else.
    return Promise.all(
      keys.map(async (key, index) => {
        const entry = found[index];

        return entry === undefined ? undefined : this.#verified(key, entry.meta);
      }),
    );
  }

  /**
   * What the driver says of several keys, in the order asked: in one question
   * where it can answer one, and a key at a time — here, so no driver has to
   * write the loop — where it cannot.
   */
  async #readMetas(keys: readonly ChannelDayKey[]): Promise<Array<FoundMeta | undefined>> {
    if (this.#driver.readMetas !== undefined) {
      return this.#driver.readMetas(keys);
    }

    const found: Array<FoundMeta | undefined> = [];

    for (const key of keys) {
      found.push(await this.#driver.readMeta(key));
    }

    return found;
  }

  /**
   * An entry's programmes, if it is one to build a guide from — what
   * {@link inspect} finds, and the one it would not use removed, so the day
   * reads as never grabbed and the next run grabs it again.
   *
   * The meta is judged before the programmes are served: a store hands back
   * whatever was last put there, and an entry that cannot answer for itself is
   * not one to build a guide from. Nor is one whose programmes do not read back
   * as what it says it holds — a line cut short, an edit — which a run would
   * otherwise fail on, or serve as an empty day until it aged out.
   */
  async read(key: ChannelDayKey): Promise<XmltvProgramme[] | undefined> {
    const found = await this.inspect(key);

    if (found === undefined) {
      return;
    }

    if (found.status !== 'readable') {
      await this.#driver.delete(key);

      if (found.status === 'corrupt') {
        this.#warn?.(
          `${key.channelId} ${key.day}: removed from the cache, its programmes unreadable ` +
            `(${errorMessage(found.error)}) — the day is grabbed again by the next run`,
          key,
        );
      }

      return;
    }

    return found.programmes;
  }

  async write(
    key: ChannelDayKey,
    programmes: XmltvProgramme[],
    meta?: Partial<CacheEntryMeta>,
  ): Promise<void> {
    await this.#driver.write(
      key,
      this.#codec.encode(programmes),
      this.#stamped(programmes.length, meta),
    );
  }

  /**
   * The codec a site's thread may encode a channel-day with for this store —
   * the name the driver gave — or `undefined` when the driver brought a codec
   * of its own, which no thread has, and is handed programmes instead.
   */
  get codecName(): CodecName | undefined {
    return typeof this.#driver.codec === 'string' ? this.#driver.codec : undefined;
  }

  /**
   * Save a channel-day a site's thread encoded with {@link codecName}: stamped
   * here, and kept as it came — 0.3ms of the main thread's time to receive and
   * under a millisecond to keep for 3,500 programmes, where encoding them here
   * would cost several.
   *
   * `programmeCount` is the thread's, counted from the same programmes it
   * encoded, since counting them here would mean decoding the bytes.
   */
  async writeEncoded(
    key: ChannelDayKey,
    body: Uint8Array,
    programmeCount: number,
    meta?: Partial<CacheEntryMeta>,
  ): Promise<void> {
    if (this.codecName === undefined) {
      throw new TypeError(
        'This cache keeps its entries with a codec of its own, which no thread has: write programmes',
      );
    }

    await this.#driver.write(key, body, this.#stamped(programmeCount, meta));
  }

  /** An entry's meta as it is written, whichever way the programmes arrived. */
  #stamped(programmeCount: number, meta?: Partial<CacheEntryMeta>): StoredEntryMeta {
    return {
      grabbedAt: meta?.grabbedAt ?? new Date().toISOString(),
      // Counted from the programmes themselves — here, or by the thread that
      // encoded them: the count is what a staleness check reads instead of the
      // programmes, so it has to be the programmes.
      programmeCount,
      // What this entry is and who wrote it, so that reading it back is never a
      // guess. The caller says neither: they are facts about the writing.
      schema: CACHE_SCHEMA,
      writtenBy: __PKG_VERSION__,
    };
  }

  async delete(key: ChannelDayKey): Promise<void> {
    await this.#driver.delete(key);
  }

  /**
   * One group of a site's state, if the store has one it can answer for.
   *
   * The same judgement as an entry's, for the same reason: what is in a store is
   * whatever was last put there, by this version or an older one or a person
   * with an editor. An envelope this code cannot read is removed, and the group
   * then reads as never written — so whoever wanted it fetches it again, which
   * is the whole of what a cache has to do about it.
   */
  async getState(site: string, key: string): Promise<StateEntry | undefined> {
    const found = await this.inspectState(site, key);

    if (found === undefined) {
      return;
    }

    if (found.status !== 'readable') {
      await this.#driver.deleteState(site, key);

      return;
    }

    return { data: found.data, meta: found.meta };
  }

  async setState(
    site: string,
    key: string,
    data: unknown,
    meta?: { writtenAt?: string },
  ): Promise<void> {
    await this.#driver.writeState(site, key, data, {
      writtenAt: meta?.writtenAt ?? new Date().toISOString(),
      // Facts about the writing, not the caller's to say — as on an entry.
      schema: STATE_SCHEMA,
      writtenBy: __PKG_VERSION__,
    });
  }

  async prune(options: { before: string }): Promise<number> {
    return this.#driver.prune(options);
  }

  /**
   * Everything the store holds, by key, narrowed by whatever of `options` is
   * given — see {@link CacheDriver.list}. Exactly that: a driver may answer
   * with more than it was asked, and what it adds is left out here, so no
   * caller has to check again.
   */
  async *list(options: CacheListOptions = {}): AsyncIterable<CachedKey> {
    const { site, channelId, kind } = options;

    // Said plainly for a driver written before `list` was asked of every one,
    // rather than as whatever calling nothing throws.
    if (typeof this.#driver.list !== 'function') {
      throw new TypeError(
        "This cache's driver has no list(), which a driver needs for anything to look inside it — " +
          'see "A driver of your own" in docs/api.md',
      );
    }

    for await (const held of this.#driver.list(options)) {
      if (
        (kind === undefined || held.kind === kind) &&
        (site === undefined || (held.kind === 'entry' ? held.key.site : held.site) === site) &&
        (channelId === undefined || (held.kind === 'entry' && held.key.channelId === channelId))
      ) {
        yield held;
      }
    }
  }

  /**
   * What several entries say about themselves, as {@link getMetas} judges them
   * — and nothing removed: one a run would remove comes back saying why. What
   * `epg cache stats` counts with.
   *
   * `undefined` for a key the store has no entry under.
   */
  async inspectMetas(
    keys: readonly ChannelDayKey[],
  ): Promise<Array<Inspected<{ meta: StoredEntryMeta }> | undefined>> {
    const found = await this.#readMetas(keys);

    return keys.map((key, index) => {
      const entry = found[index];

      if (entry === undefined) {
        return;
      }

      return this.#judgedEntry(key, entry.meta);
    });
  }

  /**
   * One entry and its programmes, as {@link read} judges it — and left where it
   * is, if a run would remove it. What `epg cache show` writes.
   */
  async inspect(
    key: ChannelDayKey,
  ): Promise<Inspected<{ meta: StoredEntryMeta; programmes: XmltvProgramme[] }> | undefined> {
    const found = await this.#driver.read(key);

    if (found === undefined) {
      return;
    }

    const judged = this.#judgedEntry(key, found.meta);

    if (judged.status !== 'readable') {
      return judged;
    }

    // A meta that reads and programmes its codec says are damaged — a line
    // cut short, an edit — is one entry to say so of, not the end of a look or
    // a run. Whatever else a codec throws may be the codec's doing rather
    // than the entry's, and is thrown: taken for a damaged entry, a codec that
    // fails on every one would empty the cache.
    try {
      return { ...judged, programmes: this.#codec.decode(found.body, judged.meta) };
    } catch (error) {
      if (!(error instanceof CorruptEntryError)) {
        throw error;
      }

      return { status: 'corrupt', meta: judged.meta, error };
    }
  }

  /**
   * One group of a site's state, as {@link getState} judges it — and left
   * where it is, if a run would remove it. What `epg cache state` shows.
   */
  async inspectState(
    site: string,
    key: string,
  ): Promise<Inspected<StateEntry, StoredStateMeta> | undefined> {
    const found = await this.#driver.readState(site, key);

    if (found === undefined) {
      return;
    }

    const judged = this.#judged(
      found.meta,
      STATE_SCHEMA,
      (meta) => typeof meta.writtenAt === 'string' && typeof meta.writtenBy === 'string',
    );

    return judged.status === 'readable' ? { ...judged, data: found.data } : judged;
  }

  async close(): Promise<void> {
    await this.#driver.close?.();
  }

  /**
   * The same as {@link close}, for `await using`.
   *
   * A cache belongs to one run, and a driver may be holding a database handle or
   * a connection for the length of it — so the language's own way of saying
   * "give this back when the block ends" is worth answering, and it runs on the
   * way out of a throw as much as a return:
   *
   * ```ts
   * await using cache = await createCacheStore(config);
   * ```
   */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  /**
   * The meta of an entry worth having, or nothing — and nothing leaves the
   * entry behind.
   *
   * An entry that cannot say when it was grabbed or how much it holds is one no
   * decision can be made about: not fresh, not stale, not empty. Removing it is
   * what turns that into a decision, since a day that is not cached is a day
   * the next run grabs.
   */
  async #verified(
    key: ChannelDayKey,
    meta: Partial<StoredEntryMeta> | undefined,
  ): Promise<StoredEntryMeta | undefined> {
    const judged = this.#judgedEntry(key, meta);

    if (judged.status !== 'readable') {
      await this.#driver.delete(key);

      return;
    }

    return judged.meta;
  }

  /**
   * An entry's meta, where it is one a run would use — or, where it is not,
   * why: the one judgement, for a run that then removes the entry and for a
   * look that leaves it. What {@link #judged} says of any meta, and the
   * config's `invalidate` beside it.
   */
  #judgedEntry(
    key: ChannelDayKey,
    meta: Partial<StoredEntryMeta> | undefined,
  ): Inspected<{ meta: StoredEntryMeta }> {
    const judged = this.#judged(
      meta,
      CACHE_SCHEMA,
      // An entry that cannot say when it was grabbed or how much it holds is
      // one no decision can be made about: not fresh, not stale, not empty.
      (found) =>
        typeof found.grabbedAt === 'string' &&
        typeof found.programmeCount === 'number' &&
        typeof found.writtenBy === 'string',
    );

    return judged.status === 'readable' && this.#invalidate?.(judged.meta, key) === true
      ? { status: 'invalidated', meta: judged.meta }
      : judged;
  }

  /**
   * What something in the store says about itself — an entry's meta, a
   * group's envelope — judged against the shape this code writes, `schema`, and
   * the fields `complete` asks for: one a run would read, or why not.
   *
   * A shape this code does not write is one it cannot read as it was meant,
   * whether older than this version or newer: a cache shared with something
   * that has moved on is not ours to interpret. It is asked first, so an older
   * one is of another schema, whatever fields it has, rather than merely one
   * that cannot be read.
   */
  #judged<M extends { schema: number }>(
    meta: Partial<M> | undefined,
    schema: number,
    complete: (meta: Partial<M>) => boolean,
  ): Inspected<{ meta: M }, M> {
    if (typeof meta?.schema === 'number' && meta.schema !== schema) {
      return { status: 'incompatible', meta: meta as Partial<M> & { schema: number } };
    }

    return meta?.schema === schema && complete(meta)
      ? { status: 'readable', meta: meta as M }
      : { status: 'unreadable', meta };
  }
}
