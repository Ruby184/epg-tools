function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/**
 * Symbol key under which the source UTC offset (in minutes) is stashed on a
 * Date. A JS `Date` is a bare UTC instant with no timezone slot, so
 * {@link parseXmltvDate} preserves the original `±HHMM` offset here and
 * {@link formatXmltvDate} reads it back to re-emit the same offset instead of
 * always normalizing to `+0000`. A Symbol key never appears in `for...in`,
 * `Object.keys`, or `JSON.stringify`, so it never leaks into the data model.
 */
export const XMLTV_OFFSET: unique symbol = Symbol('xmltvOffset');

/**
 * Symbol key under which the source precision — the number of significant
 * digits present (`4`=year, `6`=month, `8`=day, `10`=hour, `12`=minute,
 * `14`=second) — is stashed. Truncated XMLTV datetimes fill the missing
 * fields with defaults; this remembers how precise the source actually was so
 * {@link formatXmltvDate} re-emits the same shape (e.g. `20260807`, not
 * `20260807000000`). Only stored when less than full second precision.
 */
export const XMLTV_PRECISION: unique symbol = Symbol('xmltvPrecision');

/** A `Date` that may carry a preserved XMLTV source offset (minutes). */
export interface WithXmltvOffset {
  [XMLTV_OFFSET]?: number;
}

/** A `Date` that may carry a preserved XMLTV source precision (digit count). */
export interface WithXmltvPrecision {
  [XMLTV_PRECISION]?: number;
}

/**
 * A `Date` that may carry the XMLTV source offset and precision flags. The
 * flags are optional, so a plain `Date` is assignable to (and from) this type;
 * it just documents that {@link getXmltvOffset} / {@link getXmltvPrecision} are
 * meaningful on the value.
 */
export type XmltvDate = Date & WithXmltvOffset & WithXmltvPrecision;

/**
 * The source UTC offset in minutes for a Date (e.g. `120` for `+0200`, `-300`
 * for `-0500`), defaulting to `0` (UTC) when none is preserved. A zero offset
 * is UTC — the same wall clock a missing offset or an explicit `+0000`/`GMT`/
 * `UTC`/`UT`/`Z` denotes — so all of those report `0` and only a *non-UTC*
 * wall clock is actually stored. See {@link parseXmltvDate}.
 */
export function getXmltvOffset(date: Date): number {
  return (date as WithXmltvOffset)[XMLTV_OFFSET] ?? 0;
}

/**
 * Preserve a source UTC offset (in minutes) on a Date so {@link formatXmltvDate}
 * re-emits it. The Date's instant is unchanged — the offset is purely the
 * wall-clock timezone the value should be rendered in. Returns the same Date.
 *
 * A zero offset is UTC, the default: it formats identically to no offset, so
 * rather than store it, any previously preserved offset is cleared. This keeps
 * a symbol write off the parser's hot path (most datetimes are `+0000`) while
 * {@link getXmltvOffset} still reports `0` for every UTC date.
 */
export function setXmltvOffset(date: Date, offsetMinutes: number): Date & WithXmltvOffset {
  if (offsetMinutes === 0) {
    delete (date as WithXmltvOffset)[XMLTV_OFFSET];
  } else {
    (date as WithXmltvOffset)[XMLTV_OFFSET] = offsetMinutes;
  }

  return date;
}

/**
 * The source precision as a digit count (`4`/`6`/`8`/`10`/`12`/`14`); defaults
 * to `14` (full second precision) when nothing was stored. See
 * {@link XMLTV_PRECISION}.
 */
export function getXmltvPrecision(date: Date): number {
  return (date as WithXmltvPrecision)[XMLTV_PRECISION] ?? 14;
}

/**
 * Preserve a source precision (digit count) on a Date so {@link formatXmltvDate}
 * emits only that many fields. Returns the same Date.
 */
export function setXmltvPrecision(date: Date, digits: number): Date & WithXmltvPrecision {
  (date as WithXmltvPrecision)[XMLTV_PRECISION] = digits;
  return date;
}

