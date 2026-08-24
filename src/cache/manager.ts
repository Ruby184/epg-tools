/**
 * The cache a run talks to: everything true of every driver, in one place.
 *
 * A {@link CacheDriver} answers for one store and nothing more — put these
 * programmes there, hand them back, say what this entry claims about itself.
 * What is the same whatever the store is lives here instead of being written
 * again in each of them:
 *
 * - **the meta an entry carries.** Stamped on the way in, so a driver never
 *   invents a `grabbedAt` or miscounts programmes, and judged on the way out, so
 *   one answer to "is this an entry at all" covers every store there is.
 * - **what to do with a bad entry.** It goes, and the day reads as never
 *   grabbed, so the next run fetches it rather than serving something nothing
 *   here can vouch for.
 * - **when a programme becomes something a store can hold, and when it comes
 *   back.** *How* is the driver's, since the store is the one thing it is expert
 *   in — {@link CacheDriverBase} answers it for anything ordinary, and a driver
 *   overrides that. But the two moments are the same for every store, so they
 *   are here, and no driver has to remember to convert.
 *
 * This is a {@link CacheStore}, which is what the grab and the merge take, so
 * neither of them knows which driver is underneath.
 */

import type { XmltvProgramme } from '../xmltv/types.js';
import type {
  CacheDriver,
  CacheEntryMeta,
  CacheManagerOptions,
  CacheStore,
  ChannelDayKey,
  FoundMeta,
  StoredEntryMeta,
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

export class CacheManager implements CacheStore, AsyncDisposable {
  readonly #driver: CacheDriver;
  readonly #invalidate: CacheManagerOptions['invalidate'];

  constructor(options: CacheManagerOptions) {
    this.#driver = options.driver;
    this.#invalidate = options.invalidate;
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
    const driver = this.#driver;
    const found: Array<FoundMeta | undefined> = [];

    if (driver.readMetas !== undefined) {
      found.push(...(await driver.readMetas(keys)));
    } else {
      for (const key of keys) {
        found.push(await driver.readMeta(key));
      }
    }

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

  async read(key: ChannelDayKey): Promise<XmltvProgramme[] | undefined> {
    const found = await this.#driver.read(key);

    // The meta is judged before the programmes are served: a store hands back
    // whatever was last put there, and an entry that cannot answer for itself is
    // not one to build a guide from.
    return found !== undefined && (await this.#verified(key, found.meta)) !== undefined
      ? found.programmes.map((stored) => this.#driver.fromStored(stored))
      : undefined;
  }

  async write(
    key: ChannelDayKey,
    programmes: XmltvProgramme[],
    meta?: Partial<CacheEntryMeta>,
  ): Promise<void> {
    const stamped: StoredEntryMeta = {
      grabbedAt: meta?.grabbedAt ?? new Date().toISOString(),
      // Counted here rather than taken on trust: the count is what a staleness
      // check reads instead of the programmes, so it has to be the programmes.
      programmeCount: programmes.length,
      // What this entry is and who wrote it, so that reading it back is never a
      // guess. The caller says neither: they are facts about the writing.
      schema: CACHE_SCHEMA,
      writtenBy: __PKG_VERSION__,
    };

    await this.#driver.write(
      key,
      programmes.map((programme) => this.#driver.toStored(programme)),
      stamped,
    );
  }

  async delete(key: ChannelDayKey): Promise<void> {
    await this.#driver.delete(key);
  }

  async prune(options: { before: string }): Promise<number> {
    return this.#driver.prune(options);
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
    if (
      meta === undefined ||
      typeof meta.grabbedAt !== 'string' ||
      typeof meta.programmeCount !== 'number' ||
      typeof meta.writtenBy !== 'string' ||
      // A shape this code does not write is one it cannot read as it was meant,
      // whether the entry is older than this version or newer than it: a cache
      // shared with something that has moved on is not ours to interpret.
      meta.schema !== CACHE_SCHEMA
    ) {
      await this.#driver.delete(key);

      return;
    }

    const stored = meta as StoredEntryMeta;

    if (this.#invalidate?.(stored, key) === true) {
      await this.#driver.delete(key);

      return;
    }

    return stored;
  }
}
