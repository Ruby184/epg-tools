import { describe, expect, it } from 'vitest';
import {
  grabEvery,
  resolveInterval,
  type GuideCached,
  type NextGrab,
} from '../src/serve/schedule.js';

/** A local wall-clock time, since that is what an anchored schedule works in. */
function at(day: string, time: string): Date {
  return new Date(`${day}T${time}`);
}

/** A cache with something in it, which is the uninteresting case. */
function holding(present = 100): () => Promise<GuideCached> {
  return async () => ({ present, expected: 100 });
}

/** What a schedule answers, whichever of the forms it answers in. */
async function next(
  schedule: NextGrab,
  from: Date,
  runs = 1,
  cached = holding(),
): Promise<Date | number | undefined> {
  return schedule({ from, runs, cached });
}

/** What a schedule says next, as a local `HH:MM` on whichever day it lands. */
async function nextAt(schedule: NextGrab, from: Date, runs = 1): Promise<string> {
  const answer = await next(schedule, from, runs);
  const when = new Date(typeof answer === 'number' ? answer : (answer as Date));

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

  it('runs at startup, so a fresh deployment does not wait', async () => {
    // `runs` is zero only while starting up, and returning `from` is how a
    // schedule says "now".
    await expect(next(schedule, start, 0)).resolves.toBe(start);
  });

  it('spaces the rest from each finish rather than running again at once', async () => {
    // The bug this shape exists to avoid: `next` is asked again *after* every
    // grab, so answering `from` every time would grab in a loop.
    await expect(next(schedule, start, 1)).resolves.toBe(start.getTime() + 6 * 3_600_000);
    await expect(next(schedule, start, 9)).resolves.toBe(start.getTime() + 6 * 3_600_000);
  });
});

