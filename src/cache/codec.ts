/**
 * What a channel-day's programmes become in a store, and how they come back:
 * the bytes every driver keeps, made and read by a codec.
 *
 * A driver stores bytes and says which codec makes them, and the
 * {@link CacheManager} encodes and decodes — so a store is about *where* an
 * entry lives, and what an entry looks like inside is said once, by its codec.
 * Which is also what lets a site in a thread of its own encode a channel-day
 * itself: a codec named here is code both sides of the thread have, so the
 * thread sends the very bytes the store will keep and the main thread only
 * saves them. A driver that brings a codec of its own is handed programmes on
 * the main thread instead.
 *
 * Most codecs keep JSON, and a `Date` carries two things this package promises
 * to keep — the offset the source wrote it in, and how precise the source was —
 * on symbol keys, which `JSON.stringify` does not see. An ISO timestamp is the
 * instant and nothing else, so a programme stored that way comes back `+0000`,
 * and a `<date>` of `2020` comes back as a midnight timestamp. The XMLTV form is
 * what the two were read from, so it is what a record writes its dates in, and
 * what they survive in.
 */

import { parseXmltvString, serializeProgramme } from '../xmltv/main.js';
import type { SerializeOptions } from '../xmltv/main.js';
import { formatXmltvDate, getXmltvOffset, parseXmltvDate, XmltvDateError } from '../xmltv/date.js';
import { XmltvInputError } from '../xmltv/scan.js';
import type { XmltvProgramme } from '../xmltv/types.js';
import { errorMessage } from '../core/error.js';
import type { StoredEntryMeta, StoredProgramme } from './types.js';

/**
 * A channel-day's programmes as bytes, and back — what a driver of your own
 * brings when none of {@link CODECS} keeps what it wants kept.
 */
export interface CacheCodec {
  /** The programmes as the bytes a store keeps. */
  encode(programmes: XmltvProgramme[]): Uint8Array;
  /**
   * The programmes those bytes stand for — what a driver's `read` handed back,
   * with `meta`, what the entry says about itself. Throws
   * {@link CorruptEntryError} for bytes that are not what it wrote: a codec
   * that gives back exactly what it was given can tell a cut that still reads
   * by `meta.programmeCount`.
   */
  decode(body: Uint8Array, meta: StoredEntryMeta): XmltvProgramme[];
}

/**
 * Bytes a codec cannot read as the programmes it wrote — a line cut short, an
 * edit, a disk that filled — thrown by its `decode` to say so.
 *
 * What it tells the {@link CacheManager} is that the entry is damaged, not the
 * codec: a run removes it, says so as a warning of its site's, and the next run
 * grabs the day again. Anything else a codec throws is taken for the codec's
 * own failing — a bug, a format changed without a schema to say so — and thrown
 * as it is, since for every entry at once a removal would empty the cache and
 * write an empty guide over the last good one. The codecs of {@link CODECS}
 * throw it for whatever they cannot read, the cause beside it, and for a count
 * other than the one the entry was written with.
 *
 * `instanceof` knows one by its name as well, so a driver whose package brings
 * a copy of this one of its own throws one the manager knows.
 */
export class CorruptEntryError extends Error {
  override readonly name = 'CorruptEntryError';

  /**
   * An instance, or an error of the same name — another copy's. Asked of a
   * subclass, only an instance of it is one: what a subclass adds, another
   * copy's error does not have.
   */
  static [Symbol.hasInstance](value: unknown): value is CorruptEntryError {
    return (
      Function.prototype[Symbol.hasInstance].call(this, value) ||
      (this === CorruptEntryError && value instanceof Error && value.name === 'CorruptEntryError')
    );
  }
}

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

