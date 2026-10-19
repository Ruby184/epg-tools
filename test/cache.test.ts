import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CACHE_SCHEMA,
  CacheManager,
  DEFAULT_STALENESS,
  type FsCacheDriver,
  FsNdjsonCacheDriver,
  FsXmltvCacheDriver,
  MemoryCacheDriver,
  NoCacheDriver,
  STATE_SCHEMA,
  isStale,
} from '../src/cache/main.js';
import type {
  CacheDriver,
  CacheEntryMeta,
  CachedKey,
  CacheListOptions,
  ChannelDayKey,
  FoundEntry,
  FoundMeta,
  FoundState,
  FsCacheDriverOptions,
  StalenessPolicy,
  StoredEntryMeta,
  StoredProgramme,
  StoredStateMeta,
} from '../src/cache/main.js';
import { CODECS, CorruptEntryError, type CacheCodec, type CodecName } from '../src/cache/codec.js';
import {
  getXmltvOffset,
  getXmltvPrecision,
  parseXmltvDate,
  parseXmltvString,
} from '../src/xmltv/main.js';
import type { XmltvProgramme } from '../src/xmltv/types.js';

/**
 * The cache as a run sees it: a driver with the manager in front of it, which is
 * where the meta an entry carries is stamped, and where what it says is judged.
 * Tests that are about one driver's own storage reach for the driver instead.
 */
function cache(driver: CacheDriver): CacheManager {
  return new CacheManager({ driver });
}

function ndjson(options: FsCacheDriverOptions): CacheManager {
  return cache(new FsNdjsonCacheDriver(options));
}

function xmltv(options: FsCacheDriverOptions): CacheManager {
  return cache(new FsXmltvCacheDriver(options));
}

