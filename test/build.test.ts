import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gunzip as gunzipCallback } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { build, createCacheStore, guideStream, runGrab, runMerge } from '../src/build.js';
import { planRun } from '../src/cli/plan.js';
import { CacheManager, FsNdjsonCacheDriver, NoCacheDriver } from '../src/cache/main.js';
import type { EpgEventMap } from '../src/core/events.js';
import type { ChannelDayKey, StoredEntryMeta } from '../src/cache/main.js';
import { defineConfig, type EpgConfig } from '../src/config.js';
import { parseXmltvString } from '../src/xmltv/main.js';
import { defineSiteConfig, type SiteConfig } from '../src/grabber/types.js';
import type { XmltvProgramme } from '../src/xmltv/types.js';

/**
 * Whether this runtime has `node:sqlite` at all: it arrived in Node 22.5 behind
 * a flag, and the driver named `'sqlite'` is loaded only when asked for, so the
 * one test that asks has to be skipped where asking would fail.
 */
const hasSqlite = await import('node:sqlite').then(
  () => true,
  () => false,
);

const gunzip = promisify(gunzipCallback);

const NOW = new Date('2026-07-17T12:00:00.000Z');
const TODAY = '2026-07-17';
const TOMORROW = '2026-07-18';
const YESTERDAY = '2026-07-16';

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'epg-build-test-'));
}

/** A site that records which days it was asked for and returns one programme each. */
function site(fetchedDays: string[]): SiteConfig<unknown> {
  return {
    site: 'example.com',
    channels: [{ xmltvId: 'one.example', siteId: '1', name: 'One' }],
    async request({ day }) {
      fetchedDays.push(day);
      return { day };
    },
    parseDay({ day }): XmltvProgramme[] {
      return [
        {
          channel: 'one.example',
          start: new Date(`${day}T06:00:00.000Z`),
          title: [{ value: `p-${day}` }],
        },
      ];
    },
  };
}

function config(dir: string, overrides: Partial<EpgConfig> = {}): EpgConfig {
  return {
    sites: [site([])],
    days: 1,
    output: join(dir, 'guide.xml'),
    cache: { dir: join(dir, 'cache') },
    ...overrides,
  };
}

async function collect(chunks: AsyncGenerator<string>): Promise<string> {
  let out = '';

  for await (const chunk of chunks) {
    out += chunk;
  }

  return out;
}

describe('a channel list fetched before the grab', () => {
  // A build settles every list before any site is asked for a day, and the
  // fetch is still the first request of the site's turn: one queue, one state.

  it('is paced with the requests after it', async () => {
    const dir = await tempDir();
    const at: number[] = [];
    const paced: SiteConfig<unknown> = {
      ...site([]),
      rateLimit: { requests: 1, perMs: 80 },
      channels: async () => {
        at.push(Date.now());

        return [{ xmltvId: 'one.example', siteId: '1', name: 'One' }];
      },
      async request({ day }) {
        at.push(Date.now());

        return { day };
      },
    };

    await build(config(dir, { sites: [paced] }), { now: NOW });

    // One request a window: the day waits out the window the list opened,
    // rather than landing on its heels.
    expect(at).toHaveLength(2);
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(70);
  });

  it('hands the requests what fetching it taught the site, with nothing cached', async () => {
    const dir = await tempDir();
    const seen: unknown[] = [];
    const counted: number[] = [];
    const learning: SiteConfig<unknown> = {
      ...site([]),
      channels: async ({ state }) => {
        state.set('token', 'from the list');

        return [{ xmltvId: 'one.example', siteId: '1', name: 'One' }];
      },
      async request({ day, state }) {
        seen.push(state.get('token'));

        return { day };
      },
    };

    await build(config(dir, { sites: [learning], cache: { driver: () => new NoCacheDriver() } }), {
      now: NOW,
      reporter: (event) => {
        if (event.type === 'site:done') {
          counted.push(event.requests);
        }
      },
    });

    expect(seen).toEqual(['from the list']);
    // The list and the day, both counted where both were sent.
    expect(counted).toEqual([2]);
  });
});

describe('a run that selects channels', () => {
  /** One site with two channels, recording which of them it was asked for. */
  function twoChannels(fetched: string[]): SiteConfig<unknown> {
    return {
      ...site([]),
      channels: [
        { xmltvId: 'one.example', siteId: '1', name: 'One' },
        { xmltvId: 'two.example', siteId: '2', name: 'Two' },
      ],
      async request({ channel, day }) {
        fetched.push(channel.xmltvId);

        return { day };
      },
    };
  }

  it('grabs only what it selects, as a build does', async () => {
    const dir = await tempDir();
    const fetched: string[] = [];

    const summary = await runGrab(
      config(dir, { sites: [twoChannels(fetched)], channels: ['two.example'] }),
      { now: NOW },
    );

    expect(fetched).toEqual(['two.example']);
    expect(summary.fetched).toBe(1);

    // Never fetched, and never cached either.
    const cache = await createCacheStore(config(dir));

    expect(
      await cache.getMeta({ site: 'example.com', channelId: 'one.example', day: TODAY }),
    ).toBeUndefined();
  });

  it('grabs what a selected `derived` channel shifts', async () => {
    const dir = await tempDir();
    const fetched: string[] = [];

    await runGrab(
      config(dir, {
        sites: [twoChannels(fetched)],
        derived: [{ xmltvId: 'two.example+1', from: 'two.example', offset: 60 }],
        channels: ['two.example+1'],
      }),
      { now: NOW },
    );

    expect(fetched).toEqual(['two.example']);
  });

  it('says once that a selected channel is produced by no site, in a build too', async () => {
    const dir = await tempDir();
    const warnings: string[] = [];

    await build(
      config(dir, { sites: [twoChannels([])], channels: ['two.example', 'nope.example'] }),
      {
        now: NOW,
        reporter: (event) => {
          if (event.type === 'merge:warning') {
            warnings.push(event.message);
          }
        },
      },
    );

    expect(warnings).toEqual([expect.stringContaining('nope.example')]);
  });
});

