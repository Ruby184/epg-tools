import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addedTime,
  measuredOf,
  SiteClock,
  timeSpent,
  type TimeSink,
} from '../src/grabber/clock.js';
import type { MeasuredTime } from '../src/core/events.js';

/** A clock read off `now`, which the test moves on by hand — telling `sink`, where there is one. */
function clocked(sink?: TimeSink): { clock: SiteClock; at(ms: number): void } {
  let now = 0;

  vi.spyOn(performance, 'now').mockImplementation(() => now);

  return {
    clock: new SiteClock(sink),
    at: (ms) => {
      now = ms;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SiteClock', () => {
  it('gives each moment to the first part that holds, and no moment twice', () => {
    const { clock, at } = clocked();

    clock.turn(true);
    clock.queued(); // 0–10 queued
    at(10);
    clock.queued();
    clock.started(); // 10–30 working, though one still waits for a slot
    at(30);
    clock.ask();
    clock.sent(); // 30–35 out to the source
    at(35);
    clock.ask(); // one more waiting behind it
    clock.held(true); // 35–50 held: what is out is held up with it
    at(40);
    clock.answered(); // held still, with one waiting behind it
    at(45);
    clock.rateLimited(true); // held still
    at(50);
    clock.held(false); // 50–60 its own rate limit
    at(60);
    clock.rateLimited(false); // 60–70 working again
    at(70);
    clock.finished(); // 70–75 queued again
    at(75);
    clock.started(); // 75–77 working
    at(77);
    clock.finished(); // 77–80 none of them
    at(80);

    expect(clock.spent()).toEqual({ source: 5, held: 15, rateLimit: 10, working: 32, queued: 15 });
  });

  it('gives a hold the request out under it, as ky retrying a 429 holds one', () => {
    const { clock, at } = clocked();

    clock.turn(true);
    clock.ask();
    clock.sent();
    at(5);
    // Answered 429: held, and the same request out again once it is let go.
    clock.held(true);
    at(65);
    clock.held(false);
    at(70);
    clock.answered();

    expect(clock.spent()).toEqual({ source: 10, held: 60, rateLimit: 0, working: 0, queued: 0 });
  });

  it('gives a hold, or its rate limit, only what a request waits behind it', () => {
    const { clock, at } = clocked();

    clock.turn(true);
    clock.queued();
    clock.started();
    // Held with nothing waiting: its own work goes on, and is what it does.
    clock.held(true);
    clock.rateLimited(true);
    at(10);
    clock.ask(); // 10–15 held, a request waiting
    at(15);
    clock.held(false); // 15–20 its rate limit
    at(20);
    clock.sent(); // 20–25 out
    at(25);
    clock.answered(); // 25–30 working: the limit holds nothing up
    at(30);

    expect(clock.spent()).toEqual({ source: 5, held: 5, rateLimit: 5, working: 15, queued: 0 });
  });

  it('counts only its turn, and a request asked for outside one', () => {
    const { clock, at } = clocked();

    // Before its turn, and nothing asked: off the clock.
    at(10);
    // Its list, settled before the grab.
    expect(clock.ask()).toBe(true);
    clock.sent();
    at(30);
    clock.answered();
    clock.settled();
    // A hold that outlived the list, waiting for the turn: not counted.
    clock.held(true);
    at(50);
    clock.turn(true);
    // In its turn, a request puts nothing more on the clock — and waits behind
    // the hold.
    expect(clock.ask()).toBe(false);
    at(60);
    clock.held(false);
    clock.turn(false);
    at(90);

    expect(clock.spent()).toEqual({ source: 20, held: 10, rateLimit: 0, working: 0, queued: 0 });
  });

  it('reads the clock only when what holds changes', () => {
    const { clock } = clocked();
    const reads = vi.mocked(performance.now);

    clock.turn(true);
    clock.ask();
    clock.sent();
    // A parse beginning and ending while a request is out changes nothing.
    clock.queued();
    clock.started();
    clock.finished();
    clock.ask();
    clock.sent();
    clock.answered();
    expect(reads).toHaveBeenCalledTimes(1);

    clock.answered();
    expect(reads).toHaveBeenCalledTimes(2);
  });

  it('gives a wait on the run’s thread to queued, out of what its work alone was given', () => {
    const told: Array<[MeasuredTime, number]> = [];
    const { clock, at } = clocked((part, ms) => told.push([part, ms]));

    clock.turn(true);
    clock.queued();
    clock.started();
    at(10);
    // A cache call, of which 6 of its 8 milliseconds waited for a slot there.
    const call = clock.elsewhere();

    at(18);
    clock.back(call, 6);
    expect(clock.spent()).toEqual({ source: 0, held: 0, rateLimit: 0, working: 12, queued: 6 });

    // Never more than that work alone was given: here, a request was out.
    const again = clock.elsewhere();

    clock.ask();
    clock.sent();
    at(30);
    clock.answered();
    clock.back(again, 12);
    expect(clock.spent()).toEqual({ source: 12, held: 0, rateLimit: 0, working: 12, queued: 6 });
    expect(told).toEqual([
      ['working', 10],
      ['working', 8],
      ['working', -6],
      ['queued', 6],
      ['source', 12],
    ]);
  });

  it('leaves a moment the site’s other work was under way to that work', () => {
    const { clock, at } = clocked();

    clock.turn(true);
    clock.queued();
    clock.queued();
    clock.started();
    clock.started();
    // One parse's write waits on the run's thread while the other parses.
    const call = clock.elsewhere();

    at(20);
    clock.finished();
    // The other done: from here, only the wait.
    at(25);
    clock.back(call, 25);

    expect(clock.spent()).toEqual({ source: 0, held: 0, rateLimit: 0, working: 20, queued: 5 });
  });

  it('gives a call’s wait to queued, whenever the site’s other work was under way', () => {
    const { clock, at } = clocked();

    clock.turn(true);
    clock.queued();
    clock.started();
    // The call waits 6 for a slot there with nothing else of the site's under
    // way, and runs 4 there while another parse does here.
    const call = clock.elsewhere();

    at(6);
    clock.queued();
    clock.started();
    at(10);
    clock.back(call, 6);

    expect(clock.spent()).toEqual({ source: 0, held: 0, rateLimit: 0, working: 4, queued: 6 });
  });

  it('takes a call back twice as back once, leaving the others out', () => {
    const { clock, at } = clocked();

    clock.turn(true);
    clock.queued();
    clock.started();
    const call = clock.elsewhere();

    at(2);
    const other = clock.elsewhere();

    at(10);
    clock.back(call, 10);
    clock.back(call, 10);
    // Still waiting there, and all the site is doing: one wait, 0–20.
    at(20);
    clock.back(other, 18);

    expect(clock.spent()).toEqual({ source: 0, held: 0, rateLimit: 0, working: 0, queued: 20 });
  });

  it('gives a pass reading its document to the source, where nothing else holds', () => {
    const { clock, at } = clocked();

    clock.turn(true);
    clock.reading(true); // 0–10 the document arriving
    at(10);
    clock.queued();
    clock.started(); // 10–15 a write under way
    at(15);
    clock.finished();
    clock.queued(); // 15–20 a write waiting for a slot, the pass held back behind it
    at(20);
    clock.started();
    clock.finished(); // 20–30 reading again
    at(30);
    clock.reading(false); // 30–40 done: none of them
    at(40);

    expect(clock.spent()).toEqual({ source: 20, held: 0, rateLimit: 0, working: 5, queued: 5 });
  });

  it('settles a call’s wait once no call still out ran in it', () => {
    const { clock, at } = clocked();

    clock.turn(true);
    clock.queued();
    clock.queued();
    clock.started();
    clock.started();

    // A goes at 0, waits 8 for a slot there and runs 2; B's parse goes on here
    // until it goes at 2, waits 2 and runs 8. Back first, A cannot yet say
    // which of its wait was B's run.
    const a = clock.elsewhere();

    at(2);
    const b = clock.elsewhere();

    at(10);
    clock.back(a, 8);
    clock.finished();
    expect(clock.spent().queued).toBe(0);

    at(12);
    clock.back(b, 2);
    clock.finished();

    // 0–2 B's parse, 2–4 both waiting, 4–12 B running and A's 8–10 with it.
    expect(clock.spent()).toEqual({ source: 0, held: 0, rateLimit: 0, working: 10, queued: 2 });
  });

  it('takes no call’s wait out of another’s work there, two being there at once', () => {
    const { clock, at } = clocked();

    clock.turn(true);
    clock.queued();
    clock.queued();
    clock.started();
    clock.started();

    // Both go to the run's thread at once: A waits 10 for a slot and runs 2;
    // B waits 40 and runs 5.
    const a = clock.elsewhere();
    const b = clock.elsewhere();

    at(12);
    clock.back(a, 10);
    clock.finished();
    at(45);
    clock.back(b, 40);
    clock.finished();

    // 0–10 both waiting, 10–12 A running, 12–40 B waiting, 40–45 B running.
    expect(clock.spent()).toEqual({ source: 0, held: 0, rateLimit: 0, working: 7, queued: 38 });
  });

  it('lets go of what a cancel dropped, and of anything asked after it', () => {
    const { clock, at } = clocked();

    clock.turn(true);
    clock.queued();
    clock.ask();
    clock.held(true);
    at(10);
    clock.cancelled();
    // Asked once cancelled, and dropped at once: nothing waits — not behind a
    // hold a response still in flight then brings.
    clock.queued();
    clock.ask();
    clock.held(true);
    at(30);

    expect(clock.spent()).toEqual({ source: 0, held: 10, rateLimit: 0, working: 0, queued: 0 });
  });

  it('tells its sink of each stretch as it is given', () => {
    const told: Array<[MeasuredTime, number]> = [];
    const { clock, at } = clocked((part, ms) => told.push([part, ms]));

    clock.turn(true);
    clock.ask();
    clock.sent();
    at(5);
    clock.answered();
    clock.queued();
    clock.started();
    at(12);
    clock.finished();

    expect(told).toEqual([
      ['source', 5],
      ['working', 7],
    ]);
  });
});

describe('timeSpent', () => {
  it('rounds each part, and leaves the rest of ms as other', () => {
    expect(
      timeSpent(100, { source: 10.4, held: 0, rateLimit: 0, working: 20.6, queued: 0.2 }),
    ).toEqual({
      ms: 100,
      msBy: { source: 10, held: 0, rateLimit: 0, working: 21, queued: 0, other: 69 },
    });
  });

  it('takes ms up to what was measured, where that came to more', () => {
    expect(
      timeSpent(29.6, { source: 20.6, held: 0, rateLimit: 0, working: 10, queued: 0 }),
    ).toEqual({
      ms: 31,
      msBy: { source: 21, held: 0, rateLimit: 0, working: 10, queued: 0, other: 0 },
    });
  });

  it('adds two measures part by part', () => {
    expect(
      addedTime(
        { source: 1, held: 2, rateLimit: 3, working: 4, queued: 5 },
        { source: 10, held: 20, rateLimit: 30, working: 40, queued: 50 },
      ),
    ).toEqual({ source: 11, held: 22, rateLimit: 33, working: 44, queued: 55 });
  });

  it('is what two of them are added from, without other', () => {
    expect(
      measuredOf({ source: 1, held: 2, rateLimit: 3, working: 4, queued: 5, other: 6 }),
    ).toEqual({ source: 1, held: 2, rateLimit: 3, working: 4, queued: 5 });
  });
});
