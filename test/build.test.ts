import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { build, guideStream, runGrab, runMerge } from '../src/build.js';
import { defineConfig, type EpgConfig } from '../src/config.js';
import type { SiteConfig } from '../src/grabber/types.js';
import type { XmltvProgramme } from '../src/xmltv/types.js';

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
      return [{
        channel: 'one.example',
        start: new Date(`${day}T06:00:00.000Z`),
        title: [{ value: `p-${day}` }],
      }];
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
    await runGrab(config(dir, { sites: [site([])], days: 1 }), { now: new Date('2026-07-10T12:00:00.000Z') });
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
      expect(await readFile(join(dir, 'guide.xml'), 'utf8'))
        .toContain('source-info-name="from-env"');

      // Today is always refetched, so this is a grab and not a cache hit.
      expect((await runGrab(source, { now: NOW })).fetched).toBe(1);
      expect(await collect(guideStream(source, { now: NOW })))
        .toContain('source-info-name="from-env"');

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
});
