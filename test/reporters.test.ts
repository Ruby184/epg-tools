import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  atLevel,
  EVENT_KINDS,
  jsonReporter,
  LEVELS,
  progressReporter,
  render,
  renderFailure,
  reporterFor,
  REPORTER_NAMES,
  textReporter,
} from '../src/main.js';
import type { EpgEvent, EpgEventInput, EventKind, EventLevel, Reporter } from '../src/main.js';
import { silent, stamped } from '../src/core/events.js';
import { emitter } from '../src/core/reporters.js';

/** Collects lines, so what a reporter wrote can be read back. */
class Sink extends Writable {
  readonly lines: string[] = [];
  protected readonly chunks: string[] = [];

  override _write(chunk: Buffer | string, _encoding: string, done: () => void): void {
    this.chunks.push(String(chunk));
    this.lines.push(...String(chunk).split('\n').filter(Boolean));
    done();
  }

  get text(): string {
    return this.lines.join('\n');
  }
}

/**
 * One event as a reporter is given it, stamped the way the run stamps it.
 *
 * Generic so the member survives: `renderFailure` takes only the three that are
 * failures, and a helper answering plain `EpgEvent` would hide which one this is.
 */
function event<T extends EpgEventInput>(input: T): T & EventKind {
  let stampedEvent: EpgEvent | undefined;

  stamped((given) => {
    stampedEvent = given;
  })(input);

  return stampedEvent as T & EventKind;
}

describe('the event union', () => {
  it('stamps every type with a level and a phase', () => {
    // Which is the whole reason an emitter says only what happened: there is
    // one place that decides how loudly, and this is it.
    for (const [type, kind] of Object.entries(EVENT_KINDS)) {
      expect(LEVELS).toContain(kind.level);
      expect(['run', 'grab', 'merge', 'prune']).toContain(kind.phase);
      expect(type).toMatch(/^[a-z]+:[a-zA-Z]+$/);
    }
  });

  it('keeps the fields the emitter gave it', () => {
    expect(
      event({ type: 'entry:fetched', site: 's', channelId: 'c', day: 'd', programmes: 3 }),
    ).toEqual({
      type: 'entry:fetched',
      site: 's',
      channelId: 'c',
      day: 'd',
      programmes: 3,
      level: 'debug',
      phase: 'grab',
    });
  });

  it('orders levels so a threshold includes everything above it', () => {
    expect(atLevel('error', 'error')).toBe(true);
    expect(atLevel('debug', 'error')).toBe(false);
    expect(atLevel('warn', 'info')).toBe(true);
    expect(atLevel('debug', 'debug')).toBe(true);
  });
});

