import { describe, expect, it } from 'vitest';
import { OptionError, parseOptions } from '../src/core/options.js';

describe('parseOptions', () => {
  it('parses booleans, strings and positionals', () => {
    const { values, positionals } = parseOptions(
      ['build', '--config', 'epg.config.ts', '-q'],
      {
        config: { type: 'string', short: 'c' },
        quiet: { type: 'boolean', short: 'q' },
      },
      { allowPositionals: true },
    );

    expect(values).toEqual({ config: 'epg.config.ts', quiet: true });
    expect(positionals).toEqual(['build']);
  });

  it('rejects positionals unless allowed', () => {
    expect(() => parseOptions(['build'], { quiet: { type: 'boolean' } }))
      .toThrow("Unexpected argument 'build'");
  });

  it('stops treating arguments as options after --', () => {
    const { values, positionals } = parseOptions(
      ['--quiet', '--', '--not-an-option'],
      { quiet: { type: 'boolean' } },
      { allowPositionals: true },
    );

    expect(values.quiet).toBe(true);
    expect(positionals).toEqual(['--not-an-option']);
  });

  it('reports a missing value', () => {
    expect(() => parseOptions(['--config'], { config: { type: 'string' } }))
      .toThrow("Option '--config' requires a value");
  });

  it('rejects unknown options', () => {
    // tv_validate_grabber probes with a nonsense flag and requires a failure.
    expect(() => parseOptions(['--ahdmegkeja'], { quiet: { type: 'boolean' } }))
      .toThrow(/Unknown option/);
  });

  describe('numbers', () => {
    it('converts and range-checks', () => {
      const { values } = parseOptions(['--days', '14'], { days: { type: 'number', min: 1 } });

      expect(values.days).toBe(14);
      expect(typeof values.days).toBe('number');
    });

    it('rejects fractions and trailing junk instead of truncating them', () => {
      const specs = { days: { type: 'number' } } as const;

      expect(() => parseOptions(['--days=7.5'], specs)).toThrow('Invalid --days value: 7.5 (expected a whole number)');
      expect(() => parseOptions(['--days=7x'], specs)).toThrow('Invalid --days value: 7x (expected a number)');
      expect(() => parseOptions(['--days='], specs)).toThrow('Invalid --days value:  (expected a number)');
    });

    it('enforces min and max', () => {
      expect(() => parseOptions(['--days=0'], { days: { type: 'number', min: 1 } }))
        .toThrow('Invalid --days value: 0 (must be at least 1)');
      expect(() => parseOptions(['--days=99'], { days: { type: 'number', max: 14 } }))
        .toThrow('Invalid --days value: 99 (must be at most 14)');
    });

    it('accepts a fractional value when integer is off', () => {
      const { values } = parseOptions(['--ratio=1.5'], { ratio: { type: 'number', integer: false } });

      expect(values.ratio).toBe(1.5);
    });

    it('accepts a negative value in both the joined and separated forms', () => {
      // parseArgs alone rejects the separated form as an ambiguous value, but
      // Getopt::Long — hence every XMLTV grabber caller — accepts it.
      const specs = { offset: { type: 'number' } } as const;

      expect(parseOptions(['--offset', '-1'], specs).values.offset).toBe(-1);
      expect(parseOptions(['--offset=-1'], specs).values.offset).toBe(-1);
      expect(parseOptions(['-O', '-2'], { offset: { type: 'number', short: 'O' } }).values.offset).toBe(-2);
    });

    it('still reports a following option as a missing value', () => {
      expect(() => parseOptions(['--offset', '--quiet'], {
        offset: { type: 'number' },
        quiet: { type: 'boolean' },
      })).toThrow(OptionError);
    });

    it('applies a numeric default', () => {
      const { values } = parseOptions([], { days: { type: 'number', default: 7 } });

      expect(values.days).toBe(7);
    });
  });

  describe('optionalValue', () => {
    const specs = { cache: { type: 'string', optionalValue: '.epg-cache' } } as const;

    it('uses the fallback for a bare flag, at the end or before another option', () => {
      expect(parseOptions(['--cache'], specs).values.cache).toBe('.epg-cache');
      expect(parseOptions(['--cache', '--quiet'], { ...specs, quiet: { type: 'boolean' } }).values.cache)
        .toBe('.epg-cache');
    });

    it('still takes an explicit value', () => {
      expect(parseOptions(['--cache', '/tmp/c'], specs).values.cache).toBe('/tmp/c');
      expect(parseOptions(['--cache=/tmp/c'], specs).values.cache).toBe('/tmp/c');
    });

    it('leaves the option undefined when absent, so bare and absent stay distinguishable', () => {
      expect(parseOptions([], specs).values.cache).toBeUndefined();
    });

    it('works through a short flag', () => {
      const shortSpecs = { cache: { type: 'string', short: 'C', optionalValue: 'x' } } as const;

      expect(parseOptions(['-C'], shortSpecs).values.cache).toBe('x');
      expect(parseOptions(['-C', '/tmp/c'], shortSpecs).values.cache).toBe('/tmp/c');
    });

    it('leaves a following flag intact instead of eating it', () => {
      const { values } = parseOptions(['--cache', '--quiet'], { ...specs, quiet: { type: 'boolean' } });

      expect(values).toEqual({ cache: '.epg-cache', quiet: true });
    });

    it('does not claim a word that is not adjacent to it', () => {
      const { values, positionals } = parseOptions(
        ['build', '--cache', '--quiet', 'extra'],
        { ...specs, quiet: { type: 'boolean' } },
        { allowPositionals: true },
      );

      expect(values.cache).toBe('.epg-cache');
      expect(positionals).toEqual(['build', 'extra']);
    });

    it('removes the claimed word from the positionals', () => {
      const { values, positionals } = parseOptions(
        ['build', '--cache', '/tmp/c', 'extra'],
        specs,
        { allowPositionals: true },
      );

      expect(values.cache).toBe('/tmp/c');
      expect(positionals).toEqual(['build', 'extra']);
    });

    it('falls back to default when the flag is absent', () => {
      const { values } = parseOptions([], {
        cache: { type: 'string', default: 'from-config', optionalValue: '.epg-cache' },
      });

      expect(values.cache).toBe('from-config');
    });
  });

  describe('negatable', () => {
    it('switches a valued option off with null, distinct from absent', () => {
      const specs = { cache: { type: 'string', negatable: true, optionalValue: '' } } as const;

      expect(parseOptions(['--no-cache'], specs).values.cache).toBeNull();
      expect(parseOptions([], specs).values.cache).toBeUndefined();
      expect(parseOptions(['--cache'], specs).values.cache).toBe('');
    });

    it('wins over a default', () => {
      const { values } = parseOptions(['--no-cache'], {
        cache: { type: 'string', negatable: true, default: '.epg-cache' },
      });

      expect(values.cache).toBeNull();
    });

    it('switches a flag off with false', () => {
      const specs = { prune: { type: 'boolean', negatable: true, default: true } } as const;

      expect(parseOptions(['--no-prune'], specs).values.prune).toBe(false);
      expect(parseOptions([], specs).values.prune).toBe(true);
    });

    it('does not convert or transform a negated value', () => {
      const { values } = parseOptions(['--no-days'], { days: { type: 'number', negatable: true } });

      expect(values.days).toBeNull();
    });

    it('rejects --no- on an option that did not opt in', () => {
      expect(() => parseOptions(['--no-quiet'], { quiet: { type: 'boolean' } }))
        .toThrow("Unknown option '--no-quiet'");
      expect(() => parseOptions(['--no-output'], { output: { type: 'string' } }))
        .toThrow("Unknown option '--no-output'");
    });

    it('rejects --no- on an option that does not exist', () => {
      expect(() => parseOptions(['--no-zzz'], { quiet: { type: 'boolean' } }))
        .toThrow("Unknown option '--no-zzz'");
    });
  });

  describe('transform', () => {
    it('maps the raw value', () => {
      const { values } = parseOptions(['--tags=a,b'], {
        tags: { type: 'string', transform: (raw) => raw.split(',') },
      });

      expect(values.tags).toEqual(['a', 'b']);
    });

    it('maps every occurrence of a multiple option', () => {
      const { values } = parseOptions(['--n=1', '--n=2'], {
        n: { type: 'string', multiple: true, transform: (raw) => Number(raw) },
      });

      expect(values.n).toEqual([1, 2]);
    });

    it('surfaces a rejection as an OptionError', () => {
      expect(() => parseOptions(['--day=nope'], {
        day: {
          type: 'string',
          transform: (raw, flag) => {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
              throw new OptionError(`Invalid ${flag} value: ${raw} (expected YYYY-MM-DD)`);
            }

            return raw;
          },
        },
      })).toThrow('Invalid --day value: nope (expected YYYY-MM-DD)');
    });
  });
});
