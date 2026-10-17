import { describe, expect, it } from 'vitest';
import {
  dayIn,
  daysCovering,
  localTimeZone,
  resolveTimeZone,
  wallClock,
  wallTimeIn,
} from '../src/core/days.js';
import { getXmltvOffset, getXmltvPrecision, XmltvDateError } from '../src/xmltv/main.js';
import { siteDayZone, siteWindow } from '../src/grabber/site.js';
import type { SiteConfig } from '../src/grabber/types.js';

const BRATISLAVA = 'Europe/Bratislava';

describe('which day it is', () => {
  // Half past midnight in Bratislava in summer, which is still the day before
  // on UTC's calendar — the night homepi's grab started a day late.
  const halfPastMidnight = new Date('2026-07-16T22:30:00.000Z');

  it('is the day on the zone’s own calendar', () => {
    expect(dayIn(halfPastMidnight, BRATISLAVA)).toBe('2026-07-17');
    expect(dayIn(halfPastMidnight, 'UTC')).toBe('2026-07-16');
  });

  it('is the process’s own zone where none is said', () => {
    // The suite runs in UTC; see `vitest.config.ts`.
    expect(localTimeZone()).toBe('UTC');
    expect(dayIn(halfPastMidnight)).toBe('2026-07-16');
  });
});

describe('when a time of day happens', () => {
  it('is that time on the zone’s clock', () => {
    // Midnight in summer is 22:00 the evening before in UTC.
    expect(new Date(wallTimeIn('2026-07-17', BRATISLAVA)).toISOString()).toBe(
      '2026-07-16T22:00:00.000Z',
    );
    expect(new Date(wallTimeIn('2026-07-17', BRATISLAVA, 30)).toISOString()).toBe(
      '2026-07-16T22:30:00.000Z',
    );
  });

  it('is asked of the zone on a night the clocks change, not added to midnight', () => {
    // The clocks went forward at two that morning, so four o'clock is three
    // hours after midnight there, not four.
    expect(new Date(wallTimeIn('2026-03-29', BRATISLAVA, 4 * 60)).toISOString()).toBe(
      '2026-03-29T02:00:00.000Z',
    );
  });
});

describe('a time of day on a day', () => {
  /** When it is, and in what offset it is written. */
  const read = (day: string, time: string, dayZone = BRATISLAVA, timeZone = BRATISLAVA) => {
    const date = wallClock(day, time, dayZone, timeZone);

    return { at: date.toISOString(), offset: getXmltvOffset(date) };
  };

  it('is that time on the day’s clock, written in its offset', () => {
    expect(read('2026-07-17', '20:00')).toEqual({ at: '2026-07-17T18:00:00.000Z', offset: 120 });
    expect(read('2026-07-17', '6:05').at).toBe('2026-07-17T04:05:00.000Z');
  });

  it('is precise to the second only where the time gives one', () => {
    expect(getXmltvPrecision(wallClock('2026-07-17', '20:00', BRATISLAVA, BRATISLAVA))).toBe(12);
    expect(getXmltvPrecision(wallClock('2026-07-17', '20:00:30', BRATISLAVA, BRATISLAVA))).toBe(14);
  });

  it('runs on into the next day past 23, and 24:00 is the next midnight', () => {
    expect(read('2026-07-17', '25:30').at).toBe('2026-07-17T23:30:00.000Z');
    expect(read('2026-07-17', '24:00').at).toBe('2026-07-17T22:00:00.000Z');
    expect(read('2026-07-17', '00:00').at).toBe('2026-07-16T22:00:00.000Z');
  });

  it('is read on the day’s calendar and written on the guide’s where the two differ', () => {
    // Eight in the evening of a UTC day, as a Bratislava guide shows it.
    expect(read('2026-07-17', '20:00', 'UTC', BRATISLAVA)).toEqual({
      at: '2026-07-17T20:00:00.000Z',
      offset: 120,
    });
  });

  it('refuses what is not a time of day, whatever a source sent in its place', () => {
    for (const time of ['7pm', '20:60', '20:00:60', '2026-07-17 20:00', '', null, 2000]) {
      expect(() => wallClock('2026-07-17', time as string, BRATISLAVA, BRATISLAVA)).toThrow(
        XmltvDateError,
      );
    }
  });
});

