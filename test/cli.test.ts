import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli/run.js';

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
