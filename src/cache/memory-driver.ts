/**
 * A cache that lives as long as the process does.
 *
 * For a test, where a temporary directory is more setup than the thing being
 * tested; and for a run that should touch no disk at all — a container with a
 * read-only filesystem, a one-shot build in a lambda, a guide served from
 * memory.
 *
 * It keeps records, the ordinary stored form, rather than the programmes it was
 * handed — and unlike the xmltv driver, which overrides that pair away, this one
 * has a reason to pay for it. Nothing here is serialized, so nothing needs
 * preserving: what the conversion buys is a *copy*. A driver that stored the
 * caller's own objects would hand the same ones back to every reader, so a
 * `transform` that edits a programme in place, or anything holding what `read`
 * returned, would be editing the cache — and only ever under this driver. Every
 * other one gives back something parsed out of a file or a row, which is a copy
 * by construction; going through records is how this one says the same.
 *
 * It is not a test of whether a programme would survive real storage, though.
 * The record pair converts the date fields it knows, and no `JSON.stringify`
 * happens here — so a `Date` hiding somewhere the pair does not look survives as
 * a `Date`, where a file would have made it an ISO string. For that, test
 * against a driver that serializes.
 *
 * Note what per-process means for `build`: its grab and its merge each ask the
 * config for a cache, so a driver made fresh by each of them remembers nothing
 * in between and the guide comes out empty. Return the *same* instance from the
 * factory and the two halves share it:
 *
 * ```ts
 * const cache = new MemoryCacheDriver();
 *
 * export default defineConfig({ sites, output, cache: { driver: () => cache } });
 * ```
 */

import { CacheDriverBase } from './driver.js';
import type {
  CacheDriver,
  ChannelDayKey,
  FoundEntry,
  FoundMeta,
  StoredEntryMeta,
  StoredProgramme,
} from './types.js';

interface MemoryEntry {
  meta: StoredEntryMeta;
  programmes: StoredProgramme[];
}

export class MemoryCacheDriver extends CacheDriverBase implements CacheDriver<StoredProgramme> {
  /**
   * Site to channel to day, the same shape the filesystem driver gives a cache
   * for the same reasons: a prune reads the days it is deciding about instead of
   * picking them back out of a made-up key, and nothing a site or a channel is
   * called can be mistaken for a separator.
   */
  readonly #sites = new Map<string, Map<string, Map<string, MemoryEntry>>>();

  /** How many entries are held, for a test that wants to say so. */
  get size(): number {
    let entries = 0;

    for (const channels of this.#sites.values()) {
      for (const days of channels.values()) {
        entries += days.size;
      }
    }

    return entries;
  }

  /** Forget everything, so one instance can serve a suite of tests. */
  clear(): void {
    this.#sites.clear();
  }

  #days(key: ChannelDayKey): Map<string, MemoryEntry> | undefined {
    return this.#sites.get(key.site)?.get(key.channelId);
  }

  async readMeta(key: ChannelDayKey): Promise<FoundMeta | undefined> {
    const entry = this.#days(key)?.get(key.day);

    return entry && { meta: entry.meta };
  }

  async read(key: ChannelDayKey): Promise<FoundEntry<StoredProgramme> | undefined> {
    return this.#days(key)?.get(key.day);
  }

  async write(
    key: ChannelDayKey,
    programmes: StoredProgramme[],
    meta: StoredEntryMeta,
  ): Promise<void> {
    let channels = this.#sites.get(key.site);

    if (channels === undefined) {
      channels = new Map();
      this.#sites.set(key.site, channels);
    }

    let days = channels.get(key.channelId);

    if (days === undefined) {
      days = new Map();
      channels.set(key.channelId, days);
    }

    days.set(key.day, { meta, programmes });
  }

  async delete(key: ChannelDayKey): Promise<void> {
    this.#days(key)?.delete(key.day);
  }

  async prune(options: { before: string }): Promise<number> {
    let removed = 0;

    for (const [site, channels] of this.#sites) {
      for (const [channel, days] of channels) {
        for (const day of days.keys()) {
          // String comparison is what `YYYY-MM-DD` is for. Removing while
          // iterating a `Map` is allowed: what is already past is not revisited.
          if (day < options.before) {
            days.delete(day);
            removed++;
          }
        }

        // Nothing left to hold the level up, and a run that grabs for weeks
        // should not accumulate empty maps for channels it has finished with.
        if (days.size === 0) {
          channels.delete(channel);
        }
      }

      if (channels.size === 0) {
        this.#sites.delete(site);
      }
    }

    return removed;
  }
}
