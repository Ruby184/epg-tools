/**
 * Wall-clock times in a named zone, turned into instants a guide can carry.
 *
 * A source that says `2026-07-17 20:00` means eight in the evening where it is,
 * and the one thing it does not say is the offset that makes those digits an
 * instant. `new Date('2026-07-17T20:00')` reads them in *this machine's* zone,
 * which is the bug this exists to prevent: the same grabber in a container set
 * to UTC shifts every programme of a Bratislava guide by an hour or two — and by
 * a different amount either side of the night the clocks change, which is how it
 * survives a test run in March and goes wrong in June.
 *
 * The zone database is already in the runtime, so this is a few lookups rather
 * than a dependency, and it is right for dates decades either side of today,
 * historical changes included.
 */

import { daysInMonth, setXmltvOffset, setXmltvPrecision, XmltvDateError } from './date.js';
import type { XmltvDate } from './date.js';

const MINUTE = 60_000;
const DAY = 86_400_000;

/**
 * One formatter per zone, kept.
 *
 * Building an `Intl.DateTimeFormat` costs more than the lookups that follow it,
 * and a site converts one time per programme — tens of thousands in a run,
 * nearly always naming the same zone.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);

  if (formatter === undefined) {
    try {
      formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        // `h23` rather than `hour12: false`, which leaves midnight as hour 24 in
        // some locales — and would put every midnight programme a day early.
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch {
      throw new RangeError(
        `Unknown time zone ${JSON.stringify(timeZone)}: expected an IANA name such as "Europe/Bratislava"`,
      );
    }

    formatters.set(timeZone, formatter);
  }

  return formatter;
}

/**
 * What a zone did on one UTC day: an offset it held throughout, or the instant
 * it changed and the offsets either side.
 *
 * Asking `Intl` costs about nine microseconds, and a site asks per programme —
 * 280,000 of them for a fortnight of five hundred channels, which measured at
 * 6.5 seconds of a grab spent formatting dates nobody reads. A day is the
 * natural thing to remember instead: two questions settle one, and every
 * programme in it is then arithmetic.
 *
 * Which assumes a zone changes at most once in a UTC day. Nothing in the zone
 * database has ever done otherwise — the closest is Morocco, whose pair of
 * changes around Ramadan are a month apart.
 */
type ZoneDay = number | { at: number; before: number; after: number };

const zoneDays = new Map<string, ZoneDay>();

/** The offset a zone was in at an instant, from what is known of that day. */
function offsetAt(timeZone: string, instant: number): number {
  const day = Math.floor(instant / DAY);
  const key = `${timeZone}|${day}`;
  let known = zoneDays.get(key);

  if (known === undefined) {
    known = surveyDay(timeZone, day);
    zoneDays.set(key, known);
  }

  return typeof known === 'number' ? known : instant < known.at ? known.before : known.after;
}

/** Two lookups, and a search for the moment between them when they differ. */
function surveyDay(timeZone: string, day: number): ZoneDay {
  const start = day * DAY;
  const end = start + DAY - 1;
  const before = rawOffsetAt(timeZone, start);
  const after = rawOffsetAt(timeZone, end);

  if (before === after) {
    return before;
  }

  // The clocks changed somewhere in here. Halving the day to the minute finds
  // when — seventeen more questions, once, for the two days a year it happens.
  let held = start;
  let changed = end;

  while (changed - held > MINUTE) {
    const middle = held + Math.floor((changed - held) / 2);

    if (rawOffsetAt(timeZone, middle) === before) {
      held = middle;
    } else {
      changed = middle;
    }
  }

  return { at: changed, before, after };
}

/** What `Intl` says, which is what everything above is trying not to ask twice. */
function rawOffsetAt(timeZone: string, instant: number): number {
  return Math.round((wallOf(timeZone, instant) - instant) / MINUTE);
}

/** The wall clock at an instant, as though those digits were UTC. */
function wallOf(timeZone: string, instant: number): number {
  const parts: Record<string, number> = {};

  for (const { type, value } of formatterFor(timeZone).formatToParts(instant)) {
    if (type !== 'literal') {
      parts[type] = Number(value);
    }
  }

  return Date.UTC(
    parts.year!,
    parts.month! - 1,
    parts.day!,
    parts.hour!,
    parts.minute!,
    parts.second!,
  );
}

/**
 * A zone's offset from UTC in minutes at a given instant — `120` for `+0200`,
 * as XMLTV writes it.
 *
 * Rounded to the minute, which is all an XMLTV offset can say: the seconds a few
 * zones carried before standard time was adopted are not something a guide can
 * express, and no listing is from 1880 anyway.
 */
export function xmltvZoneOffset(timeZone: string, at: Date = new Date()): number {
  return offsetAt(timeZone, at.getTime());
}

/**
 * The offset a wall-clock time in a zone was written in, and the instant it
 * stands for.
 *
 * The offsets a day either side answer it. When they agree, nothing changed
 * anywhere near this time — every hour of the year but two — and the one offset
 * is the answer. When they differ the clocks changed in between, and those two
 * offsets are the only candidates there are.
 *
 * A day either side rather than an hour, because a few zones have jumped a whole
 * one crossing the date line. Asking about the time itself would not do: the
 * offset at the instant those digits make *if read as UTC* is a guess that lands
 * on the wrong side of a change as often as not, and an hour that came round
 * twice answers to it either way — which is how a first attempt at this returned
 * the second 02:30 of the night rather than the first.
 */
