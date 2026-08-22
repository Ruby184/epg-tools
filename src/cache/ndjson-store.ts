/**
 * A cache of ndjson entries: one JSON programme per line.
 *
 * The format a run wants unless it has a reason otherwise — a line is parsed
 * straight into the programme it stands for, with none of a document's
 * structure to walk. Its one wrinkle is dates, which is what most of this class
 * is about.
 */

import { formatXmltvDate, getXmltvOffset, parseXmltvDate } from '../xmltv/date.js';
import type { XmltvProgramme } from '../xmltv/types.js';
import { FsCacheStore } from './fs-store.js';

/**
 * The date-valued fields of a programme. `previouslyShown.start` is the one a
 * level down, and handled beside them.
 */
const DATE_FIELDS = ['start', 'stop', 'pdcStart', 'vpsStart', 'date'] as const;

export class FsNdjsonCacheStore extends FsCacheStore {
  protected override get extension(): string {
    return 'ndjson';
  }

  protected override entryData(programmes: XmltvProgramme[]): string {
    return programmes.map((programme) => this.#storedLine(programme)).join('\n');
  }

  protected override parseEntry(content: string): XmltvProgramme[] {
    return content
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => this.#reviveProgramme(line));
  }

  /**
   * One date as it is stored: the XMLTV form, and its trailing offset only when
   * there is one to keep.
   *
   * A `Date` carries two things this package promises to keep — the offset the
   * source wrote it in, and how precise the source actually was — and both live
   * on symbol keys, which `JSON.stringify` does not see. An ISO timestamp is the
   * instant and nothing else, so a programme cached at `+0200` would come back
   * `+0000`, and a `<date>` of `2020` as a midnight timestamp. The XMLTV form is
   * what the two were read from, so it is what they survive in.
   *
   * A zero offset and no offset mean the same thing here — both read back as
   * UTC — so `2020 +0000` would be noise in a file people do read.
   */
  #storedDate(value: Date): string {
    return formatXmltvDate(value, { offset: getXmltvOffset(value) !== 0 });
  }

  /**
   * A programme as one stored line.
   *
   * The replacer reaches for `this[key]` rather than taking the value it is
   * handed: `JSON.stringify` calls `toJSON` on a `Date` before any replacer sees
   * it, so by then the value has already become an instant-only string, while
   * the holder still has the `Date` itself. Which means every date is stored the
   * same way wherever it sits — `previouslyShown.start` included — and only
   * something that really is a `Date` is touched. Its `this` is that holder, so
   * the store's own is taken hold of first.
   */
  #storedLine(programme: XmltvProgramme): string {
    const stored = (value: Date): string => this.#storedDate(value);

    return JSON.stringify(programme, function (this: Record<string, unknown>, key, value: unknown) {
      const held = this[key];

      return held instanceof Date ? stored(held) : value;
    });
  }

  /**
   * Revive the date fields of a programme parsed from a stored line.
   *
   * By name, and not by what a value looks like, which is the difference between
   * the two directions: writing can ask whether something *is* a `Date`, while
   * reading only has the string. A title of `2020` and a production date of
   * `2020` are the same string, and so is an extension attribute that happens to
   * hold a datetime — so this converts where dates are known to live rather than
   * wherever one seems to be.
   */
  #reviveProgramme(line: string): XmltvProgramme {
    const raw = JSON.parse(line) as XmltvProgramme;

    for (const field of DATE_FIELDS) {
      if (raw[field] !== undefined) {
        raw[field] = parseXmltvDate(String(raw[field]));
      }
    }

    if (raw.previouslyShown?.start !== undefined) {
      raw.previouslyShown.start = parseXmltvDate(String(raw.previouslyShown.start));
    }

    return raw;
  }
}