describe('render', () => {
  it.each<[EpgEventInput, string]>([
    [
      { type: 'entry:cached', site: 'a.tv', channelId: 'one', day: '2026-09-01' },
      '[a.tv] one 2026-09-01: fresh in cache, skipping',
    ],
    [
      { type: 'entry:fetched', site: 'a.tv', channelId: 'one', day: '2026-09-01', programmes: 12 },
      '[a.tv] one 2026-09-01: 12 programmes',
    ],
    [
      { type: 'entry:fetched', site: 'a.tv', channelId: 'one', day: '2026-09-01', programmes: 1 },
      '[a.tv] one 2026-09-01: 1 programme',
    ],
    [
      {
        type: 'entry:appended',
        site: 'a.tv',
        channelId: 'one',
        day: '2026-09-01',
        added: 2,
        total: 9,
      },
      '[a.tv] one 2026-09-01: 2 more programmes, 9 in all',
    ],
    [
      { type: 'pacing:held', site: 'a.tv', status: 429, ms: 60 },
      '[a.tv] HTTP 429: holding requests for 60ms',
    ],
    [
      { type: 'request:started', site: 'a.tv', channels: ['one'], days: ['2026-09-01'] },
      '[a.tv] one 2026-09-01: asking',
    ],
    [
      { type: 'request:done', site: 'a.tv', channels: ['one'], days: ['2026-09-01'], ms: 412 },
      '[a.tv] one 2026-09-01: answered in 412ms',
    ],
    [
      { type: 'pacing:rateLimit', site: 'a.tv', waiting: true },
      '[a.tv] rate limit reached, waiting for the window',
    ],
    [
      { type: 'stream:gaps', site: 'a.tv', count: 3 },
      '[a.tv] 3 channel-day(s) not in the document: caching them empty',
    ],
    [
      { type: 'site:started', site: 'a.tv', channels: 50, days: 7, entries: 300, requests: 350 },
      '[a.tv] 50 channel(s) × 7 day(s): 300 to fetch in 350 request(s)',
    ],
    [
      { type: 'grab:done', fetched: 1, empty: 0, fromCache: 0, unchanged: 0, failed: 0 },
      'Grab done: 1 fetched, 0 from cache, 0 failed',
    ],
    [
      { type: 'grab:done', fetched: 1, empty: 1, fromCache: 0, unchanged: 2, failed: 3 },
      'Grab done: 1 fetched (1 empty), 0 from cache, 2 unchanged, 3 failed',
    ],
    [
      { type: 'prune:done', removed: 1, before: '2026-09-01' },
      'Pruned 1 cached entry before 2026-09-01',
    ],
    [
      { type: 'prune:done', removed: 4, before: '2026-09-01' },
      'Pruned 4 cached entries before 2026-09-01',
    ],
    [{ type: 'run:cancelled' }, 'Cancelled.'],
    [
      { type: 'run:cancelled', fetched: 7 },
      'Cancelled. 7 channel-day(s) reached the cache; no guide was written.',
    ],
  ])('renders %o', (input, line) => {
    expect(render(event(input))).toBe(line);
  });

  it('leaves the site out when told to, for a grabber that only has one', () => {
    const cached = event({
      type: 'entry:cached',
      site: 'a.tv',
      channelId: 'one',
      day: '2026-09-01',
    });

    expect(render(cached, false)).toBe('one 2026-09-01: fresh in cache, skipping');
  });

  it('has no line for a failure, which is a policy rather than a line', () => {
    expect(
      render(event({ type: 'site:failed', site: 'a.tv', error: new Error('nope') })),
    ).toBeUndefined();
  });

  it('names a request by the span it covered', () => {
    const one = event({
      type: 'request:failed',
      site: 'a.tv',
      channels: ['one'],
      days: ['2026-09-01'],
      entries: 1,
      error: new Error('gone'),
    });
    const many = event({
      type: 'request:failed',
      site: 'a.tv',
      channels: ['a', 'b', 'c'],
      days: ['2026-09-01', '2026-09-02'],
      entries: 6,
      error: new Error('gone'),
    });

    expect(renderFailure(one)).toBe('FAILED [a.tv] one 2026-09-01: gone');
    expect(renderFailure(many)).toBe(
      'FAILED [a.tv] 3 channels 2026-09-01..2026-09-02 (2 days) (6 channel-day(s)): gone',
    );
  });

  it('reads the cause chain when asked, and only then', () => {
    const failed = event({
      type: 'entry:failed',
      site: 'a.tv',
      channelId: 'one',
      day: '2026-09-01',
      error: new Error('unchanged, but nothing is cached', { cause: new Error('304') }),
    });

    // `errorMessage` reads `.message` and nothing else, so the chain a grab
    // builds was unreachable before this.
    expect(renderFailure(failed)).toBe(
      'FAILED [a.tv] one 2026-09-01: unchanged, but nothing is cached',
    );
    expect(renderFailure(failed, true, true)).toBe(
      'FAILED [a.tv] one 2026-09-01: unchanged, but nothing is cached: 304',
    );
  });

  it('says what a stray throw was, rather than becoming one itself', () => {
    expect(renderFailure(event({ type: 'site:failed', site: 'a.tv', error: 'nope' }))).toBe(
      'FAILED [a.tv] site failed: nope',
    );
  });
});

