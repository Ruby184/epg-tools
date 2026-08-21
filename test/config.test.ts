import { describe, expect, it, vi } from 'vitest';
import { defineConfig, type EpgConfig } from '../src/config.js';
import {
  createConfigContext,
  defaultsReader,
  envReader,
  type ConfigReader,
} from '../src/core/answers.js';
import { GrabberError } from '../src/core/error.js';

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
      expect((await config()).meta?.sourceInfoName).toBe('from-env');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('puts what the caller supplied ahead of the environment', async () => {
    vi.stubEnv('EPG_USERNAME', 'from-env');

    try {
      const config = defineConfig(named, { env: 'EPG_' });
      const resolved = await config(fixed('conf', { username: ['supplied'] }));

      expect(resolved.meta?.sourceInfoName).toBe('supplied');
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

      expect((await config(fixed('conf', { username: ['supplied'] }))).meta?.sourceInfoName).toBe(
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

    expect((await config()).meta?.sourceInfoName).toBe('west');
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
