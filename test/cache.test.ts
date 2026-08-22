import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_STALENESS,
  FsNdjsonCacheStore,
  FsXmltvCacheStore,
  isStale,
} from '../src/cache/main.js';
import type { StalenessPolicy } from '../src/cache/main.js';
import type { XmltvProgramme } from '../src/xmltv/types.js';

function programme(overrides: Partial<XmltvProgramme> = {}): XmltvProgramme {
  return {
    channel: 'one.example.com',
    start: new Date('2026-07-17T18:00:00.000Z'),
    stop: new Date('2026-07-17T19:00:00.000Z'),
    title: [{ value: 'Evening News', lang: 'en' }],
    ...overrides,
  };
}

describe('isStale', () => {
  const now = new Date('2026-07-17T12:00:00.000Z');
  const freshMeta = { grabbedAt: '2026-07-17T10:00:00.000Z', programmeCount: 3 };

  it('returns true when the entry is not cached', () => {
    expect(isStale('2026-07-20', undefined, DEFAULT_STALENESS, now)).toBe(true);
  });

  it('returns true for today when alwaysRefetchDays is 1, even when fresh', () => {
    expect(isStale('2026-07-17', freshMeta, DEFAULT_STALENESS, now)).toBe(true);
  });

  it('returns false for tomorrow when the entry is fresh', () => {
    expect(isStale('2026-07-18', freshMeta, DEFAULT_STALENESS, now)).toBe(false);
  });

  it('returns true when the entry is older than maxAgeDays', () => {
    const oldMeta = { grabbedAt: '2026-07-09T11:59:59.000Z', programmeCount: 3 };

    expect(isStale('2026-07-18', oldMeta, DEFAULT_STALENESS, now)).toBe(true);
  });

  it('does not force-refetch past days even inside the refetch window', () => {
    const policy: StalenessPolicy = { ...DEFAULT_STALENESS, alwaysRefetchDays: 5 };

    expect(isStale('2026-07-10', freshMeta, policy, now)).toBe(false);
  });

  it('respects a wider alwaysRefetchDays window for future days', () => {
    const policy: StalenessPolicy = { ...DEFAULT_STALENESS, alwaysRefetchDays: 3 };

    expect(isStale('2026-07-19', freshMeta, policy, now)).toBe(true);
    expect(isStale('2026-07-20', freshMeta, policy, now)).toBe(false);
  });

  it('treats an unparseable grabbedAt as stale', () => {
    const corruptMeta = { grabbedAt: 'not-a-date', programmeCount: 3 };

    expect(isStale('2026-07-20', corruptMeta, DEFAULT_STALENESS, now)).toBe(true);
  });

  describe('an entry that came back with no programmes', () => {
    // Hours old, so it is inside emptyMaxAgeDays as well as maxAgeDays.
    const emptyMeta = { grabbedAt: '2026-07-17T10:00:00.000Z', programmeCount: 0 };

    it('stays fresh on the run that wrote it', () => {
      expect(isStale('2026-07-20', emptyMeta, DEFAULT_STALENESS, now)).toBe(false);
    });

    it('goes stale a day later, while a full entry of the same age does not', () => {
      const yesterday = { grabbedAt: '2026-07-16T09:00:00.000Z', programmeCount: 0 };
      const full = { ...yesterday, programmeCount: 3 };

      expect(isStale('2026-07-20', yesterday, DEFAULT_STALENESS, now)).toBe(true);
      expect(isStale('2026-07-20', full, DEFAULT_STALENESS, now)).toBe(false);
    });

    it('is stale on any later run when emptyMaxAgeDays is 0', () => {
      const policy: StalenessPolicy = { ...DEFAULT_STALENESS, emptyMaxAgeDays: 0 };

      expect(isStale('2026-07-20', emptyMeta, policy, now)).toBe(true);
      // The entry this run just wrote is not yet older than "no days", so a
      // grab does not refetch what it has only now cached.
      expect(
        isStale('2026-07-20', { grabbedAt: now.toISOString(), programmeCount: 0 }, policy, now),
      ).toBe(false);
    });

    it('ages out with maxAgeDays when emptyMaxAgeDays is turned off', () => {
      const policy: StalenessPolicy = { ...DEFAULT_STALENESS, emptyMaxAgeDays: 7 };
      const yesterday = { grabbedAt: '2026-07-16T09:00:00.000Z', programmeCount: 0 };

      expect(isStale('2026-07-20', yesterday, policy, now)).toBe(false);
    });
  });
});