/**
 * A datetime accepted by {@link xmltvDate} and the builder: a `Date` (any
 * preserved offset/precision flags are carried over), an XMLTV datetime string
 * (see {@link parseXmltvDate}), or a **unix timestamp in seconds** (the
 * canonical unix epoch; pass milliseconds via `new Date(ms)`).
 */
export type DateInput = Date | string | number;

/** Offset/precision flags to preserve on a Date, applied by {@link xmltvDate}. */
export interface XmltvDateOptions {
  /** Source UTC offset in minutes (e.g. `120` for `+0200`). See {@link setXmltvOffset}. */
  offset?: number;
  /** Source precision as a digit count (`4`/`6`/`8`/`10`/`12`/`14`). See {@link setXmltvPrecision}. */
  precision?: number;
}

/**
 * Create a Date carrying XMLTV {@link XMLTV_OFFSET offset} and
 * {@link XMLTV_PRECISION precision} flags in one call — the convenience
 * alternative to `new Date()` followed by {@link setXmltvOffset} /
 * {@link setXmltvPrecision}. `value` is coerced per {@link DateInput}; any
 * flags already on a `Date` value (or parsed from a string) are preserved
 * unless overridden by `options`.
 */
export function xmltvDate(value: DateInput, options: XmltvDateOptions = {}): XmltvDate {
  let date: Date;

  if (value instanceof Date) {
    date = new Date(value.getTime());

    const offset = (value as WithXmltvOffset)[XMLTV_OFFSET];
    if (offset !== undefined) setXmltvOffset(date, offset);

    const precision = (value as WithXmltvPrecision)[XMLTV_PRECISION];
    if (precision !== undefined) setXmltvPrecision(date, precision);
  } else if (typeof value === 'number') {
    date = new Date(value * 1000);
  } else {
    date = parseXmltvDate(value);
  }

  // A NaN/non-finite number, or an already-invalid Date, yields `Invalid Date`.
  // (A string can't reach here invalid — parseXmltvDate throws XmltvDateError.)
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(
      typeof value === 'number'
        ? `Invalid date value: ${value} is not a finite unix timestamp (seconds)`
        : 'Invalid date value: received an Invalid Date',
    );
  }

  if (options.offset !== undefined) setXmltvOffset(date, options.offset);
  if (options.precision !== undefined) setXmltvPrecision(date, options.precision);

  return date;
}

