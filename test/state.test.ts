import { describe, expect, it } from 'vitest';
import { CacheManager, MemoryCacheDriver } from '../src/cache/main.js';
import type { CacheStore } from '../src/cache/main.js';
import {
  channelsMaxAgeMs,
  DEFAULT_CHANNELS_MAX_AGE_DAYS,
  SiteStateHandle,
  StateKey,
  TrackedMap,
} from '../src/grabber/main.js';
import type { AnySiteConfig, GrabberChannel } from '../src/grabber/main.js';

const NOW = new Date('2026-08-27T12:00:00.000Z');
const SITE = 'example.com';
const DAY_MS = 86_400_000;

function store(): CacheStore {
  return new CacheManager({ driver: new MemoryCacheDriver() });
}

/**
 * The same store with some of it watched — by delegation, deliberately.
 *
 * Not `Object.create(store)`: a `CacheManager` keeps its driver in a private
 * field, and a private field is per instance rather than inherited, so a method
 * reached through a copy is called on an object whose class never declared it and
 * throws.
 */
function wrapStore(underneath: CacheStore, overrides: Partial<CacheStore>): CacheStore {
  return {
    getMeta: (key) => underneath.getMeta(key),
    getMetas: (keys) => underneath.getMetas(keys),
    read: (key) => underneath.read(key),
    write: (key, programmes, meta) => underneath.write(key, programmes, meta),
    delete: (key) => underneath.delete(key),
    prune: (options) => underneath.prune(options),
    getState: (site, key) => underneath.getState(site, key),
    setState: (site, key, data, meta) => underneath.setState(site, key, data, meta),
    close: () => underneath.close(),
    ...overrides,
  };
}

/** A store that says how often it was asked, and holds every read until released. */
function countingStore(): { store: CacheStore; reads: string[]; release: () => void } {
  const underneath = store();
  const reads: string[] = [];
  let held: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    held = resolve;
  });

  return {
    reads,
    release: () => held?.(),
    store: wrapStore(underneath, {
      async getState(site: string, key: string) {
        reads.push(`${site}|${key}`);
        await gate;

        return underneath.getState(site, key);
      },
    }),
  };
}

function channel(id: string): GrabberChannel {
  return { xmltvId: id, siteId: `site-${id}` };
}

describe('TrackedMap', () => {
  it('says nothing changed until something does', () => {
    const map = new TrackedMap<string>([['token', 'abc']]);

    expect(map.changed.size).toBe(0);
    expect(map.get('token')).toBe('abc');

    // Setting a key to the value it already holds is not a change, so a site
    // storing the same token every run writes no file.
    map.set('token', 'abc');
    expect(map.changed.size).toBe(0);

    map.set('token', 'def');
    expect([...map.changed]).toEqual(['token']);
  });

  it('counts a removal, and only one that removed something', () => {
    const map = new TrackedMap<number>([['a', 1]]);

    expect(map.delete('nothing-there')).toBe(false);
    expect(map.changed.size).toBe(0);

    expect(map.delete('a')).toBe(true);
    expect([...map.changed]).toEqual(['a']);
  });

  it('counts everything a clear took, and nothing when it was empty', () => {
    const empty = new TrackedMap<number>();

    empty.clear();
    expect(empty.changed.size).toBe(0);

    const map = new TrackedMap<number>([
      ['a', 1],
      ['b', 2],
    ]);

    map.clear();
    expect([...map.changed].sort()).toEqual(['a', 'b']);
    expect(map.size).toBe(0);
  });

  it('is a Map, so a site has nothing to learn', () => {
    const map = new TrackedMap<number>([['a', 1]]);

    expect(map).toBeInstanceOf(Map);
    expect([...map]).toEqual([['a', 1]]);
    expect(map.has('a')).toBe(true);
  });
});

describe('channelsMaxAgeMs', () => {
  const site = (cacheChannels: AnySiteConfig['cacheChannels']): AnySiteConfig =>
    ({ cacheChannels }) as AnySiteConfig;

  it('is nothing unless the site asked', () => {
    expect(channelsMaxAgeMs(site(undefined))).toBeUndefined();
    expect(channelsMaxAgeMs(site(false))).toBeUndefined();
  });

  it('is a day when the site just says yes', () => {
    expect(channelsMaxAgeMs(site(true))).toBe(DEFAULT_CHANNELS_MAX_AGE_DAYS * DAY_MS);
    expect(channelsMaxAgeMs(site({}))).toBe(DEFAULT_CHANNELS_MAX_AGE_DAYS * DAY_MS);
  });

  it('is whatever the site says, and never negative', () => {
    expect(channelsMaxAgeMs(site({ maxAgeDays: 7 }))).toBe(7 * DAY_MS);
    expect(channelsMaxAgeMs(site({ maxAgeDays: 0 }))).toBe(0);
    expect(channelsMaxAgeMs(site({ maxAgeDays: -3 }))).toBe(0);
  });
});