describe('grabEvery anchored to a time of day', () => {
  const nightly = grabEvery('1d', { at: '04:00' });
  const sixHourly = grabEvery('6h', { at: '04:00' });

  /** A sweep that counts the calls, since not asking is half of the contract. */
  function empty(): (() => Promise<GuideCached>) & { calls: number } {
    const cached: (() => Promise<GuideCached>) & { calls: number } = Object.assign(
      async () => {
        cached.calls++;

        return { present: 0, expected: 336 };
      },
      { calls: 0 },
    );

    return cached;
  }

  it('does not run at startup, because a time was named', async () => {
    const start = at('2026-09-10', '15:20');

    expect(await nextAt(nightly, start, 0)).toBe('11 04:00');
  });

  it('runs at startup anyway when there is nothing to serve', async () => {
    const start = at('2026-09-10', '15:20');

    // Thirteen hours of serving nothing is nobody's idea of "nightly at four".
    await expect(next(nightly, start, 0, empty())).resolves.toBe(start);
  });

  it('keeps to the anchor with nothing cached when told to', async () => {
    const start = at('2026-09-10', '15:20');
    const keeping = grabEvery('1d', { at: '04:00', whenEmpty: false });
    const cached = empty();

    expect(await nextAt(keeping, start, 0)).toBe('11 04:00');
    await expect(next(keeping, start, 0, cached)).resolves.toBeTypeOf('number');
    // And it did not pay for a sweep to ignore the answer.
    expect(cached.calls).toBe(0);
  });

  it('asks only where the answer could change anything', async () => {
    const cached = empty();

    // After the first run: an empty cache then is a grab that failed, and how
    // soon to try again is not this schedule's business.
    await next(nightly, at('2026-09-10', '15:20'), 1, cached);
    // And with no anchor at all, startup is already a run.
    await next(grabEvery('6h'), at('2026-09-10', '15:20'), 0, cached);

    expect(cached.calls).toBe(0);
  });

  it('waits for today’s anchor when it is still ahead', async () => {
    expect(await nextAt(nightly, at('2026-09-10', '01:30'))).toBe('10 04:00');
    expect(await nextAt(sixHourly, at('2026-09-10', '01:30'))).toBe('10 04:00');
  });

  it('takes tomorrow’s once today’s has passed', async () => {
    expect(await nextAt(nightly, at('2026-09-10', '04:30'))).toBe('11 04:00');
    expect(await nextAt(nightly, at('2026-09-10', '23:59'))).toBe('11 04:00');
  });

  it('steps through the day for an interval shorter than one', async () => {
    expect(await nextAt(sixHourly, at('2026-09-10', '04:30'))).toBe('10 10:00');
    expect(await nextAt(sixHourly, at('2026-09-10', '10:00'))).toBe('10 16:00');
    expect(await nextAt(sixHourly, at('2026-09-10', '16:01'))).toBe('10 22:00');
    expect(await nextAt(sixHourly, at('2026-09-10', '22:01'))).toBe('11 04:00');
  });

  it('moves on from an anchor it has landed exactly on', async () => {
    // Asked at exactly 04:00, the 04:00 run is the one that just happened.
    expect(await nextAt(sixHourly, at('2026-09-10', '04:00'))).toBe('10 10:00');
  });

  it('handles an interval that does not divide a day', async () => {
    // 7h from 04:00 is 11:00, 18:00, then 01:00 — which belongs to the next
    // day's anchor arithmetic, not this one's.
    const sevenHourly = grabEvery('7h', { at: '04:00' });

    expect(await nextAt(sevenHourly, at('2026-09-10', '05:00'))).toBe('10 11:00');
    expect(await nextAt(sevenHourly, at('2026-09-10', '12:00'))).toBe('10 18:00');
    expect(await nextAt(sevenHourly, at('2026-09-10', '19:00'))).toBe('11 01:00');
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

describe('grabEvery in a time zone', () => {
  const BRATISLAVA = 'Europe/Bratislava';

  /** When a schedule says next, as an instant, asked with what a server knows. */
  async function nextFrom(schedule: NextGrab, from: string, timezone?: string): Promise<string> {
    const answer = await schedule({
      from: new Date(from),
      runs: 1,
      cached: holding(),
      ...(timezone === undefined ? {} : { timezone }),
    });

    return new Date(typeof answer === 'number' ? answer : (answer as Date)).toISOString();
  }

  it('reads its time of day on that zone’s clock', async () => {
    // 22:00 in Bratislava: half past midnight there is 22:30 UTC the same day.
    await expect(
      nextFrom(grabEvery('1d', { at: '00:30', timezone: BRATISLAVA }), '2026-10-15T20:00:00Z'),
    ).resolves.toBe('2026-10-15T22:30:00.000Z');
  });

  it('takes the server’s zone where it was given none of its own', async () => {
    const nightly = grabEvery('1d', { at: '00:30' });

    await expect(nextFrom(nightly, '2026-10-15T20:00:00Z', BRATISLAVA)).resolves.toBe(
      '2026-10-15T22:30:00.000Z',
    );
    // And the process's own with neither — UTC, as the suite runs.
    await expect(nextFrom(nightly, '2026-10-15T20:00:00Z')).resolves.toBe(
      '2026-10-16T00:30:00.000Z',
    );
  });

  it('keeps its own zone over the server’s', async () => {
    await expect(
      nextFrom(
        grabEvery('1d', { at: '00:30', timezone: 'UTC' }),
        '2026-10-15T20:00:00Z',
        BRATISLAVA,
      ),
    ).resolves.toBe('2026-10-16T00:30:00.000Z');
  });

  it('keeps its hour on a night the clocks change', async () => {
    // Half past midnight on the night summer time starts at two: four o'clock
    // is three hours away, not four.
    await expect(
      nextFrom(grabEvery('1d', { at: '04:00', timezone: BRATISLAVA }), '2026-03-28T23:30:00Z'),
    ).resolves.toBe('2026-03-29T02:00:00.000Z');
  });

  it('refuses a zone that is not one, while the config is being read', () => {
    expect(() => grabEvery('1d', { at: '00:30', timezone: 'Mars/Olympus' })).toThrow(
      'grab.timezone must be an IANA time zone',
    );
  });
});
