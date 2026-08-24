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
} from './types.js';

export class CacheManager implements CacheStore {
  readonly #driver: CacheDriver;

  constructor(options: CacheManagerOptions) {
    this.#driver = options.driver;
  }

  /** The store underneath, for anything that has to ask it something directly. */
  get driver(): CacheDriver {
    return this.#driver;
  }

  async getMeta(key: ChannelDayKey): Promise<CacheEntryMeta | undefined> {
    const found = await this.#driver.readMeta(key);

    return found === undefined ? undefined : this.#verified(key, found.meta);
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
    const stamped: CacheEntryMeta = {
      grabbedAt: meta?.grabbedAt ?? new Date().toISOString(),
      // Counted here rather than taken on trust: the count is what a staleness
      // check reads instead of the programmes, so it has to be the programmes.
      programmeCount: programmes.length,
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
    meta: Partial<CacheEntryMeta> | undefined,
  ): Promise<CacheEntryMeta | undefined> {
    if (
      meta === undefined ||
      typeof meta.grabbedAt !== 'string' ||
      typeof meta.programmeCount !== 'number'
    ) {
      await this.#driver.delete(key);

      return;
    }

    return meta as CacheEntryMeta;
  }
}