describe('SiteStateHandle', () => {
  it('reads nothing until something is asked for', async () => {
    const { store: counting, reads, release } = countingStore();

    SiteStateHandle.open(counting, SITE);
    release();

    expect(reads).toEqual([]);
  });

  it('reads a group once, however often it is asked for', async () => {
    const { store: counting, reads, release } = countingStore();
    const state = SiteStateHandle.open(counting, SITE);

    release();
    const first = await state.channels();
    const second = await state.channels();

    // The same group object back, and one question of the store.
    expect(second).toBe(first);
    expect(reads).toEqual([`${SITE}|channels`]);
  });

  it('makes two asks that overlap one question of the store', async () => {
    const { store: counting, reads, release } = countingStore();
    const state = SiteStateHandle.open(counting, SITE);

    // Both asked before either can answer, which is what two pipelines starting
    // at once look like. The promise is remembered, not just its result, so the
    // second joins the read already under way.
    const both = Promise.all([state.bag(), state.bag()]);

    release();

    const [first, second] = await both;

    expect(second).toBe(first);
    expect(reads).toEqual([`${SITE}|state`]);
  });

  it('keeps a channel list and gives it back while it is fresh', async () => {
    const shared = store();
    const list = [channel('one'), channel('two')];

    const first = SiteStateHandle.open(shared, SITE);

    expect((await first.channels()).fresh(DAY_MS, NOW)).toBeUndefined();
    (await first.channels()).set(list, NOW);
    await first.save();

    // A run of its own, as the next command would be.
    const second = SiteStateHandle.open(shared, SITE);

    expect((await second.channels()).fresh(DAY_MS, NOW)).toEqual(list);
    // An hour later it is still worth having; a day and a minute later it is not.
    expect((await second.channels()).fresh(DAY_MS, new Date(NOW.getTime() + 3_600_000))).toEqual(
      list,
    );
    expect(
      (await second.channels()).fresh(DAY_MS, new Date(NOW.getTime() + DAY_MS + 60_000)),
    ).toBeUndefined();
  });

  it('distrusts a list stamped in the future', async () => {
    const shared = store();

    await shared.setState(SITE, StateKey.CHANNELS, [channel('one')], {
      writtenAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
    });

    // A clock that moved, or a cache copied from another machine — either way
    // not something to keep for ever.
    const state = SiteStateHandle.open(shared, SITE);

    expect((await state.channels()).fresh(DAY_MS, NOW)).toBeUndefined();
  });

  it('gives up on a stored list that is not one', async () => {
    const shared = store();

    for (const stored of [42, 'a string', [{ nothing: 'like a channel' }], [null]]) {
      await shared.setState(SITE, StateKey.CHANNELS, stored, { writtenAt: NOW.toISOString() });

      const state = SiteStateHandle.open(shared, SITE);

      expect((await state.channels()).fresh(DAY_MS, NOW)).toBeUndefined();
    }
  });

  it('writes the groups that changed, and only those', async () => {
    const shared = store();
    const writes: string[] = [];
    const watched = wrapStore(shared, {
      async setState(site: string, key: string, data: unknown, meta?: { writtenAt?: string }) {
        writes.push(key);

        return shared.setState(site, key, data, meta);
      },
    });

    const state = SiteStateHandle.open(watched, SITE);
    const bag = await state.bag();

    await state.channels();

    // Read but untouched: nothing to write.
    await state.save();
    expect(writes).toEqual([]);

    bag.set('token', 'abc');
    await state.save();
    expect(writes).toEqual([StateKey.SITE]);

    // And once written it is what is stored, so a second save is a no-op.
    await state.save();
    expect(writes).toEqual([StateKey.SITE]);
  });

  it('keeps a bag as its entries, in the order they went in', async () => {
    const shared = store();
    const state = SiteStateHandle.open(shared, SITE);
    const bag = await state.bag<number>();

    // Keys that look like integers, which an object would have reordered to the
    // front — and the order is what a group ordered by use is ordered by.
    bag.set('10', 10);
    bag.set('cursor', 1);
    bag.set('2', 2);
    await state.save();

    expect((await shared.getState(SITE, StateKey.SITE))?.data).toEqual([
      ['10', 10],
      ['cursor', 1],
      ['2', 2],
    ]);

    const next = SiteStateHandle.open(shared, SITE);

    expect([...(await next.bag<number>())]).toEqual([
      ['10', 10],
      ['cursor', 1],
      ['2', 2],
    ]);
  });

  it('drops an unreadable pair rather than the bag it was in', async () => {
    const shared = store();

    await shared.setState(SITE, StateKey.SITE, [
      ['token', 'abc'],
      'not a pair',
      [42, 'key is not a string'],
      ['cursor', 7],
    ]);

    const state = SiteStateHandle.open(shared, SITE);

    // Forgetting one value is better than forgetting the token beside it.
    expect([...(await state.bag())]).toEqual([
      ['token', 'abc'],
      ['cursor', 7],
    ]);
  });

  it('starts a bag empty when what was stored is not one', async () => {
    const shared = store();

    await shared.setState(SITE, StateKey.SITE, { token: 'stored as an object' });

    const state = SiteStateHandle.open(shared, SITE);

    expect((await state.bag()).size).toBe(0);
  });

  it('keeps one named group apart from another', async () => {
    const shared = store();
    const state = SiteStateHandle.open(shared, SITE);

    (await state.bag<string>()).set('token', 'the site bag');
    (await state.bag<string>('validators')).set('https://example.test/g.xml', 'W/"1"');
    await state.save();

    expect((await shared.getState(SITE, StateKey.SITE))?.data).toEqual([['token', 'the site bag']]);
    expect((await shared.getState(SITE, 'validators'))?.data).toEqual([
      ['https://example.test/g.xml', 'W/"1"'],
    ]);
  });

  it('keeps one site apart from another', async () => {
    const shared = store();
    const mine = SiteStateHandle.open(shared, SITE);
    const theirs = SiteStateHandle.open(shared, 'other.example');

    (await mine.bag()).set('token', 'mine');
    (await theirs.bag()).set('token', 'theirs');
    await Promise.all([mine.save(), theirs.save()]);

    expect([...(await SiteStateHandle.open(shared, SITE).bag())]).toEqual([['token', 'mine']]);
    expect([...(await SiteStateHandle.open(shared, 'other.example').bag())]).toEqual([
      ['token', 'theirs'],
    ]);
  });
});