/** One programme as a record: a plain object, its dates in XMLTV form. */
export function toRecord(programme: XmltvProgramme): StoredProgramme {
  const record: StoredProgramme = { ...programme };

  for (const field of DATE_FIELDS) {
    const value = programme[field];

    if (value !== undefined) {
      record[field] = storedDate(value);
    }
  }

  if (programme.previouslyShown?.start !== undefined) {
    record.previouslyShown = {
      ...programme.previouslyShown,
      start: storedDate(programme.previouslyShown.start),
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
export function fromRecord(record: StoredProgramme): XmltvProgramme {
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

/** One programme as a line: its record, as JSON. */
export function toLine(programme: XmltvProgramme): string {
  return JSON.stringify(toRecord(programme));
}

/** The programme one line stands for. */
export function fromLine(line: string): XmltvProgramme {
  return fromRecord(JSON.parse(line) as StoredProgramme);
}

/**
 * How an entry of the xmltv driver is written — and deliberately a constant,
 * not anything a caller can reach.
 *
 * The invariant is that the cache holds what a **source said**, not what some
 * consumer wanted to read. Let an output profile in here and the shaping
 * becomes permanent and invisible: `isStale` knows nothing about the form an
 * entry was written in, so a profiled entry stays "fresh" for its whole
 * `maxAgeDays`, and by the time anyone notices the dropped `<image>` the
 * source's own window has rolled past it. Nothing but `--refetch-all` would
 * recover it.
 *
 * So: no `profile`, and no `extensions` either. If cache formatting ever does
 * become configurable, it must stay a separate setting from the one that shapes
 * output — see the test that asserts an entry is unchanged with a profile set.
 */
export const XMLTV_ENTRY: SerializeOptions = { indent: 2 };

/**
 * The codecs a store can name — and so the ones a site's thread can run for
 * it, since a name is what can be handed to a thread.
 */
export const CODECS = {
  /** One record of JSON per line: what the ndjson driver keeps after its meta line. */
  ndjson: {
    encode: (programmes) => utf8(programmes.map(toLine).join('\n')),
    // A blank line is what the end of a file looks like.
    decode: (body, meta) =>
      readAs('ndjson', meta, () =>
        text(body)
          .split('\n')
          .filter((line) => line.trim() !== '')
          .map(fromLine),
      ),
  },
  /** The records' array, as JSON: what sqlite and memory keep. */
  json: {
    encode: (programmes) => utf8(JSON.stringify(programmes.map(toRecord))),
    decode: (body, meta) =>
      readAs('json', meta, () => {
        // Bytes that are not the records' array say nothing about their
        // programmes, and are as damaged as a line cut short: the day is
        // grabbed again rather than served as empty.
        const parsed = JSON.parse(text(body)) as unknown;

        if (!Array.isArray(parsed)) {
          throw new CorruptEntryError('An entry of the json codec holds no array of records');
        }

        return (parsed as StoredProgramme[]).map(fromRecord);
      }),
  },
  /**
   * `<programme>` elements, as XMLTV writes them: what the xmltv driver puts in
   * its document. Programmes rather than records, since XMLTV is where a date's
   * offset and precision came from in the first place. Reads back the document
   * the driver hands it — or bare elements, which are wrapped.
   */
  xmltv: {
    encode: (programmes) =>
      utf8(programmes.map((programme) => serializeProgramme(programme, XMLTV_ENTRY)).join('')),
    decode: (body, meta) =>
      readAs('xmltv', meta, () => {
        const document = text(body);

        // A programme of no channel is one this codec wrote — an entry is a
        // channel's whichever way — so it is read back rather than dropped.
        return parseXmltvString(
          /^\s*(<programme[\s/>]|$)/.test(document) ? `<tv>${document}</tv>` : document,
          { tolerateMissingId: true },
        ).programmes;
      }),
  },
} satisfies Record<string, CacheCodec>;

/** A codec a store can name. */
export type CodecName = keyof typeof CODECS;

/** The codec a driver keeps its entries with, whether it named one or brought it. */
export function codecOf(codec: CodecName | CacheCodec): CacheCodec {
  if (typeof codec !== 'string') {
    return codec;
  }

  if (!Object.hasOwn(CODECS, codec)) {
    throw new TypeError(
      `A cache driver's codec is one of ${Object.keys(CODECS).join(', ')}, or an object ` +
        `with encode and decode (got "${String(codec)}")`,
    );
  }

  return CODECS[codec];
}

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

/** A day with nothing on. */
const NOTHING = new Uint8Array(0);

/**
 * Text as UTF-8, in a buffer of its own: room for the worst case, encoded once.
 *
 * A string's UTF-8 is never more than three bytes a character, so allocating
 * that much — uninitialized — and encoding into it once skips both the pass
 * that measures the exact length and the zero-fill an exact allocation does:
 * 3.8ms for 1.45 MiB of Slovak text, against 5.6 for `TextEncoder.encode` and
 * 5.3 for `Buffer.from`, and against 4.4 for SQLite binding the string itself.
 * What it costs is room: the buffer is up to three times what it holds until
 * the entry is written, which for one channel-day is kilobytes.
 *
 * Its own buffer rather than a slice of Node's pool, so a thread can transfer
 * it to the main thread instead of copying it.
 */
function utf8(source: string): Uint8Array {
  if (source === '') {
    return NOTHING;
  }

  const room = Buffer.allocUnsafeSlow(source.length * 3);
  const { written } = ENCODER.encodeInto(source, room);

  return room.subarray(0, written);
}

function text(body: Uint8Array): string {
  return DECODER.decode(body);
}

/**
 * What a codec of {@link CODECS} reads — or, for bytes it cannot, a
 * {@link CorruptEntryError}: what a parser throws for its input — JSON that is
 * not JSON, a date that is no date, a document that is not XMLTV — is the
 * entry's doing. Anything else is thrown as it is: a fault of this code taken
 * for a damaged entry would remove every entry it read.
 *
 * And for fewer or more than `meta` says the entry holds, since these give back
 * exactly what they were given and the count was taken from the very
 * programmes encoded: a cut that still reads — an ndjson entry cut between
 * lines, an xmltv document that ends early — reads as fewer.
 */
function readAs(
  codec: string,
  meta: StoredEntryMeta,
  decode: () => XmltvProgramme[],
): XmltvProgramme[] {
  let programmes: XmltvProgramme[];

  try {
    programmes = decode();
  } catch (error) {
    // The json codec's own CorruptEntryError among them, said as it is.
    if (!isInputError(error)) {
      throw error;
    }

    throw new CorruptEntryError(
      `An entry of the ${codec} codec does not read: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  if (programmes.length !== meta.programmeCount) {
    throw new CorruptEntryError(
      `An entry of the ${codec} codec reads as ${programmes.length} programmes, ` +
        `of the ${meta.programmeCount} it says it holds`,
    );
  }

  return programmes;
}

/** What a parser throws for input it cannot read, rather than for a fault of its own. */
function isInputError(error: unknown): boolean {
  return (
    error instanceof SyntaxError ||
    error instanceof XmltvDateError ||
    error instanceof XmltvInputError
  );
}

/**
 * One date as it is stored: the XMLTV form, and its trailing offset only when
 * there is one to keep.
 *
 * A zero offset and no offset mean the same thing — both read back as UTC — so
 * `2020 +0000` would be noise in a file people do read.
 */
function storedDate(value: Date): string {
  return formatXmltvDate(value, { offset: getXmltvOffset(value) !== 0 });
}
