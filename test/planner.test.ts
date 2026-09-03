import { describe, expect, it } from 'vitest';
import { planRequests, resolveBatching, type Pair, type Request } from '../src/grabber/planner.js';
import type { GrabberChannel } from '../src/grabber/main.js';

const WINDOW = ['2026-08-27', '2026-08-28', '2026-08-29', '2026-08-30'];

function channel(id: string): GrabberChannel {
  return { xmltvId: id, siteId: `site-${id}` };
}

/** The grid, as a plan over every channel-day of it. */
function plan(
  channels: GrabberChannel[],
  batching: Parameters<typeof resolveBatching>[0],
  stale: Pair[] = channels.flatMap((ch) => WINDOW.map((day) => ({ channel: ch, day }))),
  window = WINDOW,
): Request[] {
  return planRequests({ channels, window, stale, batching: resolveBatching(batching) });
}

/** A request as `[channels, days]`, which is what the shape questions are about. */
function shape(requests: Request[]): Array<[string[], string[]]> {
  return requests.map((request) => [request.channels.map((ch) => ch.xmltvId), request.days]);
}

describe('resolveBatching', () => {
  it('pins both axes to one when nothing says otherwise', () => {
    expect(resolveBatching(undefined)).toEqual({
      manyChannels: false,
      manyDays: false,
      maxChannels: 1,
      maxDays: 1,
    });
    expect(resolveBatching('none')).toEqual(resolveBatching(undefined));
  });

  it('opens the axis a mode batches, and only that one', () => {
    expect(resolveBatching('channels')).toEqual({
      manyChannels: true,
      manyDays: false,
      maxChannels: Number.POSITIVE_INFINITY,
      maxDays: 1,
    });
    expect(resolveBatching('days')).toEqual({
      manyChannels: false,
      manyDays: true,
      maxChannels: 1,
      maxDays: Number.POSITIVE_INFINITY,
    });
    expect(resolveBatching('both')).toEqual({
      manyChannels: true,
      manyDays: true,
      maxChannels: Number.POSITIVE_INFINITY,
      maxDays: Number.POSITIVE_INFINITY,
    });
  });

  it('takes a cap only on an axis its mode batches', () => {
    expect(resolveBatching({ mode: 'channels', channelsPerRequest: 3 })).toMatchObject({
      maxChannels: 3,
      maxDays: 1,
    });
    // A cap on the axis this mode does not batch is not a number to be silently
    // ignored — the types refuse it — and the axis stays pinned regardless.
    expect(resolveBatching({ mode: 'channels', daysPerRequest: 7 } as never)).toMatchObject({
      maxChannels: Number.POSITIVE_INFINITY,
      maxDays: 1,
    });
  });

  it('reads a cap of zero as "as many as it takes"', () => {
    expect(
      resolveBatching({ mode: 'both', channelsPerRequest: 0, daysPerRequest: 0 }),
    ).toMatchObject({ maxChannels: Number.POSITIVE_INFINITY, maxDays: Number.POSITIVE_INFINITY });
  });
});