describe('a site whose channel list fails', () => {
  /** A site whose source refuses its channel list, counting how often it is asked. */
  function refusing(asked: string[]): SiteConfig<unknown> {
    return {
      ...site([]),
      site: 'broken.example',
      channels: async () => {
        asked.push('channels');
        throw new Error('Request failed with status code 429');
      },
    };
  }

  it('costs a build that site, and the guide comes from the rest', async () => {
    const dir = await tempDir();
    const asked: string[] = [];
    const failed: string[] = [];

    const summary = await build(config(dir, { sites: [site([]), refusing(asked)] }), {
      now: NOW,
      reporter: (event) => {
        if (event.type === 'site:failed') {
          failed.push(event.site);
        }
      },
    });

    // Counted as `epg grab` counts it, so the run still exits non-zero.
    expect(summary).toMatchObject({ fetched: 1, sitesFailed: 1 });
    expect(failed).toEqual(['broken.example']);
    // Once, by the build: the grab is handed the failure rather than asking again.
    expect(asked).toEqual(['channels']);

    const guide = parseXmltvString(await readFile(join(dir, 'guide.xml'), 'utf8'));

    expect(guide.channels.map((channel) => channel.id)).toEqual(['one.example']);
    expect(guide.programmes).toHaveLength(1);
  });

  it('costs a grab that resolves the lists early for `cover` only that site', async () => {
    const dir = await tempDir();
    const asked: string[] = [];

    const summary = await runGrab(
      config(dir, { sites: [site([]), refusing(asked)], merge: { cover: 'first' } }),
      { now: NOW },
    );

    expect(summary).toMatchObject({ fetched: 1, sitesFailed: 1 });
    expect(asked).toEqual(['channels']);
  });

  it('leaves a merge without that site, and says so', async () => {
    const dir = await tempDir();
    const warnings: string[] = [];

    await runGrab(config(dir), { now: NOW });
    await runMerge(config(dir, { sites: [site([]), refusing([])] }), {
      now: NOW,
      reporter: (event) => {
        if (event.type === 'merge:warning') {
          warnings.push(event.message);
        }
      },
    });

    const guide = parseXmltvString(await readFile(join(dir, 'guide.xml'), 'utf8'));

    expect(guide.channels.map((channel) => channel.id)).toEqual(['one.example']);
    expect(warnings).toEqual([
      'broken.example could not resolve its channel list, so the guide has none of its ' +
        'channels: Request failed with status code 429',
    ]);
  });
});

describe('offset', () => {
  it('moves the grab window without moving "now"', async () => {
    const dir = await tempDir();
    const fetchedDays: string[] = [];

    await runGrab(config(dir, { sites: [site(fetchedDays)], days: 2 }), { now: NOW, offset: 1 });

    expect(fetchedDays).toEqual([TOMORROW, '2026-07-19']);
  });

  it('defaults to a window starting today', async () => {
    const dir = await tempDir();
    const fetchedDays: string[] = [];

    await runGrab(config(dir, { sites: [site(fetchedDays)], days: 2 }), { now: NOW });

    expect(fetchedDays).toEqual([TODAY, TOMORROW]);
  });

  it('accepts a negative offset and does not prune the days it just grabbed', async () => {
    const dir = await tempDir();
    const fetchedDays: string[] = [];
    const epgConfig = config(dir, { sites: [site(fetchedDays)], days: 2 });

    await runGrab(epgConfig, { now: NOW, offset: -1 });

    expect(fetchedDays).toEqual([YESTERDAY, TODAY]);

    // Yesterday is inside the window, so the post-grab prune must spare it —
    // and it must still be readable back out of the cache.
    const xml = await collect(guideStream(epgConfig, { now: NOW, offset: -1 }));

    expect(xml).toContain(`start="20260716060000`);
    expect(xml).toContain(`start="20260717060000`);
  });

  it('still prunes days before the window', async () => {
    const dir = await tempDir();
    const epgConfig = config(dir, { days: 1 });

    // Seed a stale day well behind the window, then grab.
    await runGrab(config(dir, { sites: [site([])], days: 1 }), {
      now: new Date('2026-07-10T12:00:00.000Z'),
    });
    await runGrab(epgConfig, { now: NOW });

    const xml = await collect(guideStream(config(dir, { days: 30 }), { now: NOW, offset: -10 }));

    expect(xml).not.toContain('start="20260710');
  });

  it('applies the same window to the grab and the merge', async () => {
    const dir = await tempDir();
    const fetchedDays: string[] = [];
    const epgConfig = config(dir, { sites: [site(fetchedDays)], days: 1 });

    await build(epgConfig, { now: NOW, offset: 2 });

    const xml = await readFile(epgConfig.output, 'utf8');

    expect(fetchedDays).toEqual(['2026-07-19']);
    expect(xml).toContain('start="20260719060000');
    expect(xml).not.toContain('start="20260717');
  });
});

