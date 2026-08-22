/**
 * A cache of XMLTV entries: one small document per channel-day.
 *
 * Slower to read and write than ndjson — a document has structure to walk, and
 * a programme is spelled out in elements rather than one line — and worth it
 * when the cache is meant to be read by something other than this package, or
 * by a person. Which is also why it is written indented, and why the grab time
 * goes in the root element: the reason to choose this format is that something
 * else looks at it, and what it finds should say when it was made.
 *
 * Dates need nothing special here. The XMLTV form is where their offset and
 * precision came from, so writing them back out keeps both.
 */

import {
  parseXmltvString,
  serializeDocumentFooter,
  serializeDocumentHeader,
  serializeProgramme,
} from '../xmltv/main.js';
import type { SerializeOptions } from '../xmltv/main.js';
import type { XmltvProgramme } from '../xmltv/types.js';
import type { CacheEntryMeta } from './types.js';
import { FsCacheStore } from './fs-store.js';

const FORMATTING: SerializeOptions = { indent: 2 };

export class FsXmltvCacheStore extends FsCacheStore {
  protected override get extension(): string {
    return 'xml';
  }

  protected override entryData(programmes: XmltvProgramme[], meta: CacheEntryMeta): string {
    // The same three pieces `writeXmltvStream` puts a whole guide together
    // from, which is what makes an entry a document the rest of the package —
    // and anything else pointed at it — can read. `date` on the root element is
    // XMLTV's own way of saying when a guide was made, so the sidecar's
    // `grabbedAt` is not the only place it is written down.
    return [
      serializeDocumentHeader({ date: new Date(meta.grabbedAt) }, FORMATTING),
      ...programmes.map((programme) => serializeProgramme(programme, FORMATTING)),
      serializeDocumentFooter(FORMATTING),
    ].join('');
  }

  protected override parseEntry(content: string): XmltvProgramme[] {
    // Whole-document rather than streaming: an entry is one channel-day, and
    // the machinery a stream needs costs more per file than the file holds.
    return parseXmltvString(content).programmes;
  }
}
