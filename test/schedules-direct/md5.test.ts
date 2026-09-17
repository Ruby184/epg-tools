import { describe, expect, it } from 'vitest';
import type { CacheEntryMeta } from '../../src/cache/types.js';
import {
  decideMd5,
  forgetMd5,
  MAX_MD5S,
  md5Key,
  pruneMd5,
  rememberMd5,
  storedMd5,
} from '../../src/grabber/schedules-direct/md5.js';
import type { SiteState } from '../../src/grabber/types.js';
import {
  SD_DATE_OUT_OF_RANGE,
  SD_SCHEDULE_QUEUED,
} from '../../src/grabber/schedules-direct/wire.js';

const GRABBED = '2026-09-12T06:00:00.000Z';

/** An entry in the cache, as the planner hands one over. */
const cached = (grabbedAt = GRABBED): CacheEntryMeta => ({ grabbedAt, programmeCount: 12 });

describe('decideMd5', () => {
  it('keeps a station-day whose md5 has not moved', () => {
    expect(decideMd5('abc', { code: 0, md5: 'abc' }, cached())).toMatchObject({
      verdict: 'keep',
      md5: 'abc',
    });
  });

  it('fetches one whose md5 has', () => {
    expect(decideMd5('abc', { code: 0, md5: 'def' }, cached())).toMatchObject({
      verdict: 'fetch',
      md5: 'def',
    });
  });

  // The state and the cache are two files that can be pruned, copied or lost
  // separately. Saying "unchanged" with nothing behind it makes the run report a
  // failed channel-day — every run, until somebody notices — so the cache wins.
  it('fetches a station-day whose md5 matches but whose entry is gone', () => {
    expect(decideMd5('abc', { code: 0, md5: 'abc' }, undefined)).toMatchObject({
      verdict: 'fetch',
      reason: 'nothing is cached for this day',
    });
  });

  it('fetches when nothing has been stored and nothing is cached', () => {
    expect(decideMd5(undefined, { code: 0, md5: 'abc' }, undefined)).toMatchObject({
      verdict: 'fetch',
    });
  });

  describe('with no md5 stored yet', () => {
    // The first run after this ships has none, and would otherwise refetch a
    // fortnight it already holds.
    it('keeps what was grabbed after the service last changed it', () => {
      expect(
        decideMd5(
          undefined,
          { code: 0, md5: 'abc', lastModified: '2026-09-12T05:00:00Z' },
          cached(),
        ),
      ).toMatchObject({ verdict: 'keep', md5: 'abc' });
    });

    it('fetches what changed after we took it', () => {
      expect(
        decideMd5(
          undefined,
          { code: 0, md5: 'abc', lastModified: '2026-09-12T07:00:00Z' },
          cached(),
        ),
      ).toMatchObject({ verdict: 'fetch' });
    });

    it('fetches when the service did not say when it changed', () => {
      expect(decideMd5(undefined, { code: 0, md5: 'abc' }, cached())).toMatchObject({
        verdict: 'fetch',
      });
    });

    // Both are ISO, but only one of them is written by this package: compared as
    // text, a trailing `.000` sorts the wrong way.
    it('compares the two as instants rather than as strings', () => {
      expect(
        decideMd5(
          undefined,
          { code: 0, md5: 'abc', lastModified: '2026-09-12T06:00:00Z' },
          cached('2026-09-12T06:00:00.000Z'),
        ),
      ).toMatchObject({ verdict: 'keep' });
    });
  });

  describe('when the service says something other than the md5', () => {
    it('caches a day outside the station`s window empty, and remembers its md5', () => {
      const decision = decideMd5(
        undefined,
        { code: SD_DATE_OUT_OF_RANGE, md5: 'abc', minDate: '2026-09-01', maxDate: '2026-09-14' },
        undefined,
      );

      // It has been told there is nothing there, which is an answer worth
      // keeping rather than a gap worth asking about again tomorrow.
      expect(decision).toMatchObject({ verdict: 'empty', md5: 'abc' });
      expect(decision.reason).toContain('2026-09-01');
      expect(decision.reason).toContain('2026-09-14');
    });

    it('calls a queued schedule unknown rather than missing', () => {
      expect(decideMd5('abc', { code: SD_SCHEDULE_QUEUED }, cached())).toMatchObject({
        verdict: 'unknown',
      });
    });

    it('keeps a day it said nothing about, where there is something to keep', () => {
      // The md5 call leaves out a day outside what a station has — no entry and
      // no code — so "absent" is not "unchanged", it is "nothing to say".
      expect(decideMd5('abc', undefined, cached())).toMatchObject({ verdict: 'keep' });
    });

    it('fetches a day it said nothing about when nothing is cached', () => {
      // Which gets the `7020` from `/schedules` and caches the day empty. The
      // alternative is what a real 21-day grab did: 435 channel-days reported
      // unchanged with nothing behind them, failing every run.
      expect(decideMd5(undefined, undefined, undefined)).toMatchObject({ verdict: 'fetch' });
    });

    it('fetches when it answered without an md5 at all', () => {
      expect(decideMd5('abc', { code: 0 }, cached())).toMatchObject({ verdict: 'fetch' });
    });
  });
});