describe('a run with a time zone', () => {
  // Half past midnight on the 17th in Bratislava, which is still the 16th in UTC.
  const LATE = new Date('2026-07-16T22:30:00.000Z');

  /** One programme in the first half hour of each local day, and one at night. */
  function local(fetchedDays: string[]): SiteConfig<unknown> {
    return {
      ...site(fetchedDays),
      parseDay({ day }): XmltvProgramme[] {
        // 00:15 and 20:00 on the day, on Bratislava's summer clock (UTC+2).
        const at = (time: string) =>
          new Date(new Date(`${day}T${time}:00.000Z`).getTime() - 2 * 3_600_000);

        return [
          { channel: 'one.example', start: at('00:15'), title: [{ value: 'small hours' }] },
          { channel: 'one.example', start: at('20:00'), title: [{ value: 'evening' }] },
        ];
      },
    };
  }

  it('starts its window on the zone’s today', async () => {
    const dir = await tempDir();
    const fetchedDays: string[] = [];

    await runGrab(config(dir, { sites: [local(fetchedDays)], timeZone: 'Europe/Bratislava' }), {
      now: LATE,
    });

    expect(fetchedDays).toEqual(['2026-07-17']);
  });

  it('clamps the guide to the zone’s midnights, keeping the first day’s small hours', async () => {
    const dir = await tempDir();

    await build(
      config(dir, {
        sites: [local([])],
        timeZone: 'Europe/Bratislava',
        merge: { clampToWindow: true },
      }),
      { now: LATE },
    );

    const guide = parseXmltvString(await readFile(join(dir, 'guide.xml'), 'utf8'));

    // 00:15 on the 17th is 22:15 on the 16th in UTC — inside the day by the
    // zone's clock, and outside it by UTC's.
    expect(guide.programmes.map((programme) => programme.title[0]?.value)).toEqual([
      'small hours',
      'evening',
    ]);
  });

  it('hands a site’s own code the run’s zone, its days’ zone and a clock on its day', async () => {
    const dir = await tempDir();
    const seen: Record<string, unknown> = {};
    const clocked: SiteConfig<unknown> = {
      ...site([]),
      channels: async ({ timeZone, dayZone }) => {
        seen['channels'] = [timeZone, dayZone];

        return [{ xmltvId: 'one.example', siteId: '1', name: 'One' }];
      },
      async request({ timeZone, dayZone, at }) {
        // A day's bounds are its midnight and the next.
        seen['request'] = [timeZone, dayZone, at('00:00').toISOString(), at('24:00').toISOString()];

        return {};
      },
      parseDay({ timeZone, dayZone, at, programme }) {
        seen['parse'] = [timeZone, dayZone];

        return [
          // An instant, written in the run's offset rather than UTC's.
          programme(new Date('2026-07-17T05:00:00.000Z'), 'Morning'),
          programme(at('20:00'), 'Evening'),
        ];
      },
      transform(programme, { timeZone, dayZone, at }) {
        seen['transform'] = [timeZone, dayZone, at('20:00').toISOString()];

        return programme;
      },
    };

    await build(
      config(dir, {
        sites: [clocked],
        timeZone: 'Europe/Bratislava',
        derived: ({ timeZone }) => {
          seen['derived'] = timeZone;

          return [];
        },
        merge: {
          transform: (programme, { timeZone }) => {
            seen['merge'] = timeZone;

            return programme;
          },
        },
      }),
      { now: LATE },
    );

    const zones = ['Europe/Bratislava', 'Europe/Bratislava'];

    expect(seen).toEqual({
      channels: zones,
      request: [...zones, '2026-07-16T22:00:00.000Z', '2026-07-17T22:00:00.000Z'],
      parse: zones,
      transform: [...zones, '2026-07-17T18:00:00.000Z'],
      derived: 'Europe/Bratislava',
      merge: 'Europe/Bratislava',
    });

    const xml = await readFile(join(dir, 'guide.xml'), 'utf8');

    expect(xml).toContain('start="20260717070000 +0200"');
    // As precise as the time it was given.
    expect(xml).toContain('start="202607172000 +0200"');
  });

  describe('and a channel list that has to be fetched', () => {
    /** A site whose list is fetched, saying which zones it was told. */
    function listing(seen: string[][]): SiteConfig<unknown> {
      return {
        ...site([]),
        channels: async ({ timeZone, dayZone }) => {
          seen.push([timeZone, dayZone]);

          return [{ xmltvId: 'one.example', siteId: '1', name: 'One' }];
        },
      };
    }

    it('tells it the run’s zone when the grab fetches it itself', async () => {
      // No selection and no `cover`, so nothing settles the list before the
      // grab: the site's own turn fetches it.
      const dir = await tempDir();
      const seen: string[][] = [];

      await runGrab(config(dir, { sites: [listing(seen)], timeZone: 'Europe/Bratislava' }), {
        now: LATE,
      });

      expect(seen).toEqual([['Europe/Bratislava', 'Europe/Bratislava']]);
    });

    it('tells it the same in a dry run', async () => {
      const dir = await tempDir();
      const seen: string[][] = [];
      const epgConfig = config(dir, { sites: [listing(seen)], timeZone: 'Europe/Bratislava' });

      await planRun(epgConfig, await createCacheStore(epgConfig), { now: LATE });

      expect(seen).toEqual([['Europe/Bratislava', 'Europe/Bratislava']]);
    });
  });

  it('asks a context covering several days which of them a time is on', async () => {
    const dir = await tempDir();
    const seen: string[] = [];

    await runGrab(
      config(dir, {
        sites: [
          defineSiteConfig({
            site: 'example.com',
            channels: [{ xmltvId: 'one.example', siteId: '1', name: 'One' }],
            batching: 'days',
            parseDay: () => [],
            async request({ at, days }) {
              seen.push(
                at('00:00', days[0]!).toISOString(),
                at('24:00', days.at(-1)!).toISOString(),
              );

              try {
                (at as (time: string) => Date)('20:00');
              } catch (error) {
                seen.push((error as Error).message);
              }

              return {};
            },
          }),
        ],
        days: 2,
        timeZone: 'Europe/Bratislava',
      }),
      { now: LATE },
    );

    expect(seen).toEqual([
      '2026-07-16T22:00:00.000Z',
      '2026-07-18T22:00:00.000Z',
      'at("20:00") needs a day: this context covers more than one',
    ]);
  });

  describe('and a site keyed by UTC date', () => {
    /** A source whose days are UTC days: 20:00 and 22:15 UTC on each. */
    function utc(fetchedDays: string[]): SiteConfig<unknown> {
      return {
        ...site(fetchedDays),
        dayZone: 'utc',
        parseDay({ day }): XmltvProgramme[] {
          return [
            {
              channel: 'one.example',
              start: new Date(`${day}T20:00:00.000Z`),
              title: [{ value: `evening ${day}` }],
            },
            {
              channel: 'one.example',
              start: new Date(`${day}T22:15:00.000Z`),
              title: [{ value: `small hours after ${day}` }],
            },
          ];
        },
      };
    }

    it('is grabbed over the UTC days that cover the window, and merged into its days', async () => {
      const dir = await tempDir();
      const fetchedDays: string[] = [];

      await build(config(dir, { sites: [utc(fetchedDays)], timeZone: 'Europe/Bratislava' }), {
        now: LATE,
      });

      // Bratislava's 17th is 22:00 UTC on the 16th to 22:00 UTC on the 17th.
      expect(fetchedDays).toEqual(['2026-07-16', '2026-07-17']);

      const guide = parseXmltvString(await readFile(join(dir, 'guide.xml'), 'utf8'));

      // The small hours of the 17th come from the UTC 16th; the 17th's own
      // late programme is the 18th there, and outside the window.
      expect(guide.programmes.map((programme) => programme.title[0]?.value)).toEqual([
        'small hours after 2026-07-16',
        'evening 2026-07-17',
      ]);
    });

    it('keeps the UTC day before the window through the prune after the grab', async () => {
      const dir = await tempDir();

      await runGrab(config(dir, { sites: [utc([])], timeZone: 'Europe/Bratislava' }), {
        now: LATE,
      });

      const cache = await createCacheStore(config(dir));

      expect(
        await cache.getMeta({ site: 'example.com', channelId: 'one.example', day: '2026-07-16' }),
      ).toMatchObject({ programmeCount: 2 });
    });

    it('hands its code the day’s zone beside the run’s', async () => {
      const dir = await tempDir();
      const seen: string[][] = [];

      await runGrab(
        config(dir, {
          sites: [
            {
              ...utc([]),
              async request({ channelDays, timeZone, dayZone }) {
                const { day } = channelDays[0]!;

                seen.push([day, timeZone, dayZone]);

                return { day };
              },
            },
          ],
          timeZone: 'Europe/Bratislava',
        }),
        { now: LATE },
      );

      expect(seen).toEqual([
        ['2026-07-16', 'Europe/Bratislava', 'UTC'],
        ['2026-07-17', 'Europe/Bratislava', 'UTC'],
      ]);
    });

    it('says whose days it counts as it starts', async () => {
      const dir = await tempDir();
      const started: unknown[] = [];

      await runGrab(config(dir, { sites: [utc([])], timeZone: 'Europe/Bratislava' }), {
        now: LATE,
        reporter: (event) => {
          if (event.type === 'site:started') {
            started.push(event);
          }
        },
      });

      expect(started).toEqual([expect.objectContaining({ days: 2, dayZone: 'UTC' })]);
    });

    it('refetches both UTC days the zone’s today spans, the later one too', async () => {
      const dir = await tempDir();
      const fetchedDays: string[] = [];
      const epgConfig = config(dir, { sites: [utc(fetchedDays)], timeZone: 'Europe/Bratislava' });

      await runGrab(epgConfig, { now: LATE });
      fetchedDays.length = 0;
      await runGrab(epgConfig, { now: new Date(LATE.getTime() + 60_000) });

      // UTC's today is still the 16th, but most of Bratislava's is the 17th.
      expect(fetchedDays).toEqual(['2026-07-16', '2026-07-17']);
    });

    it('stops asking for the UTC day before once UTC’s midnight has passed too', async () => {
      const dir = await tempDir();
      const fetchedDays: string[] = [];
      const epgConfig = config(dir, { sites: [utc(fetchedDays)], timeZone: 'Europe/Bratislava' });

      await runGrab(epgConfig, { now: LATE });
      fetchedDays.length = 0;
      // Three in the morning in Bratislava, one in UTC: the 16th is behind both.
      await build(epgConfig, { now: new Date('2026-07-17T01:00:00.000Z') });

      expect(fetchedDays).toEqual(['2026-07-17']);

      // What the cache already held of it is still in the guide.
      const guide = parseXmltvString(await readFile(join(dir, 'guide.xml'), 'utf8'));

      expect(guide.programmes.map((programme) => programme.title[0]?.value)).toEqual([
        'small hours after 2026-07-16',
        'evening 2026-07-17',
      ]);
    });

    it('reads and transforms each UTC day once, though two of its days cover it', async () => {
      const dir = await tempDir();
      const seen: string[] = [];

      await build(
        config(dir, {
          sites: [
            {
              ...utc([]),
              transform(programme, { day }) {
                seen.push(`${day} ${programme.title[0]?.value}`);

                return programme;
              },
            },
          ],
          days: 2,
          timeZone: 'Europe/Bratislava',
        }),
        { now: LATE },
      );

      // The 17th covers both the guide's 17th and its 18th.
      expect(seen.toSorted()).toEqual([
        '2026-07-16 evening 2026-07-16',
        '2026-07-16 small hours after 2026-07-16',
        '2026-07-17 evening 2026-07-17',
        '2026-07-17 small hours after 2026-07-17',
        '2026-07-18 evening 2026-07-18',
        '2026-07-18 small hours after 2026-07-18',
      ]);
    });

    describe('with a programme on air as the window begins', () => {
      /** A film from 21:30 to 23:00 UTC each day: across Bratislava's midnight. */
      const film: SiteConfig<unknown> = {
        ...utc([]),
        parseDay({ day }): XmltvProgramme[] {
          return [
            {
              channel: 'one.example',
              start: new Date(`${day}T21:30:00.000Z`),
              stop: new Date(`${day}T23:00:00.000Z`),
              title: [{ value: `film ${day}` }],
            },
          ];
        },
      };

      it('keeps it, as a source on the guide’s calendar would', async () => {
        const dir = await tempDir();

        await build(config(dir, { sites: [film], timeZone: 'Europe/Bratislava' }), { now: LATE });

        const guide = parseXmltvString(await readFile(join(dir, 'guide.xml'), 'utf8'));

        expect(guide.programmes.map((programme) => programme.title[0]?.value)).toEqual([
          'film 2026-07-16',
          'film 2026-07-17',
        ]);
      });

      it('drops it when the guide is clamped to its window', async () => {
        const dir = await tempDir();

        await build(
          config(dir, {
            sites: [film],
            timeZone: 'Europe/Bratislava',
            merge: { clampToWindow: true },
          }),
          { now: LATE },
        );

        const guide = parseXmltvString(await readFile(join(dir, 'guide.xml'), 'utf8'));

        expect(guide.programmes.map((programme) => programme.title[0]?.value)).toEqual([
          'film 2026-07-17',
        ]);
      });
    });

    it('fails a site whose dayZone is not a zone, and the guide comes from the rest', async () => {
      const dir = await tempDir();
      const failed: unknown[] = [];

      const summary = await build(
        config(dir, {
          sites: [site([]), { ...utc([]), site: 'mars.example', dayZone: 'Mars/Olympus' }],
          timeZone: 'Europe/Bratislava',
        }),
        {
          now: LATE,
          reporter: (event) => {
            if (event.type === 'site:failed') {
              failed.push(event.error);
            }
          },
        },
      );

      expect(summary).toMatchObject({ fetched: 1, sitesFailed: 1 });
      expect(failed).toHaveLength(1);
      expect(String(failed[0])).toContain(
        'Site "mars.example" dayZone must be an IANA time zone such as "Europe/Bratislava"',
      );

      const guide = parseXmltvString(await readFile(join(dir, 'guide.xml'), 'utf8'));

      expect(guide.programmes).toHaveLength(1);
    });
  });

  it('refuses a zone that is not one, before anything is asked', async () => {
    const dir = await tempDir();
    const fetchedDays: string[] = [];

    await expect(
      runGrab(config(dir, { sites: [local(fetchedDays)], timeZone: 'Mars/Olympus' }), {
        now: LATE,
      }),
    ).rejects.toThrow('timeZone must be an IANA time zone');
    expect(fetchedDays).toEqual([]);
  });
});

