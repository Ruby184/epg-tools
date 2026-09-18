import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CacheManager, MemoryCacheDriver } from '../src/cache/main.js';
import type { CacheStore } from '../src/cache/main.js';
import { grab } from '../src/grabber/main.js';
import { defineCommandSite } from '../src/grabber/command-source.js';
import { resolveChannels } from '../src/grabber/channels.js';
import { collect } from './reporting.js';

/** The stand-in grabber: a document on stdout, and a flag for every way it can go wrong. */
const GRABBER = fileURLToPath(new URL('./fixtures/fake-grabber.mjs', import.meta.url));

/**
 * Today, because that is what the program writes about — `--offset 0` is its own
 * today, so a window written into the test would stop matching tomorrow.
 */
const TODAY = new Date().toISOString().slice(0, 10);
const NOW = new Date(`${TODAY}T09:00:00.000Z`);
/** The day after, which the fixture also covers. */
const TOMORROW = new Date(Date.parse(`${TODAY}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

const store = (): CacheStore => new CacheManager({ driver: new MemoryCacheDriver() });

function site(options: Record<string, unknown> = {}) {
  return defineCommandSite({
    site: 'fake.grabber',
    command: process.execPath,
    args: [GRABBER],
    ...options,
  });
}

/** What one channel-day of the cache holds. */
const cached = (cache: CacheStore, channelId: string, day = TODAY) =>
  cache.read({ site: 'fake.grabber', channelId, day });

describe('defineCommandSite', () => {
  it('grabs what a program wrote to stdout', async () => {
    const cache = store();
    const summary = await grab([site()], { cache, now: NOW, startDay: TODAY, days: 2 });

    expect(summary.failed).toBe(0);
    expect(await cached(cache, 'one.example')).toHaveLength(1);
    expect(await cached(cache, 'two.example')).toHaveLength(1);
    // The day after, from the same run: one program, the whole window.
    expect(await cached(cache, 'one.example', TOMORROW)).toHaveLength(1);
  });

  it('fails the channel-days a dying program never reached', async () => {
    const cache = store();
    const report = collect();
    const sites = [site({ args: [GRABBER, '--truncate'] })];

    const summary = await grab(sites, {
      cache,
      now: NOW,
      startDay: TODAY,
      days: 2,
      reporter: report.reporter,
    });

    // The whole point of reading the exit code. A child's stdout ends *cleanly*
    // when the process dies, so nothing in the bytes says the document stopped
    // half way — and a pass that ended quietly would have every channel-day it
    // never reached cached as "nothing on" instead of failed.
    expect(summary.failed).toBe(2);
    expect(report.failures.map((one) => (one.error as Error).message).join(' ')).toMatch(
      /exited 255 — its output cannot be trusted/,
    );
    expect(report.of('stream:gaps')).toHaveLength(0);
    // What it did write is kept: those two channel-days are as true as they
    // would have been had the program gone on to finish.
    expect(await cached(cache, 'one.example')).toHaveLength(1);
    expect(await cached(cache, 'one.example', TOMORROW)).toBeUndefined();
  });

  it('notices the truncation in the document too, which is worth saying', async () => {
    const report = collect();

    await grab([site({ args: [GRABBER, '--truncate'] })], {
      cache: store(),
      now: NOW,
      startDay: TODAY,
      days: 2,
      reporter: report.reporter,
    });

    // The parser says what it saw; the exit code says what it means. Neither is
    // enough on its own — a document can be short without being cut off.
    expect(report.messages.some((line) => line.includes('truncated-input'))).toBe(true);
  });

  it('says what the program complained about, as it complains and afterwards', async () => {
    const cache = store();
    const report = collect();

    await grab([site({ args: [GRABBER, '--noise', '--exit', '3'] })], {
      cache,
      now: NOW,
      startDay: TODAY,
      days: 1,
      reporter: report.reporter,
    });

    // Every line as it arrives, which is the only progress a grabber gives.
    expect(report.messages.some((line) => line.includes('fetching listings'))).toBe(true);
    // And the tail of it on the failure, which is what makes the exit readable.
    expect(report.failures.map((one) => (one.error as Error).message).join(' ')).toMatch(
      /exited 3 .*It said: .*something looks odd on day 3/s,
    );
  });

  it('accepts an exit code the config says is fine', async () => {
    const cache = store();
    const summary = await grab([site({ args: [GRABBER, '--exit', '1'], okExitCodes: [1] })], {
      cache,
      now: NOW,
      startDay: TODAY,
      days: 1,
    });

    expect(summary.failed).toBe(0);
    expect(await cached(cache, 'one.example')).toHaveLength(1);
  });

  it('says so when there is no such program, rather than failing obscurely', async () => {
    const report = collect();

    await grab([site({ command: 'definitely-not-a-program-3f9a', args: [] })], {
      cache: store(),
      now: NOW,
      startDay: TODAY,
      days: 1,
      reporter: report.reporter,
    });

    expect(report.failures.map((one) => (one.error as Error).message).join(' ')).toMatch(
      /could not be run/,
    );
  });

  it('tells the program about the window, in the program`s own words', async () => {
    const cache = store();
    const asked = (window: { days: readonly string[]; startDay: string; offset: number }) => [
      GRABBER,
      '--echo-argv',
      '--days',
      String(window.days.length),
      '--offset',
      String(window.offset),
      '--from',
      window.startDay,
    ];
    // Today and tomorrow, so the offset a real run computes is 0 — from this
    // machine's clock, which is what a program means by today.
    const today = new Date().toISOString().slice(0, 10);
    const channels = await resolveChannels(site({ args: asked }), {});

    expect(channels.map((channel) => channel.name)).toEqual(
      expect.arrayContaining(['--days', '1', '--offset', '0', '--from', today]),
    );
    expect(cache).toBeDefined();
  });

  it('asks for the channel list on its own, where the program has a cheaper way', async () => {
    const channels = await resolveChannels(
      site({ channelsArgs: [GRABBER, '--list-channels'] }),
      {},
    );

    expect(channels.map((channel) => channel.xmltvId)).toEqual(['one.example', 'two.example']);
    // Kept whole, so what the document said about a channel is what the guide
    // says — the same as a published guide read over HTTP.
    expect(channels[0]?.data).toMatchObject({ id: 'one.example' });
  });

  it('reads a document the program wrote compressed', async () => {
    const cache = store();

    // The reader sniffs a pipe as it sniffs a response body, which is what the
    // document module being about documents rather than about HTTP bought.
    const summary = await grab([site({ args: [GRABBER, '--gzip'] })], {
      cache,
      now: NOW,
      startDay: TODAY,
      days: 1,
    });

    expect(summary.failed).toBe(0);
    expect(await cached(cache, 'one.example')).toHaveLength(1);
  });

  it('says the whole command line, since that is the question it asked', async () => {
    const report = collect();

    await grab([site({ args: [GRABBER, '--exit', '0'] })], {
      cache: store(),
      now: NOW,
      startDay: TODAY,
      days: 1,
      reporter: report.reporter,
    });

    // `epg try` and a verbose run instrument the site's HTTP client, and a
    // program makes no request to instrument — so this is the only place the
    // arguments appear.
    expect(report.messages.some((line) => line.includes(`running ${process.execPath}`))).toBe(true);
    expect(report.messages.some((line) => line.includes('--exit 0'))).toBe(true);
  });

  it('stops the program when the pass is let go of part way', async () => {
    const tally = join(await mkdtemp(join(tmpdir(), 'epg-command-')), 'signals');
    const config = site({
      args: [GRABBER, '--trap', '--dribble'],
      env: { FAKE_TALLY: tally },
    });
    const pass = config.stream({
      // Both channels, because a channel-day is handed over when a *wanted*
      // channel's programme follows it: an unwanted one deliberately takes no
      // part in deciding whether the document is grouped, so wanting only the
      // first would wait for the end of a document this program never ends.
      channelDays: [
        { channel: { xmltvId: 'one.example', siteId: 'one.example' }, day: TODAY },
        { channel: { xmltvId: 'two.example', siteId: 'two.example' }, day: TODAY },
      ],
      days: [TODAY],
      state: new Map(),
      log: () => undefined,
      warn: () => undefined,
      // No queue, since this is the only thing happening — the same shape
      // `epg try` hands a pass.
      paced: (task: (options: { signal?: AbortSignal }) => unknown) => task({}),
    } as never) as AsyncGenerator<unknown>;

    // One channel-day, then let go of it — which is what a consumer that stops
    // reading does, and leaves this suspended at a `yield` rather than thrown
    // out of.
    await pass.next();
    await pass.return(undefined);

    // A `catch` would not have covered that, and the program would have been
    // left writing into a pipe nobody reads.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await readFile(tally, 'utf8')).toContain('SIGTERM');
  });

  it('gives up on a program that never finishes', async () => {
    const report = collect();

    await grab([site({ args: [GRABBER, '--hang'], timeoutMs: 150 })], {
      cache: store(),
      now: NOW,
      startDay: TODAY,
      days: 1,
      reporter: report.reporter,
    });

    expect(report.failures.map((one) => (one.error as Error).message).join(' ')).toMatch(
      /was stopped: it was still running after 150ms/,
    );
  });

  it('stops the program when the run is called off, rather than hanging on it', async () => {
    const stop = new AbortController();
    const report = collect();
    const running = grab([site({ args: [GRABBER, '--hang'] })], {
      cache: store(),
      now: NOW,
      startDay: TODAY,
      days: 1,
      signal: stop.signal,
      reporter: report.reporter,
    });

    // Long enough for the program to be up, short enough to be a test.
    await new Promise((resolve) => setTimeout(resolve, 120));
    stop.abort();

    // It comes back at all, which is the assertion: a program that ignores the
    // abort would hold the run open until the test timed out.
    await running.catch(() => undefined);
    expect(report.failures.map((one) => (one.error as Error).message).join(' ')).toMatch(
      /called off|abort/i,
    );
  });
});
