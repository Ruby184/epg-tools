import { describe, expect, it } from 'vitest';
import { dayIn, localTimeZone, resolveTimeZone, wallTimeIn } from '../src/core/days.js';

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

describe('a zone a run is given', () => {
  it('is taken when it is one', () => {
    expect(resolveTimeZone(BRATISLAVA)).toBe(BRATISLAVA);
  });

  it('is the process’s own when none is given', () => {
    expect(resolveTimeZone(undefined)).toBe(localTimeZone());
  });

  it('is refused naming the setting when it is not one', () => {
    expect(() => resolveTimeZone('Mars/Olympus', 'serve.timezone')).toThrow(
      'serve.timezone must be an IANA time zone such as "Europe/Bratislava" (got "Mars/Olympus")',
    );
  });
});
