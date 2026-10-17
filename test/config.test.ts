import { describe, expect, it, vi } from 'vitest';
import { defineConfig, resolveConfigSource, type EpgConfig } from '../src/config.js';
import { ResolvedUnion } from '../src/merge/union.js';
import {
  createConfigContext,
  defaultsReader,
  envReader,
  type ConfigReader,
} from '../src/core/answers.js';
import { GrabberError } from '../src/core/error.js';
import type { XmltvDocumentMeta } from '../src/xmltv/types.js';

/** What a resolved config named itself — `meta` here is always written by hand. */
function sourceInfoName(config: EpgConfig): string | undefined {
  return (config.meta as XmltvDocumentMeta | undefined)?.sourceInfoName;
}

const STAGES = [
  {
    name: 'start',
    next: 'select-channels',
    fields: [
      { type: 'string' as const, id: 'username', title: 'User', description: 'Who you are.' },
      {
        type: 'string' as const,
        id: 'region',
        title: 'Region',
        description: 'Where.',
        default: 'west',
      },
    ],
  },
];

/** A source with fixed answers, standing in for a grabber configuration file. */
function fixed(name: string, values: Record<string, string[]>): ConfigReader {
  return {
    name,
    read: (id) => values[id],
    describe: () => `put it in ${name}`,
  };
}

const named = (ctx: { require(id: string): string }): EpgConfig => ({
  sites: [],
  output: 'guide.xml',
  meta: { sourceInfoName: ctx.require('username') },
});

describe('answer sources', () => {
  it('asks each in turn and takes the first that answers', () => {
    const ctx = createConfigContext([
      fixed('first', { username: ['a'] }),
      fixed('second', { username: ['b'], region: ['east'] }),
    ]);

    expect(ctx.get('username')).toBe('a');
    expect(ctx.get('region')).toBe('east');
    expect(ctx.get('nothing')).toBeUndefined();
  });

  it('keeps every value of a question that was answered more than once', () => {
    const ctx = createConfigContext([fixed('conf', { channel: ['one.tv', 'two.tv'] })]);

    expect(ctx.all('channel')).toEqual(['one.tv', 'two.tv']);
    expect(ctx.get('channel')).toBe('one.tv');
    expect(ctx.all('missing')).toEqual([]);
  });

  it('names every place a missing answer could have come from', () => {
    const ctx = createConfigContext([fixed('the file', {}), envReader('EPG_')]);

    expect(() => ctx.require('password')).toThrow(GrabberError);
    // In the order they are asked, so the first is the one that takes effect.
    expect(() => ctx.require('password')).toThrow(
      'No value for "password": put it in the file, or set EPG_PASSWORD',
    );
  });

  it('reads the environment under a prefix, treating an empty variable as unset', () => {
    const reader = envReader('EPG_', {
      EPG_USERNAME: 'mattias',
      EPG_PASSWORD: '',
      EPG_API_KEY: 'k',
    });

    expect(reader.read('username')).toEqual(['mattias']);
    // An unset variable and one a shell expanded to nothing are the same thing.
    expect(reader.read('password')).toBeUndefined();
    // A dashed field id is not a legal variable name.
    expect(reader.read('api-key')).toEqual(['k']);
    expect(reader.describe?.('api-key')).toBe('set EPG_API_KEY');
  });

  it('takes a stage default as the last answer', () => {
    const reader = defaultsReader(STAGES);

    expect(reader.read('region')).toEqual(['west']);
    expect(reader.read('username')).toBeUndefined();
    // Nowhere to direct a user to, so it says nothing when an answer is missing.
    expect(reader.describe).toBeUndefined();
  });
});