describe('a zone a run is given', () => {
  it('is taken when it is one', () => {
    expect(resolveTimeZone(BRATISLAVA)).toBe(BRATISLAVA);
  });

  it('is the process’s own when none is given', () => {
    expect(resolveTimeZone(undefined)).toBe(localTimeZone());
  });

  it('is refused naming the setting when it is not one', () => {
    expect(() => resolveTimeZone('Mars/Olympus', 'serve.timeZone')).toThrow(
      'serve.timeZone must be an IANA time zone such as "Europe/Bratislava" (got "Mars/Olympus")',
    );
  });
});

describe('the days of another calendar a run covers', () => {
  it('reaches back a day where the other clock is behind', () => {
    // Bratislava's 17th starts at 22:00 UTC on the 16th.
    expect(daysCovering(['2026-07-17'], BRATISLAVA, 'UTC')).toEqual(['2026-07-16', '2026-07-17']);
  });

  it('reaches on a day where it is ahead', () => {
    // New York's 17th ends at 04:00 UTC on the 18th.
    expect(daysCovering(['2026-07-17'], 'America/New_York', 'UTC')).toEqual([
      '2026-07-17',
      '2026-07-18',
    ]);
  });

  it('adds one day to a window, not one to each of its days', () => {
    expect(daysCovering(['2026-07-17', '2026-07-18', '2026-07-19'], BRATISLAVA, 'UTC')).toEqual([
      '2026-07-16',
      '2026-07-17',
      '2026-07-18',
      '2026-07-19',
    ]);
  });

  it('is the run’s own days on the run’s own calendar', () => {
    expect(daysCovering(['2026-07-17'], BRATISLAVA, BRATISLAVA)).toEqual(['2026-07-17']);
  });
});

describe('the days a run asks a site for', () => {
  /** Only what the window reads of a site: which calendar it keeps. */
  const keeping = (dayZone: string): SiteConfig<unknown> =>
    ({ site: 'example.com', dayZone }) as SiteConfig<unknown>;

  it('reaches back a day while that day is still the source’s today', () => {
    // Half past midnight in Bratislava, 22:30 on the 16th in UTC.
    const now = new Date('2026-07-16T22:30:00.000Z');

    expect(siteWindow(keeping('utc'), '2026-07-17', 1, BRATISLAVA, now)).toEqual([
      '2026-07-16',
      '2026-07-17',
    ]);
  });

  it('stops once the source’s own midnight has passed', () => {
    const now = new Date('2026-07-17T01:00:00.000Z');

    expect(siteWindow(keeping('utc'), '2026-07-17', 1, BRATISLAVA, now)).toEqual(['2026-07-17']);
  });

  it('keeps every day it covers for a window asked of the past', () => {
    const now = new Date('2026-07-17T01:00:00.000Z');

    expect(siteWindow(keeping('utc'), '2026-07-16', 1, BRATISLAVA, now)).toEqual([
      '2026-07-15',
      '2026-07-16',
    ]);
  });

  it('takes another name for the run’s own zone for the run’s own calendar', () => {
    // So the guide reads its days as a source's own, after-midnight programmes
    // of a day that runs 06:00 to 06:00 included, rather than refiling them.
    expect(siteDayZone(keeping('Etc/UTC'), 'UTC')).toBe('UTC');
    expect(siteDayZone(keeping('utc'), 'Etc/UTC')).toBe('Etc/UTC');
  });

  it('takes a zone on the run’s clock for the run’s calendar, whatever it is called', () => {
    // A link to Prague, which `Intl` still names as itself.
    expect(siteDayZone(keeping(BRATISLAVA), 'Europe/Prague')).toBe('Europe/Prague');
    // Not a link, and on the same rules.
    expect(siteDayZone(keeping('Europe/Vienna'), 'Europe/Prague')).toBe('Europe/Prague');
  });

  it('keeps a zone that agrees with the run’s only for part of the year', () => {
    // Lagos is +0100 all year, Prague only in winter.
    expect(siteDayZone(keeping('Africa/Lagos'), 'Europe/Prague')).toBe('Africa/Lagos');
  });

  it('reads a zone that is not one as the run’s, leaving refusing it to the site', () => {
    expect(siteWindow(keeping('Mars/Olympus'), '2026-07-17', 1, BRATISLAVA)).toEqual([
      '2026-07-17',
    ]);
  });
});
