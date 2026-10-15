/**
 * A cache of XMLTV entries: one small document per channel-day.
 *
 * Slower to read and write than ndjson — a document has structure to walk, and
 * a programme is spelled out in elements rather than one line — and worth it
 * when the cache is meant to be read by something other than this package, or
 * by a person. Which is also why it is written indented, and why an entry is a
 * document that validates against the DTD like any other.
 *
 * The `<programme>` elements are the `xmltv` codec's; this driver puts the
 * document around them, its meta in an instruction inside the root.
 */

import { XMLTV_ENTRY, type CacheCodec, type CodecName } from './codec.js';
import {
  parseXmltvStream,
  serializeDocumentFooter,
  serializeDocumentHeader,
} from '../xmltv/main.js';
import { FsCacheDriver } from './fs-driver.js';
import type { FoundEntry, StoredEntryMeta } from './types.js';

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

/** How much of an entry's head is handed over at a time while looking for its meta. */
const HEAD_CHUNK = 2048;

export class FsXmltvCacheDriver extends FsCacheDriver {
  readonly codec: CodecName | CacheCodec = 'xmltv';

  protected override get extension(): string {
    return 'xml';
  }

  protected override entry(body: Uint8Array, meta: StoredEntryMeta): Uint8Array[] {
    // The same pieces `writeXmltvStream` puts a whole guide together from, which
    // is what makes an entry a document the rest of the package — and anything
    // else pointed at it — can read. The header places the instruction: `root`
    // puts it just inside the element, where a reader that does not know the
    // target passes over it, and where `parseMeta` requires it to be.
    return [
      Buffer.from(
        serializeDocumentHeader(
          { date: new Date(meta.grabbedAt) },
          {
            ...XMLTV_ENTRY,
            processingInstructions: [
              { target: META_TARGET, data: this.#encodeMeta(meta), position: 'root' },
            ],
          },
        ),
      ),
      body,
      Buffer.from(serializeDocumentFooter(XMLTV_ENTRY)),
    ];
  }

  /**
   * The meta as instruction data: JSON with every `>` written as a unicode
   * escape.
   *
   * `?>` ends a processing instruction and XML offers no way to escape it there,
   * so a literal `>` in the data is one stray `?` away from truncating the
   * entry's own meta. Today's meta is a few fields that cannot hold one, but the
   * next field worth recording may well be a title or a URL.
   *
   * JSON's own escapes are the way out, because XML cannot see them: the escaped
   * form holds no `>` for an instruction to end on, and `JSON.parse` gives the
   * character back unchanged. The same trick as embedding JSON in a `<script>`
   * tag, where a literal `</script>` would end the element early.
   */
  #encodeMeta(meta: StoredEntryMeta): string {
    return JSON.stringify(meta).replaceAll('>', '\\u003e');
  }

  /**
   * The meta from the head of the document, and the whole document for the
   * codec, which reads it as one. The instruction precedes every programme, so
   * finding it reads a chunk of the head and stops — the document is parsed
   * once, by the codec, rather than once for its meta and again for its
   * programmes.
   */
  protected override async parseEntry(content: Buffer): Promise<FoundEntry> {
    return { meta: await this.parseMeta(this.#head(content)), body: content };
  }

  /**
   * An entry's bytes a slice at a time, as a file is read. Slices rather than
   * the whole, since the parser decodes as far as it is handed: all of a 24 KB
   * entry, to find the few hundred bytes of meta at its front, costs 39µs, and
   * a slice 16.
   */
  async *#head(content: Buffer): AsyncGenerator<Uint8Array> {
    for (let at = 0; at < content.length; at += HEAD_CHUNK) {
      yield content.subarray(at, at + HEAD_CHUNK);
    }
  }

  protected override async parseMeta(
    chunks: AsyncIterable<Uint8Array>,
  ): Promise<Partial<StoredEntryMeta> | undefined> {
    try {
      // The parser over the chunks, which is what it is for — decoding them
      // included. The instruction precedes every programme, so this reads a
      // couple of events and stops — and stopping is what stops the reading.
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

  /** What the instruction holds, as far as JSON goes. */
  #meta(data: string): Partial<StoredEntryMeta> | undefined {
    try {
      return JSON.parse(data) as Partial<StoredEntryMeta>;
    } catch {
      // Not JSON, so not a meta.
    }
  }
}
