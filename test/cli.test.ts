import { mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { gunzipSync, gzipSync } from 'node:zlib';
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
    async request({ day }) {
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
  return configFile(
    dir,
    `export default {
    sites: [${siteSource(options.fail)}],
    days: 1,
    output: ${JSON.stringify(join(dir, 'guide.xml'))},
    cache: { dir: ${JSON.stringify(join(dir, 'cache'))} },
  };`,
  );
}

async function run(
  argv: string[],
  signal?: AbortSignal,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const { code, stdout, stderr } = start(argv, signal);

  return { code: await code, stdout: stdout.text, stderr: stderr.text };
}

/**
 * The same, without waiting for it to finish.
 *
 * For `serve`, which does not: its output has to be readable *while* it runs,
 * since where it is listening is the first thing it says and the only way to
 * find out which port the OS handed it.
 */
function start(
  argv: string[],
  signal?: AbortSignal,
): { code: Promise<number>; stdout: Sink; stderr: Sink } {
  const stdout = new Sink();
  const stderr = new Sink();

  return { code: runCli(argv, { stdout, stderr, ...(signal ? { signal } : {}) }), stdout, stderr };
}

/** Wait for `read` to return something, or give up saying what was wanted. */
async function eventually<T>(what: string, read: () => T | undefined): Promise<T> {
  const until = Date.now() + 5000;

  while (true) {
    const value = read();

    if (value !== undefined) {
      return value;
    }

    if (Date.now() > until) {
      throw new Error(`timed out waiting for ${what}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }
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
    expect(await readFile(join(dir, 'guide.xml'), 'utf8')).toContain(
      '<channel id="one.example.tv">',
    );
  });

  it('names the channel-days that came back with nothing, and still succeeds', async () => {
    const dir = await tempDir();
    const config = await configFile(
      dir,
      `export default {
        sites: [{
          site: 'example.tv',
          channels: [{ xmltvId: 'one.example.tv', siteId: '1', name: 'One' }],
          async request() { return {}; },
          parseDay: () => [],
        }],
        days: 1,
        output: ${JSON.stringify(join(dir, 'guide.xml'))},
        cache: { dir: ${JSON.stringify(join(dir, 'cache'))} },
      };`,
    );

    const { code, stdout, stderr } = await run(['build', '--config', config]);

    // A channel with nothing on is a legitimate answer, so it is reported
    // rather than failed.
    expect(code).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toContain('Grab done: 1 fetched (1 empty), 0 from cache, 0 failed');
  });

  it('exits 130 without a guide when the run is cancelled', async () => {
    const dir = await tempDir();
    const controller = new AbortController();
    const config = await configFile(
      dir,
      `export default {
        sites: [{
          site: 'example.tv',
          channels: [
            { xmltvId: 'one.example.tv', siteId: '1' },
            { xmltvId: 'two.example.tv', siteId: '2' },
          ],
          async request({ channel }) {
            if (channel.xmltvId === 'one.example.tv') globalThis.cancelTheRun();
            return {};
          },
          parseDay: ({ channel, day }) => [{
            channel: channel.xmltvId,
            start: new Date(day + 'T06:00:00.000Z'),
            title: [{ value: 'Show' }],
          }],
        }],
        days: 1,
        output: ${JSON.stringify(join(dir, 'guide.xml'))},
        cache: { dir: ${JSON.stringify(join(dir, 'cache'))} },
      };`,
    );

    // A config file is a module of its own, so it says *when* to cancel and the
    // test does the cancelling — which is the bin's job in a real run.
    Object.assign(globalThis, { cancelTheRun: () => controller.abort(new Error('SIGINT')) });

    const { code, stdout, stderr } = await run(
      ['build', '--config', config, '--quiet'],
      controller.signal,
    );

    expect(code).toBe(130);
    expect(stdout).toBe('');
    // What it managed, and what it did not do — rather than the requests the
    // cancel itself dropped, reported one by one as failures.
    expect(stderr).toContain('Cancelled.');
    expect(stderr).toContain('no guide was written');
    expect(stderr).not.toContain('FAILED');
    await expect(stat(join(dir, 'guide.xml'))).rejects.toMatchObject({ code: 'ENOENT' });
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

  describe('how much it reports, and how', () => {
    it('says one line per site by default, not one per channel-day', async () => {
      const dir = await tempDir();
      const config = await plainConfig(dir);

      const { stdout } = await run(['grab', '--config', config]);

      // The per-channel-day chatter is what drowned the four lines that matter,
      // and what `--quiet` was the only defence against.
      expect(stdout).not.toContain('1 programme');
      expect(stdout).toContain('[example.tv] 1 channel(s) × 1 day(s): 1 to fetch in 1 request(s)');
      expect(stdout).toContain('Grab done: 1 fetched');
    });

    it('says it per channel-day with --verbose, and the same with -v', async () => {
      const dir = await tempDir();

      for (const flag of ['--verbose', '-v']) {
        const config = await plainConfig(await tempDir());
        const { stdout } = await run(['grab', '--config', config, flag]);

        expect(stdout).toContain('[example.tv] one.example.tv');
        expect(stdout).toContain('1 programme');
      }

      expect(dir).toBeTruthy();
    });

    it('takes a level outright, and says so when it is not one', async () => {
      const config = await plainConfig(await tempDir());

      const { stdout } = await run(['grab', '--config', config, '--log-level', 'error']);
      const bad = await run(['grab', '--config', config, '--log-level', 'loud']);

      expect(stdout).toBe('');
      expect(bad.code).toBe(2);
      expect(bad.stderr).toContain(
        'Invalid --log-level value: loud (expected error, warn, info, debug)',
      );
    });

    it('lets --quiet win over --verbose, so a script cannot be surprised', async () => {
      const config = await plainConfig(await tempDir());

      const { stdout } = await run(['grab', '--config', config, '-v', '-q']);

      expect(stdout).toBe('');
    });

    it('writes one JSON object per line for --reporter json', async () => {
      const config = await plainConfig(await tempDir(), { fail: true });

      const { code, stdout } = await run([
        'grab',
        '--config',
        config,
        '--reporter',
        'json',
        '--log-level',
        'debug',
      ]);
      const events = stdout
        .split('\n')
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as { type: string; level: string; error?: { message: string } },
        );

      expect(code).toBe(1);
      expect(events.map((event) => event.type)).toContain('site:started');
      // The one thing a line of text cannot be asked.
      expect(events.filter((event) => event.level === 'error')).toEqual([
        expect.objectContaining({
          type: 'request:failed',
          error: expect.objectContaining({ message: 'the feed went away' }),
        }),
      ]);
    });

    it('writes each failure where it happened for --failures inline', async () => {
      const config = await plainConfig(await tempDir(), { fail: true });

      const { stderr } = await run(['grab', '--config', config, '--failures', 'inline']);

      // Unindented, since it is not part of a block at the end.
      expect(stderr).toContain('FAILED [example.tv] one.example.tv');
      expect(stderr).not.toContain('  FAILED');
    });

    it('takes a reporter named in the config, and lets the flag override it', async () => {
      const dir = await tempDir();
      const config = await configFile(
        dir,
        `export default {
          sites: [${siteSource()}],
          days: 1,
          reporter: 'json',
          output: ${JSON.stringify(join(dir, 'guide.xml'))},
          cache: { dir: ${JSON.stringify(join(dir, 'cache'))} },
        };`,
      );

      const named = await run(['grab', '--config', config]);
      const overridden = await run(['grab', '--config', config, '--reporter', 'text']);

      expect(JSON.parse(named.stdout.split('\n')[0]!)).toMatchObject({ type: 'site:started' });
      expect(overridden.stdout).toContain('[example.tv] 1 channel(s)');
    });

    it('says so when a reporter or a failure mode is not one it has', async () => {
      const config = await plainConfig(await tempDir());

      const reporter = await run(['grab', '--config', config, '--reporter', 'yaml']);
      const failures = await run(['grab', '--config', config, '--failures', 'sometimes']);

      expect(reporter.stderr).toContain(
        'Invalid --reporter value: yaml (expected text, json, progress)',
      );
      expect(failures.stderr).toContain(
        'Invalid --failures value: sometimes (expected block, inline)',
      );
    });
  });

  it('applies --days, --output and --cache-dir over the config', async () => {
    const dir = await tempDir();
    const config = await plainConfig(dir);
    const output = join(dir, 'elsewhere', 'other.xml');

    const { code } = await run([
      'build',
      '--config',
      config,
      '--quiet',
      '--days',
      '2',
      '--output',
      output,
      '--cache-dir',
      join(dir, 'other-cache'),
    ]);

    expect(code).toBe(0);

    const guide = await readFile(output, 'utf8');
    // Two days asked for, so two programmes rather than the config's one.
    expect(guide.match(/<programme/g)).toHaveLength(2);
  });

  it('keeps the whole cache in memory for --cache-driver memory', async () => {
    const dir = await tempDir();
    const config = await plainConfig(dir);

    const { code } = await run([
      'build',
      '--config',
      config,
      '--quiet',
      '--cache-driver',
      'memory',
    ]);

    expect(code).toBe(0);
    // A guide from listings that were never written down: the grab and the merge
    // of one build share the cache, and nothing outlives them.
    expect(await readFile(join(dir, 'guide.xml'), 'utf8')).toContain('<programme');
    await expect(stat(join(dir, 'cache'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a cache driver it does not have, with the usage', async () => {
    const dir = await tempDir();
    const config = await plainConfig(dir);

    const { code, stderr } = await run(['build', '--config', config, '--cache-driver', 'postgres']);

    expect(code).toBe(2);
    expect(stderr).toContain('Invalid --cache-driver value: postgres');
    expect(stderr).toContain('ndjson, xmltv, sqlite, memory');
  });

  it('serves the guide until it is told to stop', async () => {
    const dir = await tempDir();
    const config = await plainConfig(dir);

    // Grabbed first, so there is something to serve.
    expect((await run(['grab', '--config', config, '--quiet'])).code).toBe(0);

    const controller = new AbortController();
    // The one command that does not finish on its own: it resolves when the
    // signal fires, which is what a service manager sends to stop the job.
    const serving = start(
      ['serve', '--config', config, '--port', '0', '--reporter', 'text'],
      controller.signal,
    );

    // Port 0 means the OS picks, so where it is listening is read from what it
    // said rather than assumed — which is also the reason it says it.
    const url = await eventually(
      'the server to say where it is listening',
      () => /http:\/\/\S+/.exec(serving.stdout.text)?.[0],
    );

    const response = await fetch(url);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<programme');

    controller.abort();

    // Nothing failed and nothing was left half done, so 0 rather than the 130
    // a cancelled grab answers with.
    expect(await serving.code).toBe(0);
  });

  describe('--channels', () => {
    /** Two channels, one site, and a cache we can look inside afterwards. */
    async function twoChannels(dir: string): Promise<string> {
      return configFile(
        dir,
        `export default {
        sites: [{
          site: 'example.tv',
          channels: [
            { xmltvId: 'one.example.tv', siteId: '1', name: 'One' },
            { xmltvId: 'two.example.tv', siteId: '2', name: 'Two' },
          ],
          async request({ day }) { return { day }; },
          parseDay: ({ channel, day }) => [{
            channel: channel.xmltvId,
            start: new Date(day + 'T06:00:00.000Z'),
            title: [{ value: 'Show' }],
          }],
        }],
        days: 1,
        output: ${JSON.stringify(join(dir, 'guide.xml'))},
        cache: { dir: ${JSON.stringify(join(dir, 'cache'))} },
      };`,
      );
    }

    // The point of select semantics: the channel left out is not merely absent
    // from the guide, it was never asked for. Asserted on the cache, which is
    // the only place that can tell the difference.
    it('narrows the grab, not just the guide', async () => {
      const dir = await tempDir();
      const config = await twoChannels(dir);

      const { code, stderr } = await run(['build', '-c', config, '--channels', 'one.example.tv']);

      expect(stderr).toBe('');
      expect(code).toBe(0);

      const guide = await readFile(join(dir, 'guide.xml'), 'utf8');

      expect(guide).toContain('one.example.tv');
      expect(guide).not.toContain('two.example.tv');

      const cached = await readdir(join(dir, 'cache'), { recursive: true });

      expect(cached.some((entry) => String(entry).includes('one.example.tv'))).toBe(true);
      expect(cached.some((entry) => String(entry).includes('two.example.tv'))).toBe(false);
    });

    it('takes a file naming them, and unions repeats', async () => {
      const dir = await tempDir();
      const config = await twoChannels(dir);
      const list = join(dir, 'wanted.txt');

      await writeFile(list, '# what we watch\none.example.tv\n');

      const { code } = await run([
        'merge',
        '-c',
        config,
        '--channels',
        list,
        '--channels',
        'two.example.tv',
      ]);

      expect(code).toBe(0);

      const guide = await readFile(join(dir, 'guide.xml'), 'utf8');

      expect(guide).toContain('one.example.tv');
      expect(guide).toContain('two.example.tv');
    });

    it('says which selected channels nothing produces', async () => {
      const dir = await tempDir();
      const config = await twoChannels(dir);

      const { stdout, stderr } = await run([
        'merge',
        '-c',
        config,
        '--channels',
        'one.example.tv,nope.example.tv',
        '--reporter',
        'text',
      ]);
      const said = stdout + stderr;

      expect(said).toContain('nope.example.tv');
      expect(said).toContain('produced by no site');
      // Once, not once per thing that assembles a guide.
      expect(said.match(/produced by no site/g)).toHaveLength(1);
    });

    // A derived channel is never grabbed — its source is — so selecting the
    // `+1` alone has to pull the source in behind it, and publish both.
    it('keeps the source of a selected derived channel, and grabs it', async () => {
      const dir = await tempDir();
      const config = await configFile(
        dir,
        `export default {
        sites: [{
          site: 'example.tv',
          channels: [
            { xmltvId: 'one.example.tv', siteId: '1', name: 'One' },
            { xmltvId: 'two.example.tv', siteId: '2', name: 'Two' },
          ],
          async request({ day }) { return { day }; },
          parseDay: ({ channel, day }) => [{
            channel: channel.xmltvId,
            start: new Date(day + 'T06:00:00.000Z'),
            title: [{ value: 'Show' }],
          }],
        }],
        derived: [{ xmltvId: 'one.plus1.example.tv', from: 'one.example.tv', offset: 60 }],
        days: 1,
        output: ${JSON.stringify(join(dir, 'guide.xml'))},
        cache: { dir: ${JSON.stringify(join(dir, 'cache'))} },
      };`,
      );

      const { code, stderr } = await run([
        'build',
        '-c',
        config,
        '--channels',
        'one.plus1.example.tv',
      ]);

      expect(code).toBe(0);

      const guide = await readFile(join(dir, 'guide.xml'), 'utf8');

      // Both: the shift, and the channel it is a shift of.
      expect(guide).toContain('<channel id="one.plus1.example.tv">');
      expect(guide).toContain('<channel id="one.example.tv">');
      expect(guide).not.toContain('two.example.tv');

      // The source was actually fetched — a shift with nothing to shift is
      // nothing at all.
      const cached = await readdir(join(dir, 'cache'), { recursive: true });

      expect(cached.some((entry) => String(entry).includes('one.example.tv'))).toBe(true);

      // And the derived id is not reported as something no site produces: no
      // site does produce it, which is the point of it.
      expect(stderr).not.toContain('produced by no site');
    });

    it('is refused where narrowing a run means nothing', async () => {
      const dir = await tempDir();
      const config = await plainConfig(dir);

      const { code, stderr } = await run([
        'validate',
        '-c',
        config,
        '--channels',
        'one.example.tv',
      ]);

      expect(code).toBe(2);
      expect(stderr).toContain('--channels is for build, grab, merge, serve');
    });

    it('refuses a selection that names nothing', async () => {
      const dir = await tempDir();
      const config = await plainConfig(dir);

      const { code, stderr } = await run(['merge', '-c', config, '--channels', ',']);

      expect(code).toBe(2);
      expect(stderr).toContain('named no channels');
    });
  });

  describe('channels --write', () => {
    /** A config offering two channels the files below name differently. */
    async function siteConfig(dir: string): Promise<string> {
      return configFile(
        dir,
        `export default {
        sites: [{
          site: 'example.tv',
          channels: [
            { xmltvId: 'bbcone.uk', siteId: '1', name: 'BBC One' },
            { xmltvId: 'bbctwo.uk', siteId: '2', name: 'BBC Two' },
          ],
          async request() { return {}; },
          parseDay: () => [],
        }],
        days: 1,
        output: ${JSON.stringify(join(dir, 'guide.xml'))},
        cache: { dir: ${JSON.stringify(join(dir, 'cache'))} },
      };`,
      );
    }

    it('fills an empty xmltv_id and leaves a set one alone', async () => {
      const dir = await tempDir();
      const config = await siteConfig(dir);
      const file = join(dir, 'a.channels.xml');

      await writeFile(
        file,
        `<?xml version="1.0" encoding="UTF-8"?>\n<channels site="example.tv">\n` +
          `  <channel site_id="1" xmltv_id="">BBC One HD</channel>\n` +
          `  <channel site_id="2" xmltv_id="already.set">BBC Two HD</channel>\n` +
          `</channels>\n`,
      );

      const { code, stdout } = await run(['channels', '-c', config, '--against', file, '--write']);

      expect(code).toBe(0);
      expect(stdout).toContain('Wrote 1 id into');

      const written = await readFile(file, 'utf8');

      expect(written).toContain('site_id="1" xmltv_id="bbcone.uk"');
      // Matched by name too, but an id already there is somebody's decision.
      expect(written).toContain('xmltv_id="already.set"');
    });

    it('fills a playlist`s tvg-id in place', async () => {
      const dir = await tempDir();
      const config = await siteConfig(dir);
      const file = join(dir, 'b.m3u');

      await writeFile(
        file,
        '#EXTM3U\n#EXTINF:-1 tvg-id="" tvg-name="BBC One HD",BBC One HD\nhttp://e/1\n',
      );

      const { code } = await run(['channels', '-c', config, '--against', file, '--write']);

      expect(code).toBe(0);
      // In the attribute's own place, not appended after the name.
      expect(await readFile(file, 'utf8')).toContain(
        '#EXTINF:-1 tvg-id="bbcone.uk" tvg-name="BBC One HD",BBC One HD',
      );
    });

    // A guide names its channels rather than mapping them, so writing is a
    // rename — and it has to reach every programme, or the guide is broken.
    it('renames a guide`s channels and every programme on them', async () => {
      const dir = await tempDir();
      const config = await siteConfig(dir);
      const file = join(dir, 'c.xml');

      await writeFile(
        file,
        `<?xml version="1.0" encoding="UTF-8"?><?keep me?><tv generator-info-name="theirs">` +
          `<channel id="THEIR-1"><display-name>BBC One</display-name></channel>` +
          `<programme start="20260906060000 +0000" stop="20260906070000 +0000" channel="THEIR-1">` +
          `<title>Breakfast</title></programme></tv>`,
      );

      const { code } = await run(['channels', '-c', config, '--against', file, '--write']);

      expect(code).toBe(0);

      const written = await readFile(file, 'utf8');

      expect(written).toContain('<channel id="bbcone.uk">');
      expect(written).toContain('channel="bbcone.uk"');
      expect(written).not.toContain('THEIR-1');
      // The document around it survived the rewrite.
      expect(written).toContain('generator-info-name="theirs"');
      expect(written).toContain('<?keep me?>');
    });

    it('writes elsewhere with -o, leaving the original untouched', async () => {
      const dir = await tempDir();
      const config = await siteConfig(dir);
      const file = join(dir, 'g.channels.xml');
      const before =
        `<?xml version="1.0" encoding="UTF-8"?>\n<channels site="example.tv">\n` +
        `  <channel site_id="1" xmltv_id="">BBC One</channel>\n</channels>\n`;

      await writeFile(file, before);

      const out = join(dir, 'fixed.channels.xml');
      const { code, stdout } = await run([
        'channels',
        '-c',
        config,
        '--against',
        file,
        '--write',
        '-o',
        out,
      ]);

      expect(code).toBe(0);
      // The answer went to the new file, and the summary names that one.
      expect(stdout).toContain(`Wrote 1 id into ${out}`);
      expect(await readFile(out, 'utf8')).toContain('xmltv_id="bbcone.uk"');
      expect(await readFile(file, 'utf8')).toBe(before);
    });

    it('diverts a guide rewrite too, reading the original while writing', async () => {
      const dir = await tempDir();
      const config = await siteConfig(dir);
      const file = join(dir, 'h.xml');
      const before =
        `<?xml version="1.0" encoding="UTF-8"?><tv>` +
        `<channel id="THEIR-1"><display-name>BBC One</display-name></channel>` +
        `<programme start="20260906060000 +0000" stop="20260906070000 +0000" channel="THEIR-1">` +
        `<title>Breakfast</title></programme></tv>`;

      await writeFile(file, before);

      const out = join(dir, 'renamed.xml');

      expect(
        (await run(['channels', '-c', config, '--against', file, '--write', '-o', out])).code,
      ).toBe(0);

      expect(await readFile(out, 'utf8')).toContain('channel="bbcone.uk"');
      expect(await readFile(file, 'utf8')).toBe(before);
    });

    it('refuses -o without --write, which would write nothing anywhere', async () => {
      const dir = await tempDir();
      const config = await siteConfig(dir);
      const file = join(dir, 'i.channels.xml');

      await writeFile(file, '<channels><channel site_id="1" xmltv_id="">A</channel></channels>');

      const { code, stderr } = await run([
        'channels',
        '-c',
        config,
        '--against',
        file,
        '-o',
        join(dir, 'nope.xml'),
      ]);

      expect(code).toBe(1);
      expect(stderr).toContain('takes -o only with --write');
    });

    it('leaves the file alone when there is nothing to write', async () => {
      const dir = await tempDir();
      const config = await siteConfig(dir);
      const file = join(dir, 'd.channels.xml');
      const before =
        `<?xml version="1.0" encoding="UTF-8"?>\n<channels site="example.tv">\n` +
        `  <channel site_id="9" xmltv_id="">Nobody Has This</channel>\n</channels>\n`;

      await writeFile(file, before);

      const { code, stdout } = await run(['channels', '-c', config, '--against', file, '--write']);

      expect(code).toBe(0);
      expect(stdout).not.toContain('Wrote');
      expect(await readFile(file, 'utf8')).toBe(before);
    });

    // Fixing them and then failing the run that fixed them would be a strange
    // thing for a --check to do.
    it('passes --check for what it just wrote, and fails for what it could not', async () => {
      const dir = await tempDir();
      const config = await siteConfig(dir);
      const fixable = join(dir, 'e.channels.xml');

      await writeFile(
        fixable,
        `<?xml version="1.0"?>\n<channels site="example.tv">\n` +
          `  <channel site_id="1" xmltv_id="">BBC One</channel>\n</channels>\n`,
      );

      expect(
        (await run(['channels', '-c', config, '--against', fixable, '--write', '--check'])).code,
      ).toBe(0);

      const hopeless = join(dir, 'f.channels.xml');

      await writeFile(
        hopeless,
        `<?xml version="1.0"?>\n<channels site="example.tv">\n` +
          `  <channel site_id="9" xmltv_id="">Nobody Has This</channel>\n</channels>\n`,
      );

      expect(
        (await run(['channels', '-c', config, '--against', hopeless, '--write', '--check'])).code,
      ).toBe(1);
    });
  });

  describe('filter', () => {
    const GUIDE =
      `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE tv SYSTEM "xmltv.dtd">` +
      `<?epg-note keep-me?>` +
      `<tv generator-info-name="somebody-else">` +
      `<channel id="one.uk"><display-name>One</display-name><lcn>101</lcn></channel>` +
      `<channel id="two.uk"><display-name>Two</display-name></channel>` +
      `<programme start="20260905060000 +0000" channel="one.uk"><title>Keep</title></programme>` +
      `<programme start="20260905060000 +0000" channel="two.uk"><title>Drop</title></programme>` +
      `</tv>`;

    async function guide(dir: string, xml = GUIDE, name = 'big.xml'): Promise<string> {
      const file = join(dir, name);

      await writeFile(file, xml, 'utf8');

      return file;
    }

    // The whole point: what is kept comes back as it went in, and what is not is
    // gone — programmes with it, since a programme on a dropped channel is a
    // schedule for something the guide no longer describes.
    it('keeps what was asked for, and drops the rest with its programmes', async () => {
      const dir = await tempDir();
      const file = await guide(dir);
      const out = join(dir, 'small.xml');

      const { code } = await run(['filter', file, '--channels', 'one.uk', '-o', out]);

      expect(code).toBe(0);

      const written = await readFile(out, 'utf8');

      expect(written).toContain('<channel id="one.uk">');
      expect(written).not.toContain('two.uk');
      expect(written).toContain('<title>Keep</title>');
      expect(written).not.toContain('<title>Drop</title>');
      // A provider extension on a kept channel is still its own.
      expect(written).toContain('<lcn>101</lcn>');
      // And the document around it survived: the root's attributes and an
      // instruction that was in the prolog.
      expect(written).toContain('generator-info-name="somebody-else"');
      expect(written).toContain('<?epg-note keep-me?>');
    });

    it('writes to stdout when no output is named', async () => {
      const dir = await tempDir();
      const file = await guide(dir);

      const { code, stdout, stderr } = await run(['filter', file, '--channels', 'one.uk']);

      expect(code).toBe(0);
      expect(stdout).toContain('<channel id="one.uk">');
      expect(stdout).not.toContain('two.uk');
      // The summary goes to stderr, never into the document on stdout.
      expect(stdout).not.toContain('channel,');
      expect(stderr).toContain('1 channel, 1 programme');
    });

    it('says which channels the guide does not have', async () => {
      const dir = await tempDir();
      const file = await guide(dir);

      const { code, stderr } = await run([
        'filter',
        file,
        '--channels',
        'one.uk,nope.uk',
        '-o',
        join(dir, 'small.xml'),
      ]);

      // Not an error: a guide that never carried a channel is a fact about the
      // guide, and the subset asked for is still what came back.
      expect(code).toBe(0);
      expect(stderr).toContain('1 of 2 channels are not in');
      expect(stderr).toContain('nope.uk');
    });

    it('reads and writes compressed guides', async () => {
      const dir = await tempDir();
      const file = join(dir, 'big.xml.gz');

      await writeFile(file, gzipSync(GUIDE));

      const out = join(dir, 'small.xml.gz');
      const { code } = await run(['filter', file, '--channels', 'one.uk', '-o', out]);

      expect(code).toBe(0);
      expect(gunzipSync(await readFile(out)).toString()).toContain('<channel id="one.uk">');
    });

    it('needs a guide and a selection', async () => {
      const dir = await tempDir();
      const file = await guide(dir);

      const missing = await run(['filter']);
      expect(missing.code).toBe(2);
      expect(missing.stderr).toContain('needs a guide');

      const unselected = await run(['filter', file]);
      expect(unselected.code).toBe(2);
      expect(unselected.stderr).toContain('needs --channels');
    });

    // A guide named on the command line is the whole of what this needs.
    it('needs no config', async () => {
      const dir = await tempDir();
      const file = await guide(dir);
      const cwd = vi.spyOn(process, 'cwd').mockReturnValue(dir);

      try {
        const { code, stderr } = await run(['filter', file, '--channels', 'one.uk']);

        expect(code).toBe(0);
        expect(stderr).not.toContain('config');
      } finally {
        cwd.mockRestore();
      }
    });
  });

  describe('validate', () => {
    const GUIDE =
      `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE tv SYSTEM "xmltv.dtd"><tv>` +
      `<channel id="one" data-src="acme"><display-name>One</display-name></channel>` +
      `<programme start="20260903060000 +0000" channel="ghost"><title>T</title></programme>` +
      `</tv>`;

    /** A config whose `output` is the guide, since that is what it validates. */
    async function withGuide(dir: string, xml = GUIDE): Promise<string> {
      await writeFile(join(dir, 'guide.xml'), xml, 'utf8');

      return configFile(
        dir,
        `export default {
      sites: [],
      output: ${JSON.stringify(join(dir, 'guide.xml'))},
      cache: { dir: ${JSON.stringify(join(dir, 'cache'))} },
    };`,
      );
    }

    it("validates the config's own guide when no file is named", async () => {
      const dir = await tempDir();
      const config = await withGuide(dir);

      const { code, stdout } = await run(['validate', '--config', config]);

      // The unknown channel is an error; the extension is not.
      expect(code).toBe(1);
      expect(stdout).toContain('1 channel, 1 programme');
      expect(stdout).toContain('error   unknown-channel (1)');
      expect(stdout).toContain('warning extensions (1)');
      expect(stdout).toContain('1 error, 1 warning');
    });

    it('validates a file named on the command line instead', async () => {
      const dir = await tempDir();
      const config = await withGuide(dir);
      const other = join(dir, 'other.xml');

      await writeFile(
        other,
        `<?xml version="1.0" encoding="UTF-8"?><tv>` +
          `<channel id="one"><display-name>One</display-name></channel>` +
          `<programme start="20260903060000 +0000" channel="one"><title>T</title></programme>` +
          `</tv>`,
        'utf8',
      );

      const { code, stdout } = await run(['validate', other, '--config', config]);

      expect(code).toBe(0);
      expect(stdout).toContain('nothing to report');
    });

    it('reports a missing file as one line, compressed name or not', async () => {
      const dir = await tempDir();
      const config = await withGuide(dir);
      const gone = join(dir, 'nowhere.xml.gz');

      // The plain path always managed this. The compressed one piped the read
      // into a decompressor, which forwards no error from its source: the
      // ENOENT went uncaught and the command never settled.
      const { code, stderr } = await run(['validate', gone, '--config', config]);

      expect(code).not.toBe(0);
      expect(stderr).toContain('ENOENT');
      expect(stderr).not.toContain('at Object.');
    });

    it("reads the guide back with the config's compress, not the extension", async () => {
      const dir = await tempDir();
      const guide = join(dir, 'guide.xml');

      // What `writeOutput` would have produced: gzip bytes under a plain name,
      // because `compress` outranks the extension in both directions. Reading
      // it back by the extension alone validated gzip as XML.
      await writeFile(guide, gzipSync(Buffer.from(GUIDE, 'utf8')));

      const config = await configFile(
        dir,
        `export default {
      sites: [],
      output: ${JSON.stringify(guide)},
      compress: 'gzip',
      cache: { dir: ${JSON.stringify(join(dir, 'cache'))} },
    };`,
      );

      const { stdout } = await run(['validate', '--config', config]);

      expect(stdout).toContain('1 channel, 1 programme');
    });

    it('writes one JSON document for --format json', async () => {
      const dir = await tempDir();
      const config = await withGuide(dir);

      const { stdout } = await run(['validate', '--config', config, '--format', 'json']);
      const report = JSON.parse(stdout);

      // One object with an `ok` to branch on — not the NDJSON of run events
      // that `--reporter json` produces. Two flags, two questions: the shape of
      // this command's output, and how a run narrates itself.
      expect(report).toMatchObject({ ok: false, channels: 1, programmes: 1, errors: 1 });
      expect(report.file).toContain('guide.xml');
      expect(report.findings[0]).toMatchObject({ code: 'unknown-channel', severity: 'error' });
    });

    it('fails a guide that only carries extensions when --strict says so', async () => {
      const dir = await tempDir();
      const config = await withGuide(
        dir,
        `<?xml version="1.0" encoding="UTF-8"?><tv>` +
          `<channel id="one" data-src="acme"><display-name>One</display-name></channel>` +
          `</tv>`,
      );

      expect((await run(['validate', '--config', config])).code).toBe(0);
      expect((await run(['validate', '--config', config, '--strict'])).code).toBe(1);
    });

    it('reads a compressed guide, since that is what the name promised', async () => {
      const dir = await tempDir();
      const config = await withGuide(dir);
      const gz = join(dir, 'guide.xml.gz');

      await writeFile(gz, gzipSync(Buffer.from(GUIDE, 'utf8')));

      const { code, stdout } = await run(['validate', gz, '--config', config]);

      expect(code).toBe(1);
      expect(stdout).toContain('unknown-channel');
    });

    it('needs no config at all when the guide is named', async () => {
      // A guide named on the command line is the whole of what this needs;
      // refusing to read one because the working directory has no project in
      // it would be absurd. Note there is no `--config`, and none to find.
      const dir = await tempDir();
      const file = join(dir, 'standalone.xml');

      await writeFile(file, GUIDE, 'utf8');

      const { code, stdout, stderr } = await run(['validate', file]);

      expect(code).toBe(1);
      expect(stderr).toBe('');
      expect(stdout).toContain('unknown-channel');
    });

    it('reports a guide that is not there as one line', async () => {
      const dir = await tempDir();
      const config = await withGuide(dir);

      const { code, stderr } = await run([
        'validate',
        join(dir, 'nowhere.xml'),
        '--config',
        config,
      ]);

      expect(code).toBe(1);
      expect(stderr.trimEnd().split('\n')).toHaveLength(1);
      expect(stderr).toContain('nowhere.xml');
    });

    it('refuses a --format it does not have, with the usage', async () => {
      const dir = await tempDir();
      const config = await withGuide(dir);

      const { code, stderr } = await run(['validate', '--config', config, '--format', 'yaml']);

      expect(code).toBe(2);
      expect(stderr).toContain('Invalid --format value: yaml');
      expect(stderr).toContain('text, json');
    });
  });

  it('exits 0 with what --allow-missing tolerates, and 1 past it', async () => {
    const dir = await tempDir();
    // Four channel-days, of which one channel's two always fail.
    const config = await configFile(
      dir,
      `const flaky = (site, fails) => ({
      site,
      channels: [{ xmltvId: 'a.' + site, siteId: 'a' }, { xmltvId: 'b.' + site, siteId: 'b' }],
      async request({ channel }) {
        if (fails.includes(channel.siteId)) throw new Error('the feed went away');
        return {};
      },
      parseDay: ({ channel, day }) => [{
        channel: channel.xmltvId,
        start: new Date(day + 'T06:00:00.000Z'),
        title: [{ value: 'Show' }],
      }],
    });

    export default {
      sites: [flaky('example.tv', ['b'])],
      days: 2,
      output: ${JSON.stringify(join(dir, 'guide.xml'))},
      cache: { dir: ${JSON.stringify(join(dir, 'cache'))} },
    };`,
    );

    const args = ['grab', '--config', config, '--quiet', '--refresh'];

    // Two of four channel-days lost: a failure by default.
    expect((await run(args)).code).toBe(1);

    // A count, and a share of the four it accounted for — 50% exactly, which
    // passes as "up to".
    expect((await run([...args, '--allow-missing', '2'])).code).toBe(0);
    expect((await run([...args, '--allow-missing', '1'])).code).toBe(1);
    expect((await run([...args, '--allow-missing', '50%'])).code).toBe(0);
    expect((await run([...args, '--allow-missing', '49%'])).code).toBe(1);
  });

  it('refuses to let any allowance cover a site that answered nothing', async () => {
    const dir = await tempDir();
    // No `request` at all: the site cannot be read, so nothing of it is reached
    // and there is no grid to weigh the loss against.
    const config = await configFile(
      dir,
      `export default {
      sites: [{ site: 'example.tv', channels: [{ xmltvId: 'one', siteId: '1' }] }],
      days: 1,
      output: ${JSON.stringify(join(dir, 'guide.xml'))},
      cache: { dir: ${JSON.stringify(join(dir, 'cache'))} },
    };`,
    );

    const { code, stdout, stderr } = await run([
      'grab',
      '--config',
      config,
      '--allow-missing',
      '100%',
      '--reporter',
      'text',
    ]);

    // Not "1 failed", which would read as one channel-day out of one: the
    // summary names it apart, as the exit code treats it apart.
    expect(code).toBe(1);
    expect(stdout).toContain('1 site answered nothing');
    expect(stdout).toContain('0 failed');
    expect(stderr).toContain('site failed');
  });

  it('refuses an --allow-missing value that is not one, with the usage', async () => {
    const dir = await tempDir();
    const config = await plainConfig(dir);
    const bad = async (value: string): Promise<string> =>
      (await run(['grab', '--config', config, '--allow-missing', value])).stderr;

    expect(await bad('lots')).toContain('expected a number of channel-days');
    expect(await bad('101%')).toContain('cannot exceed 100%');
    // The likeliest slip: a share written as a fraction.
    expect(await bad('0.05')).toContain('did you mean 0.05%');

    const { code, stderr } = await run(['grab', '--config', config, '--allow-missing', 'lots']);

    expect(code).toBe(2);
    expect(stderr).toContain('Usage: epg');
  });

  it('refuses an allowMissing in the config before the run, not after it', async () => {
    const dir = await tempDir();
    const config = await configFile(
      dir,
      `export default {
    sites: [${siteSource()}],
    days: 1,
    output: ${JSON.stringify(join(dir, 'guide.xml'))},
    cache: { dir: ${JSON.stringify(join(dir, 'cache'))} },
    allowMissing: 'lots',
  };`,
    );

    // The flag was checked up front and the config field was not: it was only
    // resolved once something had already failed, so a bad value threw after
    // the guide had been written, and only on the nights a day was lost.
    const { code, stderr } = await run(['grab', '--config', config]);

    // `1`, not the `2` the flag gives: a bad value in a config file is not a
    // usage error, and nothing here can print a usage line that would help.
    expect(code).toBe(1);
    expect(stderr).toContain('Invalid allowMissing value');
    expect(stderr).toContain('expected a number of channel-days');
    await expect(stat(join(dir, 'guide.xml'))).rejects.toThrow();
  });

  it('picks what the guide keeps with --extensions and --no-extensions', async () => {
    const dir = await tempDir();
    const config = await configFile(
      dir,
      `export default {
    sites: [{
      site: 'example.tv',
      channels: [{ xmltvId: 'one.example.tv', siteId: '1', name: 'One' }],
      request: async ({ day }) => ({ day }),
      parseDay: ({ channel, day }) => [{
        channel: channel.xmltvId,
        start: new Date(day + 'T06:00:00.000Z'),
        title: [{ value: 'Show' }],
        extraAttributes: { uniqueID: 'ev-1' },
        extra: [{ name: 'lcn', value: '12' }, { name: 'crid', value: 'abc' }],
      }],
    }],
    days: 1,
    extensions: ['lcn', 'crid'],
    output: ${JSON.stringify(join(dir, 'guide.xml'))},
    cache: { dir: ${JSON.stringify(join(dir, 'cache'))} },
  };`,
    );

    const args = ['build', '--config', config, '--quiet'];
    const guide = async (): Promise<string> => readFile(join(dir, 'guide.xml'), 'utf8');

    // What the config asked for.
    expect((await run(args)).code).toBe(0);
    expect(await guide()).toContain('<lcn>12</lcn>');
    expect(await guide()).toContain('<crid>abc</crid>');
    expect(await guide()).not.toContain('uniqueID');

    // A flag overrides it, as everywhere else here.
    expect((await run([...args, '--extensions', 'uniqueID,lcn'])).code).toBe(0);
    expect(await guide()).toContain('uniqueID="ev-1"');
    expect(await guide()).toContain('<lcn>12</lcn>');
    expect(await guide()).not.toContain('<crid>');

    // And `--no-extensions` is the third state: none, not "the config decides".
    expect((await run([...args, '--no-extensions'])).code).toBe(0);
    expect(await guide()).not.toContain('uniqueID');
    expect(await guide()).not.toContain('<lcn>');
    expect(await guide()).not.toContain('<crid>');
  });

  it('refuses an empty --extensions rather than silently stripping every one', async () => {
    const dir = await tempDir();
    const config = await plainConfig(dir);

    const { code, stderr } = await run(['build', '--config', config, '--extensions', ' , ']);

    expect(code).toBe(2);
    expect(stderr).toContain('Invalid --extensions value');
    expect(stderr).toContain('--no-extensions');
  });

  it('refetches the window for --refresh, and still caches what it fetched', async () => {
    const dir = await tempDir();
    const asked = join(dir, 'asked.txt');
    // The site records every request, so what came from the network and what
    // came from the cache can be told apart across runs.
    const config = await configFile(
      dir,
      `import { appendFileSync } from 'node:fs';

      export default {
        sites: [{
          site: 'example.tv',
          channels: [{ xmltvId: 'one.example.tv', siteId: '1', name: 'One' }],
          async request({ day }) {
            appendFileSync(${JSON.stringify(asked)}, day + '\\n');
            return { day };
          },
          parseDay: ({ channel, day }) => [{
            channel: channel.xmltvId,
            start: new Date(day + 'T06:00:00.000Z'),
            title: [{ value: 'Show' }],
          }],
        }],
        days: 2,
        output: ${JSON.stringify(join(dir, 'guide.xml'))},
        cache: { dir: ${JSON.stringify(join(dir, 'cache'))}, prune: false },
      };`,
    );
    const days = async (): Promise<string[]> => (await readFile(asked, 'utf8')).trim().split('\n');

    // `--offset 1` puts the window past today, which is the only part of it
    // `alwaysRefetchDays` would have refetched by itself.
    const args = ['build', '--config', config, '--quiet', '--offset', '1'];

    expect((await run(args)).code).toBe(0);
    expect(await days()).toHaveLength(2);

    // Fresh, so a second run asks for nothing.
    expect((await run(args)).code).toBe(0);
    expect(await days()).toHaveLength(2);

    expect((await run([...args, '--refresh'])).code).toBe(0);
    expect(await days()).toHaveLength(4);

    // And what it fetched was cached, so the run after it asks for nothing
    // again — the reading is what `--refresh` turns off, not the writing.
    expect((await run(args)).code).toBe(0);
    expect(await days()).toHaveLength(4);
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
    const config = await configFile(
      dir,
      `export default (...readers) => {
      const value = readers.map((reader) => reader.read('label')).find(Boolean)
        ?? [process.env.EPG_CLI_TEST_LABEL];

      return {
        sites: [${siteSource()}],
        days: 1,
        output: ${JSON.stringify(join(dir, 'guide.xml'))},
        cache: { dir: ${JSON.stringify(join(dir, 'cache'))} },
        meta: { sourceInfoName: value[0] },
      };
    };`,
    );

    vi.stubEnv('EPG_CLI_TEST_LABEL', 'from-env');

    try {
      const { code } = await run(['build', '--config', config, '--quiet']);

      expect(code).toBe(0);
      expect(await readFile(join(dir, 'guide.xml'), 'utf8')).toContain(
        'source-info-name="from-env"',
      );
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
      'init-grabber',
      'tv_grab_sk_example',
      '--config',
      config,
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
      'init-grabber',
      'tv_grab_sk_example',
      '--config',
      config,
      '--description',
      'Slovakia (example.tv)',
      '--grabber-version',
      '2.3.4',
    ]);

    expect(code).toBe(0);

    const shim = await readFile(join(dir, 'tv_grab_sk_example'), 'utf8');
    expect(shim).toContain('description: "Slovakia (example.tv)"');
    expect(shim).toContain('version: "2.3.4"');

    // Caught while writing the file rather than on the grabber's first run.
    const bad = await run([
      'init-grabber',
      'tv_grab_sk_other',
      '--config',
      config,
      '--grabber-version',
      '1.0-beta',
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
  it('is -V now, since -v became --verbose', async () => {
    const short = await run(['-V']);
    const long = await run(['--version']);

    expect(short.stdout).toBe(long.stdout);
    expect(short.stdout).toContain(__PKG_VERSION__);
  });

  it('prints the package name and version', async () => {
    const { code, stdout, stderr } = await run(['--version']);

    expect(code).toBe(0);
    // Whatever the package currently says, from the same two constants the CLI
    // prints: a literal here goes stale the moment a release bumps the version,
    // and the first thing to notice would be the release PR's own CI.
    expect(stdout).toBe(`${__PKG_NAME__} ${__PKG_VERSION__}\n`);
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