describe('the md5 bag', () => {
  it('keeps one station-day under one key, and reads back only a usable one', () => {
    const state: SiteState = new Map();

    rememberMd5(state, '20454', '2026-09-12', 'abc');

    expect(state.get(md5Key('20454', '2026-09-12'))).toBe('abc');
    expect(storedMd5(state, '20454', '2026-09-12')).toBe('abc');
    expect(storedMd5(state, '20454', '2026-09-13')).toBeUndefined();

    // Whatever a hand-edited or half-written cache file holds, it is not an md5.
    state.set(md5Key('1', '2026-09-12'), 42);
    state.set(md5Key('2', '2026-09-12'), '');

    expect(storedMd5(state, '1', '2026-09-12')).toBeUndefined();
    expect(storedMd5(state, '2', '2026-09-12')).toBeUndefined();
  });

  it('drops the days that have left the window, and nothing else', () => {
    const state: SiteState = new Map<string, unknown>([['token', 'keep me']]);

    rememberMd5(state, '1', '2026-09-10', 'old');
    rememberMd5(state, '1', '2026-09-12', 'current');

    pruneMd5(state, '2026-09-11');

    expect(storedMd5(state, '1', '2026-09-10')).toBeUndefined();
    expect(storedMd5(state, '1', '2026-09-12')).toBe('current');
    // The bag is shared with the token, which has no day and is not ours to drop.
    expect(state.get('token')).toBe('keep me');
  });

  it('forgets every md5 when the mapping itself has moved on', () => {
    const state: SiteState = new Map<string, unknown>([['token', 'keep me']]);

    rememberMd5(state, '1', '2026-09-12', 'abc');
    rememberMd5(state, '2', '2026-09-12', 'def');

    forgetMd5(state);

    expect([...state.keys()]).toEqual(['token']);
  });

  it('evicts the oldest of its own rather than growing without end', () => {
    // The token goes in first, as it does in a run — and is the one key an
    // eviction reading `state.size` and taking the front of the bag would drop.
    const state: SiteState = new Map<string, unknown>([['token', 'keep me']]);

    // One past the cap, which is the only interesting size.
    for (let index = 0; index <= MAX_MD5S; index++) {
      rememberMd5(state, String(index), '2026-09-12', 'x');
    }

    pruneMd5(state, '2026-09-01');

    expect(state.get('token')).toBe('keep me');
    // The first md5 in is the first one out, and the cap counts only ours.
    expect(state.size).toBe(MAX_MD5S + 1);
    expect(storedMd5(state, '0', '2026-09-12')).toBeUndefined();
    expect(storedMd5(state, String(MAX_MD5S), '2026-09-12')).toBe('x');
  });
});