describe('textReporter', () => {
  const failure: EpgEventInput = {
    type: 'entry:failed',
    site: 'a.tv',
    channelId: 'one',
    day: '2026-09-01',
    error: new Error('the feed went away'),
  };

  function run(reporter: Reporter, events: EpgEventInput[]): void {
    for (const input of events) {
      reporter(event(input));
    }
  }

  it('writes progress at the level asked for and nothing below it', () => {
    const out = new Sink();

    run(textReporter({ stream: out, level: 'info' }), [
      { type: 'entry:cached', site: 'a.tv', channelId: 'one', day: '2026-09-01' },
      { type: 'site:started', site: 'a.tv', channels: 1, days: 1, entries: 1, requests: 1 },
    ]);

    expect(out.lines).toEqual(['[a.tv] 1 channel(s) × 1 day(s): 1 to fetch in 1 request(s)']);
  });

  it('shows the per-channel-day chatter at debug', () => {
    const out = new Sink();

    run(textReporter({ stream: out, level: 'debug' }), [
      { type: 'entry:cached', site: 'a.tv', channelId: 'one', day: '2026-09-01' },
    ]);

    expect(out.lines).toEqual(['[a.tv] one 2026-09-01: fresh in cache, skipping']);
  });

  it('puts a warning on the error stream, so --quiet keeps it', () => {
    const out = new Sink();
    const err = new Sink();

    run(textReporter({ stream: out, errorStream: err, level: 'warn' }), [
      { type: 'site:warning', site: 'a.tv', message: 'the source moved a channel' },
      { type: 'site:note', site: 'a.tv', message: 'progress, which warn does not include' },
    ]);

    expect(out.lines).toEqual([]);
    expect(err.lines).toEqual(['[a.tv] the source moved a channel']);
  });

  it('holds failures back and writes one block when the run finishes', () => {
    const out = new Sink();
    const err = new Sink();

    run(textReporter({ stream: out, errorStream: err, level: 'info' }), [
      failure,
      { type: 'grab:done', fetched: 0, empty: 0, fromCache: 0, unchanged: 0, failed: 1 },
    ]);

    // The summary first, then the block under it as the detail of "1 failed".
    expect(err.lines).toEqual(['  FAILED [a.tv] one 2026-09-01: the feed went away']);
    expect(out.lines).toEqual(['Grab done: 0 fetched, 0 from cache, 1 failed']);
  });

  it('flushes the block even when the level would not print the summary', () => {
    // Which is what `--quiet` is: errors only, and it must still end with them.
    const err = new Sink();

    run(textReporter({ stream: new Sink(), errorStream: err, level: 'error' }), [
      failure,
      { type: 'grab:done', fetched: 0, empty: 0, fromCache: 0, unchanged: 0, failed: 1 },
    ]);

    expect(err.lines).toEqual(['  FAILED [a.tv] one 2026-09-01: the feed went away']);
  });

  it('reads the cause chain at debug, since that is where detail is wanted', () => {
    const err = new Sink();

    run(
      textReporter({ stream: new Sink(), errorStream: err, level: 'debug', failures: 'inline' }),
      [
        {
          type: 'entry:failed',
          site: 'a.tv',
          channelId: 'one',
          day: '2026-09-01',
          error: new Error('kept nothing', { cause: new Error('304') }),
        },
      ],
    );

    expect(err.lines).toEqual(['FAILED [a.tv] one 2026-09-01: kept nothing: 304']);
  });

  it('caps the block and says how many more there were', () => {
    const err = new Sink();
    const reporter = textReporter({ stream: new Sink(), errorStream: err, failureCap: 2 });

    run(reporter, [
      ...Array.from({ length: 5 }, (_, index) => ({
        ...failure,
        day: `2026-09-0${index + 1}`,
      })),
      { type: 'grab:done', fetched: 0, empty: 0, fromCache: 0, unchanged: 0, failed: 5 },
    ]);

    expect(err.lines).toEqual([
      '  FAILED [a.tv] one 2026-09-01: the feed went away',
      '  FAILED [a.tv] one 2026-09-02: the feed went away',
      '  … 2 shown, 3 more',
    ]);
  });

  it('writes each failure where it happened when asked to, and holds nothing', () => {
    const err = new Sink();

    run(textReporter({ stream: new Sink(), errorStream: err, failures: 'inline' }), [
      failure,
      { type: 'grab:done', fetched: 0, empty: 0, fromCache: 0, unchanged: 0, failed: 1 },
    ]);

    // Unindented, and not repeated by the flush the summary triggers.
    expect(err.lines).toEqual(['FAILED [a.tv] one 2026-09-01: the feed went away']);
  });

  it('drops the block on a cancel, rather than blaming the source for it', () => {
    // What a cancelled run failed at is mostly the requests the cancel itself
    // took away, and a screen of those under "Cancelled." would read as a
    // broken source.
    const err = new Sink();

    run(textReporter({ stream: new Sink(), errorStream: err, level: 'error' }), [
      failure,
      { type: 'run:cancelled', fetched: 2 },
    ]);

    expect(err.lines).toEqual([
      'Cancelled. 2 channel-day(s) reached the cache; no guide was written.',
    ]);
  });
});

