import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CacheManager, MemoryCacheDriver } from '../src/cache/main.js';
import type { CacheStore } from '../src/cache/main.js';
import { resolveChannels } from '../src/grabber/channels.js';
import { grab } from '../src/grabber/main.js';
import { SiteStateHandle } from '../src/grabber/state.js';
import { defineTvGrabCommandSite } from '../src/grabber/tv-grab-command-source.js';
import {
  byDefault,
  capabilities,
  channelsOnly,
  cutShort,
  document,
  documentFor,
  startControl,
} from './fixtures/control.js';
import { collect } from './reporting.js';

/**
 * The stand-in grabber, run as a grabber is: the program itself, with the
 * arguments this layer decides. Its shebang is what makes that possible.
 */
const GRABBER = fileURLToPath(new URL('./fixtures/fake-grabber.mjs', import.meta.url));

const TODAY = new Date().toISOString().slice(0, 10);
const NOW = new Date(`${TODAY}T09:00:00.000Z`);
/** The day after, which a gappy window is made of by holding it fresh. */
const TOMORROW = new Date(Date.parse(`${TODAY}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

const store = (): CacheStore => new CacheManager({ driver: new MemoryCacheDriver() });

/**
 * Make one day fresh for every channel, so the window around it is gappy.
 *
 * With programmes in it, deliberately: an entry holding none ages by
 * `emptyMaxAgeDays` instead — a day that came back empty being as likely to be
 * a source having a bad morning as a day with nothing on — so an empty one is
 * stale again at once and the gap never opens.
 */
async function hold(cache: CacheStore, day: string): Promise<void> {
  for (const channelId of ['one.example', 'two.example']) {
    await cache.write(
      { site: 'fake.tv_grab', channelId, day },
      [
        {
          channel: channelId,
          start: new Date(`${day}T18:00:00.000Z`),
          stop: new Date(`${day}T19:00:00.000Z`),
          title: [{ value: 'Held' }],
        },
      ],
      { grabbedAt: NOW.toISOString() },
    );
  }
}

function site(options: Record<string, unknown> = {}) {
  return defineTvGrabCommandSite({ site: 'fake.tv_grab', command: GRABBER, ...options });
}

/**
 * The argument lists a channel pass used, as the program reported them.
 *
 * Only the grabbing ones: what it was asked *about itself* is a different
 * question, and every test here is about the other. Recorded over the control
 * socket rather than echoed back as a document, because echoing turns the
 * document into the argument list and takes the channel list with it.
 */
async function argvOf(
  options: Record<string, unknown> = {},
  supports?: readonly string[],
): Promise<string[][]> {
  const control = await startControl();

  if (supports !== undefined) {
    control.answer((invocation) =>
      invocation.argv.includes('--capabilities')
        ? capabilities(supports)
        : { write: channelsOnly() },
    );
  }

  await resolveChannels(site({ env: { FAKE_CONTROL: control.path }, ...options }), {});
  await control.close();

  const about = new Set(['--capabilities', '--description', '--preferredmethod']);

  return control.invocations
    .filter((one) => !one.argv.some((arg) => about.has(arg)))
    .map((one) => one.argv);
}

describe('defineTvGrabCommandSite', () => {
  it('grabs a grabber, with the interface filled in', async () => {
    const cache = store();
    const summary = await grab([site({ configFile: 'fake.conf' })], {
      cache,
      now: NOW,
      startDay: TODAY,
      days: 2,
    });

    expect(summary.failed).toBe(0);
    expect(
      await cache.read({ site: 'fake.tv_grab', channelId: 'one.example', day: TODAY }),
    ).toHaveLength(1);
  });

  it('spells the window the way a grabber spells it', async () => {
    // `--days` is a count and `--offset` is where it starts, both in the
    // grabber's own idea of today — 0 here, since this asks about today.
    // `capabilities: ['baseline']` is what makes this the grab's own argument
    // list: without `apiconfig` there is no `--list-channels` to ask for, so
    // the channel pass runs the grab and reads the head of it.
    const argv = await argvOf({ configFile: 'fake.conf', capabilities: ['baseline'] });

    expect(argv).toEqual([
      ['--config-file', 'fake.conf', '--days', '1', '--offset', '0', '--quiet'],
    ]);
  });

  it('passes none of that to a grabber that does not advertise baseline', async () => {
    // `baseline` is what says `--days`, `--offset`, `--config-file` and
    // `--quiet` exist at all. Passing one to a grabber without it is an
    // "unknown option" and a failed site.
    const argv = await argvOf({ configFile: 'fake.conf' }, ['manualconfig']);

    expect(argv).toEqual([[]]);
  });

  it('asks for the channel list with --list-channels, which is apiconfig`s', async () => {
    const [argv] = await argvOf({ configFile: 'fake.conf' });

    // Not `--days`: this is the cheap answer, so the window is beside the point.
    expect(argv).toContain('--list-channels');
    expect(argv).not.toContain('--days');
  });

  it('reads the list out of a normal run when the grabber has no cheap answer', async () => {
    const [argv] = await argvOf({ configFile: 'fake.conf' }, ['baseline']);

    // No `apiconfig`, so no `--list-channels` to ask for: the list comes out of
    // the head of a normal run, as a published guide's does out of a document.
    expect(argv).not.toContain('--list-channels');
    expect(argv).toEqual(expect.arrayContaining(['--days', '--offset']));
  });

  it('passes --cache only to a grabber that keeps one', async () => {
    const [keeping] = await argvOf({ cache: 'fake.cache', capabilities: ['baseline', 'cache'] });
    const [without] = await argvOf({ cache: 'fake.cache', capabilities: ['baseline'] });
    // And never to `--list-channels`, which takes `config-file`, `output` and
    // `quiet` and nothing else — this package's own implementation of that
    // capability is the authority on it.
    const [listing] = await argvOf({
      cache: 'fake.cache',
      capabilities: ['baseline', 'apiconfig', 'cache'],
    });

    expect(keeping).toContain('--cache');
    expect(without).not.toContain('--cache');
    expect(listing).not.toContain('--cache');
  });

  it('takes what the config says it supports, and asks nothing', async () => {
    const cache = store();
    const state = SiteStateHandle.open(cache, 'fake.tv_grab');

    await resolveChannels(site({ capabilities: [] }), { state });

    // Nothing asked, so nothing remembered: `capabilities: []` is the way out
    // for a grabber whose own answer cannot be believed.
    expect((await state.bag()).get('capabilities')).toBeUndefined();
  });

  it('asks what it supports once, and remembers it', async () => {
    const cache = store();
    const control = await startControl();
    const config = site({ configFile: 'fake.conf', env: { FAKE_CONTROL: control.path } });
    const state = SiteStateHandle.open(cache, 'fake.tv_grab');

    await resolveChannels(config, { state });

    expect((await state.bag()).get('capabilities')).toMatchObject({
      names: ['baseline', 'manualconfig', 'apiconfig', 'preferredmethod'],
    });

    // Again over the same state, and again asking for the list itself, so the
    // only thing that could be skipped is the asking about the program.
    await resolveChannels(config, { state, refresh: true });
    await control.close();

    expect(control.said.filter((one) => one === '--capabilities')).toHaveLength(1);
  });

  it('asks again once the command changes', async () => {
    const cache = store();
    const state = SiteStateHandle.open(cache, 'fake.tv_grab');

    await resolveChannels(site({ configFile: 'fake.conf' }), { state });

    const first = (await state.bag()).get('capabilities') as { of: string };

    // A different environment is a different program as far as this is
    // concerned: what it supports was asked of the one it was asked of.
    // `refresh` because the channel list itself is cached — this is about the
    // capabilities beside it, not about the list.
    await resolveChannels(site({ env: { FAKE_SOMETHING: 'else' } }), { state, refresh: true });

    const second = (await state.bag()).get('capabilities') as { of: string };

    expect(second.of).not.toBe(first.of);
  });

  it('asks once for the whole stretch where the grabber downloads the lot anyway', async () => {
    const cache = store();
    const control = await startControl();

    // `allatonce`: "the grabber downloads data in a single chunk and filters
    // out the requested days", so asking it twice costs twice for nothing. Its
    // default answers say so, capability and all.
    await hold(cache, TOMORROW);
    await grab([site({ env: { FAKE_CONTROL: control.path } })], {
      cache,
      now: NOW,
      startDay: TODAY,
      days: 3,
    });
    await control.close();

    // One run, and **`--days 3`**: the option says how long a stretch to fetch,
    // so two days three apart need three of them. Asking for two — the number
    // of days wanted — would come back without the last, and a day the document
    // says nothing about is cached as "nothing on".
    expect(control.said.filter((one) => one.includes('--days'))).toEqual([
      '--days 3 --offset 0 --quiet',
    ]);
  });

  it('asks per stretch where the grabber pays by the day', async () => {
    const cache = store();
    const control = await startControl();

    // No `preferredmethod`, so bandwidth is to be assumed proportional to the
    // days asked for — and a gap in the middle is worth two calls.
    control.answer((invocation) =>
      invocation.argv.includes('--capabilities')
        ? capabilities(['baseline', 'apiconfig'])
        : { write: documentFor(invocation) },
    );

    await hold(cache, TOMORROW);
    await grab([site({ env: { FAKE_CONTROL: control.path } })], {
      cache,
      now: NOW,
      startDay: TODAY,
      days: 3,
    });
    await control.close();

    // One for today and one for the day after tomorrow, a day each — and
    // between them they cover everything asked for, which they must: a day no
    // run wrote about is cached empty.
    expect(control.said.filter((one) => one.includes('--days'))).toEqual([
      '--days 1 --offset 0 --quiet',
      '--days 1 --offset 2 --quiet',
    ]);
  });

  it('runs a grabber without baseline once, since there is no stretch to name', async () => {
    const cache = store();
    const control = await startControl();

    // No `preferredmethod`, so a gappy window would be worth a run per stretch
    // — and no `baseline`, so there is no `--days` or `--offset` to tell one
    // stretch from another. Twice would be the same argument list twice, and
    // the same document twice.
    control.answer((invocation) =>
      invocation.argv.includes('--capabilities')
        ? capabilities(['manualconfig'])
        : { write: documentFor(invocation) },
    );

    await hold(cache, TOMORROW);
    await grab([site({ env: { FAKE_CONTROL: control.path } })], {
      cache,
      now: NOW,
      startDay: TODAY,
      days: 3,
    });
    await control.close();

    // Two runs in all: the channel list, read out of the head of one since
    // there is no `apiconfig` either, and the grab. Per stretch it would be
    // three, the last two being the same argument list and the same document.
    expect(
      control.said.filter((one) => one !== '--capabilities' && one !== '--description'),
    ).toEqual(['', '']);
  });

  it('asks a grabber its method even where the config says what it supports', async () => {
    const cache = store();
    const control = await startControl();

    // Saying what a grabber supports is how somebody stops this interrogating
    // it. `preferredmethod` is the exception, because the capability is the
    // name of a *question*: only the program can say whether it downloads
    // everything at once, and a config that declared it and was then run once
    // per stretch would be two whole downloads where saying so was meant to
    // save one.
    await hold(cache, TOMORROW);
    await grab(
      [
        site({
          env: { FAKE_CONTROL: control.path },
          // With `apiconfig`, so the channel list is its own cheap run and the
          // only `--days` here is the grab's.
          capabilities: ['baseline', 'apiconfig', 'preferredmethod'],
        }),
      ],
      { cache, now: NOW, startDay: TODAY, days: 3 },
    );
    await control.close();

    expect(control.said).toContain('--preferredmethod');
    // Never `--capabilities`: that one the config answered.
    expect(control.said).not.toContain('--capabilities');
    expect(control.said.filter((one) => one.includes('--days'))).toEqual([
      '--days 3 --offset 0 --quiet',
    ]);
  });

  it('takes from each stretch only the days that stretch is for', async () => {
    const cache = store();
    const report = collect();
    const control = await startControl();

    // A grabber that writes the same three days whatever it is asked for —
    // one that ignores `--offset`, or answers out of a file it already has,
    // which is half of what people point this at.
    control.answer((invocation) =>
      invocation.argv.includes('--capabilities')
        ? capabilities(['baseline', 'apiconfig'])
        : { write: document({ days: [0, 1, 2] }) },
    );

    await hold(cache, TOMORROW);
    await grab([site({ env: { FAKE_CONTROL: control.path } })], {
      cache,
      now: NOW,
      startDay: TODAY,
      days: 3,
      reporter: report.reporter,
    });
    await control.close();

    // Two stretches, and each day written once. Handed the whole window, both
    // runs would answer for both days and the second would append to what the
    // first wrote — the same programmes twice in the guide.
    expect(report.of('entry:appended')).toHaveLength(0);
    expect(report.of('entry:fetched')).toHaveLength(4);
  });

  it('keeps the stretch that worked when a later one fails', async () => {
    const cache = store();
    const report = collect();
    const control = await startControl();

    // Two stretches, and the second of them refuses — which is a sentence here
    // rather than a flag the program has to interpret, because the test is
    // answering each invocation as it comes.
    control.answer((invocation) => {
      if (invocation.argv.includes('--capabilities')) {
        return capabilities(['baseline', 'apiconfig']);
      }

      return invocation.said.includes('--offset 2')
        ? { stderr: 'refusing the second', exit: 7 }
        : { write: documentFor(invocation) };
    });

    await hold(cache, TOMORROW);

    const summary = await grab([site({ env: { FAKE_CONTROL: control.path } })], {
      cache,
      now: NOW,
      startDay: TODAY,
      days: 3,
      reporter: report.reporter,
    });

    await control.close();

    // Today was written by the first run and stays written; the day after
    // tomorrow fails rather than being cached as "nothing on", which is the
    // whole reason the exit code is read at all.
    expect(
      await cache.read({ site: 'fake.tv_grab', channelId: 'one.example', day: TODAY }),
    ).toHaveLength(1);
    expect(summary.failed).toBeGreaterThan(0);
    expect(report.failures.map((one) => (one.error as Error).message).join(' ')).toMatch(
      /exited 7.*refusing the second/s,
    );
  });

  it('says which grabber it turned out to be', async () => {
    const report = collect();

    const control = await startControl();

    control.answer((invocation) =>
      invocation.argv.includes('--description')
        ? { write: 'Television listings for Somewhere\n' }
        : byDefault(invocation),
    );

    await grab([site({ env: { FAKE_CONTROL: control.path } })], {
      cache: store(),
      now: NOW,
      startDay: TODAY,
      days: 1,
      reporter: report.reporter,
    });

    // `--description` is one line about what it covers, and knowing which
    // program answered is worth a line of a verbose log.
    expect(report.messages.join(' ')).toMatch(/Television listings for Somewhere/);
  });

  it('grabs on with a grabber that will not say what it covers', async () => {
    const cache = store();
    const control = await startControl();

    // It will not say what it covers, and will not say why either.
    control.answer((invocation) =>
      invocation.argv.includes('--description') ? { exit: 1 } : byDefault(invocation),
    );

    const summary = await grab([site({ env: { FAKE_CONTROL: control.path } })], {
      cache,
      now: NOW,
      startDay: TODAY,
      days: 1,
    });

    await control.close();

    // Only `--capabilities` decides anything, so only it may fail the site.
    expect(summary.failed).toBe(0);
  });

  it('says when it cannot pass on the config file it was given', async () => {
    const said: string[] = [];

    // Without `baseline` there is no `--config-file` to pass, so the grabber
    // reads `~/.xmltv/<name>.conf` instead — somebody else's listings,
    // quietly, unless this is said.
    const control = await startControl();

    control.answer((invocation) =>
      invocation.argv.includes('--capabilities')
        ? capabilities(['manualconfig'])
        : { write: channelsOnly() },
    );

    await resolveChannels(site({ configFile: 'fake.conf', env: { FAKE_CONTROL: control.path } }), {
      says: { log: () => undefined, warn: (message) => void said.push(message) },
    });
    await control.close();

    expect(said.join(' ')).toMatch(/cannot be told to use fake\.conf/);
  });

  it('fails the site when the grabber cannot say what it supports', async () => {
    const report = collect();

    // `--capabilities` is the first thing asked of it, and a program that
    // cannot answer that is one nothing else about is worth guessing at — so
    // the failure is the probe's, before any window is asked for.
    const control = await startControl();

    control.answer((invocation) =>
      invocation.argv.includes('--capabilities')
        ? { stderr: 'cannot read my own configuration', exit: 3 }
        : byDefault(invocation),
    );

    await grab([site({ env: { FAKE_CONTROL: control.path } })], {
      cache: store(),
      now: NOW,
      startDay: TODAY,
      days: 1,
      reporter: report.reporter,
    });

    expect(report.messages.join(' ')).toMatch(
      /--capabilities exited 3.*cannot read my own configuration/s,
    );
  });

  it('fails the channel-days a dying grabber never reached, as the layer below does', async () => {
    const cache = store();
    const report = collect();

    const control = await startControl();

    // The grab dies part way; everything it is asked *about itself* is answered
    // as usual, since a program that cannot say what it supports fails before
    // there is a channel-day to fail. Cut after the first day's programmes, so
    // the days beyond it are never written and are owed when it exits badly.
    control.answer((invocation) =>
      invocation.argv.includes('--days')
        ? { write: cutShort(documentFor(invocation), 2), exit: 255 }
        : byDefault(invocation),
    );

    const summary = await grab([site({ env: { FAKE_CONTROL: control.path } })], {
      cache,
      now: NOW,
      startDay: TODAY,
      days: 2,
      reporter: report.reporter,
    });

    // The same code path, asserted rather than assumed: a truncated document is
    // what a Perl grabber leaves when it dies, and this is the layer people
    // will actually point at one.
    expect(summary.failed).toBe(2);
    expect(report.failures.map((one) => (one.error as Error).message).join(' ')).toMatch(
      /exited 255 — its output cannot be trusted/,
    );
  });
});
