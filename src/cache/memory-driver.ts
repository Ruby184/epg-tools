/**
 * A cache that lives as long as the process does.
 *
 * For a test, where a temporary directory is more setup than the thing being
 * tested; and for a run that should touch no disk at all — a container with a
 * read-only filesystem, a one-shot build in a lambda, a guide served from
 * memory.
 *
 * It keeps the bytes every other driver keeps — the `json` codec's — rather
 * than the programmes it was handed, and that is what makes it behave like the
 * others. A driver that kept the caller's own objects would hand the same ones
 * back to every reader, so a `transform` that edits a programme in place, or
 * anything holding what `read` returned, would be editing the cache — and only
 * ever under this driver. Every read here decodes, so what comes back is a copy
 * by construction, as it is from a file or a row; and a programme survives
 * exactly what it would survive in one.
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

import type { CacheCodec, CodecName } from './codec.js';
import type {
  CacheDriver,
  ChannelDayKey,
  FoundEntry,
  FoundMeta,
  FoundState,
  StoredEntryMeta,
  StoredStateMeta,
} from './types.js';

interface MemoryEntry {
  meta: StoredEntryMeta;
  body: Uint8Array;
}

export class MemoryCacheDriver implements CacheDriver {
  /** The records' array, as JSON, as sqlite keeps it. */
  readonly codec: CodecName | CacheCodec = 'json';

  /**
   * Site to channel to day, the same shape the filesystem driver gives a cache
   * for the same reasons: a prune reads the days it is deciding about instead of
   * picking them back out of a made-up key, and nothing a site or a channel is
   * called can be mistaken for a separator.
   */
  readonly #sites = new Map<string, Map<string, Map<string, MemoryEntry>>>();

  /**
   * What each site remembers, by group — site to key, nested for the same
   * reason the entries are: a site's groups are one object to hold, hand out and
   * drop, and no key can be mistaken for a separator.
   */
  readonly #state = new Map<string, Map<string, { data: unknown; meta: StoredStateMeta }>>();

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
    this.#state.clear();
  }

  #days(key: ChannelDayKey): Map<string, MemoryEntry> | undefined {
    return this.#sites.get(key.site)?.get(key.channelId);
  }

  async readMeta(key: ChannelDayKey): Promise<FoundMeta | undefined> {
    const entry = this.#days(key)?.get(key.day);

    return entry && { meta: entry.meta };
  }

  async read(key: ChannelDayKey): Promise<FoundEntry | undefined> {
    return this.#days(key)?.get(key.day);
  }

  async write(key: ChannelDayKey, body: Uint8Array, meta: StoredEntryMeta): Promise<void> {
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

    // A copy of the view, and only of the view: an encoder's buffer has room for
    // the worst case, and what a caller handed over is theirs to change.
    days.set(key.day, { meta, body: new Uint8Array(body) });
  }

  async delete(key: ChannelDayKey): Promise<void> {
    this.#days(key)?.delete(key.day);
  }

  async readState(site: string, key: string): Promise<FoundState | undefined> {
    const group = this.#state.get(site)?.get(key);

    return group && { meta: group.meta, data: this.#copy(group.data) };
  }

  async writeState(site: string, key: string, data: unknown, meta: StoredStateMeta): Promise<void> {
    let groups = this.#state.get(site);

    if (groups === undefined) {
      groups = new Map();
      this.#state.set(site, groups);
    }

    groups.set(key, { meta, data: this.#copy(data) });
  }

  async deleteState(site: string, key: string): Promise<void> {
    const groups = this.#state.get(site);

    groups?.delete(key);

    if (groups?.size === 0) {
      this.#state.delete(site);
    }
  }

  /**
   * A copy, on the way in and again on the way out — the same care the entries
   * get, for the same reason.
   *
   * Every other driver serializes, so what a caller wrote and what a later read
   * hands back are already separate objects. A caller that kept hold of what it
   * remembered, or of what it read back, would otherwise be editing the cache
   * under this driver and no other — the sort of difference a test would never
   * find.
   *
   * Through JSON rather than `structuredClone`, because JSON is what the other
   * drivers put a group through: a `Date` or a `Map` in there comes back as a
   * string or `{}` here too, rather than surviving only in memory.
   */
  #copy(data: unknown): unknown {
    return data === undefined ? undefined : (JSON.parse(JSON.stringify(data)) as unknown);
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
