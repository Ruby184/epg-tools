import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli/run.js';
import { defaultDescription } from '../src/cli/scaffold.js';

/** Collects everything written, so stdout and stderr can be asserted on. */
class Sink extends Writable {
  private chunks: string[] = [];

  override _write(chunk: Buffer | string, _encoding: string, done: () => void): void {
    this.chunks.push(String(chunk));
    done();
  }

  get text(): string {
    return this.chunks.join('');
  }
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'epg-cli-test-'));
}

/**
 * A config file on disk, since that is what the command loads. Written as
 * `.mjs` so it is the module the CLI imports and nothing else.
 */
async function configFile(dir: string, body: string): Promise<string> {
  const file = join(dir, 'epg.config.mjs');
  await writeFile(file, body, 'utf8');
  return file;
}

/** One site, one channel, one programme a day — enough to produce a guide. */
function siteSource(fail = false): string {
  return `{
    site: 'example.tv',
    channels: [{ xmltvId: 'one.example.tv', siteId: '1', name: 'One' }],
    async fetchDay({ day }) {
      ${fail ? `throw new Error('the feed went away');` : ''}
      return { day };
    },
    parseDay: ({ channel, day }) => [{
      channel: channel.xmltvId,
      start: new Date(day + 'T06:00:00.000Z'),
      title: [{ value: 'Show' }],
    }],
  }`;
}

async function plainConfig(dir: string, options: { fail?: boolean } = {}): Promise<string> {
  return configFile(dir, `export default {
    sites: [${siteSource(options.fail)}],
    days: 1,
    output: ${JSON.stringify(join(dir, 'guide.xml'))},
    cache: { dir: ${JSON.stringify(join(dir, 'cache'))} },
  };`);
}

async function run(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout = new Sink();
  const stderr = new Sink();
  const code = await runCli(argv, { stdout, stderr });

  return { code, stdout: stdout.text, stderr: stderr.text };
}

