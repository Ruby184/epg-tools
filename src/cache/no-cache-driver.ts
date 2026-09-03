/**
 * A cache that keeps nothing.
 *
 * Every day reads as never grabbed, so a grab fetches the whole window every
 * time and remembers none of it. Which is what you want when the cache is what
 * you are trying to take out of the picture: checking whether a source has
 * changed, timing a grab as a cold one, running where there is nowhere to write.
 *
 * It is not a way to make `build` faster. A merge builds the guide *from* the
 * cache, so a build over this one grabs everything and then writes an empty
 * guide. Use it with `epg grab`, whose summary is the whole point of the run — or
 * reach for {@link MemoryCacheDriver}, which forgets everything too but not
 * before the merge has read it.
 */

import { CacheDriverBase } from './driver.js';
import type { CacheDriver, FoundEntry, FoundMeta, FoundState, StoredProgramme } from './types.js';

export class NoCacheDriver extends CacheDriverBase implements CacheDriver<StoredProgramme> {
  async readMeta(): Promise<FoundMeta | undefined> {
    return;
  }

  async read(): Promise<FoundEntry<StoredProgramme> | undefined> {
    return;
  }

  async write(): Promise<void> {}

  async delete(): Promise<void> {}

  async prune(): Promise<number> {
    return 0;
  }

  /**
   * Nothing is remembered here either, which is the honest answer to the state
   * trio rather than a gap: a site asking what it knew last run learns nothing,
   * and goes and finds out.
   */
  async readState(): Promise<FoundState | undefined> {
    return;
  }

  async writeState(): Promise<void> {}

  async deleteState(): Promise<void> {}
}