function digitsOf(date: Date): string {
  return (
    `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  );
}

/** Options for {@link formatXmltvDate}. */
export interface FormatXmltvDateOptions {
  /**
   * Emit the trailing `±HHMM` offset. Default `true`. Set `false` for
   * offset-free elements like a programme's production `<date>`, which is a
   * bare `YYYY`/`YYYYMMDD` with no timezone.
   */
  offset?: boolean;
}

/**
 * Format a Date as an XMLTV datetime `YYYYMMDDHHMMSS ±HHMM`, honoring any
 * offset (see {@link setXmltvOffset}) and precision (see
 * {@link setXmltvPrecision}) preserved on it. Wall-clock fields render in the
 * preserved timezone, truncated to the preserved precision; a Date with no
 * preserved offset renders as UTC (`+0000`) at full precision. Pass
 * `{ offset: false }` to omit the offset suffix entirely.
 */
export function formatXmltvDate(date: Date, options: FormatXmltvDateOptions = {}): string {
  // Read the raw offset (not getXmltvOffset, which defaults UTC to 0): a UTC
  // date has none preserved, so it renders in place with no Date allocation.
  const offset = (date as WithXmltvOffset)[XMLTV_OFFSET];
  const precision = getXmltvPrecision(date);
  const local = offset === undefined ? date : new Date(date.getTime() + offset * 60_000);
  const stamp = precision < 14 ? digitsOf(local).slice(0, precision) : digitsOf(local);

  if (options.offset === false) {
    return stamp;
  }

  if (offset === undefined) {
    return `${stamp} +0000`;
  }

  const abs = Math.abs(offset);

  return `${stamp} ${offset < 0 ? '-' : '+'}${pad((abs / 60) | 0)}${pad(abs % 60)}`;
}

const ZERO = '0'.charCodeAt(0);
const NINE = '9'.charCodeAt(0);
const PLUS = '+'.charCodeAt(0);
const MINUS = '-'.charCodeAt(0);
const SPACE = ' '.charCodeAt(0);
const TAB = '\t'.charCodeAt(0);
const LF = '\n'.charCodeAt(0);
const CR = '\r'.charCodeAt(0);

function isSpace(code: number): boolean {
  return code === SPACE || code === TAB || code === LF || code === CR;
}

/** Named timezones that are unambiguously UTC (`+0000`); always resolved. */
const UTC_ZONES = new Set(['UTC', 'GMT', 'UT', 'Z']);

/**
 * A map from a named timezone abbreviation to its UTC offset in minutes, e.g.
 * `{ BST: 60, CET: 60, CEST: 120, EST: -300 }`. Keys must be UPPERCASE — the
 * abbreviation in the value is uppercased before lookup. Passed to
 * {@link parseXmltvDate} (and via `timezones` in the parse options) to resolve
 * the ambiguous named zones the DTD allows but that have no single correct
 * offset.
 */
export type XmltvTimezoneOffsets = Record<string, number>;

function digits(value: string, from: number, to: number): number {
  let out = 0;

  for (let i = from; i < to; i++) {
    out = out * 10 + (value.charCodeAt(i) - ZERO);
  }

  return out;
}

/** Days per month (index 0 = January); February handled via {@link isLeapYear}. */
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Thrown by {@link parseXmltvDate} for an invalid XMLTV datetime. Carries a
 * human-readable {@link reason} and the 0-based {@link index} in the input the
 * problem is anchored to, so callers (and parse warnings) can report *what* is
 * wrong and *where* without re-inspecting the value. Extends `TypeError`.
 */
export class XmltvDateError extends TypeError {
  /** The offending input string. */
  readonly value: string;
  /** Human-readable reason the value is invalid. */
  readonly reason: string;
  /** 0-based index in {@link value} the reason is anchored to. */
  readonly index: number;

  constructor(value: string, reason: string, index: number) {
    super(`Invalid XMLTV date "${value}": ${reason} (at index ${index})`);
    this.name = 'XmltvDateError';
    this.value = value;
    this.reason = reason;
    this.index = index;
  }
}

/**
 * Parse an XMLTV datetime (`YYYYMMDDHHMMSS ±HHMM`). Truncated forms
 * (`YYYYMMDDHHMM`, `YYYYMMDD`, ...) are accepted; a missing offset means
 * UTC. Charcode-based — this runs at least twice per programme, and a
 * regex here is measurable on large guides. Throws {@link XmltvDateError}
 * (a `TypeError`) with a reason and index on invalid input.
 *
 * `GMT`/`UTC`/`UT`/`Z` always resolve to `+0000`. Any other named timezone
 * must be supplied in `timezones` (abbreviation → offset minutes); an
 * unmapped named zone throws {@link XmltvDateError} so it surfaces and can be
 * fixed by adding a mapping rather than being silently mis-assumed as UTC.
 */
export function parseXmltvDate(value: string, timezones?: XmltvTimezoneOffsets): XmltvDate {
  let start = 0;
  let end = value.length;

  while (start < end && isSpace(value.charCodeAt(start))) {
    start++;
  }

  while (end > start && isSpace(value.charCodeAt(end - 1))) {
    end--;
  }

  let digitsEnd = start;

  while (digitsEnd < end) {
    const code = value.charCodeAt(digitsEnd);

    if (code < ZERO || code > NINE) {
      break;
    }

    digitsEnd++;
  }

  const count = digitsEnd - start;

  if (count === 0) {
    throw new XmltvDateError(value, 'expected a datetime, found no digits', start);
  }
  if (count < 4) {
    throw new XmltvDateError(value, 'datetime must begin with a 4-digit year', start);
  }
  if (count > 14) {
    throw new XmltvDateError(value, 'datetime has too many digits (YYYYMMDDhhmmss at most)', start + 14);
  }
  if (count % 2 !== 0) {
    throw new XmltvDateError(value, 'datetime needs an even digit count (YYYY, YYYYMM, YYYYMMDD, ...)', start + count - 1);
  }

  const year = digits(value, start, start + 4);
  const month = count >= 6 ? digits(value, start + 4, start + 6) : 1;
  const day = count >= 8 ? digits(value, start + 6, start + 8) : 1;
  const hour = count >= 10 ? digits(value, start + 8, start + 10) : 0;
  const minute = count >= 12 ? digits(value, start + 10, start + 12) : 0;
  const second = count >= 14 ? digits(value, start + 12, start + 14) : 0;

  // Reject out-of-range fields (month 13, hour 25, ...) up front, before
  // constructing the Date — `Date.UTC` would otherwise silently roll them over
  // into a different, valid-looking instant. Each is reported with its own
  // reason and position within the value. Validating arithmetically (rather
  // than round-tripping through `getUTC*` on the constructed Date) keeps this
  // off the hot path: `parseXmltvDate` runs several times per programme.
  if (month < 1 || month > 12) {
    throw new XmltvDateError(value, 'month must be in 01–12', start + 4);
  }
  // Upper bound folds the month's real length in (so Feb 30 is caught here too).
  const maxDay = month === 2 && isLeapYear(year) ? 29 : MONTH_DAYS[month - 1]!;

  if (day < 1 || day > maxDay) {
    throw new XmltvDateError(value, `day ${pad(day)} is out of range for month ${pad(month)}`, start + 6);
  }
  if (hour > 23) {
    throw new XmltvDateError(value, 'hour must be in 00–23', start + 8);
  }
  if (minute > 59) {
    throw new XmltvDateError(value, 'minute must be in 00–59', start + 10);
  }
  if (second > 59) {
    throw new XmltvDateError(value, 'second must be in 00–59', start + 12);
  }
  // A year 0–99 would map into 1900–1999 via `Date.UTC`; reject it explicitly.
  if (year < 100) {
    throw new XmltvDateError(value, 'year must be in 0100–9999', start);
  }

  const time = Date.UTC(year, month - 1, day, hour, minute, second);
  const date = new Date(time);

  let offsetStart = digitsEnd;

  while (offsetStart < end && isSpace(value.charCodeAt(offsetStart))) {
    offsetStart++;
  }

  if (offsetStart < end) {
    const sign = value.charCodeAt(offsetStart);
    let offset = 0;

    if (sign === PLUS || sign === MINUS) {
      // Numeric `±HHMM` offset.
      if (end - offsetStart !== 5) {
        throw new XmltvDateError(value, 'timezone offset must be ±HHMM', offsetStart);
      }

      for (let i = offsetStart + 1; i < end; i++) {
        const code = value.charCodeAt(i);

        if (code < ZERO || code > NINE) {
          throw new XmltvDateError(value, 'timezone offset must be ±HHMM digits', i);
        }
      }

      const offH = digits(value, offsetStart + 1, offsetStart + 3);
      const offM = digits(value, offsetStart + 3, offsetStart + 5);

      if (offH > 23) {
        throw new XmltvDateError(value, 'timezone offset hours must be in 00–23', offsetStart + 1);
      }
      if (offM > 59) {
        throw new XmltvDateError(value, 'timezone offset minutes must be in 00–59', offsetStart + 3);
      }

      offset = sign === MINUS ? -(offH * 60 + offM) : offH * 60 + offM;
    } else {
      // Named timezone: resolve via the supplied map first, then the built-in
      // UTC set. An unknown abbreviation is rejected (rather than assumed UTC)
      // so it can be seen and fixed by adding it to `timezones`.
      const zone = value.slice(offsetStart, end).toUpperCase();
      const mapped = timezones?.[zone];

      if (mapped !== undefined) {
        offset = mapped;
      } else if (!UTC_ZONES.has(zone)) {
        throw new XmltvDateError(value, `unknown timezone "${zone}" — add it to the timezone offset map`, offsetStart);
      }
      // else: GMT/UTC/UT/Z — UTC, so `offset` stays 0.
    }

    // A zero offset is UTC (the default): the instant is already correct and
    // there is nothing to preserve, so skip the no-op shift and symbol write.
    if (offset !== 0) {
      date.setTime(time - offset * 60_000);
      setXmltvOffset(date, offset);
    }
  }

  if (count < 14) {
    setXmltvPrecision(date, count);
  }

  return date;
}
