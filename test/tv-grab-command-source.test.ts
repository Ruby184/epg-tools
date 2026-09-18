import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CacheManager, MemoryCacheDriver } from '../src/cache/main.js';
import type { CacheStore } from '../src/cache/main.js';
import { resolveChannels } from '../src/grabber/channels.js';
import { grab } from '../src/grabber/main.js';
import { SiteStateHandle } from '../src/grabber/state.js';
import { defineTvGrabCommandSite } from '../src/grabber/tv-grab-command-source.js';
import { collect } from './reporting.js';

/**
 * The stand-in grabber, run as a grabber is: the program itself, with the
 * arguments this layer decides. Its shebang is what makes that possible.
 */
const GRABBER = fileURLToPath(new URL('./fixtures/fake-grabber.mjs', import.meta.url));

const TODAY = new Date().toISOString().slice(0, 10);
const NOW = new Date(`${TODAY}T09:00:00.000Z`);

const store = (): CacheStore => new CacheManager({ driver: new MemoryCacheDriver() });

function site(options: Record<string, unknown> = {}) {
  return defineTvGrabCommandSite({ site: 'fake.tv_grab', command: GRABBER, ...options });
}

/** The argv a run passed, read back out of the channels the fixture echoes. */
async function argvOf(options: Record<string, unknown>): Promise<string[]> {
  const channels = await resolveChannels(site({ extraArgs: ['--echo-argv'], ...options }), {});

  return channels.flatMap((channel) => (channel.name === undefined ? [] : [channel.name]));
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
      '--config-file',
      'fake.conf',
      '--days',
      '1',
      '--offset',
      '0',
      '--quiet',
      '--echo-argv',
    ]);
  });

  it('passes none of that to a grabber that does not advertise baseline', async () => {
    // `baseline` is what says `--days`, `--offset`, `--config-file` and
    // `--quiet` exist at all. Passing one to a grabber without it is an
    // "unknown option" and a failed site.
    const argv = await argvOf({
      configFile: 'fake.conf',
      env: { FAKE_CAPABILITIES: 'manualconfig' },
    });

    expect(argv).toEqual(['--echo-argv']);
  });

  it('asks for the channel list with --list-channels, which is apiconfig`s', async () => {
    const argv = await argvOf({ configFile: 'fake.conf' });

    // Not `--days`: this is the cheap answer, so the window is beside the point.
    expect(argv).toContain('--list-channels');
    expect(argv).not.toContain('--days');
  });

  it('reads the list out of a normal run when the grabber has no cheap answer', async () => {
    const argv = await argvOf({
      configFile: 'fake.conf',
      env: { FAKE_CAPABILITIES: 'baseline' },
    });

    // No `apiconfig`, so no `--list-channels` to ask for: the list comes out of
    // the head of a normal run, as a published guide's does out of a document.
    expect(argv).not.toContain('--list-channels');
    expect(argv).toEqual(expect.arrayContaining(['--days', '--offset']));
  });

  it('passes --cache only to a grabber that keeps one', async () => {
    expect(await argvOf({ cache: 'fake.cache', capabilities: ['baseline', 'cache'] })).toContain(
      '--cache',
    );
    expect(await argvOf({ cache: 'fake.cache', capabilities: ['baseline'] })).not.toContain(
      '--cache',
    );
    // And never to `--list-channels`, which takes `config-file`, `output` and
    // `quiet` and nothing else — this package's own implementation of that
    // capability is the authority on it.
    expect(
      await argvOf({ cache: 'fake.cache', capabilities: ['baseline', 'apiconfig', 'cache'] }),
    ).not.toContain('--cache');
  });

  it('takes what the config says it supports, and asks nothing', async () => {
    const cache = store();
    const state = SiteStateHandle.open(cache, 'fake.tv_grab');

    await resolveChannels(site({ capabilities: [], extraArgs: ['--echo-argv'] }), { state });

    // Nothing asked, so nothing remembered: `capabilities: []` is the way out
    // for a grabber whose own answer cannot be believed.
    expect((await state.bag()).get('capabilities')).toBeUndefined();
  });

  it('asks what it supports once, and remembers it', async () => {
    const cache = store();
    const tally = join(await mkdtemp(join(tmpdir(), 'epg-tv-grab-')), 'asked');
    const config = site({ configFile: 'fake.conf', env: { FAKE_TALLY: tally } });
    const state = SiteStateHandle.open(cache, 'fake.tv_grab');

    await resolveChannels(config, { state });

    expect((await state.bag()).get('capabilities')).toMatchObject({
      names: ['baseline', 'apiconfig'],
    });

    // Again over the same state, and again asking for the list itself, so the
    // only thing that could be skipped is the capability probe.
    await resolveChannels(config, { state, refresh: true });

    // One spawn, counted by the program itself: nothing else can see how many
    // times it was run.
    expect((await readFile(tally, 'utf8')).trim().split('\n')).toHaveLength(1);
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
    await resolveChannels(site({ env: { FAKE_CAPABILITIES: 'baseline' } }), {
      state,
      refresh: true,
    });

    const second = (await state.bag()).get('capabilities') as { of: string };

    expect(second.of).not.toBe(first.of);
  });

  it('says when it cannot pass on the config file it was given', async () => {
    const said: string[] = [];

    // Without `baseline` there is no `--config-file` to pass, so the grabber
    // reads `~/.xmltv/<name>.conf` instead — somebody else's listings,
    // quietly, unless this is said.
    await resolveChannels(
      site({ configFile: 'fake.conf', env: { FAKE_CAPABILITIES: 'manualconfig' } }),
      { says: { log: () => undefined, warn: (message) => void said.push(message) } },
    );

    expect(said.join(' ')).toMatch(/cannot be told to use fake\.conf/);
  });

  it('fails the site when the grabber cannot say what it supports', async () => {
    const report = collect();

    // `--capabilities` is the first thing asked of it, and a program that
    // cannot answer that is one nothing else about is worth guessing at — so
    // the failure is the probe's, before any window is asked for.
    await grab([site({ env: { FAKE_CAPABILITIES: 'fail' } })], {
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

    const summary = await grab([site({ extraArgs: ['--truncate'] })], {
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
