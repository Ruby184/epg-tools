import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_STALENESS, FsCacheStore, isStale } from '../src/cache/main.js';
import type { StalenessPolicy } from '../src/cache/main.js';
import type { XmltvProgramme } from '../src/xmltv/types.js';

// TODO: drop this probe (and the skipIf guards below) once src/xmltv/main.ts
// is merged; it is being implemented concurrently and may not exist yet.
const xmltvAvailable = await import('../src/xmltv/main.js').then(
  () => true,
  () => false,
);

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
    const policy: StalenessPolicy = { alwaysRefetchDays: 5, maxAgeDays: 7 };

    expect(isStale('2026-07-10', freshMeta, policy, now)).toBe(false);
  });

  it('respects a wider alwaysRefetchDays window for future days', () => {
    const policy: StalenessPolicy = { alwaysRefetchDays: 3, maxAgeDays: 7 };

    expect(isStale('2026-07-19', freshMeta, policy, now)).toBe(true);
    expect(isStale('2026-07-20', freshMeta, policy, now)).toBe(false);
  });

  it('treats an unparseable grabbedAt as stale', () => {
    const corruptMeta = { grabbedAt: 'not-a-date', programmeCount: 3 };

    expect(isStale('2026-07-20', corruptMeta, DEFAULT_STALENESS, now)).toBe(true);
  });
});

describe('FsCacheStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'epg-cache-test-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const key = { site: 'example.com', channelId: 'one', day: '2026-07-17' };

  it('round-trips programmes through ndjson with Dates revived', async () => {
    const store = new FsCacheStore({ dir });
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
    const store = new FsCacheStore({ dir });

    await store.write(key, [programme()], { grabbedAt: '2026-07-17T08:00:00.000Z' });

    expect(await store.getMeta(key)).toEqual({
      grabbedAt: '2026-07-17T08:00:00.000Z',
      programmeCount: 1,
    });
  });

  it('defaults grabbedAt to now when meta is omitted', async () => {
    const store = new FsCacheStore({ dir });
    const before = Date.now();

    await store.write(key, []);
    const meta = await store.getMeta(key);

    expect(meta).toBeDefined();
    expect(meta!.programmeCount).toBe(0);
    expect(Date.parse(meta!.grabbedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(meta!.grabbedAt)).toBeLessThanOrEqual(Date.now());
  });

  it('returns undefined for uncached entries', async () => {
    const store = new FsCacheStore({ dir });

    expect(await store.getMeta(key)).toBeUndefined();
    expect(await store.read(key)).toBeUndefined();
  });

  it('treats a corrupt meta sidecar as missing and deletes the entry', async () => {
    const store = new FsCacheStore({ dir });

    await store.write(key, [programme()]);
    const base = path.join(dir, 'example.com', 'one', '2026-07-17');
    await fs.writeFile(`${base}.meta.json`, '{not json', 'utf8');

    expect(await store.getMeta(key)).toBeUndefined();
    expect(await store.read(key)).toBeUndefined();
    await expect(fs.access(`${base}.ndjson`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('treats a meta sidecar with a wrong shape as corrupt', async () => {
    const store = new FsCacheStore({ dir });

    await store.write(key, [programme()]);
    const base = path.join(dir, 'example.com', 'one', '2026-07-17');
    await fs.writeFile(`${base}.meta.json`, '{"something":"else"}', 'utf8');

    expect(await store.getMeta(key)).toBeUndefined();
    await expect(fs.access(`${base}.ndjson`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('sanitizes site and channel path segments', async () => {
    const store = new FsCacheStore({ dir });
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
    const store = new FsCacheStore({ dir });

    await store.write(key, [programme()]);
    await store.delete(key);

    expect(await store.getMeta(key)).toBeUndefined();
    expect(await store.read(key)).toBeUndefined();
    // Deleting an entry that does not exist is a no-op.
    await expect(store.delete(key)).resolves.toBeUndefined();
  });

  it('prunes entries older than the cutoff and removes empty directories', async () => {
    const store = new FsCacheStore({ dir });

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

  it('prune on a missing cache root returns 0', async () => {
    const store = new FsCacheStore({ dir: path.join(dir, 'does-not-exist') });

    expect(await store.prune({ before: '2026-07-16' })).toBe(0);
  });

  it('reads an ndjson entry with a store configured for xmltv format', async () => {
    const ndjsonStore = new FsCacheStore({ dir });
    const xmltvStore = new FsCacheStore({ dir, format: 'xmltv' });

    await ndjsonStore.write(key, [programme()]);
    const read = await xmltvStore.read(key);

    expect(read).toHaveLength(1);
    expect(read![0]!.start.getTime()).toBe(Date.parse('2026-07-17T18:00:00.000Z'));
  });
});

// TODO: remove skipIf once src/xmltv/main.ts exists (implemented concurrently).
describe.skipIf(!xmltvAvailable)('FsCacheStore (xmltv format)', () => {
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
    const store = new FsCacheStore({ dir, format: 'xmltv' });
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

  it('reads an xmltv entry with a store configured for ndjson format', async () => {
    const xmltvStore = new FsCacheStore({ dir, format: 'xmltv' });
    const ndjsonStore = new FsCacheStore({ dir });

    await xmltvStore.write(key, [programme()]);
    const read = await ndjsonStore.read(key);

    expect(read).toHaveLength(1);
    expect(read![0]!.start.getTime()).toBe(Date.parse('2026-07-17T18:00:00.000Z'));
  });

  it('writing replaces a stale opposite-format data file', async () => {
    const ndjsonStore = new FsCacheStore({ dir });
    const xmltvStore = new FsCacheStore({ dir, format: 'xmltv' });

    await ndjsonStore.write(key, [programme()]);
    await xmltvStore.write(key, [programme(), programme({ title: [{ value: 'Second' }] })]);

    await expect(fs.access(`${base()}.ndjson`)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await ndjsonStore.read(key)).toHaveLength(2);

    await ndjsonStore.write(key, [programme()]);

    await expect(fs.access(`${base()}.xml`)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await xmltvStore.read(key)).toHaveLength(1);
  });
});