describe('cancellation', () => {
  it('writes no guide when the grab was cancelled, and keeps what it cached', async () => {
    const dir = await tempDir();
    const controller = new AbortController();
    const fetched: string[] = [];
    const cancelling: SiteConfig<unknown> = {
      ...site(fetched),
      channels: [
        { xmltvId: 'one.example', siteId: '1', name: 'One' },
        { xmltvId: 'two.example', siteId: '2', name: 'Two' },
      ],
      async request({ channel, day }) {
        fetched.push(channel.xmltvId);
        controller.abort(new Error('cancelled'));
        return { day };
      },
    };
    const epgConfig = config(dir, { sites: [cancelling], days: 1 });

    const summary = await build(epgConfig, { now: NOW, signal: controller.signal });

    // The channel-day in flight when the cancel landed is reported, and the one
    // still queued was never asked for.
    expect(fetched).toEqual(['one.example']);
    expect(summary.failed).toBe(1);
    // Half a window is not what the guide in place should be replaced with.
    expect(existsSync(epgConfig.output)).toBe(false);
  });

  it('stops a merge between channel-days rather than writing half a guide', async () => {
    const dir = await tempDir();
    const controller = new AbortController();
    const epgConfig = config(dir, { days: 1 });

    await runGrab(epgConfig, { now: NOW });
    expect(existsSync(join(dir, 'cache'))).toBe(true);

    controller.abort(new Error('cancelled'));

    // Node's own convention for an aborted operation, which is what the
    // output pipeline raises: an AbortError carrying the reason as its cause.
    await expect(
      runMerge(epgConfig, { now: NOW, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError', cause: { message: 'cancelled' } });

    // The document is written beside its file and renamed only when finished,
    // so an abandoned one leaves nothing at all.
    expect(existsSync(epgConfig.output)).toBe(false);
    expect((await readdir(dir)).filter((name) => name.startsWith('guide.xml'))).toEqual([]);
  });

  it('leaves the cache unpruned when a run is cancelled', async () => {
    const dir = await tempDir();
    const controller = new AbortController();
    const cache = new CacheManager({
      driver: new FsNdjsonCacheDriver({ dir: join(dir, 'cache') }),
    });
    const stale = { site: 'example.com', channelId: 'one.example', day: YESTERDAY };

    await cache.write(stale, [
      {
        channel: 'one.example',
        start: new Date(`${YESTERDAY}T06:00:00.000Z`),
        title: [{ value: 'old' }],
      },
    ]);

    const cancelling: SiteConfig<unknown> = {
      ...site([]),
      async request({ day }) {
        controller.abort(new Error('cancelled'));
        return { day };
      },
    };

    await runGrab(config(dir, { sites: [cancelling], days: 1 }), {
      now: NOW,
      signal: controller.signal,
    });

    // Pruning a window the grab never finished filling would take days it might
    // still have wanted.
    expect(await cache.getMeta(stale)).toBeDefined();
  });
});

describe('guideStream', () => {
  it('yields the same document runMerge writes', async () => {
    const dir = await tempDir();
    const epgConfig = config(dir, { days: 1 });

    await runGrab(epgConfig, { now: NOW });
    await runMerge(epgConfig, { now: NOW });

    const written = await readFile(epgConfig.output, 'utf8');
    const streamed = await collect(guideStream(epgConfig, { now: NOW }));

    expect(streamed).toBe(written);
  });

  it('starts a well-formed XMLTV document', async () => {
    const dir = await tempDir();
    const epgConfig = config(dir, { days: 1 });

    await runGrab(epgConfig, { now: NOW });

    const xml = await collect(guideStream(epgConfig, { now: NOW }));

    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<!DOCTYPE tv SYSTEM "xmltv.dtd">');
    expect(xml.trimEnd().endsWith('</tv>')).toBe(true);
    expect(xml.indexOf('<channel')).toBeLessThan(xml.indexOf('<programme'));
  });
});

describe('a configuration that still needs its answers', () => {
  it('is resolved by every entry point, not just the CLI', async () => {
    const dir = await tempDir();
    const fetched: string[] = [];
    const source = defineConfig(
      (ctx) => ({
        ...config(dir, { sites: [site(fetched)] }),
        meta: { sourceInfoName: ctx.require('label') },
      }),
      { env: 'EPG_TEST_' },
    );

    vi.stubEnv('EPG_TEST_LABEL', 'from-env');

    try {
      // Each of these took an EpgConfig only, so a factory config had to be
      // called by hand before use — while the CLI called it for you.
      const summary = await build(source, { now: NOW });
      expect(summary.fetched).toBe(1);
      expect(await readFile(join(dir, 'guide.xml'), 'utf8')).toContain(
        'source-info-name="from-env"',
      );

      // Today is always refetched, so this is a grab and not a cache hit.
      expect((await runGrab(source, { now: NOW })).fetched).toBe(1);
      expect(await collect(guideStream(source, { now: NOW }))).toContain(
        'source-info-name="from-env"',
      );

      await runMerge(source, { now: NOW });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('is resolved once for a build, so the grab and the merge agree', async () => {
    const dir = await tempDir();
    let calls = 0;

    const source = defineConfig(() => {
      calls++;
      return config(dir);
    });

    await build(source, { now: NOW });

    // A factory may read the environment or fetch; the merge must not get a
    // second, possibly different answer.
    expect(calls).toBe(1);
  });

  it('resolves a fetched channel list once for a build, not once per pass', async () => {
    const dir = await tempDir();
    let calls = 0;

    const lazy: SiteConfig<unknown> = {
      ...site([]),
      channels: () => {
        calls++;
        return [{ xmltvId: 'one.example', siteId: '1', name: 'One' }];
      },
    };

    await build(config(dir, { sites: [lazy] }), { now: NOW });

    // The grab and the merge that reads what it wrote must not each ask the
    // source what its channels are: the answer can change in between.
    expect(calls).toBe(1);
    expect(await readFile(join(dir, 'guide.xml'), 'utf8')).toContain('one.example');
  });

  it('keeps a fetched channel list for the next build when the site asks', async () => {
    const dir = await tempDir();
    let calls = 0;

    const cached: SiteConfig<unknown> = {
      ...site([]),
      cacheChannels: true,
      channels: () => {
        calls++;
        return [{ xmltvId: 'one.example', siteId: '1', name: 'One' }];
      },
    };

    await build(config(dir, { sites: [cached] }), { now: NOW });
    await build(config(dir, { sites: [cached] }), { now: NOW });

    // Two builds, one question of the source — the second read the list the
    // first left in the cache, and built the same guide from it.
    expect(calls).toBe(1);
    expect(await readFile(join(dir, 'guide.xml'), 'utf8')).toContain('one.example');
    expect(await readFile(join(dir, 'cache', 'example.com', 'channels.json'), 'utf8')).toContain(
      'one.example',
    );
  });

  it('asks every site for its channels at once when a merge has to ask', async () => {
    const dir = await tempDir();
    let waiting = 0;
    let both: (() => void) | undefined;
    // Nobody resolves until both sites are inside their channels function, so
    // this only settles if the merge asks them in parallel.
    const together = new Promise<void>((resolve) => {
      both = resolve;
    });

    const lazy = (id: string): SiteConfig<unknown> => ({
      ...site([]),
      site: id,
      channels: async () => {
        if (++waiting === 2) {
          both?.();
        }

        await together;

        return [{ xmltvId: id, siteId: '1', name: id }];
      },
    });

    // Only the merge runs, so the pre-resolved lists a build hands down are not
    // what is being measured here.
    await runMerge(config(dir, { sites: [lazy('a.example'), lazy('b.example')] }), { now: NOW });

    const guide = await readFile(join(dir, 'guide.xml'), 'utf8');

    expect(guide).toContain('a.example');
    expect(guide).toContain('b.example');
  });

  it('holds a merge to siteConcurrency when it is set', async () => {
    const dir = await tempDir();
    let inFlight = 0;
    let peak = 0;

    const lazy = (id: string): SiteConfig<unknown> => ({
      ...site([]),
      site: id,
      channels: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;

        return [{ xmltvId: id, siteId: '1', name: id }];
      },
    });

    await runMerge(
      config(dir, {
        sites: [lazy('a.example'), lazy('b.example'), lazy('c.example')],
        siteConcurrency: 1,
      }),
      { now: NOW },
    );

    expect(peak).toBe(1);
  });
});

describe("cover: 'first'", () => {
  /** A site whose channels are given, recording every (channel, day) it fetched. */
  function covering(name: string, ids: string[], asked: string[]): SiteConfig<unknown> {
    return {
      site: name,
      channels: ids.map((id) => ({ xmltvId: id, siteId: id, name: id })),
      async request({ channel, day }) {
        asked.push(`${name} ${channel.xmltvId} ${day}`);

        return { day };
      },
      parseDay({ channel, day }): XmltvProgramme[] {
        return [
          {
            channel: channel.xmltvId,
            start: new Date(`${day}T06:00:00.000Z`),
            title: [{ value: `${name}-${channel.xmltvId}` }],
          },
        ];
      },
    };
  }

  it('never asks a lower-priority site for a channel the first one covers', async () => {
    const dir = await tempDir();
    const asked: string[] = [];
    const epg = config(dir, {
      sites: [
        covering('a.example', ['one', 'two'], asked),
        covering('b.example', ['two', 'three'], asked),
      ],
      merge: { cover: 'first' },
    });

    await build(epg, { now: NOW });

    // `two` is covered by both and grabbed once, from the site that comes first.
    expect(asked.sort()).toEqual([
      `a.example one ${TODAY}`,
      `a.example two ${TODAY}`,
      `b.example three ${TODAY}`,
    ]);

    const guide = await readFile(join(dir, 'guide.xml'), 'utf8');

    expect(guide).toContain('<title>a.example-two</title>');
    expect(guide).not.toContain('b.example-two');
  });

  it('applies to a grab on its own, which is where the requests are', async () => {
    const dir = await tempDir();
    const asked: string[] = [];
    const epg = config(dir, {
      sites: [covering('a.example', ['one'], asked), covering('b.example', ['one'], asked)],
      merge: { cover: 'first' },
    });

    await runGrab(epg, { now: NOW });

    expect(asked).toEqual([`a.example one ${TODAY}`]);
  });

  it('leaves both sites asked under the strategies that use both', async () => {
    const dir = await tempDir();
    const asked: string[] = [];
    const epg = config(dir, {
      sites: [covering('a.example', ['one'], asked), covering('b.example', ['one'], asked)],
      merge: { channelStrategy: 'first-wins' },
    });

    await runGrab(epg, { now: NOW });

    // What `first-wins` keeps: the lower site's copy is cached, so switching to
    // a strategy that reads it costs no refetch.
    expect(asked.sort()).toEqual([`a.example one ${TODAY}`, `b.example one ${TODAY}`]);
  });

  it('lets a rule decide per channel, lower site and all', async () => {
    // The case `'first'` cannot express: the site that comes first is not the
    // right answer for every channel, and which one is depends on what each
    // offers. Here the second site wins `two`, which is the direction site
    // order alone can never go.
    const dir = await tempDir();
    const asked: string[] = [];
    const first = covering('a.example', ['one', 'two'], asked);
    const second = covering('b.example', ['two', 'three'], asked);

    // The first site has no picture for `two` and the second one does, which is
    // the whole of what the rule decides on.
    first.channels = [
      { xmltvId: 'one', siteId: 'one', name: 'one', logo: 'https://a.example/one.png' },
      { xmltvId: 'two', siteId: 'two', name: 'two' },
    ];
    second.channels = [
      { xmltvId: 'two', siteId: 'two', name: 'two', logo: 'https://b.example/two.png' },
      { xmltvId: 'three', siteId: 'three', name: 'three' },
    ];

    const seen: string[] = [];
    const epg = config(dir, {
      sites: [first, second],
      merge: {
        cover: ({ xmltvId, offers }) => {
          seen.push(`${xmltvId}:${offers.map((offer) => offer.site).join('+')}`);

          const best = offers.find((offer) => offer.channel.logo !== undefined);

          return best === undefined ? offers.slice(0, 1) : [best];
        },
      },
    });

    await build(epg, { now: NOW });

    // Asked only about what was contested: `one` and `three` have one site each.
    expect(seen).toEqual(['two:a.example+b.example']);
    expect(asked.sort()).toEqual([
      `a.example one ${TODAY}`,
      `b.example three ${TODAY}`,
      `b.example two ${TODAY}`,
    ]);

    const guide = await readFile(join(dir, 'guide.xml'), 'utf8');

    expect(guide).toContain('<title>b.example-two</title>');
    expect(guide).not.toContain('a.example-two');
  });

  it('says so when a rule keeps a site that offered nothing', async () => {
    const dir = await tempDir();
    const asked: string[] = [];
    const said: string[] = [];
    const epg = config(dir, {
      sites: [covering('a.example', ['one'], asked), covering('b.example', ['one'], asked)],
      merge: { cover: () => ['c.example'] },
    });

    await runGrab(epg, {
      now: NOW,
      reporter: (event) => {
        if (event.type === 'merge:warning') {
          said.push(event.message);
        }
      },
    });

    // A misspelled site name reads exactly like a rule that decided against
    // everybody, so it is said rather than left to look deliberate.
    expect(said.join('\n')).toContain('c.example');
    expect(asked).toEqual([]);
  });
});

describe('what a config asked to be told', () => {
  it('reaches the emitter through a library run, not only the command', async () => {
    const dir = await tempDir();
    const heard: string[] = [];
    const events = new EventEmitter<EpgEventMap>();

    events.on('grab:done', (event) => heard.push(`done ${String(event.fetched)}`));

    await runGrab({ ...config(dir), events }, { now: NOW });

    expect(heard).toEqual(['done 1']);
  });

  it('reaches it once from a build, through both halves', async () => {
    const dir = await tempDir();
    const heard = new Map<string, number>();
    const events = new EventEmitter<EpgEventMap>();

    for (const type of ['site:done', 'grab:done', 'merge:summary'] as const) {
      events.on(type, () => heard.set(type, (heard.get(type) ?? 0) + 1));
    }

    await build({ ...config(dir), events }, { now: NOW });

    // Each half used to add the emitter again to a reporter that already had
    // it, so everything a build said reached it twice.
    expect(Object.fromEntries(heard)).toEqual({
      'site:done': 1,
      'grab:done': 1,
      'merge:summary': 1,
    });
  });
});

describe('the cache a config describes', () => {
  /** A driver that counts what a run asked of it, and whether it was let go of. */
  class CountingDriver extends FsNdjsonCacheDriver {
    writes = 0;
    closed = 0;

    override async write(
      key: ChannelDayKey,
      body: Uint8Array,
      meta: StoredEntryMeta,
    ): Promise<void> {
      this.writes++;
      await super.write(key, body, meta);
    }

    async close(): Promise<void> {
      this.closed++;
    }
  }

  it('builds the driver a factory returns, and tells it where and when', async () => {
    const dir = await tempDir();
    const seen: Array<{ dir: string; signal?: AbortSignal | undefined }> = [];
    const controller = new AbortController();
    const driver = new CountingDriver({ dir: join(dir, 'elsewhere') });

    await runGrab(
      config(dir, {
        cache: {
          dir: join(dir, 'cache'),
          // Whatever else a driver of yours takes is in scope where the function
          // is written, which is why nothing here is passed through for it.
          driver: (options) => {
            seen.push(options);

            return driver;
          },
        },
      }),
      { now: NOW, signal: controller.signal },
    );

    expect(seen).toEqual([{ dir: join(dir, 'cache'), signal: controller.signal }]);
    expect(driver.writes).toBe(1);
    // Entries went where the driver put them, not where the config said.
    expect(await readdir(join(dir, 'elsewhere'))).toEqual(['example.com']);
  });

  it('lets go of the cache however the run ended', async () => {
    const dir = await tempDir();
    const drivers: CountingDriver[] = [];
    const withDriver = (overrides: Partial<EpgConfig> = {}): EpgConfig =>
      config(dir, {
        ...overrides,
        cache: {
          dir: join(dir, 'cache'),
          driver: (options) => {
            const driver = new CountingDriver(options);
            drivers.push(driver);

            return driver;
          },
        },
      });

    await runGrab(withDriver(), { now: NOW });
    await runMerge(withDriver(), { now: NOW });
    await collect(guideStream(withDriver(), { now: NOW }));

    // A grab, a merge, and a stream read to its end: three caches, each given
    // back — a driver holding a database handle is waiting for exactly this.
    expect(drivers.map((driver) => driver.closed)).toEqual([1, 1, 1]);

    // And a run that threw: the `finally` is the whole point. Thrown by the
    // config's own code, since a site's list failing no longer stops a merge.
    const failing = withDriver({
      derived: () => {
        throw new Error('no derived channels');
      },
    });

    await expect(runMerge(failing, { now: NOW })).rejects.toThrow('no derived channels');
    expect(drivers).toHaveLength(4);
    expect(drivers.at(-1)!.closed).toBe(1);
  });

  it('closes a guide stream that was walked away from half way', async () => {
    const dir = await tempDir();
    let driver: CountingDriver | undefined;
    const epgConfig = config(dir, {
      days: 2,
      cache: {
        dir: join(dir, 'cache'),
        driver: ({ dir: cacheDir }) => (driver = new CountingDriver({ dir: cacheDir })),
      },
    });

    await runGrab(epgConfig, { now: NOW });

    const stream = guideStream(epgConfig, { now: NOW });
    await stream.next();
    await stream.return(undefined);

    expect(driver!.closed).toBe(1);
  });

  it('asks the config invalidate about a cached entry', async () => {
    const dir = await tempDir();
    const fetchedDays: string[] = [];
    const epgConfig = config(dir, { sites: [site(fetchedDays)] });

    // Tomorrow rather than today, since today is inside `alwaysRefetchDays` and
    // would be fetched again whatever the cache holds.
    const run = { now: NOW, offset: 1 };

    await runGrab(epgConfig, run);
    expect(fetchedDays).toEqual([TOMORROW]);

    // Fresh, so a second run serves it from the cache — until something says the
    // entry is void.
    await runGrab(epgConfig, run);
    expect(fetchedDays).toEqual([TOMORROW]);

    await runGrab(
      {
        ...epgConfig,
        cache: { ...epgConfig.cache, invalidate: (meta) => meta.writtenBy === __PKG_VERSION__ },
      },
      run,
    );

    expect(fetchedDays).toEqual([TOMORROW, TOMORROW]);
  });

  it('is a resource `await using` can hold', async () => {
    const dir = await tempDir();
    let driver: CountingDriver | undefined;
    const epgConfig = config(dir, {
      cache: {
        dir: join(dir, 'cache'),
        driver: ({ dir: cacheDir }) => (driver = new CountingDriver({ dir: cacheDir })),
      },
    });

    {
      await using cache = await createCacheStore(epgConfig);

      expect(await cache.prune({ before: TODAY })).toBe(0);
      expect(driver!.closed).toBe(0);
    }

    expect(driver!.closed).toBe(1);
  });
});

describe('a compressed guide', () => {
  it('gzips what a `.gz` output asks for, and parses back the same', async () => {
    const dir = await tempDir();
    const output = join(dir, 'guide.xml.gz');

    await build(config(dir, { days: 2, output }), { now: NOW });

    const bytes = await readFile(output);

    expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0x1f, 0x8b, 0x08]));

    // The guide inside is the guide that would have been written plainly, and a
    // fraction of the size — which is the whole reason to ask.
    const plain = join(dir, 'plain.xml');

    await build(config(dir, { days: 2, output: plain }), { now: NOW });

    const document = (await gunzip(bytes)).toString('utf8');

    expect(document).toBe(await readFile(plain, 'utf8'));
    expect(bytes.length).toBeLessThan((await stat(plain)).size);
    expect(parseXmltvString(document).programmes).toHaveLength(2);
  });

  it('writes a plain guide to a `.gz` name when the config says so', async () => {
    const dir = await tempDir();
    const output = join(dir, 'guide.xml.gz');

    await build(config(dir, { output, compress: false }), { now: NOW });

    expect(await readFile(output, 'utf8')).toContain('<programme');
  });

  it('compresses a guide whose name says nothing, when asked', async () => {
    const dir = await tempDir();
    const output = join(dir, 'guide.xml');

    await build(config(dir, { output, compress: { format: 'gzip', level: 9 } }), { now: NOW });

    expect((await gunzip(await readFile(output))).toString('utf8')).toContain('<programme');
  });
});

describe('a cache handed to a run', () => {
  it("is used instead of the config's, and left open for its owner", async () => {
    const dir = await tempDir();
    const driver = new FsNdjsonCacheDriver({ dir: join(dir, 'mine') });
    let closed = 0;
    const cache = new CacheManager({ driver });
    cache.close = async (): Promise<void> => {
      closed++;
    };

    const epgConfig = config(dir, { cache: { dir: join(dir, 'ignored') } });

    await runGrab(epgConfig, { now: NOW, cache });
    await runMerge(epgConfig, { now: NOW, cache });
    await collect(guideStream(epgConfig, { now: NOW, cache }));

    // The config's own directory was never touched, and nothing closed a cache
    // it did not open — a caller that opened a database may want it again.
    await expect(readdir(join(dir, 'ignored'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(join(dir, 'mine'))).toEqual(['example.com']);
    expect(closed).toBe(0);
  });

  it('is asked for once by a build, and shared by its grab and its merge', async () => {
    const dir = await tempDir();
    let asked = 0;
    const epgConfig = config(dir, {
      days: 2,
      cache: {
        dir: join(dir, 'cache'),
        driver: ({ dir: cacheDir }) => {
          asked++;

          return new FsNdjsonCacheDriver({ dir: cacheDir });
        },
      },
    });

    await build(epgConfig, { now: NOW });

    expect(asked).toBe(1);
    expect(await readFile(epgConfig.output, 'utf8')).toContain(`p-${TODAY}`);
  });

  it('builds a whole guide through a cache that only lives in memory', async () => {
    const dir = await tempDir();
    const fetchedDays: string[] = [];
    const epgConfig = config(dir, {
      days: 2,
      sites: [site(fetchedDays)],
      cache: { dir: join(dir, 'cache'), driver: 'memory' },
    });

    await build(epgConfig, { now: NOW });

    // The merge read what the grab had just written, because a build shares one
    // cache — and nothing was left on disk to read it from again.
    const guide = await readFile(epgConfig.output, 'utf8');

    expect(guide).toContain(`p-${TODAY}`);
    expect(guide).toContain(`p-${TOMORROW}`);
    expect(fetchedDays).toEqual([TODAY, TOMORROW]);
    expect(existsSync(join(dir, 'cache'))).toBe(false);

    // And a second build grabs the lot again, since nothing remembers it.
    await build(epgConfig, { now: NOW });
    expect(fetchedDays).toEqual([TODAY, TOMORROW, TODAY, TOMORROW]);
  });
});

describe('naming a driver a config does not have', () => {
  it('fails rather than quietly using the default', async () => {
    const dir = await tempDir();
    const epgConfig = config(dir, {
      // A config written in JavaScript can say this; TypeScript cannot.
      cache: { dir: join(dir, 'cache'), driver: 'postgres' as 'ndjson' },
    });

    await expect(createCacheStore(epgConfig)).rejects.toThrow('Unknown cache driver: postgres');
  });

  it.skipIf(hasSqlite)('says what the sqlite driver needs when the runtime lacks it', async () => {
    const dir = await tempDir();
    const epgConfig = config(dir, { cache: { dir: join(dir, 'cache'), driver: 'sqlite' } });

    // Node's own message names a module the config never mentioned, so the
    // choice that led here is named instead — with Node's reason kept.
    await expect(createCacheStore(epgConfig)).rejects.toThrow(
      /sqlite cache driver needs Node 24 or newer.*node:sqlite/s,
    );
  });

  it.skipIf(!hasSqlite)('keeps its entries in one SQLite file when asked for by name', async () => {
    const dir = await tempDir();
    const fetchedDays: string[] = [];
    const epgConfig = config(dir, {
      sites: [site(fetchedDays)],
      cache: { dir: join(dir, 'cache'), driver: 'sqlite' },
    });

    await runGrab(epgConfig, { now: NOW });
    await runMerge(epgConfig, { now: NOW });

    // One file for the whole cache, rather than a directory per channel.
    expect((await readdir(join(dir, 'cache'))).filter((name) => !name.includes('-'))).toEqual([
      'cache.sqlite',
    ]);
    expect(await readFile(epgConfig.output, 'utf8')).toContain('p-2026-07-17');
    expect(fetchedDays).toEqual([TODAY]);

    // And the guide comes from the cache on a second merge, with no grab.
    await runMerge(epgConfig, { now: NOW });
    expect(fetchedDays).toEqual([TODAY]);
  });
});

describe('an output profile', () => {
  /** A site whose programme carries the things a profile reshapes. */
  function shapedSite(fetchedDays: string[]): SiteConfig<unknown> {
    return {
      ...site(fetchedDays),
      parseDay({ day }): XmltvProgramme[] {
        return [
          {
            channel: 'one.example',
            start: new Date(`${day}T06:00:00.000Z`),
            title: [{ value: `p-${day}` }],
            category: [{ value: 'Movie', lang: 'en' }],
            review: [{ type: 'text', value: 'Good' }],
          },
        ];
      },
    };
  }

  it('shapes the guide and leaves the cache holding what the site said', async () => {
    // The property the whole design rests on: a profile applies as the document
    // is written, so the cache stays a record of what each source produced.
    const dir = await tempDir();
    const fetchedDays: string[] = [];
    const epgConfig = config(dir, { sites: [shapedSite(fetchedDays)], profile: 'tvheadend' });

    await build(epgConfig, { now: NOW });

    const guide = await readFile(epgConfig.output, 'utf8');

    expect(guide).toContain('Movie / Drama');
    expect(guide).toContain('eit="0x10"');
    // tvheadend reads no `<review>`, so the profile drops it.
    expect(guide).not.toContain('<review');

    // The cache, meanwhile, is untouched by any of it.
    const cached = await readFile(
      join(dir, 'cache', 'example.com', 'one.example', `${TODAY}.ndjson`),
      'utf8',
    );

    expect(cached).toContain('Movie');
    expect(cached).not.toContain('Movie / Drama');
    expect(cached).toContain('Good');
  });

  it('answers two consumers from one grab, fetching nothing the second time', async () => {
    // Which is the point of shaping on the way out rather than on the way in:
    // switching profile is a re-merge, not a re-grab.
    const dir = await tempDir();
    const fetchedDays: string[] = [];
    const base = config(dir, { sites: [shapedSite(fetchedDays)] });

    await build({ ...base, profile: 'tvheadend' }, { now: NOW });
    expect(fetchedDays).toEqual([TODAY]);

    const plain = join(dir, 'plain.xml');

    await runMerge({ ...base, output: plain, profile: 'jellyfin' }, { now: NOW });

    // No second grab, and a different document.
    expect(fetchedDays).toEqual([TODAY]);

    const shaped = await readFile(base.output, 'utf8');
    const other = await readFile(plain, 'utf8');

    // Only the tvheadend profile asks for the genre code.
    expect(shaped).toContain('eit="0x10"');
    expect(other).not.toContain('eit=');
    expect(other).toContain('Movie / Drama');
  });
});
