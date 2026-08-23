/**
 * A cache of XMLTV entries: one small document per channel-day.
 *
 * Slower to read and write than ndjson — a document has structure to walk, and
 * a programme is spelled out in elements rather than one line — and worth it
 * when the cache is meant to be read by something other than this package, or
 * by a person. Which is also why it is written indented, and why an entry is a
 * document that validates against the DTD like any other.
 *
 * Dates need nothing special here. The XMLTV form is where their offset and
 * precision came from, so writing them back out keeps both.
 */

import {
  parseXmltvStream,
  parseXmltvString,
  serializeDocumentFooter,
  serializeDocumentHeader,
  serializeProcessingInstruction,
  serializeProgramme,
} from '../xmltv/main.js';
import type { SerializeOptions } from '../xmltv/main.js';
import type { XmltvProgramme } from '../xmltv/types.js';
import type { CacheEntryMeta } from './types.js';
import { FsCacheStore } from './fs-store.js';

const FORMATTING: SerializeOptions = { indent: 2 };

/**
 * The processing instruction an entry carries its own meta in.
 *
 * The root element says `date`, because that is XMLTV's way of saying when a
 * document was made and a reader of the cache should see it. What it cannot say
 * is how many programmes the document holds: there is no such attribute, the DTD
 * has no room to invent one — `xmllint` refuses a document that tries — and a
 * staleness check has to know without reading them all.
 *
 * An instruction is where XML puts exactly this: something for one reader,
 * ignored by every other, and outside anything a DTD constrains. Holding the
 * whole meta rather than the one field attributes cannot express means the next
 * thing worth recording needs no new mechanism.
 */
const META_TARGET = 'epg-cache';

export class FsXmltvCacheStore extends FsCacheStore {
  protected override get extension(): string {
    return 'xml';
  }

  protected override entryData(programmes: XmltvProgramme[], meta: CacheEntryMeta): string {
    // The same pieces `writeXmltvStream` puts a whole guide together from, which
    // is what makes an entry a document the rest of the package — and anything
    // else pointed at it — can read. The instruction sits just inside the root,
    // where a reader that does not know the target passes over it, and where
    // `parseMeta` requires it to be.
    return [
      serializeDocumentHeader({ date: new Date(meta.grabbedAt) }, FORMATTING),
      serializeProcessingInstruction(
        { target: META_TARGET, data: this.#encodeMeta(meta), position: 'root' },
        FORMATTING,
      ),
      ...programmes.map((programme) => serializeProgramme(programme, FORMATTING)),
      serializeDocumentFooter(FORMATTING),
    ].join('');
  }

  /**
   * The meta as instruction data: JSON with every `>` written as a unicode
   * escape.
   *
   * `?>` ends a processing instruction and XML offers no way to escape it there,
   * so a literal `>` in the data is one stray `?` away from truncating the
   * entry's own meta. Today's meta is two fields that cannot hold one, but the
   * next field worth recording may well be a title or a URL.
   *
   * JSON's own escapes are the way out, because XML cannot see them: the escaped
   * form holds no `>` for an instruction to end on, and `JSON.parse` gives the
   * character back unchanged. The same trick as embedding JSON in a `<script>`
   * tag, where a literal `</script>` would end the element early.
   */
  #encodeMeta(meta: CacheEntryMeta): string {
    return JSON.stringify(meta).replaceAll('>', '\\u003e');
  }

  protected override parseEntry(content: string): XmltvProgramme[] {
    // Whole-document rather than streaming: an entry is one channel-day, and
    // the machinery a stream needs costs more per file than the file holds.
    return parseXmltvString(content).programmes;
  }

  protected override async parseMeta(
    chunks: AsyncIterable<string>,
  ): Promise<CacheEntryMeta | undefined> {
    try {
      // The parser over the chunks, which is what it is for. The instruction
      // precedes every programme, so this reads a couple of events and stops —
      // and stopping is what stops the reading.
      for await (const event of parseXmltvStream(chunks)) {
        if (event.type === 'processing-instruction') {
          // Inside the root, and nowhere else. A prolog instruction is parsed
          // before the root element is, so taking a meta from one would mean
          // trusting a file that has not yet shown itself to be an XMLTV
          // document — the `<tv>` it is missing is what the scanner throws on
          // below, and that throw has to come first to be worth anything.
          if (event.value.position === 'root' && event.value.target === META_TARGET) {
            return this.#meta(event.value.data);
          }

          // Someone else's instruction, addressed to a reader that is not this
          // one. Stepping over it is the whole point of the mechanism.
          continue;
        }

        // Once the content starts there is no meta to find.
        if (event.type !== 'meta') {
          return;
        }
      }
    } catch {
      // A document whose root is not `<tv>` is refused by throwing. Here that is
      // not news to report but an entry to give up on, which is what falling out
      // of here says.
    }
  }

  /** What the instruction holds, when it holds a meta. */
  #meta(data: string): CacheEntryMeta | undefined {
    try {
      const meta = JSON.parse(data) as Partial<CacheEntryMeta>;

      return typeof meta.grabbedAt === 'string' && typeof meta.programmeCount === 'number'
        ? (meta as CacheEntryMeta)
        : undefined;
    } catch {
      // Not JSON, so not a meta.
    }
  }
}