/** What the manager stamps onto an entry written now, over what a test says. */
function stamped(meta: CacheEntryMeta): StoredEntryMeta {
  return { ...meta, schema: CACHE_SCHEMA, writtenBy: __PKG_VERSION__ };
}

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

  it('takes today on the zone’s calendar when it is given one', () => {
    // Half past midnight in Bratislava, still the 17th in UTC: the 18th is
    // today there, and always fetched again.
    const lateNight = new Date('2026-07-17T22:30:00.000Z');

    expect(
      isStale('2026-07-18', freshMeta, DEFAULT_STALENESS, lateNight, 'Europe/Bratislava'),
    ).toBe(true);
    expect(isStale('2026-07-18', freshMeta, DEFAULT_STALENESS, lateNight, 'UTC')).toBe(false);
  });

  it('counts a day of another calendar by the hours it shares with the zone’s today', () => {
    // Half past midnight on the 18th in Bratislava, still the 17th in UTC. The
    // 18th there runs from 22:00 UTC on the 17th to 22:00 UTC on the 18th.
    const lateNight = new Date('2026-07-17T22:30:00.000Z');
    const stale = (day: string) =>
      isStale(day, freshMeta, DEFAULT_STALENESS, lateNight, 'Europe/Bratislava', 'UTC');

    expect(stale('2026-07-17')).toBe(true);
    // Most of today there, though by its date it is tomorrow in UTC.
    expect(stale('2026-07-18')).toBe(true);
    expect(stale('2026-07-19')).toBe(false);
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

describe('a cache of ndjson files, cancelled', () => {
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
    const store = ndjson({ dir, signal: controller.signal });

    controller.abort(new Error('cancelled'));

    await expect(store.write(key, [programme()])).rejects.toMatchObject({ name: 'AbortError' });
    // Nothing whatever: a write goes out before the directory is made sure of,
    // and the directory is only made when the write says it is missing — so a
    // refused write leaves no entry, no temp file, and no path made to hold
    // either.
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('refuses a read', async () => {
    const controller = new AbortController();
    await ndjson({ dir }).write(key, [programme()]);

    const store = ndjson({ dir, signal: controller.signal });
    controller.abort(new Error('cancelled'));

    // `readFile` carries the signal, so an aborted read raises Node's own
    // `AbortError`. A staleness check opens the entry and reads the front of it,
    // and neither of those takes a signal — so it asks, and raises the reason.
    await expect(store.read(key)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(store.getMeta(key)).rejects.toThrow('cancelled');
  });

  it('stops reading an entry between chunks, not only before the first', async () => {
    const controller = new AbortController();
    let taken = 0;

    // How many chunks the front of an entry is worth is `parseMeta`'s to decide,
    // and a document whose root never arrives has it reading to the scan limit —
    // so a cancelled run has to stop inside that loop, not merely before it.
    class Counting extends FsNdjsonCacheDriver {
      protected override async parseMeta(
        chunks: AsyncIterable<Uint8Array>,
      ): Promise<Partial<CacheEntryMeta> | undefined> {
        for await (const _chunk of chunks) {
          taken++;
          controller.abort(new Error('cancelled'));
        }

        return undefined;
      }
    }

    // Entries big enough that their front is several chunks over.
    const many = Array.from({ length: 200 }, () => programme());
    await ndjson({ dir }).write(key, many);

    await expect(
      cache(new Counting({ dir, signal: controller.signal })).getMeta(key),
    ).rejects.toThrow('cancelled');
    // The one it had already taken when the run was cancelled, and no more.
    expect(taken).toBe(1);
  });

  it('stops a prune between days, keeping what it has already removed', async () => {
    const seeding = ndjson({ dir });

    for (const site of ['a.example', 'b.example', 'c.example']) {
      await seeding.write({ site, channelId: 'one', day: '2026-07-01' }, [programme()]);
    }

    const controller = new AbortController();
    const store = ndjson({ dir, signal: controller.signal });
    controller.abort(new Error('cancelled'));

    // A prune is a walk, so this is where it can stop — having removed whole
    // days, never half of one. `readdir` and `rm` take no signal, so this is
    // our own `throwIfAborted`, which raises the reason rather than wrapping it
    // the way an aborted `fs` call does.
    await expect(store.prune({ before: '2026-07-17' })).rejects.toThrow('cancelled');
    expect((await fs.readdir(dir)).sort()).toEqual(['a.example', 'b.example', 'c.example']);
  });
});

describe('a cache of ndjson files', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'epg-cache-test-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const key = { site: 'example.com', channelId: 'one', day: '2026-07-17' };

  it('writes every day of a channel, and again after a prune took the directory', async () => {
    const store = ndjson({ dir });
    const channelDir = path.join(dir, 'example.com', 'one');

    // Every day of a channel in turn — the shape of a grab.
    for (const day of ['2026-07-01', '2026-07-02', '2026-07-03']) {
      await store.write({ ...key, day }, [programme()]);
    }

    // One file per channel-day, meta and all.
    expect((await fs.readdir(channelDir)).length).toBe(3);

    // A prune that empties the channel takes its directory with it, and the
    // next write has to find that out and make it again.
    expect(await store.prune({ before: '2026-07-17' })).toBe(3);
    await expect(fs.access(channelDir)).rejects.toMatchObject({ code: 'ENOENT' });

    await store.write(key, [programme()]);

    expect(await store.read(key)).toHaveLength(1);
  });

  it.each(['..', '.'])(
    'keeps an entry inside the cache when a key segment is %j',
    async (segment) => {
      // A channel id comes off a site's own channel list, which is not this
      // package's to trust. `encodeURIComponent` neutralizes a separator but not a
      // dot, and `.`/`..` are the filesystem's words for "here" and "one up".
      const cacheDir = path.join(dir, 'below', 'cache');
      const store = ndjson({ dir: cacheDir });
      const traversing = { site: segment, channelId: segment, day: '2026-07-17' };

      await store.write(traversing, [programme()]);

      // Nothing climbed out: the cache is still the only thing under `below`.
      expect(await fs.readdir(path.join(dir, 'below'))).toEqual(['cache']);
      expect(await store.read(traversing)).toHaveLength(1);
    },
  );

  it('leaves an ordinary site and channel where they already were', async () => {
    // The encoding only touches a segment that is nothing but dots, so no cache
    // written before it is invalidated by it.
    await ndjson({ dir }).write({ site: 'example.com', channelId: 'one.tv', day: '2026-07-17' }, [
      programme(),
    ]);

    await expect(
      fs.access(path.join(dir, 'example.com', 'one.tv', '2026-07-17.ndjson')),
    ).resolves.toBeUndefined();
  });

  it.each([
    ['the channel directory', 'example.com'],
    // `mkdir -p` makes the whole path back, so how much went does not matter.
    ['the whole cache', '.'],
  ])('makes the path again when something outside this run removed %s', async (_what, target) => {
    const store = ndjson({ dir });

    await store.write(key, [programme()]);
    expect(await store.read(key)).toHaveLength(1);

    // Another grab's prune, a `rm -rf`, a tmp reaper: a cache directory is not
    // this process's to go on assuming anything about, and the write is where
    // it finds out.
    await fs.rm(path.join(dir, target), { recursive: true, force: true });
    expect(await store.read(key)).toBeUndefined();

    await store.write(key, [programme()]);

    expect(await store.read(key)).toHaveLength(1);
  });

  it('round-trips programmes through ndjson with Dates revived', async () => {
    const store = ndjson({ dir });
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

  it('round-trips metadata through the entry itself', async () => {
    const store = ndjson({ dir });

    await store.write(key, [programme()], { grabbedAt: '2026-07-17T08:00:00.000Z' });

    expect(await store.getMeta(key)).toEqual(
      stamped({ grabbedAt: '2026-07-17T08:00:00.000Z', programmeCount: 1 }),
    );
  });

  it('defaults grabbedAt to now when meta is omitted', async () => {
    const store = ndjson({ dir });
    const before = Date.now();

    await store.write(key, []);
    const meta = await store.getMeta(key);

    expect(meta).toBeDefined();
    expect(meta!.programmeCount).toBe(0);
    expect(Date.parse(meta!.grabbedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(meta!.grabbedAt)).toBeLessThanOrEqual(Date.now());
  });

  it('returns undefined for uncached entries', async () => {
    const store = ndjson({ dir });

    expect(await store.getMeta(key)).toBeUndefined();
    expect(await store.read(key)).toBeUndefined();
  });

  it('treats an entry whose meta line is corrupt as missing, and removes it', async () => {
    const store = ndjson({ dir });
    const file = path.join(dir, 'example.com', 'one', '2026-07-17.ndjson');

    for (const head of ['{not json', '{"something":"else"}', 'no newline at all']) {
      await store.write(key, [programme()]);
      const body = (await fs.readFile(file, 'utf8')).split('\n').slice(1).join('\n');
      await fs.writeFile(file, `${head}\n${body}`, 'utf8');

      // An entry that cannot say when it was grabbed is one nothing can be
      // decided about, so it goes and the day is grabbed again.
      expect(await store.getMeta(key), head).toBeUndefined();
      await expect(fs.access(file)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('reads the meta of an entry whose preamble outruns the head', async () => {
    const store = ndjson({ dir });
    const file = path.join(dir, 'example.com', 'one', '2026-07-17.ndjson');

    await store.write(key, [programme()]);

    // A meta line longer than the head a staleness check reads, which is a
    // reason to look at the whole entry rather than to throw it away.
    const [meta, ...body] = (await fs.readFile(file, 'utf8')).split('\n');
    const padded = JSON.stringify({ ...JSON.parse(meta!), note: 'x'.repeat(600) });
    await fs.writeFile(file, [padded, ...body].join('\n'), 'utf8');

    expect(await store.getMeta(key)).toMatchObject({ programmeCount: 1 });
    await expect(fs.access(file)).resolves.toBeUndefined();
  });

  it('sanitizes site and channel path segments', async () => {
    const store = ndjson({ dir });
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

  it('deletes an entry, meta and all', async () => {
    const store = ndjson({ dir });

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

    for (const Driver of [FsNdjsonCacheDriver, FsXmltvCacheDriver]) {
      const store = cache(new Driver({ dir: path.join(dir, Driver.name) }));
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
    const store = ndjson({ dir });
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
    const store = ndjson({ dir });

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
    const store = ndjson({ dir });

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
    const store = ndjson({ dir: path.join(dir, 'does-not-exist') });

    expect(await store.prune({ before: '2026-07-16' })).toBe(0);
  });
});

describe('a cache of xmltv files', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'epg-cache-xmltv-test-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const key = { site: 'example.com', channelId: 'one', day: '2026-07-17' };
  const base = () => path.join(dir, 'example.com', 'one', '2026-07-17');

  it('gives up on an entry whose root element is not <tv>', async () => {
    const store = xmltv({ dir });

    await store.write(key, [programme()]);
    await fs.writeFile(`${base()}.xml`, '<?xml version="1.0"?><guide><programme/></guide>', 'utf8');

    // The scanner says so by throwing, which here is an entry to grab again
    // rather than a failure to report.
    expect(await store.getMeta(key)).toBeUndefined();
    await expect(fs.access(`${base()}.xml`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('carries its meta in an instruction, and stays a valid document', async () => {
    const store = xmltv({ dir });

    await store.write(key, [programme(), programme({ title: [{ value: 'Second' }] })], {
      grabbedAt: '2026-07-17T08:00:00.000Z',
    });

    const document = await fs.readFile(`${base()}.xml`, 'utf8');

    // The root element says when, as XMLTV does; the count has no attribute the
    // DTD would allow, so the whole meta goes where XML puts things meant for
    // one reader.
    expect(document).toContain('<tv date="20260717080000 +0000">');
    expect(document).toContain(
      `<?epg-cache {"grabbedAt":"2026-07-17T08:00:00.000Z","programmeCount":2,` +
        `"schema":${CACHE_SCHEMA},"writtenBy":"${__PKG_VERSION__}"}?>`,
    );
    expect(await store.getMeta(key)).toEqual(
      stamped({ grabbedAt: '2026-07-17T08:00:00.000Z', programmeCount: 2 }),
    );
  });

  it('escapes `>` in its meta so no field can truncate the instruction', async () => {
    const { parseXmltvString } = await import('../src/xmltv/main.js');

    // `?>` ends an instruction and XML has no escape for it, so the JSON has to
    // carry the `>` in a form XML cannot see. Today's meta is four fields that
    // cannot hold one; the guard is for the first field that can. Reached
    // through `entryData` because `write` builds the meta itself.
    class Exposed extends FsXmltvCacheDriver {
      data(meta: StoredEntryMeta): string {
        return Buffer.concat(this.entry(CODECS.xmltv.encode([programme()]), meta)).toString();
      }
    }

    const meta = {
      grabbedAt: '2026-07-17T08:00:00.000Z',
      programmeCount: 1,
      schema: CACHE_SCHEMA,
      writtenBy: __PKG_VERSION__,
      note: 'what?> now',
    } as StoredEntryMeta;

    const document = new Exposed({ dir }).data(meta);

    expect(document).not.toContain('what?>');
    expect(document).toContain('what?\\u003e now');

    // Still one instruction holding the whole meta, and it reads back intact.
    const [instruction] = parseXmltvString(document).processingInstructions;

    expect(instruction).toMatchObject({ target: 'epg-cache', position: 'root' });
    expect(JSON.parse(instruction!.data)).toEqual(meta);
  });

  it('will not take its meta from a prolog instruction', async () => {
    const store = xmltv({ dir });

    await store.write(key, [programme()], { grabbedAt: '2026-07-17T08:00:00.000Z' });

    // The same instruction, moved ahead of the root — and the root replaced with
    // something that is not a guide at all. A prolog one is parsed before the
    // root is, so trusting it would mean trusting this file.
    await fs.writeFile(
      `${base()}.xml`,
      '<?xml version="1.0"?><?epg-cache {"grabbedAt":"2026-07-17T08:00:00.000Z",' +
        '"programmeCount":9}?><guide><programme/></guide>',
      'utf8',
    );

    expect(await store.getMeta(key)).toBeUndefined();
  });

  it('steps over an instruction meant for another reader', async () => {
    const store = xmltv({ dir });

    await store.write(key, [programme()], { grabbedAt: '2026-07-17T08:00:00.000Z' });

    const document = await fs.readFile(`${base()}.xml`, 'utf8');
    // Someone else's instruction, ahead of this store's own.
    await fs.writeFile(
      `${base()}.xml`,
      document.replace('<?epg-cache', '<?other-reader hello?><?epg-cache'),
      'utf8',
    );

    expect(await store.getMeta(key)).toMatchObject({ programmeCount: 1 });
  });

  it('round-trips programmes through xmltv format', async () => {
    const store = xmltv({ dir });
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
    expect(await store.getMeta(key)).toEqual(
      stamped({ grabbedAt: '2026-07-17T08:00:00.000Z', programmeCount: 2 }),
    );
  });
});

describe("a site's own state, kept as files", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'epg-cache-test-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const site = 'example.com';

  it('keeps one file per group, beside the channels of the same site', async () => {
    const store = ndjson({ dir });

    await store.setState(site, 'channels', [{ xmltvId: 'one.example.com', siteId: '1' }]);
    await store.write({ site, channelId: 'one.example.com', day: '2026-07-17' }, [programme()]);

    // A group is a file in the site's directory; a channel is a directory in it.
    // Which is also why a channel called `channels` collides with nothing: the
    // group carries the extension.
    expect((await fs.readdir(path.join(dir, site))).sort()).toEqual([
      'channels.json',
      'one.example.com',
    ]);

    const found = await store.getState(site, 'channels');

    expect(found?.data).toEqual([{ xmltvId: 'one.example.com', siteId: '1' }]);
    expect(found?.meta).toMatchObject({ schema: STATE_SCHEMA });
  });

  it('writes one group without standing on another', async () => {
    const store = ndjson({ dir });

    await store.setState(site, 'channels', ['first'], { writtenAt: '2026-07-17T08:00:00.000Z' });
    await store.setState(site, 'validators', { 'https://example.com/g.xml': { etag: 'W/"1"' } });

    // The point of a key: refreshing the validators leaves the channel list
    // exactly as it was, including when it was written.
    await store.setState(site, 'validators', { 'https://example.com/g.xml': { etag: 'W/"2"' } });

    expect(await store.getState(site, 'channels')).toEqual({
      data: ['first'],
      meta: expect.objectContaining({ writtenAt: '2026-07-17T08:00:00.000Z' }),
    });
    expect((await store.getState(site, 'validators'))?.data).toEqual({
      'https://example.com/g.xml': { etag: 'W/"2"' },
    });
  });

  it('reads nothing for a group nothing has written, and for a site with no directory', async () => {
    const store = ndjson({ dir });

    expect(await store.getState(site, 'channels')).toBeUndefined();

    await store.setState(site, 'channels', ['first']);

    expect(await store.getState(site, 'validators')).toBeUndefined();
    expect(await store.getState('other.example', 'channels')).toBeUndefined();
  });

  it('treats a group it cannot read as one to remove, so it is written again', async () => {
    const store = ndjson({ dir });
    const file = path.join(dir, site, 'channels.json');

    await store.setState(site, 'channels', ['first']);
    await fs.writeFile(file, '{ not json at all');

    // There is a file, and nothing in it anybody can read — so it goes, and the
    // group reads as never written rather than as an empty one.
    expect(await store.getState(site, 'channels')).toBeUndefined();
    await expect(fs.stat(file)).rejects.toThrow();

    await store.setState(site, 'channels', ['again']);
    expect((await store.getState(site, 'channels'))?.data).toEqual(['again']);
  });

  it('sanitizes the site and the key, and makes the directory it needs', async () => {
    const store = ndjson({ dir });

    await store.setState('../escape/../..', '../..', ['held']);

    // Encoded, so a group of a site named out of a channel list stays inside the
    // cache directory — the same treatment a site or a channel id gets.
    expect((await fs.readdir(dir)).sort()).toEqual(['..%2Fescape%2F..%2F..']);
    expect((await store.getState('../escape/../..', '../..'))?.data).toEqual(['held']);
  });

  it('survives a prune, which only ever looks at the days', async () => {
    const store = ndjson({ dir });

    await store.setState(site, 'channels', ['kept']);
    await store.write({ site, channelId: 'one', day: '2026-07-10' }, [programme()]);

    expect(await store.prune({ before: '2026-07-17' })).toBe(1);

    // The channel's directory went with its last day; the state did not, and the
    // site's directory stayed for it.
    expect(await fs.readdir(path.join(dir, site))).toEqual(['channels.json']);
    expect((await store.getState(site, 'channels'))?.data).toEqual(['kept']);
  });

  it('refuses to write once the run is cancelled', async () => {
    const controller = new AbortController();
    const store = ndjson({ dir, signal: controller.signal });

    await store.setState(site, 'channels', ['before']);
    controller.abort();

    await expect(store.setState(site, 'channels', ['after'])).rejects.toThrow();
    expect((await ndjson({ dir }).getState(site, 'channels'))?.data).toEqual(['before']);
  });
});

describe('CacheManager', () => {
  const key = { site: 'example.com', channelId: 'one', day: '2026-07-17' };

  /**
   * A driver of the ordinary kind: it keeps JSON somewhere and says nothing
   * about dates, which is what makes it the one to test the manager with — and
   * what a driver written outside this package looks like. What it holds is
   * exactly what it was given, so a test can read it, or spoil it.
   */
  class RecordingDriver implements CacheDriver {
    readonly codec = 'json' as const;
    readonly entries = new Map<string, { meta: StoredEntryMeta; body: Uint8Array }>();
    /** What each site remembers, by `site|key`, for a test to read or to spoil. */
    readonly groups = new Map<string, { meta: Partial<StoredStateMeta>; data: unknown }>();
    deletes: string[] = [];
    stateDeletes: string[] = [];
    closed = 0;

    #id(key: ChannelDayKey): string {
      return `${key.site}|${key.channelId}|${key.day}`;
    }

    /** What the store holds for a key, for a test to read or to spoil. */
    stored(key: ChannelDayKey): { meta: StoredEntryMeta; body: Uint8Array } {
      return this.entries.get(this.#id(key))!;
    }

    /** The records the bytes for a key hold, as the `json` codec wrote them. */
    records(key: ChannelDayKey): StoredProgramme[] {
      return JSON.parse(new TextDecoder().decode(this.stored(key).body)) as StoredProgramme[];
    }

    async readMeta(key: ChannelDayKey): Promise<FoundMeta | undefined> {
      const entry = this.entries.get(this.#id(key));

      return entry && { meta: entry.meta };
    }

    async read(key: ChannelDayKey): Promise<FoundEntry | undefined> {
      return this.entries.get(this.#id(key));
    }

    async write(key: ChannelDayKey, body: Uint8Array, meta: StoredEntryMeta): Promise<void> {
      this.entries.set(this.#id(key), { meta, body });
    }

    async delete(key: ChannelDayKey): Promise<void> {
      this.deletes.push(this.#id(key));
      this.entries.delete(this.#id(key));
    }

    async prune(): Promise<number> {
      return 0;
    }

    async readState(site: string, key: string): Promise<FoundState | undefined> {
      return this.groups.get(`${site}|${key}`);
    }

    async writeState(
      site: string,
      key: string,
      data: unknown,
      meta: StoredStateMeta,
    ): Promise<void> {
      this.groups.set(`${site}|${key}`, { meta, data });
    }

    async deleteState(site: string, key: string): Promise<void> {
      this.stateDeletes.push(`${site}|${key}`);
      this.groups.delete(`${site}|${key}`);
    }

    async *list(): AsyncIterable<CachedKey> {
      for (const id of this.entries.keys()) {
        const [site = '', channelId = '', day = ''] = id.split('|');

        yield { kind: 'entry', key: { site, channelId, day } };
      }

      for (const id of this.groups.keys()) {
        const [site = '', key = ''] = id.split('|');

        yield { kind: 'state', site, key };
      }
    }

    async close(): Promise<void> {
      this.closed++;
    }
  }

  it('gives an inherited driver dates it can store, and Dates back', async () => {
    const driver = new RecordingDriver();
    const store = cache(driver);
    const [original] = parseXmltvString(
      '<?xml version="1.0"?><tv><programme start="20260807203000 +0200" channel="one.tv">' +
        '<title>Film</title><date>2020</date></programme></tv>',
    ).programmes;

    await store.write(key, [original!]);

    // Nothing the driver holds is a `Date`: neither the offset nor the precision
    // would have survived `JSON.stringify`, so the record keeps the XMLTV form.
    // A driver that names `json` keeps exactly what that codec wrote.
    const [record] = driver.records(key);

    expect(record!.start).toBe('20260807203000 +0200');
    expect(record!.date).toBe('2020');
    expect(JSON.parse(JSON.stringify(record))).toEqual(record);

    // And what the store holds is what comes back, both of them intact.
    const [back] = (await store.read(key))!;

    expect(back!.start).toBeInstanceOf(Date);
    expect(getXmltvOffset(back!.start)).toBe(120);
    expect(back!.date).toBeInstanceOf(Date);
    expect(getXmltvPrecision(back!.date!)).toBe(4);
  });

  it('leaves the caller their own programmes, unconverted', async () => {
    const mine = programme({ previouslyShown: { start: new Date('2019-05-05T10:00:00.000Z') } });

    await cache(new RecordingDriver()).write(key, [mine]);

    // A record is a copy: a caller that goes on using its programmes after
    // caching them must not find their dates turned into strings underneath.
    expect(mine.start).toBeInstanceOf(Date);
    expect(mine.previouslyShown!.start).toBeInstanceOf(Date);
  });

  it('counts the programmes itself rather than believing the caller', async () => {
    const driver = new RecordingDriver();

    await cache(driver).write(key, [programme(), programme()], {
      grabbedAt: '2026-07-17T08:00:00.000Z',
      programmeCount: 99,
    });

    // The count is what a staleness check reads instead of the programmes, so it
    // has to be the programmes. `grabbedAt` is the caller's to say.
    expect(driver.stored(key).meta).toEqual(
      stamped({ grabbedAt: '2026-07-17T08:00:00.000Z', programmeCount: 2 }),
    );
  });

  it('removes an entry that cannot answer for itself, and only that', async () => {
    const driver = new RecordingDriver();
    const store = cache(driver);

    await store.write(key, [programme()]);
    // Whatever was last written there: an older version's meta, a half-finished
    // write, somebody with an editor.
    driver.stored(key).meta = { grabbedAt: '2026-07-17T08:00:00.000Z' } as StoredEntryMeta;

    expect(await store.getMeta(key)).toBeUndefined();
    expect(driver.deletes).toEqual(['example.com|one|2026-07-17']);

    // A day never grabbed is the common case by far, and nothing to remove — a
    // manager that could not tell the two apart would be asking the store to
    // delete a thousand entries a run that were never there.
    expect(await store.getMeta({ ...key, day: '2026-07-18' })).toBeUndefined();
    expect(driver.deletes).toHaveLength(1);
  });

  it('will not serve an entry whose meta it would not trust', async () => {
    const driver = new RecordingDriver();
    const store = cache(driver);

    await store.write(key, [programme()]);
    driver.stored(key).meta = undefined as unknown as StoredEntryMeta;

    expect(await store.read(key)).toBeUndefined();
    expect(driver.deletes).toEqual(['example.com|one|2026-07-17']);
  });

  it('stamps what the entry is and who wrote it', async () => {
    const driver = new RecordingDriver();

    await cache(driver).write(key, [programme()]);

    // Neither is the caller's to say: they are facts about the writing, and what
    // makes reading the entry back later a decision rather than a guess.
    expect(driver.stored(key).meta).toMatchObject({
      schema: CACHE_SCHEMA,
      writtenBy: __PKG_VERSION__,
    });
  });

  it('voids an entry whose schema is not the one this code writes', async () => {
    const driver = new RecordingDriver();
    const store = cache(driver);

    for (const schema of [CACHE_SCHEMA - 1, CACHE_SCHEMA + 1, undefined]) {
      await store.write(key, [programme()]);
      driver.stored(key).meta.schema = schema as number;

      // Older or newer makes no difference: a shape this code does not write is
      // one it cannot read as it was meant, and a day of listings costs one
      // request to grab again.
      expect(await store.getMeta(key), String(schema)).toBeUndefined();
      expect(driver.entries.has('example.com|one|2026-07-17')).toBe(false);
    }
  });

  it('voids an entry that does not say who wrote it', async () => {
    const driver = new RecordingDriver();
    const store = cache(driver);

    await store.write(key, [programme()]);
    driver.stored(key).meta.writtenBy = undefined as unknown as string;

    expect(await store.getMeta(key)).toBeUndefined();
  });

  it('asks invalidate about an entry it would otherwise have kept', async () => {
    const driver = new RecordingDriver();
    const asked: Array<[string, string]> = [];
    const store = new CacheManager({
      driver,
      // What the schema number cannot express: a release whose grabbing changed
      // rather than its storing, so anything written before it is worth dropping.
      invalidate: (meta, key) => {
        asked.push([meta.writtenBy, key.day]);

        return meta.writtenBy !== '9.9.9';
      },
    });

    await store.write(key, [programme()]);

    expect(await store.getMeta(key)).toBeUndefined();
    expect(await store.read(key)).toBeUndefined();
    expect(asked).toEqual([[__PKG_VERSION__, '2026-07-17']]);
    // Removed, so the day reads as never grabbed and the next run fetches it —
    // and nothing asks again about an entry that is no longer there.
    expect(driver.deletes).toEqual(['example.com|one|2026-07-17']);
  });

  it('keeps an entry invalidate approves of, and never sees a broken one', async () => {
    const driver = new RecordingDriver();
    const seen: number[] = [];
    const store = new CacheManager({
      driver,
      invalidate: (meta) => {
        seen.push(meta.schema);

        return false;
      },
    });

    await store.write(key, [programme()]);
    expect(await store.getMeta(key)).toMatchObject({ programmeCount: 1 });

    // An entry the shape check already refused is not one a hook is asked
    // about: there is nothing there for it to judge.
    driver.stored(key).meta.schema = CACHE_SCHEMA + 1;
    expect(await store.getMeta(key)).toBeUndefined();
    expect(seen).toEqual([CACHE_SCHEMA]);
  });

  it('asks a driver for a whole batch at once when it can take one', async () => {
    class BatchingDriver extends RecordingDriver {
      batches: number[] = [];

      async readMetas(keys: readonly ChannelDayKey[]): Promise<Array<FoundMeta | undefined>> {
        this.batches.push(keys.length);

        // One question of the store, which is the whole point of the method.
        return keys
          .map((one) => this.entries.get(`${one.site}|${one.channelId}|${one.day}`))
          .map((entry) => entry && { meta: entry.meta });
      }
    }

    const driver = new BatchingDriver();
    const store = cache(driver);
    const days = ['2026-07-17', '2026-07-18', '2026-07-19'];

    await store.write({ ...key, day: days[0]! }, [programme()]);
    await store.write({ ...key, day: days[2]! }, [programme(), programme()]);

    const metas = await store.getMetas(days.map((day) => ({ ...key, day })));

    // In the order they were asked for, with a gap where the day was never
    // grabbed — a store answers in whatever order suits it.
    expect(metas.map((meta) => meta?.programmeCount)).toEqual([1, undefined, 2]);
    expect(driver.batches).toEqual([3]);
  });

  it('asks a driver without one for each key in turn, and only in turn', async () => {
    const driver = new RecordingDriver();
    const store = cache(driver);
    const asked: string[] = [];
    let inFlight = 0;
    let most = 0;

    driver.readMeta = async (one: ChannelDayKey): Promise<FoundMeta | undefined> => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      asked.push(one.day);

      return { meta: stamped({ grabbedAt: '2026-07-17T08:00:00.000Z', programmeCount: 1 }) };
    };

    await store.getMetas(
      ['2026-07-17', '2026-07-18', '2026-07-19'].map((day) => ({ ...key, day })),
    );

    // One at a time: the caller has already decided how many of these to have
    // in flight, and a batch that fanned out would multiply that by its size —
    // for a cache of files, the descriptor storm the bound is there to prevent.
    expect(asked).toEqual(['2026-07-17', '2026-07-18', '2026-07-19']);
    expect(most).toBe(1);
  });

  it('judges every entry of a batch as it judges one on its own', async () => {
    const driver = new RecordingDriver();
    const store = cache(driver);
    const days = ['2026-07-17', '2026-07-18'];

    for (const day of days) {
      await store.write({ ...key, day }, [programme()]);
    }

    // A shape this code does not write: void, and removed, which is what makes
    // the day read as never grabbed.
    driver.stored({ ...key, day: days[1]! }).meta.schema = CACHE_SCHEMA + 1;

    const metas = await store.getMetas(days.map((day) => ({ ...key, day })));

    expect(metas.map((meta) => meta?.programmeCount)).toEqual([1, undefined]);
    expect(driver.deletes).toEqual([`example.com|one|${days[1]!}`]);
  });

  it('closes the driver it was given, and manages without one that cannot', async () => {
    const driver = new RecordingDriver();

    await cache(driver).close();
    expect(driver.closed).toBe(1);

    // `close` is a driver's to have or not: a directory holds nothing open.
    await expect(cache(new FsNdjsonCacheDriver({ dir: '.' })).close()).resolves.toBeUndefined();
  });

  it('stamps a remembered group with when it was written and what wrote it', async () => {
    const driver = new RecordingDriver();
    const store = cache(driver);

    await store.setState('example.com', 'channels', ['one']);

    const held = driver.groups.get('example.com|channels')!;

    expect(held.data).toEqual(['one']);
    expect(held.meta).toEqual({
      writtenAt: expect.any(String),
      schema: STATE_SCHEMA,
      writtenBy: expect.any(String),
    });

    // A run stamps what it remembers with its own "now", as it does a grabbedAt.
    await store.setState('example.com', 'channels', ['two'], {
      writtenAt: '2026-07-17T08:00:00.000Z',
    });
    expect(driver.groups.get('example.com|channels')!.meta.writtenAt).toBe(
      '2026-07-17T08:00:00.000Z',
    );
  });

  it('voids a group whose envelope is not the one this code writes, and removes it', async () => {
    const driver = new RecordingDriver();
    const store = cache(driver);

    await store.setState('example.com', 'channels', ['one']);
    driver.groups.get('example.com|channels')!.meta.schema = STATE_SCHEMA + 1;

    // Either way — older or newer — a group this code cannot read as it was
    // meant is one to give up on, so whoever wanted it goes and finds out again.
    expect(await store.getState('example.com', 'channels')).toBeUndefined();
    expect(driver.stateDeletes).toEqual(['example.com|channels']);
    expect(driver.groups.size).toBe(0);
  });

  it('voids a group that cannot say when it was written or by what', async () => {
    const driver = new RecordingDriver();
    const store = cache(driver);

    for (const meta of [{}, { schema: STATE_SCHEMA }, { writtenAt: 5, schema: STATE_SCHEMA }]) {
      driver.groups.set('example.com|channels', { meta: meta as never, data: ['one'] });

      expect(await store.getState('example.com', 'channels')).toBeUndefined();
    }

    // And a group whose payload was unreadable, which a driver reports the same
    // way: an envelope is worth nothing without what it wrapped.
    driver.groups.set('example.com|channels', { meta: undefined as never, data: undefined });
    expect(await store.getState('example.com', 'channels')).toBeUndefined();
  });

  it('keeps one site apart from another, and one group from the next', async () => {
    const store = cache(new RecordingDriver());

    await store.setState('a.example', 'channels', ['a']);
    await store.setState('b.example', 'channels', ['b']);
    await store.setState('a.example', 'validators', { url: { etag: 'W/"1"' } });

    expect((await store.getState('a.example', 'channels'))?.data).toEqual(['a']);
    expect((await store.getState('b.example', 'channels'))?.data).toEqual(['b']);
    expect((await store.getState('a.example', 'validators'))?.data).toEqual({
      url: { etag: 'W/"1"' },
    });
  });
});

describe('MemoryCacheDriver', () => {
  const key = { site: 'example.com', channelId: 'one', day: '2026-07-17' };

  it('round-trips programmes with their dates, as a stored cache does', async () => {
    const driver = new MemoryCacheDriver();
    const store = cache(driver);
    const [original] = parseXmltvString(
      '<?xml version="1.0"?><tv><programme start="20260807203000 +0200" channel="one.tv">' +
        '<title>Film</title><date>2020</date></programme></tv>',
    ).programmes;

    await store.write(key, [original!]);
    const [back] = (await store.read(key))!;

    // Records rather than `Date`s, and the two things a `Date` carries beside
    // its instant come back with it.
    expect(getXmltvOffset(back!.start)).toBe(120);
    expect(getXmltvPrecision(back!.date!)).toBe(4);
    expect(await store.getMeta(key)).toMatchObject({ programmeCount: 1 });
  });

  it('hands out a copy, so what a reader does cannot reach the cache', async () => {
    const store = cache(new MemoryCacheDriver());
    const mine = programme();

    await store.write(key, [mine]);

    const [first] = (await store.read(key))!;
    const [second] = (await store.read(key))!;

    // Not the object that was written, and not the same object twice: every
    // other driver gives back something parsed out of a file or a row, and this
    // one says the same by going through records. So a `transform` that edits a
    // programme in place — or anything holding what a read returned — is not
    // quietly editing the cache.
    expect(first).not.toBe(mine);
    expect(first).not.toBe(second);
    expect(first).toEqual(mine);

    first!.title = [{ value: 'Rewritten' }];

    expect((await store.read(key))![0]!.title[0]!.value).toBe('Evening News');
  });

  it('deletes, prunes by day, and can be emptied outright', async () => {
    const driver = new MemoryCacheDriver();
    const store = cache(driver);

    for (const day of ['2026-07-10', '2026-07-15', '2026-07-17']) {
      await store.write({ ...key, day }, [programme()]);
      await store.write({ ...key, channelId: 'two', day }, [programme()]);
    }

    expect(driver.size).toBe(6);
    await store.delete({ ...key, day: '2026-07-17' });
    expect(driver.size).toBe(5);

    expect(await store.prune({ before: '2026-07-16' })).toBe(4);
    expect(driver.size).toBe(1);
    expect(await store.read({ ...key, channelId: 'two', day: '2026-07-17' })).toHaveLength(1);
    expect(await store.read({ ...key, day: '2026-07-10' })).toBeUndefined();

    driver.clear();
    expect(driver.size).toBe(0);
  });

  it('remembers a group for the life of the process, and hands out a copy', async () => {
    const driver = new MemoryCacheDriver();
    const store = cache(driver);
    const mine = { list: ['one'] };

    await store.setState(key.site, 'channels', mine);
    mine.list.push('two');

    const stored = async (): Promise<{ list: string[] }> =>
      (await store.getState(key.site, 'channels'))!.data as { list: string[] };
    const held = await stored();

    // Copied on the way in and again on the way out, because every other driver
    // serializes: a caller mutating what it stored — or what it read — must not
    // be editing the cache under this driver and no other.
    expect(held.list).toEqual(['one']);
    held.list.push('three');
    expect((await stored()).list).toEqual(['one']);

    driver.clear();
    expect(await store.getState(key.site, 'channels')).toBeUndefined();
  });

  it('keeps one site apart from another with the same channel and day', async () => {
    const driver = new MemoryCacheDriver();
    const store = cache(driver);

    await store.write(key, [programme()]);
    await store.write({ ...key, site: 'other.example' }, [programme(), programme()]);

    expect(await store.getMeta(key)).toMatchObject({ programmeCount: 1 });
    expect(await store.getMeta({ ...key, site: 'other.example' })).toMatchObject({
      programmeCount: 2,
    });
  });
});

describe('NoCacheDriver', () => {
  const key = { site: 'example.com', channelId: 'one', day: '2026-07-17' };

  it('keeps nothing, so every day reads as never grabbed', async () => {
    const store = cache(new NoCacheDriver());

    await store.write(key, [programme()]);

    expect(await store.getMeta(key)).toBeUndefined();
    expect(await store.read(key)).toBeUndefined();
    expect(await store.prune({ before: '2026-07-17' })).toBe(0);
    await expect(store.delete(key)).resolves.toBeUndefined();
  });

  it('remembers nothing either, which a site learns by being told nothing', async () => {
    const store = cache(new NoCacheDriver());

    await store.setState(key.site, 'channels', ['one']);

    expect(await store.getState(key.site, 'channels')).toBeUndefined();
  });
});

/**
 * `node:sqlite` is not on every runtime this package supports, so the driver is
 * a separate entry point — and its tests only run where the module exists.
 */
const sqlite = await import('../src/cache/sqlite-driver.js').catch(() => undefined);

describe.skipIf(sqlite === undefined)('SqliteCacheDriver', () => {
  // Read without insisting: a skipped suite still runs its callback, to find out
  // what tests are in it, so this line executes on a runtime where the module
  // never loaded. Nothing inside a skipped test body does.
  const SqliteCacheDriver = sqlite?.SqliteCacheDriver as NonNullable<
    typeof sqlite
  >['SqliteCacheDriver'];
  const key = { site: 'example.com', channelId: 'one', day: '2026-07-17' };
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'epg-cache-sqlite-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('keeps the cache in one file under the cache directory', async () => {
    const store = cache(new SqliteCacheDriver({ dir: path.join(dir, 'made', 'on', 'demand') }));

    await store.write(key, [programme()]);

    // The directory is made if it is not there — SQLite will not do it — and the
    // whole cache is that one file, plus whatever WAL it keeps beside it.
    expect((await fs.readdir(path.join(dir, 'made', 'on', 'demand'))).sort()).toContain(
      'cache.sqlite',
    );
    await store.close();
  });

  it('round-trips programmes with their dates, and reads a meta without them', async () => {
    await using store = cache(new SqliteCacheDriver({ dir }));
    const [original] = parseXmltvString(
      '<?xml version="1.0"?><tv><programme start="20260807203000 +0200" channel="one.tv">' +
        '<title>Film</title><date>2020</date></programme></tv>',
    ).programmes;

    await store.write(key, [original!, programme()], { grabbedAt: '2026-07-17T08:00:00.000Z' });

    expect(await store.getMeta(key)).toEqual(
      stamped({ grabbedAt: '2026-07-17T08:00:00.000Z', programmeCount: 2 }),
    );

    const [back] = (await store.read(key))!;

    expect(getXmltvOffset(back!.start)).toBe(120);
    expect(getXmltvPrecision(back!.date!)).toBe(4);
  });

  it('keeps one row per channel-day, however often it is written', async () => {
    await using store = cache(new SqliteCacheDriver({ dir }));

    await store.write(key, [programme()]);
    await store.write(key, [programme(), programme()]);
    await store.write(key, [programme({ title: [{ value: 'Later' }] })]);

    const read = await store.read(key);

    expect(read).toHaveLength(1);
    expect(read![0]!.title[0]!.value).toBe('Later');
    expect(await store.getMeta(key)).toMatchObject({ programmeCount: 1 });
  });

  it('deletes one entry and prunes a whole day range in one statement', async () => {
    await using store = cache(new SqliteCacheDriver({ dir }));

    for (const day of ['2026-07-10', '2026-07-15', '2026-07-17']) {
      for (const channelId of ['one', 'two']) {
        await store.write({ ...key, channelId, day }, [programme()]);
      }
    }

    await store.delete({ ...key, day: '2026-07-17' });
    expect(await store.read({ ...key, day: '2026-07-17' })).toBeUndefined();
    expect(await store.read({ ...key, channelId: 'two', day: '2026-07-17' })).toHaveLength(1);

    expect(await store.prune({ before: '2026-07-16' })).toBe(4);
    expect(await store.read({ ...key, day: '2026-07-15' })).toBeUndefined();
    expect(await store.read({ ...key, channelId: 'two', day: '2026-07-17' })).toHaveLength(1);
  });

  it('gives up on the programmes of a row whose payload is not records', async () => {
    const file = path.join(dir, 'cache.sqlite');
    const first = new SqliteCacheDriver({ dir });

    await cache(first).write(key, [programme(), programme()]);
    await first.close();

    // Nothing here writes a row in that state, so it takes the database itself:
    // a restore of half a file, a hand-edited row, a bug in something else
    // sharing the cache.
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(file);
    db.exec("UPDATE entries SET programmes = CAST('not json at all' AS BLOB)");
    db.close();

    await using store = cache(new SqliteCacheDriver({ dir }));

    // The meta is still good, so a staleness check alone keeps the entry; a
    // read finds what it holds is not the two programmes it says, and removes
    // it, so the day reads as never grabbed and the next run grabs it again.
    expect(await store.getMeta(key)).toMatchObject({ programmeCount: 2 });
    expect(await store.read(key)).toBeUndefined();
    expect(await store.getMeta(key)).toBeUndefined();
  });

  it('removes an entry whose programmes a codec cannot read at all, as a run reads it', async () => {
    const lines = path.join(dir, 'lines');
    const store = ndjson({ dir: lines });

    await store.write(key, [programme(), programme()]);

    const file = path.join(lines, key.site, key.channelId, `${key.day}.ndjson`);
    const content = (await fs.readFile(file, 'utf8')).trimEnd().split('\n');

    // The last programme cut short, which `JSON.parse` throws on — and which
    // used to throw out of the merge with it.
    await fs.writeFile(
      file,
      `${content.slice(0, -1).join('\n')}\n${content.at(-1)!.slice(0, 20)}\n`,
    );

    expect(await store.read(key)).toBeUndefined();
    expect(await store.getMeta(key)).toBeUndefined();
  });

  it('answers a batch of metas in one statement, in the order asked', async () => {
    await using store = cache(new SqliteCacheDriver({ dir }));
    const days = ['2026-07-15', '2026-07-16', '2026-07-17'];

    await store.write({ ...key, day: days[0]! }, [programme()]);
    await store.write({ ...key, day: days[2]! }, [programme(), programme()]);
    // Another channel's day, which the batch must not pick up for this one.
    await store.write({ ...key, channelId: 'two', day: days[1]! }, [programme()]);

    const metas = await store.getMetas(days.map((day) => ({ ...key, day })));

    expect(metas.map((meta) => meta?.programmeCount)).toEqual([1, undefined, 2]);

    // A batch of keys nothing has ever been written for, and one of none.
    expect(
      await store.getMetas([
        { ...key, day: '2026-01-01' },
        { ...key, channelId: 'three', day: days[0]! },
      ]),
    ).toEqual([undefined, undefined]);
    expect(await store.getMetas([])).toEqual([]);
  });

  it('refuses a batch once the run is cancelled', async () => {
    const controller = new AbortController();
    const store = cache(new SqliteCacheDriver({ dir, signal: controller.signal }));

    await store.write(key, [programme()]);
    controller.abort(new Error('cancelled'));

    await expect(store.getMetas([key])).rejects.toThrow('cancelled');
    await store.close();
  });

  it('refuses what it is asked once the run is cancelled', async () => {
    const controller = new AbortController();
    const store = cache(new SqliteCacheDriver({ dir, signal: controller.signal }));

    await store.write(key, [programme()]);
    controller.abort(new Error('cancelled'));

    // A statement against a local file is not worth interrupting half way, so
    // this is asked before each one rather than inside any.
    await expect(store.read(key)).rejects.toThrow('cancelled');
    await expect(store.getMeta(key)).rejects.toThrow('cancelled');
    await expect(store.prune({ before: '2026-07-17' })).rejects.toThrow('cancelled');
    await store.close();
  });

  it('starts the table again when its version is not the one this code writes', async () => {
    const file = path.join(dir, 'cache.sqlite');
    const first = new SqliteCacheDriver({ dir });

    await cache(first).write(key, [programme()]);
    await first.close();

    // A column layout this code does not know is not something re-grabbing a day
    // could fix — the statements would not run — so the table goes and is made
    // again, and the days are grabbed once more.
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(file);
    db.exec('PRAGMA user_version = 99');
    db.close();

    await using store = cache(new SqliteCacheDriver({ dir }));

    expect(await store.getMeta(key)).toBeUndefined();
    await store.write(key, [programme()]);
    expect(await store.read(key)).toHaveLength(1);
  });

  it('changes nothing it only reads, of tables another version made', async () => {
    const file = path.join(dir, 'cache.sqlite');
    const first = new SqliteCacheDriver({ dir });

    await cache(first).write(key, [programme()]);
    await cache(first).setState(key.site, 'state', [['cursor', 1]]);
    await first.close();

    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(file);
    db.exec('PRAGMA user_version = 99');
    db.close();

    const looked = new SqliteCacheDriver({ dir });
    const listed: unknown[] = [];

    for await (const held of looked.list()) {
      listed.push(held);
    }

    expect(listed).toEqual([]);
    expect(await looked.readMeta(key)).toBeUndefined();
    expect(await looked.readMetas([key])).toEqual([undefined]);
    expect(await looked.read(key)).toBeUndefined();
    expect(await looked.readState(key.site, 'state')).toBeUndefined();
    expect(await looked.prune({ before: '2099-01-01' })).toBe(0);
    await looked.delete(key);
    await looked.deleteState(key.site, 'state');
    await looked.close();

    // The tables, and what is in them, as another version left them.
    const after = new DatabaseSync(file);

    expect(after.prepare('PRAGMA user_version').get()).toEqual({ user_version: 99 });
    expect(after.prepare('SELECT count(*) AS n FROM entries').get()).toEqual({ n: 1 });
    expect(after.prepare('SELECT count(*) AS n FROM state').get()).toEqual({ n: 1 });
    after.close();
  });

  it.skipIf(process.getuid?.() === 0)(
    'refuses a place it could never make the database, before anything is asked',
    async () => {
      const locked = path.join(dir, 'locked');

      await fs.mkdir(locked, { mode: 0o500 });

      try {
        expect(() => new SqliteCacheDriver({ dir: path.join(locked, 'cache') })).toThrow(
          `The sqlite cache cannot be made at ${path.join(locked, 'cache', 'cache.sqlite')}: ${locked} is not writable`,
        );
      } finally {
        await fs.chmod(locked, 0o700);
      }
    },
  );

  it('lists a page at a time, and a change made while listing is made at once', async () => {
    const file = path.join(dir, 'cache.sqlite');
    const driver = new SqliteCacheDriver({ dir });
    const store = cache(driver);
    const days = Array.from({ length: 2500 }, (_, i) =>
      new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
    );

    for (const day of days) {
      await store.write({ ...key, day }, []);
    }

    const { DatabaseSync } = await import('node:sqlite');
    const other = new DatabaseSync(file);
    const seen: string[] = [];

    for await (const held of driver.list()) {
      seen.push((held as { key: ChannelDayKey }).key.day);

      // Removed as it is handed out — and seen gone from another connection
      // straight after, which a write left waiting on an open read would not be.
      await store.delete((held as { key: ChannelDayKey }).key);

      if (seen.length === 1500) {
        expect(other.prepare('SELECT count(*) AS n FROM entries').get()).toEqual({ n: 1000 });
      }
    }

    other.close();
    await driver.close();

    expect(seen).toEqual(days);
  });

  it('logs ahead for a prune too, which changes what is there', async () => {
    const file = path.join(dir, 'cache.sqlite');
    const first = new SqliteCacheDriver({ dir });

    await cache(first).write(key, [programme()]);
    await first.close();

    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = DELETE');
    db.close();

    const driver = new SqliteCacheDriver({ dir });

    expect(await driver.prune({ before: '2099-01-01' })).toBe(1);
    await driver.close();

    const after = new DatabaseSync(file);

    expect(after.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    after.close();
  });

  it('opens nothing again once closed', async () => {
    const driver = new SqliteCacheDriver({ dir });

    await driver.close();

    await expect(driver.readMeta(key)).rejects.toThrow('This sqlite cache is closed');
    await expect(cache(driver).write(key, [])).rejects.toThrow('This sqlite cache is closed');
  });

  it('logs ahead from its first write, whatever it read before', async () => {
    const file = path.join(dir, 'cache.sqlite');
    const first = new SqliteCacheDriver({ dir });

    await cache(first).write(key, [programme()]);
    await first.close();

    // A copy someone took out of WAL to move it.
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = DELETE');
    db.close();

    const driver = new SqliteCacheDriver({ dir });

    await driver.readMeta(key);
    await cache(driver).write(key, [programme()]);
    await driver.close();

    const after = new DatabaseSync(file);

    expect(after.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    after.close();
  });

  it('steps two listings through at once, each to its end', async () => {
    const driver = new SqliteCacheDriver({ dir });
    const store = cache(driver);

    for (const day of ['2026-07-17', '2026-07-18', '2026-07-19']) {
      await store.write({ ...key, day }, []);
    }

    const first = driver.list()[Symbol.asyncIterator]();
    const second = driver.list()[Symbol.asyncIterator]();
    const days: string[][] = [[], []];

    // Turn about, so neither is read whole before the other starts.
    for (let turn = 0; turn < 3; turn++) {
      for (const [index, listing] of [first, second].entries()) {
        const { value } = await listing.next();

        days[index]!.push((value as { key: ChannelDayKey }).key.day);
      }
    }

    expect(days).toEqual([
      ['2026-07-17', '2026-07-18', '2026-07-19'],
      ['2026-07-17', '2026-07-18', '2026-07-19'],
    ]);
    expect((await first.next()).done).toBe(true);
    await driver.close();
  });

  it('makes nothing where there is no database, until it writes', async () => {
    const nowhere = path.join(dir, 'not', 'here');
    const driver = new SqliteCacheDriver({ dir: nowhere });

    expect(await driver.readMeta(key)).toBeUndefined();
    expect(await driver.prune({ before: '2099-01-01' })).toBe(0);

    for await (const held of driver.list()) {
      expect.unreachable(String(held));
    }

    expect(await fs.stat(nowhere).catch(() => undefined)).toBeUndefined();

    await cache(driver).write(key, [programme()]);

    expect(await cache(driver).read(key)).toHaveLength(1);
    await driver.close();
  });

  it("keeps a site's state in a row of its own, one per group", async () => {
    await using store = cache(new SqliteCacheDriver({ dir }));

    await store.setState(key.site, 'channels', [{ xmltvId: 'one', siteId: '1' }]);
    await store.setState(key.site, 'validators', {
      'https://example.com/g.xml': { etag: 'W/"1"' },
    });
    await store.setState('other.example', 'channels', ['theirs']);

    expect((await store.getState(key.site, 'channels'))?.data).toEqual([
      { xmltvId: 'one', siteId: '1' },
    ]);
    expect((await store.getState(key.site, 'validators'))?.data).toEqual({
      'https://example.com/g.xml': { etag: 'W/"1"' },
    });
    expect((await store.getState('other.example', 'channels'))?.data).toEqual(['theirs']);

    // One row per (site, key), however often it is written.
    await store.setState(key.site, 'channels', ['replaced']);
    expect((await store.getState(key.site, 'channels'))?.data).toEqual(['replaced']);
    expect(await store.getState(key.site, 'nothing-here')).toBeUndefined();
  });

  it('gives up on a group whose payload is not JSON, and takes the row with it', async () => {
    const driver = new SqliteCacheDriver({ dir });
    const store = cache(driver);

    await store.setState(key.site, 'channels', ['one']);
    await driver.close();

    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(dir, 'cache.sqlite'));
    db.exec("UPDATE state SET data = 'not json'");
    db.close();

    await using second = cache(new SqliteCacheDriver({ dir }));

    expect(await second.getState(key.site, 'channels')).toBeUndefined();
    // Removed rather than left to be read again next run.
    await second.setState(key.site, 'channels', ['again']);
    expect((await second.getState(key.site, 'channels'))?.data).toEqual(['again']);
  });
});

describe('isStale with refetchAll', () => {
  const now = new Date('2026-07-17T12:00:00.000Z');
  const policy: StalenessPolicy = { ...DEFAULT_STALENESS, refetchAll: true };
  const fresh = { grabbedAt: '2026-07-17T11:00:00.000Z', programmeCount: 3 };

  it('refetches a day however fresh the entry is', () => {
    expect(isStale('2026-07-20', fresh, DEFAULT_STALENESS, now)).toBe(false);
    expect(isStale('2026-07-20', fresh, policy, now)).toBe(true);
  });

  it('reaches days behind today, which alwaysRefetchDays does not', () => {
    // A window shifted into the past with `--offset -2`: the refetch window only
    // ever reaches forward, so this is the difference between the two.
    const wide: StalenessPolicy = { ...DEFAULT_STALENESS, alwaysRefetchDays: 30 };

    expect(isStale('2026-07-15', fresh, wide, now)).toBe(false);
    expect(isStale('2026-07-15', fresh, policy, now)).toBe(true);
  });
});

describe('a channel-day a thread encoded for its store', () => {
  // How a site in a thread of its own hands its programmes over to a store
  // that names a codec: encoded already, for the main thread only to save.
  // What comes out must be what writing the programmes would have kept.
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'epg-cache-encoded-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const key = { site: 'example.com', channelId: 'one', day: '2026-07-17' };
  const grabbedAt = '2026-07-17T12:00:00.000Z';

  /** Two programmes carrying what an encoding has to keep: an offset, and a year. */
  const offered = (): XmltvProgramme[] => [
    programme({
      start: parseXmltvDate('20260717200000 +0200'),
      stop: parseXmltvDate('20260717210000 +0200'),
      date: parseXmltvDate('2020'),
    }),
    programme({
      start: parseXmltvDate('20260717210000 +0200'),
      title: [{ value: 'Neskoro', lang: 'sk' }],
    }),
  ];

  const drivers: Array<[string, () => CacheDriver]> = [
    ['ndjson', () => new FsNdjsonCacheDriver({ dir })],
    ['xmltv', () => new FsXmltvCacheDriver({ dir })],
    ['memory', () => new MemoryCacheDriver()],
    ...(sqlite === undefined
      ? []
      : ([['sqlite', () => new sqlite.SqliteCacheDriver({ dir })]] as Array<
          [string, () => CacheDriver]
        >)),
  ];

  for (const [name, make] of drivers) {
    it(`reads back from the ${name} driver what writing programmes would have kept`, async () => {
      const store = cache(make());
      const encoded = { ...key, channelId: 'two' };
      const codec = store.codecName!;

      await store.write(key, offered(), { grabbedAt });
      await store.writeEncoded(encoded, CODECS[codec].encode(offered()), 2, { grabbedAt });

      const read = await store.read(encoded);

      expect(read).toEqual(await store.read(key));
      expect(getXmltvOffset(read![0]!.start)).toBe(120);
      expect(getXmltvPrecision(read![0]!.date!)).toBe(4);
      expect((await store.getMeta(encoded))?.programmeCount).toBe(2);
    });
  }

  it('writes the same ndjson file, byte for byte, as programmes would have', async () => {
    const store = ndjson({ dir });
    const file = path.join(dir, 'example.com', 'one', '2026-07-17.ndjson');

    await store.write(key, offered(), { grabbedAt });

    const written = await fs.readFile(file, 'utf8');

    await store.writeEncoded(key, CODECS.ndjson.encode(offered()), 2, { grabbedAt });

    expect(await fs.readFile(file, 'utf8')).toBe(written);
  });

  it('keeps with a codec a driver brings, and names none for a thread', async () => {
    // A codec that leaves descriptions out: code no thread has, so the store
    // names none, and is only ever handed programmes.
    const brief: CacheCodec = {
      encode: (programmes) =>
        CODECS.json.encode(programmes.map(({ desc: _desc, ...kept }) => kept as XmltvProgramme)),
      decode: (body, meta) => CODECS.json.decode(body, meta),
    };

    class Brief extends MemoryCacheDriver {
      override readonly codec = brief;
    }

    const store = cache(new Brief());

    await store.write(key, [programme({ desc: [{ value: 'Long.' }] })], { grabbedAt });

    expect((await store.read(key))?.[0]?.desc).toBeUndefined();
    expect(store.codecName).toBeUndefined();
    await expect(store.writeEncoded(key, new Uint8Array(), 0)).rejects.toThrow('write programmes');
  });

  it('refuses a codec it has no name for', () => {
    class Unheard extends MemoryCacheDriver {
      override readonly codec = 'yaml' as never;
    }

    expect(() => cache(new Unheard())).toThrow(
      "A cache driver's codec is one of ndjson, json, xmltv",
    );
  });
});

describe('a meta longer than one read', () => {
  // A meta is read from the front of an entry in chunks of bytes, each read into
  // the buffer the last one used, and a chunk ends wherever the read did —
  // inside a character, as often as not. What the meta is decoded from has to
  // be every chunk as it was read, and the character put back together.
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'epg-cache-meta-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const key = { site: 'example.com', channelId: 'one', day: '2026-07-17' };

  const drivers: Array<[CodecName, (options: FsCacheDriverOptions) => FsCacheDriver]> = [
    ['ndjson', (options) => new FsNdjsonCacheDriver(options)],
    ['xmltv', (options) => new FsXmltvCacheDriver(options)],
  ];

  for (const [codec, make] of drivers) {
    it(`reads back whole from the ${codec} driver, however the reads fall`, async () => {
      const driver = make({ dir });

      // Three-byte characters, a few thousand bytes of them, from each of three
      // starting points: one of those puts a read's end inside one.
      for (const lead of ['', 'a', 'aa']) {
        const meta = {
          ...stamped({ grabbedAt: '2026-07-17T12:00:00.000Z', programmeCount: 1 }),
          note: `${lead}${'€'.repeat(1500)}`,
        };

        await driver.write(key, CODECS[codec].encode([programme()]), meta);

        expect((await driver.readMeta(key))?.meta).toEqual(meta);
        expect((await driver.read(key))?.meta).toEqual(meta);
      }
    });
  }
});

describe('what a store lists', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'epg-cache-list-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  /** What a listing named, as sortable lines. */
  async function listed(driver: CacheDriver, options?: CacheListOptions): Promise<string[]> {
    const names: string[] = [];

    for await (const held of driver.list(options)) {
      names.push(
        held.kind === 'entry'
          ? `entry ${held.key.site} | ${held.key.channelId} | ${held.key.day}`
          : `state ${held.site} | ${held.key}`,
      );
    }

    return names.sort();
  }

  const meta = (): StoredStateMeta => ({
    writtenAt: '2026-07-17T12:00:00.000Z',
    schema: STATE_SCHEMA,
    writtenBy: __PKG_VERSION__,
  });

  const drivers: Array<[string, () => CacheDriver]> = [
    ['ndjson', () => new FsNdjsonCacheDriver({ dir })],
    ['xmltv', () => new FsXmltvCacheDriver({ dir })],
    ['memory', () => new MemoryCacheDriver()],
    ...(sqlite === undefined
      ? []
      : ([['sqlite', () => new sqlite.SqliteCacheDriver({ dir })]] as Array<
          [string, () => CacheDriver]
        >)),
  ];

  for (const [name, make] of drivers) {
    describe(`the ${name} driver`, () => {
      it('lists every entry and every group, and a site of them when asked', async () => {
        const driver = make();
        const store = cache(driver);

        try {
          await store.write({ site: 'a.tv', channelId: 'one', day: '2026-07-17' }, [programme()]);
          await store.write({ site: 'a.tv', channelId: 'one', day: '2026-07-18' }, []);
          await store.write({ site: 'a.tv', channelId: 'two', day: '2026-07-17' }, [programme()]);
          await store.write({ site: 'b.tv', channelId: 'one', day: '2026-07-17' }, [programme()]);
          await driver.writeState('a.tv', 'channels', { channels: [] }, meta());
          await driver.writeState('b.tv', 'state', [['cursor', 42]], meta());

          expect(await listed(driver)).toEqual([
            'entry a.tv | one | 2026-07-17',
            'entry a.tv | one | 2026-07-18',
            'entry a.tv | two | 2026-07-17',
            'entry b.tv | one | 2026-07-17',
            'state a.tv | channels',
            'state b.tv | state',
          ]);
          expect(await listed(driver, { site: 'b.tv' })).toEqual([
            'entry b.tv | one | 2026-07-17',
            'state b.tv | state',
          ]);
          expect(await listed(driver, { site: 'c.tv' })).toEqual([]);
        } finally {
          await driver.close?.();
        }
      });

      it('narrows to one kind, and to one channel', async () => {
        const driver = make();
        const store = cache(driver);

        try {
          await store.write({ site: 'a.tv', channelId: 'one', day: '2026-07-17' }, []);
          await store.write({ site: 'a.tv', channelId: 'two', day: '2026-07-17' }, []);
          await store.write({ site: 'b.tv', channelId: 'one', day: '2026-07-17' }, []);
          await driver.writeState('a.tv', 'state', [], meta());
          await driver.writeState('b.tv', 'state', [], meta());

          expect(await listed(driver, { site: 'a.tv', kind: 'state' })).toEqual([
            'state a.tv | state',
          ]);
          expect(await listed(driver, { kind: 'entry', site: 'b.tv' })).toEqual([
            'entry b.tv | one | 2026-07-17',
          ]);
          // A channel's entries are all a channel has: state is a site's.
          expect(await listed(driver, { site: 'a.tv', channelId: 'two' })).toEqual([
            'entry a.tv | two | 2026-07-17',
          ]);
          expect(await listed(driver, { site: 'a.tv', channelId: 'two', kind: 'state' })).toEqual(
            [],
          );
          // And in every site, where it is looked for.
          expect(await listed(driver, { channelId: 'one' })).toEqual([
            'entry a.tv | one | 2026-07-17',
            'entry b.tv | one | 2026-07-17',
          ]);
        } finally {
          await driver.close?.();
        }
      });

      it('names a key as it was written, whatever it had to be made into to be kept', async () => {
        const driver = make();
        const store = cache(driver);

        try {
          await store.write({ site: 'example.com:8080', channelId: '..', day: '2026-07-17' }, []);
          await store.write({ site: 'example.com:8080', channelId: 'a/b', day: '2026-07-17' }, []);
          await driver.writeState('example.com:8080', 'x/y', null, meta());

          expect(await listed(driver, { site: 'example.com:8080' })).toEqual([
            'entry example.com:8080 | .. | 2026-07-17',
            'entry example.com:8080 | a/b | 2026-07-17',
            'state example.com:8080 | x/y',
          ]);
        } finally {
          await driver.close?.();
        }
      });

      it('lists nothing for a store that holds nothing', async () => {
        const driver = make();

        try {
          expect(await listed(driver)).toEqual([]);
        } finally {
          await driver.close?.();
        }
      });

      it('lists what is left after a prune, and nothing removed', async () => {
        const driver = make();
        const store = cache(driver);

        try {
          await store.write({ site: 'a.tv', channelId: 'one', day: '2026-07-16' }, []);
          await store.write({ site: 'a.tv', channelId: 'one', day: '2026-07-17' }, []);
          await store.prune({ before: '2026-07-17' });

          expect(await listed(driver)).toEqual(['entry a.tv | one | 2026-07-17']);
        } finally {
          await driver.close?.();
        }
      });
    });
  }

  it('passes over a file a cache directory holds that the driver did not write', async () => {
    const driver = new FsNdjsonCacheDriver({ dir });

    await cache(driver).write({ site: 'a.tv', channelId: 'one', day: '2026-07-17' }, []);
    // An entry being written, a note, an entry of another driver, a file at the
    // top, and a directory whose name no encoding made.
    await fs.writeFile(path.join(dir, 'a.tv', 'one', '.2026-07-18.ndjson.tmp'), '');
    await fs.writeFile(path.join(dir, 'a.tv', 'one', 'notes.txt'), '');
    await fs.writeFile(path.join(dir, 'a.tv', 'one', '2026-07-19.xml'), '');
    await fs.writeFile(path.join(dir, 'a.tv', 'README'), '');
    await fs.writeFile(path.join(dir, 'README'), '');
    // An entry in a site, and a channel, no encoding could have named.
    await fs.mkdir(path.join(dir, '100%', 'one'), { recursive: true });
    await fs.writeFile(path.join(dir, '100%', 'one', '2026-07-17.ndjson'), '');
    await fs.mkdir(path.join(dir, 'a.tv', '50%'));
    await fs.writeFile(path.join(dir, 'a.tv', '50%', '2026-07-17.ndjson'), '');
    // Names it would have made otherwise: a mount's, and a lower-case escape.
    await fs.mkdir(path.join(dir, 'lost+found'), { mode: 0o000 });
    await fs.mkdir(path.join(dir, 'a.tv', 'a%2fb'));
    await fs.writeFile(path.join(dir, 'a.tv', 'a%2fb', '2026-07-17.ndjson'), '');

    expect(await listed(driver)).toEqual(['entry a.tv | one | 2026-07-17']);
  });

  it('lists through a link as a read follows one', async () => {
    const driver = new FsNdjsonCacheDriver({ dir });
    const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), 'epg-cache-elsewhere-'));

    try {
      const moved = new FsNdjsonCacheDriver({ dir: elsewhere });

      await cache(moved).write({ site: 'big.tv', channelId: 'one', day: '2026-07-17' }, []);
      await cache(moved).write({ site: 'big.tv', channelId: 'two', day: '2026-07-17' }, []);
      await cache(driver).write({ site: 'a.tv', channelId: 'one', day: '2026-07-17' }, []);
      // A site moved to another disk and linked back, a channel linked in, and
      // one day's file linked in.
      await fs.symlink(path.join(elsewhere, 'big.tv'), path.join(dir, 'big.tv'));
      await fs.symlink(path.join(elsewhere, 'big.tv', 'two'), path.join(dir, 'a.tv', 'two'));
      await fs.symlink(
        path.join(elsewhere, 'big.tv', 'one', '2026-07-17.ndjson'),
        path.join(dir, 'a.tv', 'one', '2026-07-18.ndjson'),
      );

      expect(await listed(driver)).toEqual([
        'entry a.tv | one | 2026-07-17',
        'entry a.tv | one | 2026-07-18',
        'entry a.tv | two | 2026-07-17',
        'entry big.tv | one | 2026-07-17',
        'entry big.tv | two | 2026-07-17',
      ]);
    } finally {
      await fs.rm(elsewhere, { recursive: true, force: true });
    }
  });

  it.skipIf(process.getuid?.() === 0)(
    'passes over a directory it cannot read, unless that is the one it was asked for',
    async () => {
      const driver = new FsNdjsonCacheDriver({ dir });

      await cache(driver).write({ site: 'a.tv', channelId: 'one', day: '2026-07-17' }, []);
      // A name a site could have, in a directory nobody here may read.
      await fs.mkdir(path.join(dir, '.Trash-0'), { mode: 0o000 });

      try {
        expect(await listed(driver)).toEqual(['entry a.tv | one | 2026-07-17']);
        // Looked for in every site, it is in one found by the walk.
        expect(await listed(driver, { channelId: 'one' })).toEqual([
          'entry a.tv | one | 2026-07-17',
        ]);
        await expect(listed(driver, { site: '.Trash-0' })).rejects.toThrow(/EACCES/);
      } finally {
        await fs.chmod(path.join(dir, '.Trash-0'), 0o700);
      }
    },
  );

  it.skipIf(process.getuid?.() === 0)(
    'says so of a channel it cannot read, rather than list it as holding nothing',
    async () => {
      const driver = new FsNdjsonCacheDriver({ dir });

      await cache(driver).write({ site: 'a.tv', channelId: 'one', day: '2026-07-17' }, []);
      await cache(driver).write({ site: 'a.tv', channelId: 'locked', day: '2026-07-17' }, []);
      // Written by a run as somebody else, who kept it to themselves.
      await fs.chmod(path.join(dir, 'a.tv', 'locked'), 0o000);

      try {
        for (const options of [{}, { site: 'a.tv' }, { channelId: 'locked' }]) {
          await expect(listed(driver, options)).rejects.toThrow(/EACCES/);
        }

        // Another channel, asked for alone, is not that one.
        expect(await listed(driver, { site: 'a.tv', channelId: 'one' })).toEqual([
          'entry a.tv | one | 2026-07-17',
        ]);
        expect(await listed(driver, { channelId: 'one' })).toEqual([
          'entry a.tv | one | 2026-07-17',
        ]);
      } finally {
        await fs.chmod(path.join(dir, 'a.tv', 'locked'), 0o700);
      }
    },
  );

  it('prunes through a link as it lists through one, and leaves the link', async () => {
    const driver = new FsNdjsonCacheDriver({ dir });
    const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), 'epg-cache-elsewhere-'));

    try {
      const moved = new FsNdjsonCacheDriver({ dir: elsewhere });

      await cache(moved).write({ site: 'big.tv', channelId: 'one', day: '2026-07-10' }, []);
      await cache(moved).write({ site: 'big.tv', channelId: 'one', day: '2026-07-17' }, []);
      await cache(moved).write({ site: 'other.tv', channelId: 'two', day: '2026-07-10' }, []);
      await cache(driver).write({ site: 'a.tv', channelId: 'one', day: '2026-07-17' }, []);
      // A site moved to another disk and linked back, and a channel linked in.
      await fs.symlink(path.join(elsewhere, 'big.tv'), path.join(dir, 'big.tv'));
      await fs.symlink(path.join(elsewhere, 'other.tv', 'two'), path.join(dir, 'a.tv', 'two'));

      expect(await driver.prune({ before: '2026-07-15' })).toBe(2);
      expect(await listed(driver)).toEqual([
        'entry a.tv | one | 2026-07-17',
        'entry big.tv | one | 2026-07-17',
      ]);
      // The links stay, the channel's emptied: where one points was somebody's
      // choice.
      expect((await fs.lstat(path.join(dir, 'big.tv'))).isSymbolicLink()).toBe(true);
      expect((await fs.lstat(path.join(dir, 'a.tv', 'two'))).isSymbolicLink()).toBe(true);
      expect(await fs.readdir(path.join(elsewhere, 'other.tv', 'two'))).toEqual([]);
    } finally {
      await fs.rm(elsewhere, { recursive: true, force: true });
    }
  });

  it.skipIf(process.getuid?.() === 0)(
    'prunes past a directory it cannot read, or could not have named',
    async () => {
      const driver = new FsNdjsonCacheDriver({ dir });

      await cache(driver).write({ site: 'a.tv', channelId: 'one', day: '2026-07-10' }, []);
      await cache(driver).write({ site: 'a.tv', channelId: 'one', day: '2026-07-17' }, []);
      // A mount's: one nobody here may read, and an empty one no site is called.
      await fs.mkdir(path.join(dir, '.Trash-0', 'files'), { recursive: true });
      await fs.chmod(path.join(dir, '.Trash-0'), 0o000);
      await fs.mkdir(path.join(dir, 'lost+found'));

      try {
        expect(await driver.prune({ before: '2026-07-15' })).toBe(1);
        expect((await fs.stat(path.join(dir, 'lost+found'))).isDirectory()).toBe(true);

        // A channel of a site nobody here may read is this driver's, and says so.
        await cache(driver).write({ site: 'a.tv', channelId: 'locked', day: '2026-07-10' }, []);
        await fs.chmod(path.join(dir, 'a.tv', 'locked'), 0o000);

        await expect(driver.prune({ before: '2026-07-15' })).rejects.toThrow(/EACCES/);
      } finally {
        await fs.chmod(path.join(dir, '.Trash-0'), 0o700);
        await fs.chmod(path.join(dir, 'a.tv', 'locked'), 0o700).catch(() => undefined);
      }
    },
  );

  it('lists nothing from a cache directory not made yet', async () => {
    const driver = new FsNdjsonCacheDriver({ dir: path.join(dir, 'not', 'yet') });

    expect(await listed(driver)).toEqual([]);
    expect(await listed(driver, { site: 'a.tv' })).toEqual([]);
  });

  it('lists nothing from a store that keeps nothing', async () => {
    expect(await listed(new NoCacheDriver())).toEqual([]);
  });
});

describe('a look inside the cache', () => {
  const key = { site: 'a.tv', channelId: 'one', day: '2026-07-17' };
  const other = { ...key, channelId: 'two' };
  const missing = { ...key, channelId: 'three' };

  /** A cache with one entry a run would use, and one it would remove. */
  async function looked(
    invalidate?: (meta: StoredEntryMeta, at: ChannelDayKey) => boolean,
  ): Promise<{ driver: MemoryCacheDriver; store: CacheManager }> {
    const driver = new MemoryCacheDriver();
    const store = new CacheManager({ driver, ...(invalidate ? { invalidate } : {}) });

    await store.write(key, [programme()], { grabbedAt: '2026-07-17T03:00:00.000Z' });
    await store.write(other, [programme()], { grabbedAt: '2026-07-17T03:00:00.000Z' });

    const found = (await driver.read(other))!;

    await driver.write(other, found.body, { ...(found.meta as StoredEntryMeta), schema: 0 });

    return { driver, store };
  }

  it('judges metas as a run does, and leaves the ones a run would remove', async () => {
    const { driver, store } = await looked();

    expect(await store.inspectMetas([key, other, missing])).toEqual([
      {
        status: 'readable',
        meta: stamped({ grabbedAt: '2026-07-17T03:00:00.000Z', programmeCount: 1 }),
      },
      {
        status: 'incompatible',
        meta: {
          ...stamped({ grabbedAt: '2026-07-17T03:00:00.000Z', programmeCount: 1 }),
          schema: 0,
        },
      },
      undefined,
    ]);
    expect(await driver.readMeta(other)).toBeDefined();

    // Where a run, asking the same, removes it.
    expect(await store.getMetas([other])).toEqual([undefined]);
    expect(await driver.readMeta(other)).toBeUndefined();
  });

  it("says what the config's invalidate voids, and leaves that too", async () => {
    const { driver, store } = await looked((_meta, at) => at.channelId === 'one');

    const meta = stamped({ grabbedAt: '2026-07-17T03:00:00.000Z', programmeCount: 1 });

    expect(await store.inspectMetas([key])).toEqual([{ status: 'invalidated', meta }]);
    expect(await store.inspect(key)).toEqual({ status: 'invalidated', meta });
    expect(await driver.readMeta(key)).toBeDefined();
  });

  it('reads an entry with its programmes, or says why it would not', async () => {
    const { driver, store } = await looked();

    expect(await store.inspect(key)).toEqual({
      status: 'readable',
      meta: stamped({ grabbedAt: '2026-07-17T03:00:00.000Z', programmeCount: 1 }),
      programmes: [programme()],
    });

    const found = (await driver.read(key))!;

    await driver.write(key, found.body, {
      ...(found.meta as StoredEntryMeta),
      grabbedAt: 7 as never,
    });

    // What it said, as the store had it.
    expect(await store.inspect(key)).toEqual({
      status: 'unreadable',
      meta: { ...(found.meta as StoredEntryMeta), grabbedAt: 7 },
    });

    // Of another schema, whatever fields it has: an older entry need not have
    // today's.
    await driver.write(key, found.body, { schema: 0 } as StoredEntryMeta);

    expect(await store.inspect(key)).toEqual({ status: 'incompatible', meta: { schema: 0 } });
    expect(await store.inspect(missing)).toBeUndefined();
    expect(await driver.read(key)).toBeDefined();
  });

  it("reads a group of a site's state, and leaves one a run would remove", async () => {
    const { driver, store } = await looked();

    await store.setState('a.tv', 'state', [['cursor', 42]], {
      writtenAt: '2026-07-17T03:00:00.000Z',
    });
    await driver.writeState('a.tv', 'old', [], {
      writtenAt: '2026-07-17T03:00:00.000Z',
      schema: STATE_SCHEMA + 1,
      writtenBy: '9.9.9',
    });

    await driver.writeState('a.tv', 'torn', [], {
      schema: STATE_SCHEMA,
      writtenBy: '9.9.9',
    } as StoredStateMeta);

    expect(await store.inspectState('a.tv', 'state')).toEqual({
      status: 'readable',
      data: [['cursor', 42]],
      meta: {
        writtenAt: '2026-07-17T03:00:00.000Z',
        schema: STATE_SCHEMA,
        writtenBy: __PKG_VERSION__,
      },
    });
    expect(await store.inspectState('a.tv', 'old')).toEqual({
      status: 'incompatible',
      meta: { writtenAt: '2026-07-17T03:00:00.000Z', schema: STATE_SCHEMA + 1, writtenBy: '9.9.9' },
    });
    expect(await store.inspectState('a.tv', 'torn')).toEqual({
      status: 'unreadable',
      meta: { schema: STATE_SCHEMA, writtenBy: '9.9.9' },
    });
    expect(await store.inspectState('a.tv', 'none')).toBeUndefined();
    expect(await driver.readState('a.tv', 'old')).toBeDefined();

    // Where a run, asking the same, removes it.
    expect(await store.getState('a.tv', 'old')).toBeUndefined();
    expect(await driver.readState('a.tv', 'old')).toBeUndefined();
  });

  it('lists exactly what it was asked for, whatever its driver answers with', async () => {
    const driver = new MemoryCacheDriver();
    const store = new CacheManager({ driver });

    await store.write(key, []);
    await store.write({ ...key, site: 'b.tv' }, []);
    await store.setState('a.tv', 'state', []);

    // A driver that narrows by nothing at all, which it may.
    const unnarrowed = Object.assign(Object.create(driver) as MemoryCacheDriver, {
      list: () => driver.list(),
    });
    const keys: string[] = [];

    for await (const held of new CacheManager({ driver: unnarrowed }).list({
      site: 'a.tv',
      kind: 'entry',
    })) {
      keys.push(held.kind === 'entry' ? `${held.key.site} ${held.key.channelId}` : held.key);
    }

    expect(keys).toEqual(['a.tv one']);
  });

  it('says an entry whose programmes cannot be read is corrupt, and why', async () => {
    const { driver, store } = await looked();
    const found = (await driver.read(key))!;

    // Bytes that are not the json codec's records at all, and not an array.
    await driver.write(key, new TextEncoder().encode('[{"title": '), found.meta as StoredEntryMeta);

    expect(await store.inspect(key)).toEqual({
      status: 'corrupt',
      meta: found.meta,
      error: expect.any(CorruptEntryError),
    });

    await driver.write(
      key,
      new TextEncoder().encode('{"title": 1}'),
      found.meta as StoredEntryMeta,
    );

    expect(await store.inspect(key)).toEqual({
      status: 'corrupt',
      meta: found.meta,
      error: new CorruptEntryError('An entry of the json codec holds no array of records'),
    });
  });

  it('knows a corrupt entry by its name, as another copy of this package throws one', () => {
    const copy = Object.assign(new Error('cut short'), { name: 'CorruptEntryError' });

    class Truncated extends CorruptEntryError {}

    expect(copy instanceof CorruptEntryError).toBe(true);
    expect(new Truncated('cut short') instanceof CorruptEntryError).toBe(true);
    expect(new Error('cut short') instanceof CorruptEntryError).toBe(false);
    // Only an error is one, whatever else carries the name.
    expect({ name: 'CorruptEntryError' } instanceof CorruptEntryError).toBe(false);
    // A subclass is asked as any class is: another copy has none of it.
    expect(new Truncated('cut short') instanceof Truncated).toBe(true);
    expect(copy instanceof Truncated).toBe(false);
    expect(new CorruptEntryError('cut short') instanceof Truncated).toBe(false);
  });

  it('has every codec it ships say what it cannot read is a corrupt entry, and why', () => {
    const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
    const thrown = (decode: () => unknown): unknown => {
      try {
        decode();
      } catch (error) {
        return error;
      }
    };

    for (const [codec, body] of [
      ['ndjson', '{"title": '],
      ['json', '[{"title": '],
      ['xmltv', '<html></html>'],
      // Records that read, with a date in them that does not.
      ['ndjson', '{"start": "the evening"}'],
      ['json', '[{"start": "the evening"}]'],
    ] as const) {
      const error = thrown(() =>
        CODECS[codec].decode(
          bytes(body),
          stamped({ grabbedAt: '2026-07-17T03:00:00.000Z', programmeCount: 1 }),
        ),
      );

      expect(error).toBeInstanceOf(CorruptEntryError);
      expect((error as Error).name).toBe('CorruptEntryError');
      expect((error as Error).message).toMatch(
        new RegExp(`^An entry of the ${codec} codec does not read: .+`),
      );
      // What the parser said, for whoever has to look into it.
      expect((error as Error).cause).toBeInstanceOf(Error);
    }
  });

  it("says so where a codec cannot read an entry's programmes at all", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'epg-cache-corrupt-'));

    try {
      const store = ndjson({ dir });

      await store.write(key, [programme(), programme()]);

      const file = path.join(dir, 'a.tv', 'one', '2026-07-17.ndjson');
      const lines = (await fs.readFile(file, 'utf8')).trimEnd().split('\n');

      // The last programme cut short.
      await fs.writeFile(file, `${lines.slice(0, -1).join('\n')}\n${lines.at(-1)!.slice(0, 20)}\n`);

      const inspected = await store.inspect(key);

      expect(inspected).toEqual({
        status: 'corrupt',
        meta: expect.objectContaining({ programmeCount: 2 }),
        error: expect.any(CorruptEntryError),
      });
      expect((inspected as { error: Error }).error.cause).toBeInstanceOf(SyntaxError);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('says so of a driver with no list, as one written before every driver had one', async () => {
    const driver = new MemoryCacheDriver();

    (driver as { list?: unknown }).list = undefined;

    const listing = new CacheManager({ driver }).list()[Symbol.asyncIterator]();

    await expect(listing.next()).rejects.toThrow("This cache's driver has no list()");
  });

  it('says an entry of a codec this package ships that holds fewer than it says is corrupt', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'epg-cache-short-'));

    try {
      const lines = ndjson({ dir: path.join(dir, 'lines') });
      const documents = xmltv({ dir: path.join(dir, 'documents') });

      await lines.write(key, [programme(), programme(), programme()]);
      await documents.write(key, [programme(), programme(), programme()]);

      // An ndjson entry cut between lines, and an xmltv document that ends
      // early: each still reads, as fewer programmes than it says it holds.
      const lineFile = path.join(dir, 'lines', 'a.tv', 'one', '2026-07-17.ndjson');
      const kept = (await fs.readFile(lineFile, 'utf8')).split('\n').slice(0, 2).join('\n');

      await fs.writeFile(lineFile, `${kept}\n`);

      const documentFile = path.join(dir, 'documents', 'a.tv', 'one', '2026-07-17.xml');
      const document = await fs.readFile(documentFile, 'utf8');

      await fs.writeFile(documentFile, document.slice(0, document.lastIndexOf('<programme')));

      for (const store of [lines, documents]) {
        const inspected = await store.inspect(key);

        expect(inspected).toMatchObject({
          status: 'corrupt',
          error: expect.any(CorruptEntryError),
        });
        expect((inspected as { error: Error }).error.message).toMatch(
          /^An entry of the (ndjson|xmltv) codec reads as [0-2] programmes, of the 3 it says it holds$/,
        );
        expect(await store.read(key)).toBeUndefined();
        expect(await store.getMeta(key)).toBeUndefined();
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  /** A memory store whose codec is its own: one that drops the first programme, and throws what `fails` says on what it will not read. */
  function ownCodec(fails: (body: Uint8Array) => Error | undefined): {
    driver: MemoryCacheDriver;
    store: CacheManager;
    warned: string[];
    /** The meta each read handed the codec. */
    handed: StoredEntryMeta[];
  } {
    const driver = new MemoryCacheDriver();
    const warned: string[] = [];
    const handed: StoredEntryMeta[] = [];

    Object.defineProperty(driver, 'codec', {
      value: {
        encode: CODECS.json.encode,
        decode: (body: Uint8Array, meta: StoredEntryMeta) => {
          const error = fails(body);

          if (error !== undefined) {
            throw error;
          }

          handed.push(meta);

          return CODECS.json.decode(body, meta).slice(1);
        },
      } satisfies CacheCodec,
    });

    return {
      driver,
      store: new CacheManager({ driver, warn: (message) => warned.push(message) }),
      warned,
      handed,
    };
  }

  it('throws what is no fault of the bytes, rather than take the entry for a damaged one', async () => {
    const store = cache(new MemoryCacheDriver());

    await store.write(key, [programme()]);

    // A fault of this code's own, as a release could ship one, where the
    // parser it calls throws on input that is fine.
    const parse = vi.spyOn(JSON, 'parse').mockImplementation(() => {
      throw new TypeError('a fault of its own');
    });

    try {
      const thrown = await store.read(key).catch((error: unknown) => error);

      expect(thrown).toEqual(new TypeError('a fault of its own'));
      expect(thrown).not.toBeInstanceOf(CorruptEntryError);
    } finally {
      parse.mockRestore();
    }

    // Kept, for a release without the fault to read.
    expect(await store.read(key)).toHaveLength(1);
  });

  it('reads back a programme of no channel that the xmltv codec wrote', () => {
    const written = [programme({ channel: '' })];

    expect(
      CODECS.xmltv.decode(
        CODECS.xmltv.encode(written),
        stamped({ grabbedAt: '2026-07-17T03:00:00.000Z', programmeCount: 1 }),
      ),
    ).toMatchObject([{ channel: '' }]);
  });

  it('has every codec it ships hold an entry to the count it was written with', () => {
    for (const codec of ['ndjson', 'json', 'xmltv'] as const) {
      const body = CODECS[codec].encode([programme(), programme()]);
      const meta = (programmeCount: number): StoredEntryMeta => ({
        schema: CACHE_SCHEMA,
        writtenBy: '0.9.0',
        grabbedAt: '2026-07-17T03:00:00.000Z',
        programmeCount,
      });

      expect(CODECS[codec].decode(body, meta(2))).toHaveLength(2);
      expect(() => CODECS[codec].decode(body, meta(3))).toThrow(
        new CorruptEntryError(
          `An entry of the ${codec} codec reads as 2 programmes, of the 3 it says it holds`,
        ),
      );
    }
  });

  it("leaves what a driver's own codec gives back to it, however many", async () => {
    const { store, handed } = ownCodec(() => undefined);

    await store.write(key, [programme(), programme()]);

    // Fewer than it says is the codec's own business — handed the meta, to
    // hold the entry to it or not.
    expect(await store.inspect(key)).toMatchObject({ status: 'readable' });
    expect(await store.read(key)).toHaveLength(1);
    expect(handed).toEqual([
      expect.objectContaining({ programmeCount: 2 }),
      expect.objectContaining({ programmeCount: 2 }),
    ]);
  });

  it("throws what a driver's own codec throws, other than a corrupt entry, and keeps the entry", async () => {
    const { driver, store, warned } = ownCodec((body) =>
      body.length === 0 ? new Error('a bug in the codec') : undefined,
    );

    await store.write(key, [programme(), programme()]);

    const found = (await driver.read(key))!;

    await driver.write(key, new Uint8Array(), found.meta as StoredEntryMeta);

    await expect(store.inspect(key)).rejects.toThrow('a bug in the codec');
    await expect(store.read(key)).rejects.toThrow('a bug in the codec');
    // Kept: a codec that throws on every entry must not empty the cache.
    expect(await driver.readMeta(key)).toBeDefined();
    expect(warned).toEqual([]);
  });

  it("removes what a driver's own codec says is a corrupt entry, as it does its own", async () => {
    // Thrown by this package, and by a copy of it the driver's own package brought.
    for (const error of [
      new CorruptEntryError('cut short'),
      Object.assign(new Error('cut short'), { name: 'CorruptEntryError' }),
    ]) {
      const { driver, store, warned } = ownCodec((body) => (body.length === 0 ? error : undefined));

      await store.write(key, [programme(), programme()]);

      const found = (await driver.read(key))!;

      await driver.write(key, new Uint8Array(), found.meta as StoredEntryMeta);

      expect(await store.inspect(key)).toEqual({ status: 'corrupt', meta: found.meta, error });
      // Looking left it; a run removes it, and says so.
      expect(await driver.readMeta(key)).toBeDefined();
      expect(await store.read(key)).toBeUndefined();
      expect(await driver.readMeta(key)).toBeUndefined();
      expect(warned).toEqual([
        'one 2026-07-17: removed from the cache, its programmes unreadable (cut short) — ' +
          'the day is grabbed again by the next run',
      ]);
    }
  });

  it('lists what its driver lists', async () => {
    const { store } = await looked();
    const keys: string[] = [];

    for await (const held of store.list({ site: 'a.tv' })) {
      keys.push(held.kind === 'entry' ? held.key.channelId : held.key);
    }

    expect(keys.sort()).toEqual(['one', 'two']);
  });
});