describe('planRequests', () => {
  it('cuts the grid into one channel-day each by default', () => {
    const requests = plan([channel('a'), channel('b')], 'none');

    // A day at a time, every channel of it before the next day: the requests go
    // out in the order the guide is most wanted in, so a run that stops early
    // has whole early days rather than a fortnight of one channel.
    expect(shape(requests)).toEqual([
      [['a'], ['2026-08-27']],
      [['b'], ['2026-08-27']],
      [['a'], ['2026-08-28']],
      [['b'], ['2026-08-28']],
      [['a'], ['2026-08-29']],
      [['b'], ['2026-08-29']],
      [['a'], ['2026-08-30']],
      [['b'], ['2026-08-30']],
    ]);
    expect(requests.every((request) => request.pairs.length === 1)).toBe(true);
  });

  it('orders the channel-days inside a request channel-major, then by day', () => {
    const [request] = plan([channel('a'), channel('b')], 'both');

    // What `channelDays` promises a site, whatever order the requests are in.
    expect(request!.pairs.map((pair) => `${pair.channel.xmltvId} ${pair.day}`)).toEqual([
      'a 2026-08-27',
      'a 2026-08-28',
      'a 2026-08-29',
      'a 2026-08-30',
      'b 2026-08-27',
      'b 2026-08-28',
      'b 2026-08-29',
      'b 2026-08-30',
    ]);
  });

  it('puts a day of channels in one request under `channels`', () => {
    expect(shape(plan([channel('a'), channel('b'), channel('c')], 'channels'))).toEqual([
      [['a', 'b', 'c'], ['2026-08-27']],
      [['a', 'b', 'c'], ['2026-08-28']],
      [['a', 'b', 'c'], ['2026-08-29']],
      [['a', 'b', 'c'], ['2026-08-30']],
    ]);
  });

  it('puts a channel of days in one request under `days`', () => {
    expect(shape(plan([channel('a'), channel('b')], 'days'))).toEqual([
      [['a'], WINDOW],
      [['b'], WINDOW],
    ]);
  });

  it('takes both caps under `both`, and asks for the rectangle', () => {
    const requests = plan([channel('a'), channel('b'), channel('c')], {
      mode: 'both',
      channelsPerRequest: 2,
      daysPerRequest: 3,
    });

    expect(shape(requests)).toEqual([
      [
        ['a', 'b'],
        ['2026-08-27', '2026-08-28', '2026-08-29'],
      ],
      [['c'], ['2026-08-27', '2026-08-28', '2026-08-29']],
      [['a', 'b'], ['2026-08-30']],
      [['c'], ['2026-08-30']],
    ]);
    // Six channel-days in the first rectangle, and it says so.
    expect(requests[0]!.pairs).toHaveLength(6);
  });

  it('leaves out a channel with nothing stale on any day of the group', () => {
    const channels = [channel('a'), channel('b'), channel('c')];
    const stale = WINDOW.map((day) => ({ channel: channels[1]!, day }));

    // Only `b` is stale, so `a` and `c` are not what a request is made for —
    // even though the mode would happily have covered them.
    expect(shape(plan(channels, 'channels', stale))).toEqual([
      [['b'], ['2026-08-27']],
      [['b'], ['2026-08-28']],
      [['b'], ['2026-08-29']],
      [['b'], ['2026-08-30']],
    ]);
  });

  it('trims the days of a request to the stale ones, gaps and all', () => {
    const a = channel('a');
    const stale = [
      { channel: a, day: '2026-08-27' },
      { channel: a, day: '2026-08-30' },
    ];
    const [request] = plan([a], 'days', stale);

    // A `days` request's days can have holes in it: what is fresh is not asked
    // for, though `from`/`to` still span the gap.
    expect(request!.days).toEqual(['2026-08-27', '2026-08-30']);
    expect(request!.pairs.map((pair) => pair.day)).toEqual(['2026-08-27', '2026-08-30']);
  });

  it('cuts day groups from the window, not from the stale days', () => {
    const a = channel('a');
    const stale = [
      { channel: a, day: '2026-08-28' },
      { channel: a, day: '2026-08-29' },
    ];

    // Grouped in twos from the start of the window — so the two stale days fall
    // in different requests, and which days share one does not shift with what
    // happens to be cached.
    expect(shape(plan([a], { mode: 'days', daysPerRequest: 2 }, stale))).toEqual([
      [['a'], ['2026-08-28']],
      [['a'], ['2026-08-29']],
    ]);
  });

  it('keeps a request covering a channel-day that was already fresh', () => {
    const channels = [channel('a'), channel('b')];
    const stale = [
      { channel: channels[0]!, day: '2026-08-27' },
      { channel: channels[1]!, day: '2026-08-28' },
    ];
    const [request] = plan(channels, 'both', stale, ['2026-08-27', '2026-08-28']);

    // The rectangle is what the request covers; `pairs` is what it is *for*, and
    // under `both` the two differ — a fresh channel-day inside it is neither
    // parsed nor rewritten.
    expect(shape([request!])).toEqual([
      [
        ['a', 'b'],
        ['2026-08-27', '2026-08-28'],
      ],
    ]);
    expect(request!.pairs.map((pair) => `${pair.channel.xmltvId} ${pair.day}`)).toEqual([
      'a 2026-08-27',
      'b 2026-08-28',
    ]);
  });

  it('follows the order the site declared its channels in', () => {
    const channels = [channel('z'), channel('m'), channel('a')];

    expect(shape(plan(channels, 'channels'))[0]![0]).toEqual(['z', 'm', 'a']);
  });

  it('hands out a copy of the channels, so a site may sort what it is given', () => {
    const channels = [channel('a'), channel('b')];
    const [request] = plan(channels, 'channels');

    request!.channels.reverse();

    expect(channels.map((ch) => ch.xmltvId)).toEqual(['a', 'b']);
  });

  it('plans nothing when nothing is stale', () => {
    expect(plan([channel('a')], 'both', [])).toEqual([]);
    expect(plan([], 'both')).toEqual([]);
  });
});
