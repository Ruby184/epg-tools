import { describe, expect, it } from 'vitest';
import { grabEvery, resolveInterval, type NextGrab } from '../src/serve/schedule.js';

/** A local wall-clock time, since that is what an anchored schedule works in. */
function at(day: string, time: string): Date {
  return new Date(`${day}T${time}`);
}

/** What a schedule says next, as a local `HH:MM` on whichever day it lands. */
function nextAt(schedule: NextGrab, from: Date, runs = 1): string {
  const next = schedule(from, runs);
  const when = new Date(typeof next === 'number' ? next : (next as Date));

  return `${when.getDate()} ${String(when.getHours()).padStart(2, '0')}:${String(
    when.getMinutes(),
  ).padStart(2, '0')}`;
}

describe('resolveInterval', () => {
  it('reads a duration with a unit', () => {
    expect(resolveInterval('6h', 'x')).toBe(6 * 3_600_000);
    expect(resolveInterval('30m', 'x')).toBe(30 * 60_000);
    expect(resolveInterval('1d', 'x')).toBe(86_400_000);
    expect(resolveInterval('90s', 'x')).toBe(90_000);
    expect(resolveInterval('500ms', 'x')).toBe(500);
    // Fractions are allowed, since half an hour is a reasonable thing to want.
    expect(resolveInterval('0.5h', 'x')).toBe(1_800_000);
  });

  it('reads a bare number as milliseconds, from either door', () => {
    expect(resolveInterval(60_000, 'x')).toBe(60_000);
    expect(resolveInterval('60000', 'x')).toBe(60_000);
    expect(resolveInterval(' 6h ', 'x')).toBe(6 * 3_600_000);
  });

  it('refuses what is not a duration, naming the option', () => {
    for (const bad of ['', 'soon', '6hours', '-1h', '0', '0s', 'h', '6 h', Number.NaN]) {
      expect(() => resolveInterval(bad as string, 'grab.every'), String(bad)).toThrow(
        /Invalid grab\.every value/,
      );
    }
  });
});

describe('grabEvery with no anchor', () => {
  const schedule = grabEvery('6h');
  const start = at('2026-09-10', '15:20');

  it('runs at startup, so a fresh deployment does not wait', () => {
    // `runs` is zero only while starting up, and returning `from` is how a
    // schedule says "now".
    expect(schedule(start, 0)).toBe(start);
  });

  it('spaces the rest from each finish rather than running again at once', () => {
    // The bug this shape exists to avoid: `next` is asked again *after* every
    // grab, so answering `from` every time would grab in a loop.
    expect(schedule(start, 1)).toBe(start.getTime() + 6 * 3_600_000);
    expect(schedule(start, 9)).toBe(start.getTime() + 6 * 3_600_000);
  });
});

describe('grabEvery anchored to a time of day', () => {
  const nightly = grabEvery('1d', { at: '04:00' });
  const sixHourly = grabEvery('6h', { at: '04:00' });

  it('does not run at startup, because a time was named', () => {
    const start = at('2026-09-10', '15:20');

    expect(nextAt(nightly, start, 0)).toBe('11 04:00');
  });

  it('waits for today’s anchor when it is still ahead', () => {
    expect(nextAt(nightly, at('2026-09-10', '01:30'))).toBe('10 04:00');
    expect(nextAt(sixHourly, at('2026-09-10', '01:30'))).toBe('10 04:00');
  });

  it('takes tomorrow’s once today’s has passed', () => {
    expect(nextAt(nightly, at('2026-09-10', '04:30'))).toBe('11 04:00');
    expect(nextAt(nightly, at('2026-09-10', '23:59'))).toBe('11 04:00');
  });

  it('steps through the day for an interval shorter than one', () => {
    expect(nextAt(sixHourly, at('2026-09-10', '04:30'))).toBe('10 10:00');
    expect(nextAt(sixHourly, at('2026-09-10', '10:00'))).toBe('10 16:00');
    expect(nextAt(sixHourly, at('2026-09-10', '16:01'))).toBe('10 22:00');
    expect(nextAt(sixHourly, at('2026-09-10', '22:01'))).toBe('11 04:00');
  });

  it('moves on from an anchor it has landed exactly on', () => {
    // Asked at exactly 04:00, the 04:00 run is the one that just happened.
    expect(nextAt(sixHourly, at('2026-09-10', '04:00'))).toBe('10 10:00');
  });

  it('handles an interval that does not divide a day', () => {
    // 7h from 04:00 is 11:00, 18:00, then 01:00 — which belongs to the next
    // day's anchor arithmetic, not this one's.
    const sevenHourly = grabEvery('7h', { at: '04:00' });

    expect(nextAt(sevenHourly, at('2026-09-10', '05:00'))).toBe('10 11:00');
    expect(nextAt(sevenHourly, at('2026-09-10', '12:00'))).toBe('10 18:00');
    expect(nextAt(sevenHourly, at('2026-09-10', '19:00'))).toBe('11 01:00');
  });

  it('refuses a time of day that is not one', () => {
    for (const bad of ['4', '4pm', '24:00', '04:60', '04-00', '', 'now']) {
      expect(() => grabEvery('1d', { at: bad }), bad).toThrow(/Invalid grab\.at value/);
    }
  });

  it('refuses a bad interval where it was written, not on the first tick', () => {
    expect(() => grabEvery('often')).toThrow(/Invalid grab\.every value/);
  });
});