describe('progressReporter', () => {
  /** A sink that says it is a terminal, since that is what decides. */
  class Tty extends Sink {
    readonly isTTY = true;
    readonly columns = 200;

    /** Everything written, control codes and all, as one string. */
    get raw(): string {
      return this.chunks.join('');
    }
  }

  function run(reporter: Reporter, events: EpgEventInput[]): void {
    for (const input of events) {
      reporter(event(input));
    }
  }

  const started: EpgEventInput = {
    type: 'site:started',
    site: 'a.tv',
    channels: 2,
    days: 3,
    entries: 6,
    requests: 6,
  };

  it('draws one line and rewrites it, rather than adding to a list', () => {
    const out = new Tty();

    run(progressReporter({ stream: out, failureCap: 0 }), [
      started,
      { type: 'request:done', site: 'a.tv', channels: ['one'], days: ['2026-09-01'], ms: 3 },
      { type: 'entry:fetched', site: 'a.tv', channelId: 'one', day: '2026-09-01', programmes: 4 },
    ]);

    // The totals come from `site:started`, which the planner has already
    // resolved — a denominator that is real.
    expect(out.raw).toContain('a.tv · 1/6 channel-days');
    expect(out.raw).toContain('\r\u001b[K');
  });

  it('erases the line to write what is worth keeping, then draws it again', () => {
    const out = new Tty();
    const err = new Sink();

    run(progressReporter({ stream: out, errorStream: err, failures: 'inline' }), [
      started,
      { type: 'site:warning', site: 'a.tv', message: 'the source moved a channel' },
    ]);

    expect(err.lines).toEqual(['[a.tv] the source moved a channel']);
    // Erased before the warning and drawn again after it, so the warning is not
    // written into a line that is about to be overwritten.
    expect(out.raw).toBe(`a.tv · 0/6 channel-days\r\u001b[Ka.tv · 0/6 channel-days`);
  });

  it('takes the line away when the run is over, and lets the summary stand', () => {
    const out = new Tty();

    run(progressReporter({ stream: out }), [
      started,
      { type: 'grab:done', fetched: 6, empty: 0, fromCache: 0, unchanged: 0, failed: 0 },
    ]);

    expect(out.lines.at(-1)).toBe('Grab done: 6 fetched, 0 from cache, 0 failed');
    expect(out.raw.endsWith('Grab done: 6 fetched, 0 from cache, 0 failed\n')).toBe(true);
  });

  it('writes nothing when the line would say what it already says', () => {
    const out = new Tty();

    run(progressReporter({ stream: out }), [
      started,
      // Neither of these moves a number the line shows.
      { type: 'request:started', site: 'a.tv', channels: ['one'], days: ['2026-09-01'] },
      { type: 'stream:ignored', site: 'a.tv', count: 2 },
    ]);

    expect(out.raw).toBe('a.tv · 0/6 channel-days');
  });

  it('leaves nothing on screen when a half of the run ends', () => {
    const out = new Tty();

    run(progressReporter({ stream: out }), [
      started,
      { type: 'grab:done', fetched: 6, empty: 0, fromCache: 0, unchanged: 0, failed: 0 },
      // The merge draws a line of its own, and takes it away again.
      { type: 'merge:channel', channelId: 'one' },
      { type: 'merge:done', output: 'guide.xml' },
    ]);

    expect(out.raw.endsWith('Guide written to guide.xml\n')).toBe(true);
    expect(out.raw).toContain('merging · 1 channel');
  });

  it('counts every channel-day a failed request took down', () => {
    const out = new Tty();

    run(progressReporter({ stream: out, errorStream: new Sink() }), [
      started,
      {
        type: 'request:failed',
        site: 'a.tv',
        channels: ['one', 'two'],
        days: ['2026-09-01'],
        entries: 2,
        error: new Error('down'),
      },
    ]);

    expect(out.raw).toContain('2/6 channel-days · 2 failed');
  });

  it('counts a whole site the way the summary counts it', () => {
    const out = new Tty();

    run(progressReporter({ stream: out, errorStream: new Sink() }), [
      started,
      { type: 'site:failed', site: 'a.tv', error: new Error('unreadable') },
    ]);

    // Without this the live line said `0 failed` and `Grab done` said `1`.
    expect(out.raw).toContain('1 failed');
  });

  it('is the text one on anything without a cursor to move', () => {
    const pipe = new Sink();

    run(progressReporter({ stream: pipe }), [started]);

    // A pipe, a file, a CI log: what a script reads is unchanged.
    expect(pipe.lines).toEqual(['[a.tv] 2 channel(s) × 3 day(s): 6 to fetch in 6 request(s)']);
  });

  it.each(['debug', 'warn', 'error'] as const)('is the text one at %s', (level) => {
    const out = new Tty();

    run(progressReporter({ stream: out, level }), [started]);

    // At `debug` the per-channel-day lines are the point and a live line would
    // swallow them; below `info` there is no progress to show.
    expect(out.raw).not.toContain('\u001b[K');
  });
});