function resolve(wall: number, timeZone: string): { instant: number; offset: number } {
  const before = offsetAt(timeZone, wall - DAY);
  const after = offsetAt(timeZone, wall + DAY);

  if (before === after) {
    return { instant: wall - before * MINUTE, offset: before };
  }

  const earlier = wall - before * MINUTE;
  const later = wall - after * MINUTE;
  const earlierHolds = offsetAt(timeZone, earlier) === before;
  const laterHolds = offsetAt(timeZone, later) === after;

  if (earlierHolds && laterHolds) {
    // The clocks went back, so this wall time came round twice. A listing means
    // the first of them: the guide is read forwards, and a programme at 02:30
    // that night is the one before the change.
    return earlier <= later
      ? { instant: earlier, offset: before }
      : { instant: later, offset: after };
  }

  if (earlierHolds || laterHolds) {
    return earlierHolds ? { instant: earlier, offset: before } : { instant: later, offset: after };
  }

  // The clocks went forward, so this wall time never happened. Reading it in the
  // offset from before the change puts it the same distance past the gap as it
  // was into it — 02:30 becomes 03:30 — which keeps the night in order and every
  // gap between programmes the length the source gave it.
  return { instant: earlier, offset: after };
}

/**
 * What a named zone is worth at a given moment, for
 * {@link parseXmltvDate}'s timezone map.
 *
 * Sources write the ambiguous ones: a guide stamped `CET` in July means `+0200`
 * and the same guide in January means `+0100`, which no fixed number can say.
 *
 * ```ts
 * parseXmltvDate('20260717200000 CET', { CET: xmltvZone('Europe/Bratislava') });
 * ```
 *
 * It takes the wall clock the digits spell out and answers with the offset that
 * turns them into the right instant — the same reading {@link zonedXmltvDate}
 * does, so a source whose datetimes are named in one place and bare in another
 * comes out to the same moment either way.
 *
 * Those two agree on the instant always, and on the digits except for an hour
 * the clocks skipped, which cannot be written down twice: `zonedXmltvDate` moves
 * such a time past the gap, where a parsed one keeps the digits it was given and
 * takes the offset from before the change. `20260329023000 CET` and
 * `202603290330 +0200` are the same moment written two ways, and a guide built
 * from either merges the same.
 */
export function xmltvZone(timeZone: string): (wall: Date) => number {
  return (wall) =>
    Math.round((wall.getTime() - resolve(wall.getTime(), timeZone).instant) / MINUTE);
}

/**
 * How much of a local time was given: `2026`, `2026-07`, … down to the second,
 * with or without separators.
 *
 * The same digit counts XMLTV uses for precision, so a source that says only
 * `2026-07-17 20:00` is written back out as `202607172000` rather than gaining a
 * `:00` it never claimed.
 */
const LOCAL = /^(\d{4})(?:-?(\d{2})(?:-?(\d{2})(?:[T ]?(\d{2})(?::?(\d{2})(?::?(\d{2}))?)?)?)?)?$/;

/**
 * A wall-clock time in a named zone, as a `Date` that knows the offset it was
 * written in.
 *
 * ```ts
 * zonedXmltvDate('2026-07-17 20:00', 'Europe/Bratislava'); // 18:00Z, +0200
 * zonedXmltvDate('20261225183000', 'Europe/Bratislava'); // 17:30Z, +0100
 * ```
 *
 * The instant is what the guide is built and merged from; the offset is what it
 * is written with, so a listing reads as the source published it — which is what
 * XMLTV carries an offset for at all.
 *
 * Takes the XMLTV digit form or the ISO-ish one, truncated anywhere from the
 * year down. What it will not take is a time that already carries an offset:
 * something ending `+0200` or `Z` needs no zone to interpret it, and passing
 * both is a mistake worth hearing about rather than a preference to resolve.
 * {@link parseXmltvDate} is for those.
 */
export function zonedXmltvDate(local: string, timeZone: string): XmltvDate {
  const fields = LOCAL.exec(local.trim());

  if (fields === null) {
    throw new XmltvDateError(
      local,
      'expected a local datetime with no offset, such as "2026-07-17 20:00"',
      0,
    );
  }

  const [, year, month, day, hour, minute, second] = fields;
  const fieldsGiven = [year, month, day, hour, minute, second].filter(
    (field) => field !== undefined,
  );
  const numbers = fieldsGiven.map(Number);
  const [y, mo = 1, d = 1, h = 0, mi = 0, sec = 0] = numbers;

  // Checked before the date is built rather than read back out of it, because
  // `Date.UTC` rolls anything out of range into something valid-looking and says
  // nothing: month 13 becomes January of the next year, 31 April becomes 1 May,
  // and a year of `0099` becomes 1999.
  if (
    y! < 100 ||
    mo < 1 ||
    mo > 12 ||
    d < 1 ||
    d > daysInMonth(y!, mo) ||
    h > 23 ||
    mi > 59 ||
    sec > 59
  ) {
    throw new XmltvDateError(local, 'expected a real date', 0);
  }

  const wall = Date.UTC(y!, mo - 1, d, h, mi, sec);
  const { instant, offset } = resolve(wall, timeZone);
  const date = new Date(instant);

  setXmltvOffset(date, offset);
  // Four digits for the year and two for each field after it, which is how the
  // rest of this module counts precision.
  setXmltvPrecision(date, fieldsGiven.length * 2 + 2);

  return date as XmltvDate;
}

/**
 * The same instant, written in a zone.
 *
 * For a source that gives an instant rather than a wall clock — an epoch
 * timestamp, an ISO string in UTC — where the guide should still read locally.
 * Nothing about *when* changes; what changes is the offset it is rendered in,
 * and with it the digits a reader sees.
 *
 * ```ts
 * setXmltvZone(new Date('2026-07-17T18:00:00Z'), 'Europe/Bratislava'); // 20:00 +0200
 * ```
 */
export function setXmltvZone(date: Date, timeZone: string): Date {
  return setXmltvOffset(date, xmltvZoneOffset(timeZone, date));
}