describe('epg', () => {
  it('prints the usage for --help and exits 0', async () => {
    const { code, stdout, stderr } = await run(['--help']);

    expect(code).toBe(0);
    expect(stdout).toContain('Usage: epg <command> [options]');
    // The help was asked for, so it is not an error.
    expect(stderr).toBe('');
  });

  it('rejects an unknown option, and an unknown command, with the usage', async () => {
    const bad = await run(['--nonsense']);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("Unknown option '--nonsense'");
    expect(bad.stderr).toContain('Usage: epg');

    // Caught before the config is looked for, so it cannot fail for the wrong
    // reason in a directory that happens to have no config.
    const command = await run(['bulid']);
    expect(command.code).toBe(2);
    expect(command.stderr).toContain('Unknown command: bulid');
  });

  it('builds a guide, reporting progress on stdout', async () => {
    const dir = await tempDir();
    const config = await plainConfig(dir);

    const { code, stdout, stderr } = await run(['build', '--config', config]);

    expect(code).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toContain('Grab done: 1 fetched, 0 from cache, 0 failed');
    expect(stdout).toContain(`Guide written to ${join(dir, 'guide.xml')}`);
    expect(await readFile(join(dir, 'guide.xml'), 'utf8')).toContain('<channel id="one.example.tv">');
  });

  it('says nothing under --quiet, and still writes the guide', async () => {
    const dir = await tempDir();
    const config = await plainConfig(dir);

    const { code, stdout, stderr } = await run(['build', '--config', config, '--quiet']);

    expect(code).toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toBe('');
    expect(await readFile(join(dir, 'guide.xml'), 'utf8')).toContain('<programme');
  });

  it('exits 1 with the failure on stderr when a channel-day cannot be grabbed', async () => {
    const dir = await tempDir();
    const config = await plainConfig(dir, { fail: true });

    const { code, stdout, stderr } = await run(['build', '--config', config, '--quiet']);

    // Partial data: the guide is written, and the run is still a failure.
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('FAILED [example.tv] one.example.tv');
    expect(stderr).toContain('the feed went away');
  });

  it('applies --days, --output and --cache-dir over the config', async () => {
    const dir = await tempDir();
    const config = await plainConfig(dir);
    const output = join(dir, 'elsewhere', 'other.xml');

    const { code } = await run([
      'build', '--config', config, '--quiet',
      '--days', '2', '--output', output, '--cache-dir', join(dir, 'other-cache'),
    ]);

    expect(code).toBe(0);

    const guide = await readFile(output, 'utf8');
    // Two days asked for, so two programmes rather than the config's one.
    expect(guide.match(/<programme/g)).toHaveLength(2);
  });

  it('reports a missing config file as one line, not a stack', async () => {
    const dir = await tempDir();

    const { code, stderr } = await run(['build', '--config', join(dir, 'nowhere.mjs')]);

    expect(code).toBe(1);
    expect(stderr.trimEnd().split('\n')).toHaveLength(1);
    expect(stderr).toContain('nowhere.mjs');
  });

  it('reports a config file that exports the wrong thing', async () => {
    const dir = await tempDir();
    const config = await configFile(dir, 'export default { nothing: true };');

    const { code, stderr } = await run(['build', '--config', config]);

    expect(code).toBe(1);
    expect(stderr).toContain('must default-export an EpgConfig, or a defineConfig() factory');
  });

  it('resolves a configuration that answers itself from the environment', async () => {
    const dir = await tempDir();
    const config = await configFile(dir, `export default (...readers) => {
      const value = readers.map((reader) => reader.read('label')).find(Boolean)
        ?? [process.env.EPG_CLI_TEST_LABEL];

      return {
        sites: [${siteSource()}],
        days: 1,
        output: ${JSON.stringify(join(dir, 'guide.xml'))},
        cache: { dir: ${JSON.stringify(join(dir, 'cache'))} },
        meta: { sourceInfoName: value[0] },
      };
    };`);

    vi.stubEnv('EPG_CLI_TEST_LABEL', 'from-env');

    try {
      const { code } = await run(['build', '--config', config, '--quiet']);

      expect(code).toBe(0);
      expect(await readFile(join(dir, 'guide.xml'), 'utf8'))
        .toContain('source-info-name="from-env"');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('prunes to a day, and refuses one that is not a day', async () => {
    const dir = await tempDir();
    const config = await plainConfig(dir);

    await run(['build', '--config', config, '--quiet', '--offset', '-2']);

    const pruned = await run(['prune', '--config', config, '--before', '2099-01-01']);
    expect(pruned.code).toBe(0);
    expect(pruned.stdout).toMatch(/Pruned \d+ cached entr/);

    // A string cutoff that looks like a date would prune far too much.
    const invalid = await run(['prune', '--config', config, '--before', '2026-99-99']);
    expect(invalid.code).toBe(2);
    expect(invalid.stderr).toContain('Invalid --before value: 2026-99-99');
  });

  it('merges from the cache without grabbing', async () => {
    const dir = await tempDir();
    const config = await plainConfig(dir);

    await run(['grab', '--config', config, '--quiet']);

    const { code, stdout } = await run(['merge', '--config', config]);

    expect(code).toBe(0);
    expect(stdout).toContain('Guide written to');
    expect(await readFile(join(dir, 'guide.xml'), 'utf8')).toContain('<programme');
  });
});

describe('epg init-grabber', () => {
  it('writes an executable shim beside the config and says what to do with it', async () => {
    const dir = await tempDir();
    const config = await plainConfig(dir);

    const { code, stdout, stderr } = await run([
      'init-grabber', 'tv_grab_sk_example', '--config', config,
    ]);

    expect(code).toBe(0);
    expect(stderr).toBe('');

    const file = join(dir, 'tv_grab_sk_example');
    expect(stdout).toContain(`Wrote ${file}`);
    expect(stdout).toContain('--configure');

    // Run by name, so it has to be executable.
    expect((await stat(file)).mode & 0o777).toBe(0o755);

    const shim = await readFile(file, 'utf8');
    expect(shim.startsWith('#!/usr/bin/env node\n')).toBe(true);
    // Imports the package it was generated by, and the config it sits beside.
    expect(shim).toContain(`import("epg-tools/tv-grab")`);
    expect(shim).toContain(`import("./epg.config.mjs")`);
    expect(shim).toContain(`description: "Slovakia (tv_grab_sk_example)"`);
    expect(shim).toContain(`version: "0.1.0"`);
    expect(shim).toContain(`grabberName: "tv_grab_sk_example"`);
    // Nothing at the top level and no require, so the file is valid whether
    // Node reads it as CommonJS or as an ES module.
    expect(shim).not.toMatch(/^(import|export)\b/m);
    expect(shim).not.toMatch(/\brequire\s*\(/);
  });

  it('refuses to replace an existing file unless forced', async () => {
    const dir = await tempDir();
    const config = await plainConfig(dir);
    const argv = ['init-grabber', 'tv_grab_sk_example', '--config', config];

    await run(argv);
    const again = await run([...argv, '--description', 'Second']);

    expect(again.code).toBe(1);
    expect(again.stderr).toContain('already exists; pass --force to replace it');
    expect(await readFile(join(dir, 'tv_grab_sk_example'), 'utf8')).not.toContain('Second');

    const forced = await run([...argv, '--description', 'Second', '--force']);
    expect(forced.code).toBe(0);
    expect(await readFile(join(dir, 'tv_grab_sk_example'), 'utf8')).toContain('"Second"');
  });

  it('takes a description and a version, and rejects a version XMLTV would not', async () => {
    const dir = await tempDir();
    const config = await plainConfig(dir);

    const { code } = await run([
      'init-grabber', 'tv_grab_sk_example', '--config', config,
      '--description', 'Slovakia (example.tv)', '--grabber-version', '2.3.4',
    ]);

    expect(code).toBe(0);

    const shim = await readFile(join(dir, 'tv_grab_sk_example'), 'utf8');
    expect(shim).toContain('description: "Slovakia (example.tv)"');
    expect(shim).toContain('version: "2.3.4"');

    // Caught while writing the file rather than on the grabber's first run.
    const bad = await run([
      'init-grabber', 'tv_grab_sk_other', '--config', config, '--grabber-version', '1.0-beta',
    ]);

    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('Invalid grabber version "1.0-beta"');
  });

  it('warns about a name no consumer will discover, but still writes it', async () => {
    const dir = await tempDir();
    const config = await plainConfig(dir);

    const { code, stderr } = await run(['init-grabber', 'my-grabber', '--config', config]);

    expect(code).toBe(0);
    expect(stderr).toContain('is not named tv_grab_<country>[_<source>]');
    expect(await readFile(join(dir, 'my-grabber'), 'utf8')).toContain('grabberName: "my-grabber"');
  });

  it('needs a name', async () => {
    const dir = await tempDir();
    const config = await plainConfig(dir);

    const { code, stderr } = await run(['init-grabber', '--config', config]);

    expect(code).toBe(2);
    expect(stderr).toContain('init-grabber needs a name');
  });

  it('names the country from the code in the grabber name', () => {
    expect(defaultDescription('tv_grab_sk_example')).toBe('Slovakia (tv_grab_sk_example)');
    expect(defaultDescription('tv_grab_fi')).toBe('Finland (tv_grab_fi)');
    // Aliases resolve — grabbers are named uk, the region code is GB.
    expect(defaultDescription('tv_grab_uk_thing')).toBe('United Kingdom (tv_grab_uk_thing)');
    // An unassigned code is left as it is rather than invented.
    expect(defaultDescription('tv_grab_qq_thing')).toBe('QQ (tv_grab_qq_thing)');
    // Nothing that looks like a country: the name is the best there is.
    expect(defaultDescription('grabber')).toBe('grabber');
  });
});

describe('epg --version', () => {
  it('prints the package name and version', async () => {
    const { code, stdout, stderr } = await run(['--version']);

    expect(code).toBe(0);
    expect(stdout).toBe('epg-tools 0.1.0\n');
    expect(stderr).toBe('');
  });

  it('is what a scaffolded grabber reports as its own, taken from the project', async () => {
    const dir = await tempDir();
    const config = await plainConfig(dir);

    // The grabber ships with the project the config lives in, so that is the
    // version it should claim — not a constant, and not this package's.
    await writeFile(join(dir, 'package.json'), JSON.stringify({ version: '3.4.5' }), 'utf8');
    await run(['init-grabber', 'tv_grab_sk_example', '--config', config]);
    expect(await readFile(join(dir, 'tv_grab_sk_example'), 'utf8')).toContain('version: "3.4.5"');

    // A version XMLTV would reject is ignored rather than written out to fail
    // on the grabber's first run.
    await writeFile(join(dir, 'package.json'), JSON.stringify({ version: '3.4.5-beta.1' }), 'utf8');
    await run(['init-grabber', 'tv_grab_sk_example', '--config', config, '--force']);
    expect(await readFile(join(dir, 'tv_grab_sk_example'), 'utf8')).toContain('version: "0.1.0"');
  });
});

describe('flushing', () => {
  /** Records a chunk only once it has been written out, as a pipe would. */
  class SlowSink extends Writable {
    private flushed: string[] = [];

    override _write(chunk: Buffer | string, _encoding: string, done: () => void): void {
      setTimeout(() => {
        this.flushed.push(String(chunk));
        done();
      }, 1);
    }

    get text(): string {
      return this.flushed.join('');
    }
  }

  it('does not resolve until everything it wrote has been flushed', async () => {
    const dir = await tempDir();
    const config = await plainConfig(dir, { fail: true });
    const stdout = new SlowSink();
    const stderr = new SlowSink();

    // A caller is free to exit the moment this resolves, so by then the
    // progress on stdout and the failure on stderr must both be out — an
    // unawaited write is only queued, and process.exit() discards the queue.
    const code = await runCli(['build', '--config', config], { stdout, stderr });

    expect(code).toBe(1);
    expect(stdout.text).toContain('Guide written to');
    expect(stderr.text).toContain('FAILED [example.tv] one.example.tv');
  });
});