describe('jsonReporter', () => {
  it('writes one object per line, with the level and phase on it', () => {
    const out = new Sink();

    jsonReporter({ stream: out })(
      event({
        type: 'entry:fetched',
        site: 'a.tv',
        channelId: 'one',
        day: '2026-09-01',
        programmes: 4,
      }),
    );

    expect(JSON.parse(out.lines[0]!)).toEqual({
      type: 'entry:fetched',
      site: 'a.tv',
      channelId: 'one',
      day: '2026-09-01',
      programmes: 4,
      level: 'debug',
      phase: 'grab',
    });
  });

  it('turns an error into something JSON keeps, cause chain and all', () => {
    const out = new Sink();
    const error = new Error('outer', { cause: new TypeError('inner') });

    jsonReporter({ stream: out })(event({ type: 'site:failed', site: 'a.tv', error }));

    const written = JSON.parse(out.lines[0]!) as {
      error: { name: string; cause: { name: string; message: string } };
    };

    // An `Error` stringifies to `{}`, and `errorMessage` only ever reads
    // `.message` — so this is the one form in which a chain survives at all.
    expect(written.error.name).toBe('Error');
    expect(written.error.cause).toMatchObject({ name: 'TypeError', message: 'inner' });
  });

  it('says what a stray throw was', () => {
    const out = new Sink();

    jsonReporter({ stream: out })(event({ type: 'site:failed', site: 'a.tv', error: 'nope' }));

    expect(JSON.parse(out.lines[0]!)).toMatchObject({ error: { message: 'nope' } });
  });

  it('drops what the level does not ask for', () => {
    const out = new Sink();

    jsonReporter({ stream: out, level: 'error' })(
      event({ type: 'entry:cached', site: 'a.tv', channelId: 'one', day: '2026-09-01' }),
    );

    expect(out.lines).toEqual([]);
  });
});

describe('reporterFor', () => {
  const runtime = { stdout: new Sink(), stderr: new Sink(), level: 'info' as EventLevel };

  it('has nothing to build when nothing was asked for', () => {
    expect(reporterFor(undefined, runtime)).toBeUndefined();
  });

  it.each(REPORTER_NAMES)('builds the %s one by name', (name) => {
    expect(typeof reporterFor(name, runtime)).toBe('function');
  });

  it('hands a factory of your own exactly what ours are given', () => {
    const seen: unknown[] = [];
    const reporter = reporterFor((given) => {
      seen.push(given);
      return () => {};
    }, runtime);

    expect(typeof reporter).toBe('function');
    expect(seen).toEqual([runtime]);
  });

  it('says so when a config written in JavaScript names one that does not exist', () => {
    expect(() => reporterFor('yaml' as never, runtime)).toThrow(/Unknown reporter: yaml/);
  });
});

describe('emitter', () => {
  it('is silent when nobody is listening', () => {
    expect(emitter({})).toBe(silent);
  });

  it('stamps what it passes on, so a reporter is told how loudly', () => {
    const seen: EpgEvent[] = [];

    emitter({ reporter: (event) => seen.push(event) })({
      type: 'entry:cached',
      site: 'a.tv',
      channelId: 'one',
      day: '2026-09-01',
    });

    expect(seen).toEqual([
      {
        type: 'entry:cached',
        site: 'a.tv',
        channelId: 'one',
        day: '2026-09-01',
        level: 'debug',
        phase: 'grab',
      },
    ]);
  });
});