describe('FsNdjsonCacheStore cancellation', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'epg-cache-cancel-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const key = { site: 'example.com', channelId: 'one', day: '2026-07-17' };

  it('refuses a write, leaving no entry and no temp file behind', async () => {
    const controller = new AbortController();
    const store = new FsNdjsonCacheStore({ dir, signal: controller.signal });

    controller.abort(new Error('cancelled'));

    await expect(store.write(key, [programme()])).rejects.toMatchObject({ name: 'AbortError' });
    // The directory is made without a signal — `mkdir` takes none, and an empty
    // one costs nothing — but the entry is written beside its own path first, so
    // a refused write leaves neither it nor a temp file behind.
    expect(await fs.readdir(path.join(dir, 'example.com', 'one'))).toEqual([]);
  });

  it('refuses a read', async () => {
    const controller = new AbortController();
    await new FsNdjsonCacheStore({ dir }).write(key, [programme()]);

    const store = new FsNdjsonCacheStore({ dir, signal: controller.signal });
    controller.abort(new Error('cancelled'));

    await expect(store.read(key)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(store.getMeta(key)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('stops a prune between days, keeping what it has already removed', async () => {
    const seeding = new FsNdjsonCacheStore({ dir });

    for (const site of ['a.example', 'b.example', 'c.example']) {
      await seeding.write({ site, channelId: 'one', day: '2026-07-01' }, [programme()]);
    }

    const controller = new AbortController();
    const store = new FsNdjsonCacheStore({ dir, signal: controller.signal });
    controller.abort(new Error('cancelled'));

    // A prune is a walk, so this is where it can stop — having removed whole
    // days, never half of one. `readdir` and `rm` take no signal, so this is
    // our own `throwIfAborted`, which raises the reason rather than wrapping it
    // the way an aborted `fs` call does.
    await expect(store.prune({ before: '2026-07-17' })).rejects.toThrow('cancelled');
    expect((await fs.readdir(dir)).sort()).toEqual(['a.example', 'b.example', 'c.example']);
  });
});

describe('FsNdjsonCacheStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'epg-cache-test-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const key = { site: 'example.com', channelId: 'one', day: '2026-07-17' };

  it('makes a channel directory once, and again after a prune took it away', async () => {
    const store = new FsNdjsonCacheStore({ dir });
    const channelDir = path.join(dir, 'example.com', 'one');

    // Every day of a channel in turn — the shape of a grab.
    for (const day of ['2026-07-01', '2026-07-02', '2026-07-03']) {
      await store.write({ ...key, day }, [programme()]);
    }

    expect((await fs.readdir(channelDir)).length).toBe(6);

    // A prune that empties the channel takes its directory with it, so the
    // store must not go on believing it is there.
    expect(await store.prune({ before: '2026-07-17' })).toBe(3);
    await expect(fs.access(channelDir)).rejects.toMatchObject({ code: 'ENOENT' });

    await store.write(key, [programme()]);

    expect(await store.read(key)).toHaveLength(1);
  });

  it('round-trips programmes through ndjson with Dates revived', async () => {
    const store = new FsNdjsonCacheStore({ dir });
    const programmes = [
      programme(),
      programme({
        start: new Date('2026-07-17T19:00:00.000Z'),
        stop: new Date('2026-07-17T20:30:00.000Z'),
        title: [{ value: 'Movie Night' }],
        previouslyShown: {
          start: new Date('2026-01-02T20:00:00.000Z'),
          channel: 'two.example.com',
        },
      }),
    ];

    await store.write(key, programmes, { grabbedAt: '2026-07-17T08:00:00.000Z' });
    const read = await store.read(key);

    expect(read).toBeDefined();
    expect(read).toHaveLength(2);
    expect(read![0]!.start).toBeInstanceOf(Date);
    expect(read![0]!.stop).toBeInstanceOf(Date);
    expect(read![0]!.start.getTime()).toBe(Date.parse('2026-07-17T18:00:00.000Z'));
    expect(read![0]!.stop!.getTime()).toBe(Date.parse('2026-07-17T19:00:00.000Z'));
    expect(read![1]!.previouslyShown!.start).toBeInstanceOf(Date);
    expect(read![1]!.previouslyShown!.start!.getTime()).toBe(
      Date.parse('2026-01-02T20:00:00.000Z'),
    );
    expect(read).toEqual(programmes);
  });

  it('round-trips metadata through the sidecar file', async () => {
    const store = new FsNdjsonCacheStore({ dir });

    await store.write(key, [programme()], { grabbedAt: '2026-07-17T08:00:00.000Z' });

    expect(await store.getMeta(key)).toEqual({
      grabbedAt: '2026-07-17T08:00:00.000Z',
      programmeCount: 1,
    });
  });

  it('defaults grabbedAt to now when meta is omitted', async () => {
    const store = new FsNdjsonCacheStore({ dir });
    const before = Date.now();

    await store.write(key, []);
    const meta = await store.getMeta(key);

    expect(meta).toBeDefined();
    expect(meta!.programmeCount).toBe(0);
    expect(Date.parse(meta!.grabbedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(meta!.grabbedAt)).toBeLessThanOrEqual(Date.now());
  });

  it('returns undefined for uncached entries', async () => {
    const store = new FsNdjsonCacheStore({ dir });

    expect(await store.getMeta(key)).toBeUndefined();
    expect(await store.read(key)).toBeUndefined();
  });

  it('treats a corrupt meta sidecar as missing and deletes the entry', async () => {
    const store = new FsNdjsonCacheStore({ dir });

    await store.write(key, [programme()]);
    const base = path.join(dir, 'example.com', 'one', '2026-07-17');
    await fs.writeFile(`${base}.meta.json`, '{not json', 'utf8');

    expect(await store.getMeta(key)).toBeUndefined();
    expect(await store.read(key)).toBeUndefined();
    await expect(fs.access(`${base}.ndjson`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('treats a meta sidecar with a wrong shape as corrupt', async () => {
    const store = new FsNdjsonCacheStore({ dir });

    await store.write(key, [programme()]);
    const base = path.join(dir, 'example.com', 'one', '2026-07-17');
    await fs.writeFile(`${base}.meta.json`, '{"something":"else"}', 'utf8');

    expect(await store.getMeta(key)).toBeUndefined();
    await expect(fs.access(`${base}.ndjson`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('sanitizes site and channel path segments', async () => {
    const store = new FsNdjsonCacheStore({ dir });
    const trickyKey = { site: 'a/b', channelId: 'c:1/..', day: '2026-07-17' };

    await store.write(trickyKey, [programme()]);

    const file = path.join(
      dir,
      encodeURIComponent('a/b'),
      encodeURIComponent('c:1/..'),
      '2026-07-17.ndjson',
    );
    await expect(fs.access(file)).resolves.toBeUndefined();
    expect(await store.read(trickyKey)).toHaveLength(1);
  });

  it('deletes an entry including its sidecar', async () => {
    const store = new FsNdjsonCacheStore({ dir });

    await store.write(key, [programme()]);
    await store.delete(key);

    expect(await store.getMeta(key)).toBeUndefined();
    expect(await store.read(key)).toBeUndefined();
    // Deleting an entry that does not exist is a no-op.
    await expect(store.delete(key)).resolves.toBeUndefined();
  });

  it('keeps the offset and precision a date was written with', async () => {
    const { parseXmltvString, serializeProgramme, getXmltvOffset, getXmltvPrecision } =
      await import('../src/xmltv/main.js');
    const source =
      '<?xml version="1.0"?><tv><programme start="20260807203000 +0200" ' +
      'stop="20260807221500 +0200" channel="one.tv"><title>Film</title><date>2020</date>' +
      '<previously-shown start="20200101120000 +0200"/></programme></tv>';
    const original = parseXmltvString(source).programmes[0]!;

    for (const Store of [FsNdjsonCacheStore, FsXmltvCacheStore]) {
      const store = new Store({ dir: path.join(dir, Store.name) });
      await store.write(key, [original]);
      const [back] = (await store.read(key))!;

      // A `Date` is an instant; the offset the source wrote it in and how
      // precise it was live on symbol keys beside it, which JSON does not see.
      // So the entry holds the XMLTV form, and what comes back out serializes
      // to exactly what went in — `+0200` still, and a year still a year.
      expect(serializeProgramme(back!)).toBe(serializeProgramme(original));
      expect(getXmltvOffset(back!.start)).toBe(120);
      expect(back!.date).toBeInstanceOf(Date);
      expect(getXmltvPrecision(back!.date!)).toBe(4);
      expect(getXmltvOffset(back!.previouslyShown!.start!)).toBe(120);
    }
  });

  it('revives every date a programme can carry', async () => {
    const store = new FsNdjsonCacheStore({ dir });
    // Every date-valued field in the model, so a seventh one added to
    // `XmltvProgramme` without being taught to the store fails here rather than
    // coming back a string and throwing at the serializer — which is how the
    // production `<date>` was missed.
    const dated = programme({
      start: new Date('2026-07-17T18:00:00.000Z'),
      stop: new Date('2026-07-17T19:00:00.000Z'),
      pdcStart: new Date('2026-07-17T18:01:00.000Z'),
      vpsStart: new Date('2026-07-17T18:02:00.000Z'),
      date: new Date('2020-01-01T00:00:00.000Z'),
      previouslyShown: { start: new Date('2019-05-05T10:00:00.000Z'), channel: 'two.example' },
    });

    await store.write(key, [dated]);
    const [back] = (await store.read(key))!;

    for (const field of ['start', 'stop', 'pdcStart', 'vpsStart', 'date'] as const) {
      expect(back![field], field).toBeInstanceOf(Date);
      expect(back![field]!.toISOString(), field).toBe(dated[field]!.toISOString());
    }

    expect(back!.previouslyShown!.start).toBeInstanceOf(Date);
    expect(back!.previouslyShown!.start!.toISOString()).toBe('2019-05-05T10:00:00.000Z');
  });

  it('prunes entries older than the cutoff and removes empty directories', async () => {
    const store = new FsNdjsonCacheStore({ dir });

    await store.write({ site: 's1', channelId: 'c1', day: '2026-07-10' }, [programme()]);
    await store.write({ site: 's1', channelId: 'c1', day: '2026-07-15' }, [programme()]);
    await store.write({ site: 's1', channelId: 'c1', day: '2026-07-17' }, [programme()]);
    await store.write({ site: 's1', channelId: 'c2', day: '2026-07-10' }, [programme()]);
    await store.write({ site: 's2', channelId: 'c1', day: '2026-07-14' }, [programme()]);

    const removed = await store.prune({ before: '2026-07-16' });

    expect(removed).toBe(4);
    expect(await store.read({ site: 's1', channelId: 'c1', day: '2026-07-17' })).toHaveLength(1);
    expect(await store.read({ site: 's1', channelId: 'c1', day: '2026-07-15' })).toBeUndefined();
    await expect(fs.access(path.join(dir, 's1', 'c2'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(path.join(dir, 's2'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('leaves a directory that is not empty, without failing over it', async () => {
    const store = new FsNdjsonCacheStore({ dir });

    await store.write({ site: 's1', channelId: 'c1', day: '2026-07-10' }, [programme()]);
    // Something that is not an entry, so the day goes and the directory cannot.
    // Which is also what a grab writing the day it is grabbing looks like from
    // here: `rmdir` refusing is the check, rather than a `readdir` beforehand
    // that another process can make untrue in between.
    await fs.writeFile(path.join(dir, 's1', 'c1', 'notes.txt'), 'mine', 'utf8');

    expect(await store.prune({ before: '2026-07-16' })).toBe(1);

    expect(await fs.readdir(path.join(dir, 's1', 'c1'))).toEqual(['notes.txt']);
  });

  it('prune on a missing cache root returns 0', async () => {
    const store = new FsNdjsonCacheStore({ dir: path.join(dir, 'does-not-exist') });

    expect(await store.prune({ before: '2026-07-16' })).toBe(0);
  });
});

describe('FsXmltvCacheStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'epg-cache-xmltv-test-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const key = { site: 'example.com', channelId: 'one', day: '2026-07-17' };
  const base = () => path.join(dir, 'example.com', 'one', '2026-07-17');

  it('round-trips programmes through xmltv format', async () => {
    const store = new FsXmltvCacheStore({ dir });
    const programmes = [
      programme(),
      programme({ start: new Date('2026-07-17T19:00:00.000Z'), title: [{ value: 'Late Show' }] }),
    ];

    await store.write(key, programmes, { grabbedAt: '2026-07-17T08:00:00.000Z' });

    await expect(fs.access(`${base()}.xml`)).resolves.toBeUndefined();
    await expect(fs.access(`${base()}.ndjson`)).rejects.toMatchObject({ code: 'ENOENT' });

    const read = await store.read(key);

    expect(read).toHaveLength(2);
    expect(read![0]!.channel).toBe('one.example.com');
    expect(read![0]!.start).toBeInstanceOf(Date);
    expect(read![0]!.start.getTime()).toBe(Date.parse('2026-07-17T18:00:00.000Z'));
    expect(read![0]!.stop!.getTime()).toBe(Date.parse('2026-07-17T19:00:00.000Z'));
    expect(read![0]!.title[0]!.value).toBe('Evening News');
    expect(read![1]!.title[0]!.value).toBe('Late Show');
    expect(await store.getMeta(key)).toEqual({
      grabbedAt: '2026-07-17T08:00:00.000Z',
      programmeCount: 2,
    });
  });
});