describe('defineConfig', () => {
  it('returns a plain config unchanged', () => {
    const config: EpgConfig = { sites: [], output: 'guide.xml' };
    expect(defineConfig(config)).toBe(config);
  });

  it('resolves with no sources at all, which is what epg build does', async () => {
    vi.stubEnv('EPG_USERNAME', 'from-env');

    try {
      const config = defineConfig(named, { env: 'EPG_' });
      expect(sourceInfoName(await config())).toBe('from-env');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('puts what the caller supplied ahead of the environment', async () => {
    vi.stubEnv('EPG_USERNAME', 'from-env');

    try {
      const config = defineConfig(named, { env: 'EPG_' });
      const resolved = await config(fixed('conf', { username: ['supplied'] }));

      expect(sourceInfoName(resolved)).toBe('supplied');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('lets the configuration order the sources itself', async () => {
    vi.stubEnv('EPG_USERNAME', 'from-env');

    try {
      const config = defineConfig(named, {
        readers: (supplied) => [envReader('EPG_'), ...supplied],
      });

      expect(sourceInfoName(await config(fixed('conf', { username: ['supplied'] })))).toBe(
        'from-env',
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('answers from a stage default when nothing else does', async () => {
    const config = defineConfig(
      (ctx) => ({
        sites: [],
        output: 'guide.xml',
        meta: { sourceInfoName: ctx.require('region') },
      }),
      { stages: STAGES, env: 'EPG_' },
    );

    expect(sourceInfoName(await config())).toBe('west');
  });

  it('carries its stages, so a grabber shim cannot pass one without the other', () => {
    expect(defineConfig(named, { stages: STAGES }).stages).toBe(STAGES);
    // Nothing to carry, and nothing pretending there is.
    expect(defineConfig(named).stages).toBeUndefined();
  });

  it('awaits a factory that has to fetch something first', async () => {
    const config = defineConfig(
      async (ctx) => {
        await Promise.resolve();
        return { sites: [], output: `${ctx.get('region') ?? 'nowhere'}.xml` };
      },
      { stages: STAGES },
    );

    expect((await config()).output).toBe('west.xml');
  });
});

describe('a config as it is loaded', () => {
  const plain: EpgConfig = { sites: [], output: 'guide.xml' };

  it('settles the time zone it left out as the process’s own', async () => {
    // The suite runs in UTC; see `vitest.config.ts`.
    expect((await resolveConfigSource(plain)).timeZone).toBe('UTC');
  });

  it('keeps one it was given, from a factory as from an object', async () => {
    const zone = { ...plain, timeZone: 'Europe/Bratislava' };

    expect((await resolveConfigSource(zone)).timeZone).toBe('Europe/Bratislava');
    expect((await resolveConfigSource(defineConfig(() => zone))).timeZone).toBe(
      'Europe/Bratislava',
    );
  });

  it('refuses one that is not a zone, before anything reads it', async () => {
    await expect(resolveConfigSource({ ...plain, timeZone: 'Mars/Olympus' })).rejects.toThrow(
      'timeZone must be an IANA time zone such as "Europe/Bratislava" (got "Mars/Olympus")',
    );
  });

  it('carries merge.union settled, with its own match, for the merge to take', async () => {
    const loaded = await resolveConfigSource({
      ...plain,
      merge: {
        union: { title: 'match' },
        match: { normalizeTitle: (title) => title.replace(/\s+[IVX]+\.?$/, '') },
      },
    });
    const union = loaded.merge?.union;

    expect(union).toBeInstanceOf(ResolvedUnion);
    expect(
      (union as ResolvedUnion).apply({
        channel: 'X',
        start: new Date(0),
        title: [{ value: 'Priatelia I.' }, { value: 'Priatelia' }],
      }).title,
    ).toEqual([{ value: 'Priatelia I.' }]);
  });

  it('loads a config whose merge is null, as everything that reads it does', async () => {
    const loaded = await resolveConfigSource({ ...plain, merge: null as never });

    expect(loaded.merge).toBeNull();
  });

  it('refuses a merge.union it cannot read, before a grab would run', async () => {
    await expect(
      resolveConfigSource({ ...plain, merge: { union: { desc: 'containd' as never } } }),
    ).rejects.toThrow("merge.union.desc must be 'exact', 'caseless', 'match', 'contained'");
  });
});
