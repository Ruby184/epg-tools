/**
 * A cache of ndjson entries: a meta line, then one JSON programme per line.
 *
 * The driver a run wants unless it has a reason otherwise — a line is parsed
 * straight into the programme it stands for, with none of a document's structure
 * to walk. The lines are the `ndjson` codec's; this driver only puts its meta
 * in front of them, so a channel-day a site's thread encoded is written out as
 * it came.
 */

import { FsCacheDriver } from './fs-driver.js';
import type { CacheCodec, CodecName } from './codec.js';
import type { FoundEntry, StoredEntryMeta } from './types.js';

/** Where a meta line ends and the programmes begin. */
const NEWLINE = 0x0a;

export class FsNdjsonCacheDriver extends FsCacheDriver {
  readonly codec: CodecName | CacheCodec = 'ndjson';

  protected override get extension(): string {
    return 'ndjson';
  }

  /**
   * The meta on the first line, then the programmes' lines as the codec wrote
   * them. The newline belongs to the meta rather than to the body: a day with
   * nothing on is an entry of meta alone, and it still has to be a whole line
   * to read.
   */
  protected override entry(body: Uint8Array, meta: StoredEntryMeta): Uint8Array[] {
    return [Buffer.from(`${JSON.stringify(meta)}\n`), body];
  }

  protected override parseEntry(content: Buffer): FoundEntry {
    const end = content.indexOf(NEWLINE);

    return end === -1
      ? { meta: this.#meta(content.toString('utf8')), body: new Uint8Array(0) }
      : { meta: this.#meta(content.toString('utf8', 0, end)), body: content.subarray(end + 1) };
  }

  protected override async parseMeta(
    chunks: AsyncIterable<Uint8Array>,
  ): Promise<Partial<StoredEntryMeta> | undefined> {
    const head: Uint8Array[] = [];

    for await (const chunk of chunks) {
      const end = chunk.indexOf(NEWLINE);

      // The first line as soon as there is a whole one, however many chunks it
      // took — and no chunk after it, which is what taking them one at a time
      // is for. An entry with nothing after its meta still ends in one. Found
      // in the bytes and decoded once, joined, so a character the reads split
      // comes back whole.
      if (end !== -1) {
        head.push(chunk.subarray(0, end));

        return this.#meta(Buffer.concat(head).toString('utf8'));
      }

      // Kept past the next read, which goes into the buffer under this one.
      head.push(Buffer.from(chunk));
    }
  }

  /** One meta line as far as JSON goes; what it holds is judged above. */
  #meta(line: string): Partial<StoredEntryMeta> | undefined {
    try {
      return JSON.parse(line) as Partial<StoredEntryMeta>;
    } catch {
      // Not a line of JSON, so not a meta.
    }
  }
}
