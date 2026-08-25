import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CACHE_SCHEMA,
  CacheDriverBase,
  CacheManager,
  DEFAULT_STALENESS,
  FsNdjsonCacheDriver,
  FsXmltvCacheDriver,
  MemoryCacheDriver,
  NoCacheDriver,
  isStale,
} from '../src/cache/main.js';
import type {
  CacheDriver,
  CacheEntryMeta,
  ChannelDayKey,
  FoundEntry,
  FoundMeta,
  FsCacheDriverOptions,
  StalenessPolicy,
  StoredEntryMeta,
  StoredProgramme,
} from '../src/cache/main.js';
import { getXmltvOffset, getXmltvPrecision, parseXmltvString } from '../src/xmltv/main.js';
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
        chunks: AsyncIterable<string>,
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
        return this.entryData([programme()], meta);
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

describe('CacheManager', () => {
  const key = { site: 'example.com', channelId: 'one', day: '2026-07-17' };

  /**
   * A driver of the ordinary kind: it keeps JSON somewhere and says nothing
   * about dates, which is what makes it the one to test the manager with — and
   * what a driver written outside this package looks like. What it holds is
   * exactly what it was given, so a test can read it, or spoil it.
   */
  class RecordingDriver extends CacheDriverBase implements CacheDriver<StoredProgramme> {
    readonly entries = new Map<string, { meta: StoredEntryMeta; programmes: StoredProgramme[] }>();
    deletes: string[] = [];
    closed = 0;

    #id(key: ChannelDayKey): string {
      return `${key.site}|${key.channelId}|${key.day}`;
    }

    /** What the store holds for a key, for a test to read or to spoil. */
    stored(key: ChannelDayKey): { meta: StoredEntryMeta; programmes: StoredProgramme[] } {
      return this.entries.get(this.#id(key))!;
    }

    async readMeta(key: ChannelDayKey): Promise<FoundMeta | undefined> {
      const entry = this.entries.get(this.#id(key));

      return entry && { meta: entry.meta };
    }

    async read(key: ChannelDayKey): Promise<FoundEntry<StoredProgramme> | undefined> {
      return this.entries.get(this.#id(key));
    }

    async write(
      key: ChannelDayKey,
      programmes: StoredProgramme[],
      meta: StoredEntryMeta,
    ): Promise<void> {
      this.entries.set(this.#id(key), { meta, programmes });
    }

    async delete(key: ChannelDayKey): Promise<void> {
      this.deletes.push(this.#id(key));
      this.entries.delete(this.#id(key));
    }

    async prune(): Promise<number> {
      return 0;
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
    const [record] = driver.stored(key).programmes;

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
    db.exec("UPDATE entries SET programmes = 'not json at all'");
    db.close();

    await using store = cache(new SqliteCacheDriver({ dir }));

    // The meta is still good, and it is what the manager judges an entry by — so
    // the entry stays, and a count disagreeing with what came back is what makes
    // the day worth grabbing again.
    expect(await store.getMeta(key)).toMatchObject({ programmeCount: 2 });
    expect(await store.read(key)).toEqual([]);
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
