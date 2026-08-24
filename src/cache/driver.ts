/**
 * What a driver starts from: how one programme becomes something a store can
 * hold, and how it comes back.
 *
 * Programmes reach a driver as programmes — `Date`s and all — because that is
 * what the run has and what the run wants back. Almost every store, though,
 * holds JSON, so that is what these do by default, and it is worth having by
 * default: a `Date` carries two things this package promises to keep — the
 * offset the source wrote it in, and how precise the source was — and both live
 * on symbol keys, which `JSON.stringify` does not see. An ISO timestamp is the
 * instant and nothing else, so a programme stored that way comes back `+0000`,
 * and a `<date>` of `2020` comes back as a midnight timestamp. The XMLTV form is
 * what the two were read from, so it is what they survive in.
 *
 * Two pairs rather than one, because they answer different questions. What a
 * *record* is, {@link toRecord} and {@link fromRecord} — override to keep fewer
 * fields, or ones of your own. What the store actually holds, {@link toStored}
 * and {@link fromStored} — a record by default, a line of JSON for the ndjson
 * driver, and for the xmltv driver the programme untouched, since XMLTV is where
 * a date's offset and precision came from in the first place and converting them
 * out and back would be two passes over every date to arrive where it started.
 */

import { formatXmltvDate, getXmltvOffset, parseXmltvDate } from '../xmltv/date.js';
import type { XmltvProgramme } from '../xmltv/types.js';
import type { StoredProgramme } from './types.js';

/**
 * The date-valued fields of a programme. `previouslyShown.start` is the one a
 * level down, and handled beside them.
 *
 * By name in both directions, which is what makes the two symmetrical. Reading
 * has nothing but the string to go on — a title of `2020`, a production date of
 * `2020` and an extension attribute that happens to hold a datetime are the same
 * four characters — so it converts where dates are known to live rather than
 * wherever one seems to be, and writing does the same so that the pair agree.
 */
const DATE_FIELDS = ['start', 'stop', 'pdcStart', 'vpsStart', 'date'] as const;

export abstract class CacheDriverBase<TStored = StoredProgramme> {
  /** One programme as a record: a plain object, its dates in XMLTV form. */
  protected toRecord(programme: XmltvProgramme): StoredProgramme {
    const record: StoredProgramme = { ...programme };

    for (const field of DATE_FIELDS) {
      const value = programme[field];

      if (value !== undefined) {
        record[field] = this.#storedDate(value);
      }
    }

    if (programme.previouslyShown?.start !== undefined) {
      record.previouslyShown = {
        ...programme.previouslyShown,
        start: this.#storedDate(programme.previouslyShown.start),
      };
    }

    return record;
  }

  /**
   * The programme one record stands for, dates and all.
   *
   * What a store holds is taken at its word, which is what the cast says: a
   * record is whatever was last written there, and the fields a programme must
   * have are not something a read can insist on after the fact. An entry too
   * broken to be one is caught where that judgement belongs, by the manager
   * reading its meta.
   */
  protected fromRecord(record: StoredProgramme): XmltvProgramme {
    const programme = { ...record } as unknown as XmltvProgramme;

    for (const field of DATE_FIELDS) {
      if (programme[field] !== undefined) {
        programme[field] = parseXmltvDate(String(programme[field]));
      }
    }

    if (programme.previouslyShown?.start !== undefined) {
      programme.previouslyShown = {
        ...programme.previouslyShown,
        start: parseXmltvDate(String(programme.previouslyShown.start)),
      };
    }

    return programme;
  }

  /**
   * One programme as this driver keeps it, a record unless it says otherwise.
   *
   * Public, unlike the record pair: the manager is what calls these, at the two
   * moments a programme crosses into the store and back, so that no driver has
   * to remember to.
   *
   * The cast is what the default costs: it is written for the default `TStored`,
   * and a driver that names another form is a driver that overrides this pair —
   * which is also why the pair reaches for {@link toRecord} rather than for
   * `super`, whose type here is whatever the subclass said it stores.
   */
  toStored(programme: XmltvProgramme): TStored {
    return this.toRecord(programme) as TStored;
  }

  /** The programme one stored thing stands for. */
  fromStored(stored: TStored): XmltvProgramme {
    return this.fromRecord(stored as StoredProgramme);
  }

  /**
   * One date as it is stored: the XMLTV form, and its trailing offset only when
   * there is one to keep.
   *
   * A zero offset and no offset mean the same thing — both read back as UTC — so
   * `2020 +0000` would be noise in a file people do read.
   */
  #storedDate(value: Date): string {
    return formatXmltvDate(value, { offset: getXmltvOffset(value) !== 0 });
  }
}
