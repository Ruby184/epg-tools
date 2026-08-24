/**
 * A cache of ndjson entries: one JSON programme per line.
 *
 * The driver a run wants unless it has a reason otherwise — a line is parsed
 * straight into the programme it stands for, with none of a document's structure
 * to walk. A line is also what it keeps each programme *as*, which is the one
 * thing it changes about the record codec it inherits.
 */

import type { XmltvProgramme } from '../xmltv/types.js';
import { FsCacheDriver } from './fs-driver.js';
import type { CacheEntryMeta, FoundEntry, StoredProgramme } from './types.js';

export class FsNdjsonCacheDriver extends FsCacheDriver<string> {
  protected override get extension(): string {
    return 'ndjson';
  }

  override toStored(programme: XmltvProgramme): string {
    return JSON.stringify(this.toRecord(programme));
  }

  override fromStored(line: string): XmltvProgramme {
    return this.fromRecord(JSON.parse(line) as StoredProgramme);
  }

  /**
   * The meta on the first line, then one programme per line after it. The
   * newline belongs to the meta rather than to the join: a day with nothing on
   * is an entry of meta alone, and it still has to be a whole line to read.
   */
  protected override entryData(lines: string[], meta: CacheEntryMeta): string {
    return `${JSON.stringify(meta)}\n${lines.join('\n')}`;
  }

  protected override parseEntry(content: string): FoundEntry<string> {
    const [head, ...rest] = content.split('\n');

    return {
      meta: this.#meta(head ?? ''),
      // Lines, not programmes: turning one into the other is `fromStored`'s, and
      // a blank line is what the end of a file looks like.
      programmes: rest.filter((line) => line.trim() !== ''),
    };
  }

  protected override async parseMeta(
    chunks: AsyncIterable<string>,
  ): Promise<Partial<CacheEntryMeta> | undefined> {
    let head = '';

    for await (const chunk of chunks) {
      head += chunk;

      const end = head.indexOf('\n');

      // The first line as soon as there is a whole one, however many chunks it
      // took — and no chunk after it, which is what taking them one at a time
      // is for. An entry with nothing after its meta still ends in one.
      if (end !== -1) {
        return this.#meta(head.slice(0, end));
      }
    }
  }

  /** One meta line as far as JSON goes; what it holds is judged above. */
  #meta(line: string): Partial<CacheEntryMeta> | undefined {
    try {
      return JSON.parse(line) as Partial<CacheEntryMeta>;
    } catch {
      // Not a line of JSON, so not a meta.
    }
  }
}
