import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { defineConfig, type EpgConfig } from '../src/config.js';
import { envReader, type ConfigContext } from '../src/core/answers.js';
import { resolveChannels } from '../src/grabber/channels.js';
import type { SiteConfig } from '../src/grabber/types.js';
import type { XmltvProgramme } from '../src/xmltv/types.js';
import {
  applyChannelSelection,
  defineCapability,
  DEFAULT_CAPABILITIES,
  GrabberError,
  lineupsCapability,
  lineupsFromSites,
  listChannelsXml,
  parseGrabberConfig,
  serializeLineups,
  parseSelection,
  preferredMethodCapability,
  renderSelectChannelsStage,
  renderStageXml,
  resolveChannelIds,
  runConfigure,
  runXmltvGrabber,
  saveGrabberConfig,
  resolveStages,
  DEFAULT_STAGES,
  serializeGrabberConfig,
  type CapabilityEntry,
  type ConfigSource,
  type ConfigStage,
  type LineupConfig,
  type LineupSource,
  type Prompter,
} from '../src/tv-grab/main.js';

const NOW = new Date('2026-07-17T12:00:00.000Z');

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
  return mkdtemp(join(tmpdir(), 'epg-tv-grab-test-'));
}

function site(id: string, fetchedDays: string[] = []): SiteConfig<unknown> {
  return {
    site: 'example.tv',
    channels: [{ xmltvId: id, siteId: '1', name: `Channel ${id}` }],
    async request({ day }) {
      fetchedDays.push(day);
      return { day };
    },
    parseDay({ channel, day }): XmltvProgramme[] {
      return [
        {
          channel: channel.xmltvId,
          start: new Date(`${day}T06:00:00.000Z`),
          title: [{ value: `p-${day}` }],
        },
      ];
    },
  };
}

function config(dir: string, overrides: Partial<EpgConfig> = {}): EpgConfig {
  return {
    sites: [site('one.example.tv')],
    days: 1,
    output: join(dir, 'unused.xml'),
    cache: { dir: join(dir, 'cache') },
    ...overrides,
  };
}

const META = {
  description: 'Slovakia (tv_grab_sk_example)',
  version: '1.2',
  grabberName: 'tv_grab_sk_example',
  now: NOW,
};

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(source: ConfigSource, argv: string[]): Promise<RunResult> {
  const stdout = new Sink();
  const stderr = new Sink();
  const code = await runXmltvGrabber(source, { ...META, argv, stdout, stderr });

  return { code, stdout: stdout.text, stderr: stderr.text };
}

/** Writes a config file selecting the default channel, and returns its path. */
async function configured(dir: string): Promise<string> {
  const configFile = join(dir, 'grabber.conf');
  await saveGrabberConfig(configFile, { channel: ['one.example.tv'] });
  return configFile;
}

describe('config file format', () => {
  it('parses key=value and key!value into selected and deselected', () => {
    const conf = parseGrabberConfig(
      [
        '# a comment',
        '',
        'username=mattias',
        'channel=svt1.svt.se',
        'channel=kanal5.se',
        'channel!svt2.svt.se',
      ].join('\n'),
    );

    expect(conf).toEqual({
      username: ['mattias'],
      channel: ['svt1.svt.se', 'kanal5.se'],
      no_channel: ['svt2.svt.se'],
    });
  });

  it('keeps space after the sign but strips it, and a comment, from the end', () => {
    expect(parseGrabberConfig('password= se cret  # trailing')).toEqual({ password: [' se cret'] });
  });

  it('treats an unparseable line as no configuration at all', () => {
    // The reference returns undef for the whole file, and callers rely on it
    // to tell the user to run --configure.
    expect(parseGrabberConfig('channel=one.example.tv\nnot a config line\n')).toBeUndefined();
  });

  it('round-trips, writing no_x back as x!value', () => {
    const conf = { channel: ['a.example.tv'], no_channel: ['b.example.tv'] };
    const text = serializeGrabberConfig(conf);

    expect(text).toBe('channel=a.example.tv\nchannel!b.example.tv\n');
    expect(parseGrabberConfig(text)).toEqual(conf);
  });
});

describe('applyChannelSelection', () => {
  it('filters an eager channel list and drops emptied sites', () => {
    const epg: EpgConfig = {
      sites: [site('one.example.tv'), site('two.example.tv')],
      output: 'x',
    };

    const selected = applyChannelSelection(epg, new Set(['one.example.tv']));

    expect(selected.sites).toHaveLength(1);
    expect(selected.sites[0]?.channels).toEqual([
      { xmltvId: 'one.example.tv', siteId: '1', name: 'Channel one.example.tv' },
    ]);
  });

  it('filters a lazy channel list without resolving it eagerly', async () => {
    let calls = 0;
    const epg: EpgConfig = {
      sites: [
        {
          ...site('one.example.tv'),
          channels: async () => {
            calls++;
            return [
              { xmltvId: 'one.example.tv', siteId: '1' },
              { xmltvId: 'two.example.tv', siteId: '2' },
            ];
          },
        },
      ],
      output: 'x',
    };

    const selected = applyChannelSelection(epg, new Set(['two.example.tv']));

    expect(calls).toBe(0);

    const resolved = await resolveChannels(selected.sites[0]!);

    expect(resolved).toEqual([{ xmltvId: 'two.example.tv', siteId: '2' }]);
    expect(calls).toBe(1);
  });

  it('resolveChannelIds deduplicates across sites, keeping priority order', async () => {
    const epg: EpgConfig = {
      sites: [site('one.example.tv'), site('two.example.tv'), site('one.example.tv')],
      output: 'x',
    };

    expect(await resolveChannelIds(epg)).toEqual(['one.example.tv', 'two.example.tv']);
  });
});

describe('capability options', () => {
  it('--capabilities lists them one per line without loading the config', async () => {
    let loaded = false;
    const { code, stdout } = await run(() => {
      loaded = true;
      throw new Error('config must not be loaded');
    }, ['--capabilities']);

    expect(stdout).toBe('baseline\nmanualconfig\napiconfig\ncache\npreferredmethod\nnewchannels\n');
    expect(code).toBe(0);
    expect(loaded).toBe(false);
  });

  it('does not resolve until stdout has been flushed', async () => {
    // A piped stdout is asynchronous on POSIX, so a caller that exits the
    // moment the run resolves must not be able to lose the document.
    const written: string[] = [];
    const slow = new Writable({
      write(chunk: Buffer | string, _encoding, done): void {
        setTimeout(() => {
          written.push(String(chunk));
          done();
        }, 5);
      },
    });

    const dir = await tempDir();
    const options = { ...META, stdout: slow, stderr: new Sink() };

    expect(await runXmltvGrabber(config(dir), { ...options, argv: ['--capabilities'] })).toBe(0);
    expect(written.join('')).toContain('baseline\n');

    // The same guarantee for a document a capability emits.
    expect(
      await runXmltvGrabber(config(dir), {
        ...options,
        argv: ['--configure-api', '--config-file', join(dir, 'missing.conf')],
      }),
    ).toBe(0);
    expect(written.join('')).toContain('<xmltvconfiguration');
  });

  it('--description prints the one-line description', async () => {
    const { code, stdout } = await run(() => {
      throw new Error('config must not be loaded');
    }, ['--description']);

    expect(stdout).toBe('Slovakia (tv_grab_sk_example)\n');
    expect(code).toBe(0);
  });

  it('--version prints the module and grabber versions', async () => {
    const { code, stdout } = await run(() => {
      throw new Error('config must not be loaded');
    }, ['--version']);

    expect(stdout).toBe(
      `XMLTV module version ${__PKG_VERSION__}\nThis is tv_grab_sk_example version 1.2\n`,
    );
    expect(code).toBe(0);
  });

  it('--help prints usage and exits 1, as the reference does', async () => {
    const { code, stdout } = await run(() => {
      throw new Error('config must not be loaded');
    }, ['--help']);

    expect(stdout).toContain('tv_grab_sk_example --capabilities');
    expect(stdout).toContain('[--days N] [--offset N]');
    expect(code).toBe(1);
  });

  it('derives the whole synopsis from the option specs', async () => {
    const { stdout } = await run(() => {
      throw new Error('config must not be loaded');
    }, ['--help']);

    // Every flag, its value's name and its --no- form come from the spec that
    // declares it; a capability only says which options make up a form.
    expect(
      stdout.startsWith(
        [
          'tv_grab_sk_example --help',
          'tv_grab_sk_example --version',
          'tv_grab_sk_example --capabilities',
          'tv_grab_sk_example --description',
          'tv_grab_sk_example --preferredmethod',
          '',
          'tv_grab_sk_example [--config-file FILE] [--days N] [--offset N]',
          '                   [--output FILE] [--quiet] [--debug]',
          '                   [--cache [DIR] | --no-cache]',
          '                   [--channel-updates add|ignore|notify|signal]',
          '',
          'tv_grab_sk_example --configure [--config-file FILE]',
          '',
          'tv_grab_sk_example --configure-api [--stage NAME] [--config-file FILE]',
          '                   [--output FILE]',
          '',
          'tv_grab_sk_example --list-channels [--config-file FILE] [--output FILE]',
          '                   [--quiet]',
          '',
        ].join('\n'),
      ),
    ).toBe(true);
  });

  it('explains every option under the capability that declares it', async () => {
    const { stdout } = await run(() => {
      throw new Error('config must not be loaded');
    }, ['--help']);

    expect(stdout).toContain('  -h, --help                    Print this help.\n');
    expect(stdout).toContain('\nGrabbing:\n  --config-file FILE            Where the config');
    // Grouped by owner, so the list says which capability brings what.
    expect(stdout).toContain('\napiconfig:\n  --configure-api ');
    expect(stdout).toContain('\ncache:\n  --cache [DIR] | --no-cache    Keep the day cache');
    // A flag too wide for the column keeps its own line.
    expect(stdout).toContain(
      '\n  --channel-updates add|ignore|notify|signal\n                                What to do',
    );

    // An option error stays terse: the caller mistyped one flag.
    const { stderr } = await run(() => {
      throw new Error('config must not be loaded');
    }, ['--ahdmegkeja']);

    expect(stderr).toContain('tv_grab_sk_example --configure [--config-file FILE]');
    expect(stderr).not.toContain('Print this help.');
  });

  it('refuses to start when a form names an option nobody declared', async () => {
    const dir = await tempDir();

    await expect(
      runXmltvGrabber(config(dir), {
        ...META,
        capabilities: [
          ...DEFAULT_CAPABILITIES,
          defineCapability({
            name: 'typo',
            options: { typo: { type: 'boolean' } },
            usage: { modes: [['typo', 'confg-file']] },
            run: () => undefined,
          }),
        ],
        argv: ['--help'],
        stdout: new Sink(),
        stderr: new Sink(),
      }),
    ).rejects.toThrow(/names an unknown option --confg-file/);
  });

  it('rejects an unknown option with usage on stderr', async () => {
    // tv_validate_grabber probes with exactly this and reports `noparamcheck`
    // if the grabber accepts it.
    const { code, stdout, stderr } = await run(() => {
      throw new Error('config must not be loaded');
    }, ['--ahdmegkeja']);

    expect(code).toBe(1);
    expect(stderr).toContain("Unknown option '--ahdmegkeja'");
    expect(stdout).toBe('');
  });

  it('rejects an option outside the advertised capabilities', async () => {
    const stdout = new Sink();
    const stderr = new Sink();
    const code = await runXmltvGrabber(
      { sites: [], output: 'x' },
      {
        ...META,
        capabilities: ['baseline'],
        argv: ['--configure'],
        stdout,
        stderr,
      },
    );

    expect(code).toBe(1);
    expect(stderr.text).toContain("Unknown option '--configure'");
  });

  it('rejects a grabber version the reference would croak on', async () => {
    await expect(
      runXmltvGrabber({ sites: [], output: 'x' }, { ...META, version: 'v1.2', argv: [] }),
    ).rejects.toThrow(/Invalid grabber version/);
  });
});

describe('--preferredmethod', () => {
  it('prints allatonce by default, without loading the config', async () => {
    const { code, stdout } = await run(() => {
      throw new Error('config must not be loaded');
    }, ['--preferredmethod']);

    expect(stdout).toBe('allatonce\n');
    expect(code).toBe(0);
  });

  it('prints a value the capability was built with', async () => {
    const stdout = new Sink();
    const code = await runXmltvGrabber(
      { sites: [], output: 'x' },
      {
        ...META,
        capabilities: ['baseline', preferredMethodCapability('onechannelatatime')],
        argv: ['--preferredmethod'],
        stdout,
        stderr: new Sink(),
      },
    );

    expect(stdout.text).toBe('onechannelatatime\n');
    expect(code).toBe(0);
  });

  it('rejects an empty method when the capability is built', () => {
    // The reference croaks when the capability and its value disagree. Here
    // the value is an argument to the capability, so the only way they can
    // disagree at all is an empty one.
    expect(() => preferredMethodCapability('')).toThrow(/non-empty method/);
  });
});

describe('--channel-updates', () => {
  /** Configured for one channel, while the site offers three. */
  async function partlyConfigured(dir: string): Promise<string> {
    const configFile = join(dir, 'g.conf');

    await saveGrabberConfig(configFile, {
      channel: ['one.example.tv'],
      no_channel: ['two.example.tv'],
    });

    return configFile;
  }

  function threeSites(dir: string): EpgConfig {
    return config(dir, {
      sites: [site('one.example.tv'), site('two.example.tv'), site('three.example.tv')],
    });
  }

  it('notifies about a channel never asked about, but still exits 0', async () => {
    const dir = await tempDir();
    const configFile = await partlyConfigured(dir);

    const { code, stderr, stdout } = await run(threeSites(dir), [
      '--config-file',
      configFile,
      '--quiet',
    ]);

    // two.example.tv was declined, so it is not new; three.example.tv is.
    expect(stderr).toContain('New channel(s) available: three.example.tv');
    expect(stderr).not.toContain('two.example.tv');
    // A complete guide is a successful run: a consumer that has never heard of
    // this capability must not see the day a channel appears as a failure.
    expect(code).toBe(0);
    // The guide is still produced, and still only the selected channel.
    expect(stdout).toContain('<channel id="one.example.tv">');
    expect(stdout).not.toContain('three.example.tv');
  });

  it('signal reports the same thing and exits 2', async () => {
    const dir = await tempDir();
    const configFile = await partlyConfigured(dir);

    const { code, stderr, stdout } = await run(threeSites(dir), [
      '--config-file',
      configFile,
      '--quiet',
      '--channel-updates',
      'signal',
    ]);

    expect(stderr).toContain('New channel(s) available: three.example.tv');
    expect(code).toBe(2);
    // Advisory only: the guide is complete, which is the point of a code of
    // its own rather than the 1 that means partial data.
    expect(stdout).toContain('<channel id="one.example.tv">');
  });

  it('says nothing and exits 0 when every channel is accounted for', async () => {
    const dir = await tempDir();
    const configFile = await configured(dir);

    const { code, stderr } = await run(config(dir), ['--config-file', configFile, '--quiet']);

    expect(stderr).toBe('');
    expect(code).toBe(0);
  });

  it('ignore keeps the old silence', async () => {
    const dir = await tempDir();
    const configFile = await partlyConfigured(dir);

    const { code, stderr } = await run(threeSites(dir), [
      '--config-file',
      configFile,
      '--quiet',
      '--channel-updates',
      'ignore',
    ]);

    expect(stderr).toBe('');
    expect(code).toBe(0);
  });

  it('add grabs the new channel and records it in the config file', async () => {
    const dir = await tempDir();
    const configFile = await partlyConfigured(dir);

    const { code, stdout } = await run(threeSites(dir), [
      '--config-file',
      configFile,
      '--quiet',
      '--channel-updates',
      'add',
    ]);

    expect(code).toBe(0);
    expect(stdout).toContain('<channel id="three.example.tv">');

    const saved = parseGrabberConfig(await readFile(configFile, 'utf8'));

    expect(saved?.channel).toEqual(['one.example.tv', 'three.example.tv']);
    // The declined channel stays declined, and stays out of the guide.
    expect(saved?.no_channel).toEqual(['two.example.tv']);
    expect(stdout).not.toContain('two.example.tv');
  });

  it('reports a channel that is no longer offered but never removes it', async () => {
    // A site whose channel list is fetched can come back short after a blip;
    // deleting the selection on that basis would be unrecoverable.
    const dir = await tempDir();
    const configFile = join(dir, 'g.conf');
    await saveGrabberConfig(configFile, { channel: ['one.example.tv', 'gone.example.tv'] });

    const { stderr } = await run(config(dir), ['--config-file', configFile, '--quiet']);

    expect(stderr).toContain('No longer offered, keeping in');
    expect(stderr).toContain('gone.example.tv');

    const saved = parseGrabberConfig(await readFile(configFile, 'utf8'));

    expect(saved?.channel).toContain('gone.example.tv');
  });

  it('rejects an unknown mode', async () => {
    const dir = await tempDir();

    const { code, stderr } = await run(config(dir), ['--channel-updates', 'maybe']);

    expect(code).toBe(1);
    expect(stderr).toContain(
      'Invalid --channel-updates value: maybe (expected add, ignore, notify, signal)',
    );
  });

  it('is unavailable when the capability is not advertised', async () => {
    const stderr = new Sink();
    const code = await runXmltvGrabber(
      { sites: [], output: 'x' },
      {
        ...META,
        capabilities: ['baseline'],
        argv: ['--channel-updates', 'add'],
        stdout: new Sink(),
        stderr,
      },
    );

    expect(code).toBe(1);
    expect(stderr.text).toContain("Unknown option '--channel-updates'");
  });
});

describe('custom capabilities', () => {
  it('advertises its name, adds its options, and handles them before any config', async () => {
    const dir = await tempDir();
    let resolvedConfig = false;

    const ping = defineCapability({
      name: 'ping',
      options: {
        ping: { type: 'boolean' },
        'ping-text': { type: 'string', default: 'pong', placeholder: 'TEXT' },
      },
      usage: { modes: [['ping', 'ping-text']] },
      async run(ctx) {
        if (!ctx.values.ping) {
          return undefined;
        }

        await ctx.emit(`${ctx.values['ping-text']}\n`);
        return 0;
      },
    });

    const options = {
      ...META,
      capabilities: [...DEFAULT_CAPABILITIES, ping],
      stdout: new Sink(),
      stderr: new Sink(),
    };

    const caps = new Sink();
    await runXmltvGrabber(config(dir), { ...options, argv: ['--capabilities'], stdout: caps });
    expect(caps.text.trimEnd().split('\n')).toContain('ping');

    // Runs in the same slot as the built-in information options: no config
    // file needed, and the grabber's own config never resolved.
    const out = new Sink();
    const code = await runXmltvGrabber(
      () => {
        resolvedConfig = true;
        return config(dir);
      },
      { ...options, argv: ['--ping', '--ping-text', 'hello'], stdout: out },
    );

    expect(code).toBe(0);
    expect(out.text).toBe('hello\n');
    expect(resolvedConfig).toBe(false);

    const help = new Sink();
    await runXmltvGrabber(config(dir), { ...options, argv: ['--help'], stdout: help });
    expect(help.text).toContain('tv_grab_sk_example --ping [--ping-text TEXT]');
  });

  it('can act on the loaded configuration and on a missing one', async () => {
    const dir = await tempDir();
    const seen: (string | undefined)[] = [];

    const probe = defineCapability({
      name: 'probe',
      options: { probe: { type: 'boolean' } },
      run(ctx) {
        if (!ctx.values.probe) {
          return;
        }

        // What --configure-api needs: reached whether or not a config exists.
        ctx.onConfigLoaded((conf) => {
          seen.push(conf === undefined ? undefined : (conf.channel ?? []).join(','));
          return 0;
        });
      },
    });

    const options = {
      ...META,
      capabilities: [...DEFAULT_CAPABILITIES, probe],
      stdout: new Sink(),
      stderr: new Sink(),
    };

    expect(
      await runXmltvGrabber(config(dir), {
        ...options,
        argv: ['--probe', '--config-file', join(dir, 'missing.conf')],
      }),
    ).toBe(0);

    const configFile = await configured(dir);
    await runXmltvGrabber(config(dir), {
      ...options,
      argv: ['--probe', '--config-file', configFile],
    });

    expect(seen).toEqual([undefined, 'one.example.tv']);
  });

  it('can serve one option before the config and another that requires it', async () => {
    const dir = await tempDir();
    let resolvedConfig = false;

    // The `lineups` shape: --list-lineups must answer with no config at all,
    // --get-lineup cannot. One capability, two points in the dispatch.
    const atlas = defineCapability({
      name: 'atlas',
      options: { 'list-atlas': { type: 'boolean' }, 'get-atlas': { type: 'boolean' } },
      async run(ctx) {
        if (ctx.values['list-atlas']) {
          await ctx.emit('<atlas />\n');
          return 0;
        }

        if (ctx.values['get-atlas']) {
          ctx.onConfigLoaded(async (conf) => {
            if (conf === undefined) {
              throw new GrabberError('You need to configure the grabber to choose an atlas.');
            }

            await ctx.emit(`<atlas>${(conf.channel ?? []).join(',')}</atlas>\n`);
            return 0;
          });
        }
      },
    });

    const options = {
      ...META,
      capabilities: [...DEFAULT_CAPABILITIES, atlas],
      stdout: new Sink(),
      stderr: new Sink(),
    };

    const missing = join(dir, 'missing.conf');
    const listed = new Sink();
    const code = await runXmltvGrabber(
      () => {
        resolvedConfig = true;
        return config(dir);
      },
      { ...options, argv: ['--list-atlas', '--config-file', missing], stdout: listed },
    );

    // Answered before the config file is even read, let alone required.
    expect(code).toBe(0);
    expect(listed.text).toBe('<atlas />\n');
    expect(resolvedConfig).toBe(false);

    const stderr = new Sink();
    expect(
      await runXmltvGrabber(config(dir), {
        ...options,
        argv: ['--get-atlas', '--config-file', missing],
        stderr,
      }),
    ).toBe(1);
    // Its own message, not the grabber's generic one.
    expect(stderr.text).toBe('You need to configure the grabber to choose an atlas.\n');

    const stdout = new Sink();
    const configFile = await configured(dir);
    expect(
      await runXmltvGrabber(config(dir), {
        ...options,
        argv: ['--get-atlas', '--config-file', configFile],
        stdout,
      }),
    ).toBe(0);
    expect(stdout.text).toBe('<atlas>one.example.tv</atlas>\n');
  });

  it('writes a replaced configuration itself, and only when it differs', async () => {
    const dir = await tempDir();
    const configFile = join(dir, 'grabber.conf');
    // Hand-written, so a needless rewrite would be visible: the comment is
    // not something the serializer would put back.
    await writeFile(configFile, '# hand written\nchannel=one.example.tv\n', 'utf8');

    const rename = defineCapability({
      name: 'rename',
      options: { 'rename-to': { type: 'string' } },
      run(ctx) {
        ctx.onConfigLoaded((conf) => {
          // No path, no import, no write: the run persists this on the way out.
          ctx.replaceConfig({ ...conf, channel: [ctx.values['rename-to'] ?? 'one.example.tv'] });
          return 0;
        });
      },
    });

    const options = {
      ...META,
      capabilities: [...DEFAULT_CAPABILITIES, rename],
      stdout: new Sink(),
      stderr: new Sink(),
    };

    expect(
      await runXmltvGrabber(config(dir), {
        ...options,
        argv: ['--config-file', configFile],
      }),
    ).toBe(0);

    // Same configuration, so the file was left exactly as it was.
    expect(await readFile(configFile, 'utf8')).toBe('# hand written\nchannel=one.example.tv\n');

    expect(
      await runXmltvGrabber(config(dir), {
        ...options,
        argv: ['--config-file', configFile, '--rename-to', 'two.example.tv'],
      }),
    ).toBe(0);

    expect(await readFile(configFile, 'utf8')).toBe('channel=two.example.tv\n');
  });

  it('shows a replaced configuration to the capabilities that come after', async () => {
    const dir = await tempDir();
    const configFile = await configured(dir);
    const seenLoaded: string[] = [];
    const seenAdjust: string[] = [];

    const first = defineCapability({
      name: 'first',
      run(ctx) {
        ctx.onConfigLoaded((conf) => {
          ctx.replaceConfig({ ...conf, channel: ['two.example.tv'] });
        });
        ctx.onAdjust((config, { conf }) => {
          ctx.replaceConfig({ ...conf, channel: ['three.example.tv'] });
          return config;
        });
      },
    });

    const second = defineCapability({
      name: 'second',
      run(ctx) {
        ctx.onConfigLoaded((conf) => {
          seenLoaded.push((conf?.channel ?? []).join(','));
        });
        ctx.onAdjust((config, { conf }) => {
          seenAdjust.push((conf.channel ?? []).join(','));
          return config;
        });
      },
    });

    await runXmltvGrabber(
      config(dir, { sites: [site('one.example.tv'), site('two.example.tv')] }),
      {
        ...META,
        capabilities: [...DEFAULT_CAPABILITIES, first, second],
        argv: ['--config-file', configFile, '--quiet'],
        stdout: new Sink(),
        stderr: new Sink(),
      },
    );

    // Not 'one.example.tv', which is what both tasks would see if the
    // configuration were handed out once instead of read per task.
    expect(seenLoaded).toEqual(['two.example.tv']);
    expect(seenAdjust).toEqual(['three.example.tv']);
    // ...and the run persisted the last replacement, once.
    expect(await readFile(configFile, 'utf8')).toBe('channel=three.example.tv\n');
  });

  it('turns a thrown GrabberError into one line on stderr and its exit code', async () => {
    const dir = await tempDir();
    const configFile = await configured(dir);

    const boom = defineCapability({
      name: 'boom',
      options: { boom: { type: 'boolean' }, 'boom-later': { type: 'boolean' } },
      run(ctx) {
        if (ctx.values.boom) {
          throw new GrabberError('Nothing to grab from here.', 4);
        }

        if (ctx.values['boom-later']) {
          // Not from `run`, so this proves the catch is wider than the dispatch.
          ctx.onAdjust(() => {
            throw new GrabberError('Too late to grab.');
          });
        }
      },
    });

    const options = {
      ...META,
      capabilities: [...DEFAULT_CAPABILITIES, boom],
      stdout: new Sink(),
    };

    const stderr = new Sink();
    expect(
      await runXmltvGrabber(config(dir), {
        ...options,
        argv: ['--boom', '--config-file', configFile],
        stderr,
      }),
    ).toBe(4);
    expect(stderr.text).toBe('Nothing to grab from here.\n');

    const later = new Sink();
    expect(
      await runXmltvGrabber(config(dir), {
        ...options,
        argv: ['--boom-later', '--config-file', configFile, '--quiet'],
        stderr: later,
      }),
    ).toBe(1);
    // The code defaults to 1, and --quiet never hides an error.
    expect(later.text).toBe('Too late to grab.\n');

    expect(new GrabberError('x').code).toBe(1);
  });

  it('flushes what a capability wrote to stderr before the run resolves', async () => {
    const dir = await tempDir();
    const written: string[] = [];
    const slow = new Writable({
      write(chunk: Buffer | string, _encoding, done): void {
        setTimeout(() => {
          written.push(String(chunk));
          done();
        }, 5);
      },
    });

    const noisy = defineCapability({
      name: 'noisy',
      options: { noisy: { type: 'boolean' } },
      run(ctx) {
        if (!ctx.values.noisy) {
          return undefined;
        }

        // Deliberately not awaited — the run must still not lose it.
        ctx.stderr.write('a note\n');
        return 0;
      },
    });

    const code = await runXmltvGrabber(config(dir), {
      ...META,
      capabilities: [...DEFAULT_CAPABILITIES, noisy],
      argv: ['--noisy'],
      stdout: new Sink(),
      stderr: slow,
    });

    expect(code).toBe(0);
    expect(written.join('')).toContain('a note\n');
  });

  it('can reshape the config and the selection without taking over the run', async () => {
    const dir = await tempDir();
    const configFile = await configured(dir);
    const cleaned: string[] = [];

    const only = defineCapability({
      name: 'only',
      options: { only: { type: 'string' } },
      run(ctx) {
        const only = ctx.values.only;

        if (only === undefined) {
          return;
        }

        ctx.onAdjust((config, { selection }) => {
          selection.clear();
          selection.add(only);
          ctx.setExitCode(3);
          ctx.onFinish(() => {
            cleaned.push('done');
          });

          return { ...config, days: 1 };
        });
      },
    });

    const stdout = new Sink();
    const code = await runXmltvGrabber(
      config(dir, { sites: [site('one.example.tv'), site('two.example.tv')] }),
      {
        ...META,
        capabilities: [...DEFAULT_CAPABILITIES, only],
        argv: ['--config-file', configFile, '--quiet', '--only', 'two.example.tv'],
        stdout,
        stderr: new Sink(),
      },
    );

    // The grab still happened, with the selection the capability imposed.
    expect(stdout.text).toContain('<channel id="two.example.tv">');
    expect(stdout.text).not.toContain('one.example.tv');
    // An advisory code, and cleanup ran after the guide was written.
    expect(code).toBe(3);
    expect(cleaned).toEqual(['done']);
  });

  it('rejects a name or an option that collides with something built in', async () => {
    const dir = await tempDir();

    await expect(
      runXmltvGrabber(config(dir), {
        ...META,
        capabilities: ['baseline', defineCapability({ name: 'baseline', run: () => undefined })],
        argv: ['--capabilities'],
      }),
    ).rejects.toThrow(/built in and cannot be redefined/);

    await expect(
      runXmltvGrabber(config(dir), {
        ...META,
        capabilities: [
          'baseline',
          defineCapability({
            name: 'x',
            options: { days: { type: 'string' } },
            run: () => undefined,
          }),
        ],
        argv: ['--capabilities'],
      }),
    ).rejects.toThrow(/redefines the option --days/);

    const twice = defineCapability({ name: 'dup', run: () => undefined });

    await expect(
      runXmltvGrabber(config(dir), {
        ...META,
        capabilities: ['baseline', twice, defineCapability({ name: 'dup', run: () => undefined })],
        argv: ['--capabilities'],
      }),
    ).rejects.toThrow(/declared twice/);
  });

  it('leaves its options unknown when the capability is not advertised', async () => {
    const dir = await tempDir();
    const stderr = new Sink();

    const code = await runXmltvGrabber(config(dir), {
      ...META,
      capabilities: ['baseline'],
      argv: ['--ping'],
      stdout: new Sink(),
      stderr,
    });

    expect(code).toBe(1);
    expect(stderr.text).toContain("Unknown option '--ping'");
  });
});

describe('configuration', () => {
  it('--configure writes a config file selecting every channel', async () => {
    const dir = await tempDir();
    const configFile = join(dir, 'grabber.conf');

    const { code } = await run(config(dir), [
      '--configure',
      '--config-file',
      configFile,
      '--quiet',
    ]);

    expect(code).toBe(0);
    expect(await readFile(configFile, 'utf8')).toBe('channel=one.example.tv\n');
  });

  it('warns about a channel id XMLTV would reject', async () => {
    const dir = await tempDir();
    const configFile = join(dir, 'grabber.conf');

    const { stderr } = await run(config(dir, { sites: [site('not dotted')] }), [
      '--configure',
      '--config-file',
      configFile,
      '--quiet',
    ]);

    expect(stderr).toContain('is not a valid XMLTV id');
  });

  it('refuses to grab without a configuration', async () => {
    const dir = await tempDir();

    const { code, stderr } = await run(config(dir), ['--config-file', join(dir, 'missing.conf')]);

    expect(code).toBe(1);
    expect(stderr).toBe('You need to configure the grabber by running it with --configure\n');
  });

  it('answers the config from the file it loaded', async () => {
    const dir = await tempDir();
    const configFile = join(dir, 'grabber.conf');
    await saveGrabberConfig(configFile, { channel: ['one.example.tv'], username: ['mattias'] });

    let seen: string | undefined;

    const source = defineConfig((ctx) => {
      seen = ctx.require('username');
      return config(dir);
    });

    await run(source, ['--config-file', configFile, '--days', '1', '--quiet']);

    expect(seen).toBe('mattias');
  });

  it('falls back to the environment, and says where a missing answer could go', async () => {
    const dir = await tempDir();
    const configFile = join(dir, 'grabber.conf');
    await saveGrabberConfig(configFile, { channel: ['one.example.tv'] });

    const source = defineConfig(
      (ctx) => ({ ...config(dir), meta: { sourceInfoName: ctx.require('username') } }),
      { env: 'TV_GRAB_TEST_' },
    );

    // Nothing in the file and nothing in the environment: one line naming both
    // places, and the exit code of a failed run rather than a stack trace.
    const missing = await run(source, ['--config-file', configFile, '--days', '1']);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toBe(
      'No value for "username": run --configure to be asked for it, or set TV_GRAB_TEST_USERNAME\n',
    );

    vi.stubEnv('TV_GRAB_TEST_USERNAME', 'from-env');

    try {
      const { stdout } = await run(source, ['--config-file', configFile, '--days', '1', '--quiet']);
      expect(stdout).toContain('source-info-name="from-env"');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('does not let an unanswered question outrank the environment', async () => {
    const dir = await tempDir();
    const configFile = join(dir, 'grabber.conf');

    // What --configure writes for a field nobody answered: the line is there,
    // the answer is not.
    await saveGrabberConfig(configFile, { channel: ['one.example.tv'], username: [''] });

    const source = defineConfig(
      (ctx) => ({ ...config(dir), meta: { sourceInfoName: ctx.require('username') } }),
      { env: 'TV_GRAB_TEST_' },
    );

    vi.stubEnv('TV_GRAB_TEST_USERNAME', 'from-env');

    try {
      const { stdout } = await run(source, ['--config-file', configFile, '--days', '1', '--quiet']);
      expect(stdout).toContain('source-info-name="from-env"');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('prefers the configuration file to the environment, unless told otherwise', async () => {
    const dir = await tempDir();
    const configFile = join(dir, 'grabber.conf');
    await saveGrabberConfig(configFile, { channel: ['one.example.tv'], username: ['from-file'] });

    const named = (ctx: ConfigContext): EpgConfig => ({
      ...config(dir),
      meta: { sourceInfoName: ctx.require('username') },
    });

    vi.stubEnv('TV_GRAB_TEST_USERNAME', 'from-env');

    try {
      // --configure was an explicit act on this machine, so it wins by default.
      const byDefault = await run(defineConfig(named, { env: 'TV_GRAB_TEST_' }), [
        '--config-file',
        configFile,
        '--days',
        '1',
        '--quiet',
      ]);
      expect(byDefault.stdout).toContain('source-info-name="from-file"');

      // …and the order is the config's to state, for a deployment where the
      // environment is the truth and a stale .conf is a hazard.
      const envFirst = await run(
        defineConfig(named, {
          readers: (supplied) => [envReader('TV_GRAB_TEST_'), ...supplied],
        }),
        ['--config-file', configFile, '--days', '1', '--quiet'],
      );
      expect(envFirst.stdout).toContain('source-info-name="from-env"');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('resolves the channel list with the answers just given', async () => {
    const dir = await tempDir();
    const configFile = join(dir, 'grabber.conf');
    let credentials: string | undefined;

    // A site whose channel list needs a login: --configure is the one run
    // where the password exists only in the answers being collected.
    const source = defineConfig(
      (ctx) => {
        credentials = ctx.require('username');
        return config(dir);
      },
      { stages: CREDENTIAL_STAGES },
    );

    const code = await runXmltvGrabber(source, {
      ...META,
      argv: ['--configure', '--config-file', configFile],
      stdout: new Sink(),
      stderr: new Sink(),
      // Username, password, then the region choice.
      stdin: Readable.from(['mattias\nhunter2\n1\n']),
    });

    expect(code).toBe(0);
    expect(credentials).toBe('mattias');
    expect(await readFile(configFile, 'utf8')).toContain('channel=one.example.tv');
  });

  it('configures with the stages the configuration carries', async () => {
    const dir = await tempDir();
    const source = defineConfig(
      (ctx) => ({
        ...config(dir),
        meta: { sourceInfoName: ctx.require('username') },
      }),
      { stages: CREDENTIAL_STAGES },
    );

    const stdout = new Sink();

    // No `stages` in the grabber options: they came with the configuration
    // that asks the questions, so the two cannot drift apart.
    await runXmltvGrabber(source, {
      ...META,
      argv: ['--configure-api'],
      stdout,
      stderr: new Sink(),
    });

    expect(stdout.text).toContain('<secretstring id="password">');
    expect(stdout.text).toContain('<nextstage stage="region" />');
  });

  it('grabs only the selected channels', async () => {
    const dir = await tempDir();
    const configFile = join(dir, 'grabber.conf');
    await saveGrabberConfig(configFile, { channel: ['two.example.tv'] });

    const { stdout } = await run(
      config(dir, { sites: [site('one.example.tv'), site('two.example.tv')] }),
      ['--config-file', configFile, '--quiet'],
    );

    expect(stdout).toContain('two.example.tv');
    expect(stdout).not.toContain('one.example.tv');
  });
});

const CREDENTIAL_STAGES: ConfigStage[] = [
  {
    name: 'start',
    next: 'region',
    fields: [
      { type: 'string', id: 'username', title: 'Username', description: 'Your account name.' },
      { type: 'secretstring', id: 'password', title: 'Password', description: 'Your password.' },
    ],
  },
  {
    name: 'region',
    next: 'select-channels',
    fields: [
      {
        type: 'selectone',
        id: 'region',
        title: 'Region',
        description: 'Which lineup to grab.',
        default: 'west',
        options: [
          { value: 'east', text: 'East' },
          { value: 'west', text: 'West' },
        ],
      },
    ],
  },
];

/** Answers a fixed script of replies, so a stage walk can be driven in a test. */
function scriptedPrompter(answers: string[], asked: string[] = []): Prompter & { asked: string[] } {
  let i = 0;

  return {
    asked,
    interactive: true,
    async ask(question) {
      asked.push(question);
      return answers[i++] ?? '';
    },
    async askSecret(question) {
      asked.push(question);
      return answers[i++] ?? '';
    },
    close() {},
  };
}

describe('resolveStages', () => {
  /** A stage that is fine on its own, so each case changes exactly one thing. */
  function stage(overrides: Partial<ConfigStage> = {}): ConfigStage {
    return {
      name: 'start',
      fields: [{ type: 'string', id: 'username', title: 'User', description: 'Who you are.' }],
      next: 'select-channels',
      ...overrides,
    };
  }

  it('falls back to channel selection alone, and passes a walk that ends there', () => {
    expect(resolveStages(undefined)).toBe(DEFAULT_STAGES);
    expect(resolveStages(CREDENTIAL_STAGES)).toBe(CREDENTIAL_STAGES);
  });

  it('insists on somewhere to begin', () => {
    expect(() => resolveStages([])).toThrow(/needs a stage called "start"/);
    expect(() => resolveStages([stage({ name: 'region' })])).toThrow(/stage called "start"/);
  });

  it('insists the walk ends at one of the two terminals', () => {
    // Both finish: 'select-channels' goes on to offer the channels, 'end' is
    // for a stage that has already settled them, as a chosen lineup does.
    expect(resolveStages([stage({ next: 'end' })])).toHaveLength(1);

    expect(() => resolveStages([stage({ next: 'finish' })])).toThrow(
      /No configuration stage is called "finish".*or "end" to finish without/s,
    );
  });

  it('refuses a stage named after the end of the walk', () => {
    // Its predecessor would name it and stop there, so it could never be
    // entered — which looks exactly like a stage being skipped.
    expect(() => resolveStages([stage({ next: 'end' }), stage({ name: 'end' })])).toThrow(
      /stage "end" is named after the end of the walk/,
    );
  });

  it('refuses stages that lead in a circle', () => {
    // Left alone, --configure would ask these two forever.
    expect(() =>
      resolveStages([stage({ next: 'region' }), stage({ name: 'region', next: 'start' })]),
    ).toThrow(/lead back to "start", so --configure would never finish/);
  });

  it('refuses two stages with one name', () => {
    expect(() => resolveStages([stage(), stage()])).toThrow(/stage "start" is declared twice/);
  });

  it('refuses a field id the configuration file could not hold', () => {
    const bad = (id: string): ConfigStage =>
      stage({ fields: [{ type: 'string', id, title: 'T', description: 'D' }] });

    // Each of these would be written as `id=value` and read back as something
    // else — or, for the first, as an unparseable line, which makes the whole
    // configuration count as missing.
    expect(() => resolveStages([bad('user name')])).toThrow(/not a name a configuration file/);
    expect(() => resolveStages([bad('user=name')])).toThrow(/not a name a configuration file/);
    expect(() => resolveStages([bad('no_region')])).toThrow(/marks a declined answer/);
    expect(() => resolveStages([bad('channel')])).toThrow(/a name the grabber writes itself/);
  });

  it('refuses a question asked twice, or one with no answer to give', () => {
    expect(() =>
      resolveStages([
        stage({
          fields: [
            { type: 'string', id: 'region', title: 'T', description: 'D' },
            { type: 'string', id: 'region', title: 'T', description: 'D' },
          ],
        }),
      ]),
    ).toThrow(/asked twice in the same stage/);

    expect(() =>
      resolveStages([
        stage({
          fields: [{ type: 'selectone', id: 'region', title: 'T', description: 'D', options: [] }],
        }),
      ]),
    ).toThrow(/offers nothing to choose from/);
  });

  it('is checked before the grabber does anything at all', async () => {
    const dir = await tempDir();

    // Alongside the version check: a mistake in the grabber, not in the
    // command line, so it is a throw rather than an exit code.
    await expect(
      runXmltvGrabber(config(dir), {
        ...META,
        stages: [stage({ next: 'nowhere' })],
        argv: ['--capabilities'],
        stdout: new Sink(),
        stderr: new Sink(),
      }),
    ).rejects.toThrow(/No configuration stage is called "nowhere"/);
  });
});

describe('stage documents', () => {
  it('renders a stage the way XMLTV::Configure::Writer does', () => {
    expect(renderStageXml(CREDENTIAL_STAGES[0] as ConfigStage, 'tv_grab_sk_example')).toBe(
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<xmltvconfiguration grabber="tv_grab_sk_example">\n` +
        `  <string id="username">\n` +
        `    <title lang="en">Username</title>\n` +
        `    <description lang="en">Your account name.</description>\n` +
        `  </string>\n` +
        `  <secretstring id="password">\n` +
        `    <title lang="en">Password</title>\n` +
        `    <description lang="en">Your password.</description>\n` +
        `  </secretstring>\n` +
        `  <nextstage stage="region" />\n` +
        `</xmltvconfiguration>\n`,
    );
  });

  it('puts default on the element and wraps option labels in <text>', () => {
    const xml = renderStageXml(CREDENTIAL_STAGES[1] as ConfigStage, 'tv_grab_sk_example');

    expect(xml).toContain('<selectone id="region" default="west">');
    expect(xml).toContain(
      '<option value="east">\n      <text lang="en">East</text>\n    </option>',
    );
    expect(xml).toContain('<nextstage stage="select-channels" />');
  });

  it('renders a constant as an attribute', () => {
    const xml = renderStageXml(
      {
        name: 'start',
        next: 'select-channels',
        fields: [{ type: 'string', id: 'v', title: 'V', description: 'D', constant: '123' }],
      },
      'g',
    );

    expect(xml).toContain('<string id="v" constant="123">');
  });

  it('escapes markup in labels and values', () => {
    const xml = renderStageXml(
      {
        name: 'start',
        next: 'select-channels',
        fields: [{ type: 'string', id: 'x', title: 'A & B', description: '<b>' }],
      },
      'tv_grab_&',
    );

    expect(xml).toContain('grabber="tv_grab_&amp;"');
    expect(xml).toContain('<title lang="en">A &amp; B</title>');
    expect(xml).toContain('<description lang="en">&lt;b&gt;</description>');
  });

  it('renders the select-channels stage with end as its successor', () => {
    // SelectChannelsStage calls end('end') — there is nothing after channels.
    const xml = renderSelectChannelsStage(
      [{ id: 'one.example.tv', name: 'One' }, { id: 'two.example.tv' }],
      'tv_grab_sk_example',
    );

    expect(xml).toContain('<selectmany id="channel">');
    expect(xml).toContain('Select the channels that you want to receive data for.');
    expect(xml).toContain('<option value="one.example.tv">\n      <text lang="en">One</text>');
    expect(xml).toContain(
      '<option value="two.example.tv">\n      <text lang="en">two.example.tv</text>',
    );
    expect(xml).toContain('<nextstage stage="end" />');
  });
});

describe('parseSelection', () => {
  it('takes individual numbers, ranges and a mixture', () => {
    expect(parseSelection('2', 5)).toEqual([1]);
    expect(parseSelection('2-4', 5)).toEqual([1, 2, 3]);
    expect(parseSelection('1-2,5', 5)).toEqual([0, 1, 4]);
    expect(parseSelection('1-2 5', 5)).toEqual([0, 1, 4]);
  });

  it('treats all, none and an empty line as blanket answers', () => {
    expect(parseSelection('all', 3)).toEqual([0, 1, 2]);
    expect(parseSelection('ALL', 3)).toEqual([0, 1, 2]);
    expect(parseSelection('none', 3)).toEqual([]);
    expect(parseSelection('  ', 3)).toEqual([]);
  });

  it('deduplicates overlaps and sorts the result', () => {
    expect(parseSelection('3,1-3,1', 5)).toEqual([0, 1, 2]);
  });

  it('accepts a reversed range', () => {
    expect(parseSelection('4-2', 5)).toEqual([1, 2, 3]);
  });

  it('rejects out-of-range and malformed input', () => {
    expect(parseSelection('0', 5)).toBeUndefined();
    expect(parseSelection('6', 5)).toBeUndefined();
    expect(parseSelection('1-9', 5)).toBeUndefined();
    expect(parseSelection('maybe', 5)).toBeUndefined();
    expect(parseSelection('1,,x', 5)).toBeUndefined();
    expect(parseSelection('-2', 5)).toBeUndefined();
  });
});

describe('runConfigure', () => {
  const channels = async (): Promise<{ id: string; name?: string }[]> => [
    { id: 'one.example.tv', name: 'One' },
    { id: 'two.example.tv', name: 'Two' },
  ];

  it('walks every stage and records the answers', async () => {
    const prompter = scriptedPrompter(['mattias', 'hunter2', '1', '1']);
    const out = new Sink();

    const conf = await runConfigure({ stages: CREDENTIAL_STAGES, channels, prompter, out });

    expect(conf).toEqual({
      username: ['mattias'],
      password: ['hunter2'],
      region: ['east'],
      channel: ['one.example.tv'],
      no_channel: ['two.example.tv'],
    });
  });

  it('takes the default when the answer is empty, and offers it in the prompt', async () => {
    const asked: string[] = [];
    const prompter = scriptedPrompter(['', '', '', 'all'], asked);
    const out = new Sink();

    const conf = await runConfigure({ stages: CREDENTIAL_STAGES, channels, prompter, out });

    expect(conf?.region).toEqual(['west']);
    expect(asked).toContain('Region: [west] ');
    // Descriptions are shown before each question.
    expect(out.text).toContain('Which lineup to grab.');
  });

  it('numbers the options and takes the whole selection in one answer', async () => {
    const asked: string[] = [];
    const prompter = scriptedPrompter(['u', 'p', '1', 'all'], asked);
    const out = new Sink();

    const conf = await runConfigure({ stages: CREDENTIAL_STAGES, channels, prompter, out });

    expect(out.text).toContain('  1) one.example.tv — One');
    expect(out.text).toContain('  2) two.example.tv — Two');
    expect(asked).toContain('Select [1-2, ranges like 2-7, all, none] ');
    expect(conf?.channel).toEqual(['one.example.tv', 'two.example.tv']);
    expect(conf?.no_channel).toBeUndefined();
  });

  it('re-asks until a select-many answer is understood', async () => {
    const asked: string[] = [];
    const prompter = scriptedPrompter(['u', 'p', '1', 'maybe', '2'], asked);
    const out = new Sink();

    const conf = await runConfigure({ stages: CREDENTIAL_STAGES, channels, prompter, out });

    expect(out.text).toContain('Enter numbers or ranges between 1 and 2, or all, or none.');
    expect(asked.filter((q) => q.startsWith('Select ['))).toHaveLength(2);
    expect(conf?.channel).toEqual(['two.example.tv']);
  });

  it('records a constant without asking', async () => {
    const asked: string[] = [];
    const prompter = scriptedPrompter(['all'], asked);
    const out = new Sink();

    const conf = await runConfigure({
      stages: [
        {
          name: 'start',
          next: 'select-channels',
          fields: [{ type: 'string', id: 'api', title: 'API', description: 'D', constant: 'v3' }],
        },
      ],
      channels,
      prompter,
      out,
    });

    expect(conf?.api).toEqual(['v3']);
    expect(asked.some((q) => q.startsWith('API'))).toBe(false);
  });

  it('selects everything when the input is not a terminal', async () => {
    const prompter = { ...scriptedPrompter([]), interactive: false };
    const out = new Sink();

    const conf = await runConfigure({
      stages: [{ name: 'start', next: 'select-channels', fields: [] }],
      channels,
      prompter,
      out,
    });

    expect(conf?.channel).toEqual(['one.example.tv', 'two.example.tv']);
    expect(out.text).toContain('not a terminal');
  });
});

describe('--configure-api', () => {
  it('prints the start stage by default', async () => {
    const dir = await tempDir();
    const stdout = new Sink();
    const stderr = new Sink();

    const code = await runXmltvGrabber(config(dir), {
      ...META,
      stages: CREDENTIAL_STAGES,
      argv: ['--configure-api', '--config-file', join(dir, 'g.conf')],
      stdout,
      stderr,
    });

    expect(code).toBe(0);
    expect(stdout.text).toContain('<xmltvconfiguration grabber="tv_grab_sk_example">');
    expect(stdout.text).toContain('<string id="username">');
    expect(stdout.text).toContain('<nextstage stage="region" />');
  });

  it('prints a named stage', async () => {
    const dir = await tempDir();
    const configFile = join(dir, 'g.conf');
    await saveGrabberConfig(configFile, { username: ['m'] });

    const stdout = new Sink();
    const code = await runXmltvGrabber(config(dir), {
      ...META,
      stages: CREDENTIAL_STAGES,
      argv: ['--configure-api', '--stage', 'region', '--config-file', configFile],
      stdout,
      stderr: new Sink(),
    });

    expect(code).toBe(0);
    expect(stdout.text).toContain('<selectone id="region" default="west">');
  });

  it("builds the select-channels stage from the grabber's channels", async () => {
    const dir = await tempDir();
    const configFile = join(dir, 'g.conf');
    await saveGrabberConfig(configFile, { username: ['m'] });

    const stdout = new Sink();
    await runXmltvGrabber(
      config(dir, { sites: [site('one.example.tv'), site('two.example.tv')] }),
      {
        ...META,
        argv: ['--configure-api', '--stage', 'select-channels', '--config-file', configFile],
        stdout,
        stderr: new Sink(),
      },
    );

    expect(stdout.text).toContain('<selectmany id="channel">');
    expect(stdout.text).toContain('<option value="one.example.tv">');
    expect(stdout.text).toContain('<option value="two.example.tv">');
  });

  it('refuses a non-start stage before any configuration exists', async () => {
    const dir = await tempDir();
    const stderr = new Sink();

    const code = await runXmltvGrabber(config(dir), {
      ...META,
      stages: CREDENTIAL_STAGES,
      argv: ['--configure-api', '--stage', 'region', '--config-file', join(dir, 'missing.conf')],
      stdout: new Sink(),
      stderr,
    });

    expect(code).toBe(1);
    expect(stderr.text).toBe("You need to start configuration with the 'start' stage.\n");
  });

  it('rejects a stage that does not exist', async () => {
    const dir = await tempDir();
    const configFile = join(dir, 'g.conf');
    // A configuration must exist, or the earlier "start with 'start'" guard fires.
    await saveGrabberConfig(configFile, { username: ['m'] });

    const stderr = new Sink();

    const code = await runXmltvGrabber(config(dir), {
      ...META,
      argv: ['--configure-api', '--stage', 'nope', '--config-file', configFile],
      stdout: new Sink(),
      stderr,
    });

    expect(code).toBe(1);
    expect(stderr.text).toContain("Unknown configuration stage 'nope'");
  });

  it('writes to --output when asked', async () => {
    const dir = await tempDir();
    const file = join(dir, 'stage.xml');
    const stdout = new Sink();

    await runXmltvGrabber(config(dir), {
      ...META,
      argv: ['--configure-api', '--config-file', join(dir, 'g.conf'), '--output', file],
      stdout,
      stderr: new Sink(),
    });

    expect(stdout.text).toBe('');
    expect(await readFile(file, 'utf8')).toContain('<xmltvconfiguration');
  });
});

describe('--list-channels', () => {
  it('lists channels and no programmes', async () => {
    const dir = await tempDir();
    const configFile = await configured(dir);

    const { code, stdout } = await run(
      config(dir, { sites: [site('one.example.tv'), site('two.example.tv')] }),
      ['--list-channels', '--config-file', configFile],
    );

    expect(code).toBe(0);
    expect(stdout).toContain('<channel id="one.example.tv">');
    expect(stdout).toContain('<channel id="two.example.tv">');
    expect(stdout).not.toContain('<programme');
  });

  it('lists every channel, not just the configured ones', async () => {
    // The caller uses this to *offer* a choice, so a selection must not narrow it.
    const dir = await tempDir();
    const configFile = join(dir, 'g.conf');
    await saveGrabberConfig(configFile, { channel: ['one.example.tv'] });

    const { stdout } = await run(
      config(dir, { sites: [site('one.example.tv'), site('two.example.tv')] }),
      ['--list-channels', '--config-file', configFile],
    );

    expect(stdout).toContain('two.example.tv');
  });

  it('refuses without a configuration', async () => {
    const dir = await tempDir();

    const { code, stderr } = await run(config(dir), [
      '--list-channels',
      '--config-file',
      join(dir, 'missing.conf'),
    ]);

    expect(code).toBe(1);
    expect(stderr).toBe('You need to configure the grabber before you can list the channels.\n');
  });

  it('merges a channel covered by several sites into one element', async () => {
    const dir = await tempDir();
    const configFile = await configured(dir);
    const withLogo: SiteConfig<unknown> = {
      ...site('one.example.tv'),
      site: 'other.tv',
      channels: [
        { xmltvId: 'one.example.tv', siteId: '9', name: 'Alias', logo: 'https://x/l.png' },
      ],
    };

    const { stdout } = await run(config(dir, { sites: [site('one.example.tv'), withLogo] }), [
      '--list-channels',
      '--config-file',
      configFile,
    ]);

    expect([...stdout.matchAll(/<channel /g)]).toHaveLength(1);
    expect(stdout).toContain('Channel one.example.tv');
    expect(stdout).toContain('Alias');
    expect(stdout).toContain('https://x/l.png');
  });

  it('is exposed directly as listChannelsXml', async () => {
    const xml = await listChannelsXml({ sites: [site('one.example.tv')], output: 'x' });

    expect(xml).toContain('<!DOCTYPE tv SYSTEM "xmltv.dtd">');
    expect(xml).toContain('<channel id="one.example.tv">');
    expect(xml.trimEnd().endsWith('</tv>')).toBe(true);
  });
});

describe('grabbing', () => {
  it('exits 130 and writes nothing when the run is cancelled', async () => {
    const dir = await tempDir();
    const configFile = await configured(dir);
    const controller = new AbortController();
    const output = join(dir, 'guide.xml');
    const stdout = new Sink();
    const stderr = new Sink();

    const cancelling: SiteConfig<unknown> = {
      ...site('one.example.tv'),
      async request({ day }) {
        controller.abort(new Error('SIGTERM received'));
        return { day };
      },
    };

    const code = await runXmltvGrabber(config(dir, { sites: [cancelling] }), {
      ...META,
      argv: ['--config-file', configFile, '--output', output],
      stdout,
      stderr,
      signal: controller.signal,
    });

    expect(code).toBe(130);
    expect(stderr.text).toContain('cancelled');
    // A consumer reads whatever arrives as the whole guide, so half a document
    // would be taken for one.
    expect(stdout.text).toBe('');
    await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('writes the guide into a socket, as tvheadend listens for it', async () => {
    const dir = await tempDir();
    const configFile = await configured(dir);
    const socketPath = join(dir, 'xmltv.sock');

    // What tvheadend's External XMLTV module does: listen, read to the end,
    // parse what arrived.
    const received: string[] = [];
    const server = createServer((socket) => {
      const chunks: string[] = [];
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => chunks.push(chunk));
      socket.on('end', () => received.push(chunks.join('')));
    });

    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    try {
      const { code } = await run(config(dir), [
        '--config-file',
        configFile,
        '--quiet',
        '--output',
        socketPath,
      ]);

      expect(code).toBe(0);
      // The reader only gets to parse because the writer closed.
      await vi.waitFor(() => expect(received).toHaveLength(1));
      expect(received[0]).toContain('<channel id="one.example.tv">');
      expect(received[0]?.endsWith('</tv>')).toBe(true);
      // Nothing was written beside it: the path is a socket, not a name to take.
      expect((await stat(socketPath)).isSocket()).toBe(true);

      // Byte for byte what stdout would have carried.
      const viaStdout = await run(config(dir), ['--config-file', configFile, '--quiet']);
      expect(received[0]).toBe(viaStdout.stdout);
    } finally {
      server.close();
    }
  });

  it('fails with one line when nothing is listening on the socket', async () => {
    const dir = await tempDir();
    const configFile = await configured(dir);
    const socketPath = join(dir, 'dead.sock');

    // A socket left behind by a listener that died — Node unlinks the path on
    // an orderly close, so the owner has to be killed for the file to stay.
    // It still stats as a socket, so the failure can only come from connecting.
    const child = spawn(process.execPath, [
      '-e',
      `require('net').createServer().listen(${JSON.stringify(socketPath)}, () => console.log('up'))`,
    ]);

    await once(child.stdout, 'data');
    child.kill('SIGKILL');
    await once(child, 'exit');

    expect((await stat(socketPath)).isSocket()).toBe(true);

    const { code, stderr } = await run(config(dir), [
      '--config-file',
      configFile,
      '--quiet',
      '--output',
      socketPath,
    ]);

    expect(code).toBe(1);
    expect(stderr).toBe(`Cannot write to socket ${socketPath}: nothing is listening on it\n`);
  });

  it('writes the guide to stdout', async () => {
    const dir = await tempDir();
    const configFile = await configured(dir);

    const { code, stdout } = await run(config(dir), ['--config-file', configFile, '--quiet']);

    expect(code).toBe(0);
    expect(stdout.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(stdout).toContain('<!DOCTYPE tv SYSTEM "xmltv.dtd">');
    expect(stdout.trimEnd().endsWith('</tv>')).toBe(true);
    expect(stdout.indexOf('<channel')).toBeLessThan(stdout.indexOf('<programme'));
  });

  it('produces identical output through --output and through stdout', async () => {
    // ValidateGrabber reports `outputdiffers` when these disagree.
    const dir = await tempDir();
    const configFile = await configured(dir);
    const file = join(dir, 'out.xml');

    const viaStdout = await run(config(dir), ['--config-file', configFile, '--quiet']);
    const viaFile = await run(config(dir), [
      '--config-file',
      configFile,
      '--quiet',
      '--output',
      file,
    ]);

    expect(viaFile.code).toBe(0);
    expect(viaFile.stdout).toBe('');
    expect(viaStdout.stdout).toContain('<programme');
    expect(await readFile(file, 'utf8')).toBe(viaStdout.stdout);
  });

  it('says nothing on stderr under --quiet', async () => {
    // ValidateGrabber reports `notquiet` for any stderr output at all.
    const dir = await tempDir();
    const configFile = await configured(dir);

    const { stderr } = await run(config(dir), ['--config-file', configFile, '--quiet']);

    expect(stderr).toBe('');
  });

  it('honours --days and --offset', async () => {
    const dir = await tempDir();
    const configFile = await configured(dir);
    const fetchedDays: string[] = [];

    const { stdout } = await run(config(dir, { sites: [site('one.example.tv', fetchedDays)] }), [
      '--config-file',
      configFile,
      '--days',
      '2',
      '--offset',
      '1',
      '--quiet',
    ]);

    expect(fetchedDays).toHaveLength(2);
    expect(stdout).toContain(`start="${fetchedDays[0]?.replace(/-/g, '')}060000`);
    expect(stdout).not.toContain('<programme start="20260717');
  });

  it('accepts a negative offset in the separated form', async () => {
    const dir = await tempDir();
    const configFile = await configured(dir);
    const fetchedDays: string[] = [];

    const { code } = await run(config(dir, { sites: [site('one.example.tv', fetchedDays)] }), [
      '--config-file',
      configFile,
      '--offset',
      '-1',
      '--quiet',
    ]);

    expect(code).toBe(0);
    expect(fetchedDays).toHaveLength(1);
  });

  it('is additive: two one-day runs cover the same span as one two-day run', async () => {
    // ValidateGrabber reports `notadditive` when they disagree.
    const dir = await tempDir();
    const configFile = await configured(dir);
    const epg = config(dir);
    const args = ['--config-file', configFile, '--quiet'];

    const both = await run(epg, [...args, '--offset', '1', '--days', '2']);
    const first = await run(epg, [...args, '--offset', '1', '--days', '1']);
    const second = await run(epg, [...args, '--offset', '2', '--days', '1']);

    const starts = (xml: string): string[] =>
      [...xml.matchAll(/<programme start="([^"]+)"/g)].map((m) => m[1] as string);

    expect(starts(both.stdout)).toHaveLength(2);
    expect([...starts(first.stdout), ...starts(second.stdout)].sort()).toEqual(
      starts(both.stdout).sort(),
    );
  });

  it('reports a failed channel-day on stderr and exits 1, even under --quiet', async () => {
    const dir = await tempDir();
    const configFile = await configured(dir);

    const { code, stderr } = await run(
      config(dir, {
        sites: [
          {
            ...site('one.example.tv'),
            async request() {
              throw new Error('upstream is down');
            },
          },
        ],
      }),
      ['--config-file', configFile, '--quiet'],
    );

    expect(code).toBe(1);
    expect(stderr).toContain('upstream is down');
  });

  it('--cache redirects the cache directory, and bare --cache leaves it alone', async () => {
    const dir = await tempDir();
    const configFile = await configured(dir);
    const elsewhere = join(dir, 'elsewhere');

    await run(config(dir), ['--config-file', configFile, '--quiet', '--cache', elsewhere]);

    const cached = await readFile(
      join(elsewhere, 'example.tv', 'one.example.tv', '2026-07-17.ndjson'),
      'utf8',
    );
    expect(cached).toContain('p-2026-07-17');

    // Bare --cache is XMLTV's `cache:s` form: accepted, and means "as configured".
    const { code } = await run(config(dir), ['--config-file', configFile, '--quiet', '--cache']);
    expect(code).toBe(0);
  });

  it('--no-cache still produces a guide but leaves nothing on disk', async () => {
    const dir = await tempDir();
    const configFile = await configured(dir);
    const cacheDir = join(dir, 'cache');

    const { code, stdout } = await run(config(dir), [
      '--config-file',
      configFile,
      '--quiet',
      '--no-cache',
    ]);

    expect(code).toBe(0);
    expect(stdout).toContain('<programme');
    await expect(
      readFile(join(cacheDir, 'example.tv', 'one.example.tv', '2026-07-17.ndjson'), 'utf8'),
    ).rejects.toThrow();
  });

  it('--no-cache refetches every day instead of serving a warm cache', async () => {
    const dir = await tempDir();
    const configFile = await configured(dir);
    const fetchedDays: string[] = [];
    const epg = config(dir, { sites: [site('one.example.tv', fetchedDays)] });
    const args = ['--config-file', configFile, '--quiet'];

    await run(epg, args);
    expect(fetchedDays).toHaveLength(1);

    // A warm cache would skip this day; a scratch cache cannot.
    await run(epg, [...args, '--no-cache']);
    expect(fetchedDays).toHaveLength(2);
  });
});

const LINEUPS: LineupConfig[] = [
  {
    id: 'cable',
    type: 'List',
    displayName: [{ value: 'Cable', lang: 'en' }],
    entries: [{ station: { xmltvId: 'one.example.tv', name: 'One' }, preset: '1' }],
  },
  {
    id: 'terrestrial',
    type: 'DTV',
    displayName: [{ value: 'Digital terrestrial' }],
    entries: [{ station: { xmltvId: 'two.example.tv', name: 'Two' }, preset: '2' }],
  },
];

/** One site carrying both channels, so a lineup can pick between them. */
function lineupConfig(dir: string): EpgConfig {
  return config(dir, {
    sites: [
      {
        ...site('one.example.tv'),
        channels: [
          { xmltvId: 'one.example.tv', siteId: '1', name: 'One', preset: '1' },
          { xmltvId: 'two.example.tv', siteId: '2', name: 'Two', preset: '2' },
        ],
      },
    ],
  });
}

function withLineups(
  dir: string,
  source: LineupSource = LINEUPS,
): { config: EpgConfig; options: typeof META & { capabilities: CapabilityEntry[] } } {
  return {
    config: lineupConfig(dir),
    options: { ...META, capabilities: [...DEFAULT_CAPABILITIES, lineupsCapability(source)] },
  };
}

describe('lineups', () => {
  it('is advertised only when the grabber declares lineups', async () => {
    const dir = await tempDir();
    const { config: epg, options } = withLineups(dir);

    const advertised = new Sink();
    await runXmltvGrabber(epg, {
      ...options,
      argv: ['--capabilities'],
      stdout: advertised,
      stderr: new Sink(),
    });
    expect(advertised.text.trimEnd().split('\n')).toContain('lineups');

    // Without the capability the options do not exist at all, which is what
    // %cap_options does in the reference: an unadvertised feature is not a
    // flag that quietly does nothing.
    const plain = await run(epg, ['--capabilities']);
    expect(plain.stdout).not.toContain('lineups');

    const rejected = await run(epg, ['--list-lineups']);
    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toContain(`Unknown option '--list-lineups'`);
  });

  it('lists them with no configuration file anywhere', async () => {
    const dir = await tempDir();
    const { config: epg, options } = withLineups(dir);
    const stdout = new Sink();

    const code = await runXmltvGrabber(epg, {
      ...options,
      // Deliberately a path that does not exist: choosing a lineup is what a
      // caller does *before* configuring, so it cannot need a configuration.
      argv: ['--list-lineups', '--config-file', join(dir, 'missing.conf')],
      stdout,
      stderr: new Sink(),
    });

    expect(code).toBe(0);
    expect(stdout.text).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<xmltv-lineups>\n' +
        '  <xmltv-lineup id="cable">\n' +
        '    <type>List</type>\n' +
        '    <display-name lang="en">Cable</display-name>\n' +
        '    <lineup-entry>\n' +
        '      <preset>1</preset>\n' +
        '      <station rfc2838="one.example.tv">\n' +
        '        <name>One</name>\n' +
        '      </station>\n' +
        '    </lineup-entry>\n' +
        '  </xmltv-lineup>\n' +
        '  <xmltv-lineup id="terrestrial">\n' +
        '    <type>DTV</type>\n' +
        '    <display-name>Digital terrestrial</display-name>\n' +
        '    <lineup-entry>\n' +
        '      <preset>2</preset>\n' +
        '      <station rfc2838="two.example.tv">\n' +
        '        <name>Two</name>\n' +
        '      </station>\n' +
        '    </lineup-entry>\n' +
        '  </xmltv-lineup>\n' +
        '</xmltv-lineups>\n',
    );
  });

  it('honours --output, as every document-producing option does', async () => {
    const dir = await tempDir();
    const { config: epg, options } = withLineups(dir);
    const file = join(dir, 'lineups.xml');
    const stdout = new Sink();

    await runXmltvGrabber(epg, {
      ...options,
      argv: ['--list-lineups', '--output', file],
      stdout,
      stderr: new Sink(),
    });

    expect(stdout.text).toBe('');
    expect(await readFile(file, 'utf8')).toContain('<xmltv-lineup id="cable">');
  });

  it('prints the configured one for --get-lineup, and says what is missing', async () => {
    const dir = await tempDir();
    const { config: epg, options } = withLineups(dir);
    const configFile = join(dir, 'lineup.conf');

    const missing = new Sink();
    expect(
      await runXmltvGrabber(epg, {
        ...options,
        argv: ['--get-lineup', '--config-file', join(dir, 'nothing.conf')],
        stdout: new Sink(),
        stderr: missing,
      }),
    ).toBe(1);
    expect(missing.text).toBe(
      'You need to configure the grabber before you can output your chosen lineup.\n',
    );

    await saveGrabberConfig(configFile, { lineup: ['terrestrial'] });
    const stdout = new Sink();

    expect(
      await runXmltvGrabber(epg, {
        ...options,
        argv: ['--get-lineup', '--config-file', configFile],
        stdout,
        stderr: new Sink(),
      }),
    ).toBe(0);

    expect(stdout.text).toContain('<xmltv-lineup id="terrestrial">');
    expect(stdout.text).not.toContain('id="cable"');

    // A configuration written when the offer was different.
    await saveGrabberConfig(configFile, { lineup: ['gone'] });
    const stale = new Sink();

    expect(
      await runXmltvGrabber(epg, {
        ...options,
        argv: ['--get-lineup', '--config-file', configFile],
        stdout: new Sink(),
        stderr: stale,
      }),
    ).toBe(1);
    expect(stale.text).toBe('Configured lineup "gone" is not one this grabber offers\n');
  });

  it('asks which lineup last, and finishes without offering channels', async () => {
    const dir = await tempDir();
    const { config: epg, options } = withLineups(dir);

    // The stage the capability added is now what `start` leads to.
    const start = new Sink();
    await runXmltvGrabber(epg, {
      ...options,
      argv: ['--configure-api'],
      stdout: start,
      stderr: new Sink(),
    });
    expect(start.text).toContain('<nextstage stage="lineup" />');

    // A stage other than the first is only printed once configuration has
    // begun, so there has to be something to have begun it.
    const configFile = join(dir, 'partial.conf');
    await saveGrabberConfig(configFile, { username: ['mattias'] });

    const stage = new Sink();
    await runXmltvGrabber(epg, {
      ...options,
      argv: ['--configure-api', '--stage', 'lineup', '--config-file', configFile],
      stdout: stage,
      stderr: new Sink(),
    });

    expect(stage.text).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<xmltvconfiguration grabber="tv_grab_sk_example">\n' +
        '  <selectone id="lineup">\n' +
        '    <title lang="en">Lineup</title>\n' +
        '    <description lang="en">Which lineup to grab. Its channels are then grabbed as a set.' +
        '</description>\n' +
        '    <option value="cable">\n' +
        '      <text lang="en">Cable</text>\n' +
        '    </option>\n' +
        '    <option value="terrestrial">\n' +
        '      <text lang="en">Digital terrestrial</text>\n' +
        '    </option>\n' +
        '  </selectone>\n' +
        // Not select-channels: the lineup is the channel selection, so this is
        // where configuration ends.
        '  <nextstage stage="end" />\n' +
        '</xmltvconfiguration>\n',
    );
  });

  it('records a single lineup without asking about it', async () => {
    const dir = await tempDir();
    const { config: epg, options } = withLineups(dir, [LINEUPS[0] as LineupConfig]);
    const configFile = join(dir, 'partial.conf');
    await saveGrabberConfig(configFile, { username: ['mattias'] });

    const stage = new Sink();
    await runXmltvGrabber(epg, {
      ...options,
      argv: ['--configure-api', '--stage', 'lineup', '--config-file', configFile],
      stdout: stage,
      stderr: new Sink(),
    });

    // There is nothing to choose between, but the answer still has to be
    // written down — which is exactly what a constant field is for.
    expect(stage.text).toContain('<string id="lineup" constant="cable">');
  });

  it('asks the question in --configure too, and skips channel selection', async () => {
    const dir = await tempDir();
    const { config: epg, options } = withLineups(dir);
    const configFile = join(dir, 'lineup.conf');
    const prompter = scriptedPrompter(['2']);
    const out = new Sink();

    const conf = await runConfigure({
      stages: [
        { name: 'start', fields: [], next: 'lineup' },
        {
          name: 'lineup',
          next: 'end',
          fields: [
            {
              type: 'selectone',
              id: 'lineup',
              title: 'Lineup',
              description: 'Which lineup to grab.',
              options: LINEUPS.map((lineup) => ({ value: lineup.id, text: lineup.id })),
            },
          ],
        },
      ],
      channels: async () => {
        throw new Error('channel selection must not be reached');
      },
      prompter,
      out,
    });

    expect(conf).toEqual({ lineup: ['terrestrial'] });
    expect(out.text).not.toContain('Select the channels');

    // End to end: the walk, the file it writes, and what it does not write.
    const stderr = new Sink();
    expect(
      await runXmltvGrabber(epg, {
        ...options,
        argv: ['--configure', '--config-file', configFile],
        stdout: new Sink(),
        stderr,
        // Nothing to answer with, so the question takes its first option — and
        // the point of the case is what happens *after* it: no channel
        // selection, and a file naming only the lineup.
        stdin: Readable.from([]),
      }),
    ).toBe(0);

    expect(await readFile(configFile, 'utf8')).toBe('lineup=cable\n');
  });

  it("grabs the lineup's channels instead of a per-channel selection", async () => {
    const dir = await tempDir();
    const { config: epg, options } = withLineups(dir);
    const configFile = join(dir, 'lineup.conf');

    await saveGrabberConfig(configFile, { lineup: ['terrestrial'] });
    const stdout = new Sink();
    const stderr = new Sink();

    expect(
      await runXmltvGrabber(epg, {
        ...options,
        argv: ['--days', '1', '--config-file', configFile],
        stdout,
        stderr,
      }),
    ).toBe(0);

    expect(stdout.text).toContain('<channel id="two.example.tv">');
    expect(stdout.text).not.toContain('<channel id="one.example.tv">');
    // And nothing reports the channels it did not ask about as new: the
    // configuration names none by hand, because the lineup names them all.
    expect(stderr.text).not.toContain('New channel(s)');
  });

  it('leaves a configuration that names its channels alone', async () => {
    const dir = await tempDir();
    const { config: epg, options } = withLineups(dir);
    const configFile = join(dir, 'channels.conf');

    // Configured before this grabber offered lineups: still per-channel.
    await saveGrabberConfig(configFile, { channel: ['one.example.tv'] });
    const stdout = new Sink();

    expect(
      await runXmltvGrabber(epg, {
        ...options,
        argv: ['--days', '1', '--config-file', configFile],
        stdout,
        stderr: new Sink(),
      }),
    ).toBe(0);

    expect(stdout.text).toContain('<channel id="one.example.tv">');
    expect(stdout.text).not.toContain('<channel id="two.example.tv">');
  });
});

describe('lineup documents', () => {
  it('writes every element in the order the schema demands', () => {
    const xml = serializeLineups(
      [
        {
          id: 'full',
          type: 'DTV',
          displayName: [
            { value: 'Everything', lang: 'en' },
            { value: 'Všetko', lang: 'sk' },
          ],
          logo: [{ url: 'https://example.tv/l.png', width: 64, height: 32 }],
          availability: [{ value: 'SK', area: 'country' }],
          entries: [
            {
              // Deliberately written in an order the schema does not allow, to show
              // the output is the schema's order and not the object's.
              analog: [
                {
                  system: 'PAL-B/G',
                  number: 'E7',
                  frequency: 189250,
                  fccCallsign: 'KTLA',
                  cni: '0x4101',
                },
              ],
              station: {
                xmltvId: 'one.example.tv',
                name: 'One & Only',
                shortName: 'One',
                lang: 'en',
                logo: [{ url: 'https://example.tv/one.png' }],
                type: 'TV',
                commercialFree: false,
                video: { format: 'HDTV', aspectRatio: '16:9' },
                audio: { format: 'stereo' },
              },
              availability: [{ value: 'West', area: 'region' }],
              packages: [{ value: 'Basic', type: 'subscription' }],
              section: 'Entertainment',
              preset: '1',
            },
          ],
        },
      ],
      { generatorInfoName: 'epg-tools', modified: '20260717120000 +0000' },
    );

    expect(xml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<xmltv-lineups modified="20260717120000 +0000" generator-info-name="epg-tools">\n' +
        '  <xmltv-lineup id="full">\n' +
        '    <type>DTV</type>\n' +
        '    <display-name lang="en">Everything</display-name>\n' +
        '    <display-name lang="sk">Všetko</display-name>\n' +
        '    <logo url="https://example.tv/l.png" height="32" width="64" />\n' +
        '    <availability area="country">SK</availability>\n' +
        '    <lineup-entry>\n' +
        '      <preset>1</preset>\n' +
        '      <section>Entertainment</section>\n' +
        '      <package type="subscription">Basic</package>\n' +
        '      <availability area="region">West</availability>\n' +
        '      <station rfc2838="one.example.tv" type="TV">\n' +
        '        <name lang="en">One &amp; Only</name>\n' +
        '        <short-name lang="en">One</short-name>\n' +
        '        <logo url="https://example.tv/one.png" />\n' +
        '        <commercial-free>false</commercial-free>\n' +
        '        <video>\n' +
        '          <format>HDTV</format>\n' +
        '          <aspect-ratio>16:9</aspect-ratio>\n' +
        '        </video>\n' +
        '        <audio>\n' +
        '          <format>stereo</format>\n' +
        '        </audio>\n' +
        '      </station>\n' +
        '      <analog-channel>\n' +
        '        <system>PAL-B/G</system>\n' +
        '        <number>E7</number>\n' +
        '        <frequency>189250</frequency>\n' +
        '        <fcc-callsign>KTLA</fcc-callsign>\n' +
        '        <cni tt-8-30-1="0x4101" />\n' +
        '      </analog-channel>\n' +
        '    </lineup-entry>\n' +
        '  </xmltv-lineup>\n' +
        '</xmltv-lineups>\n',
    );
  });

  it('writes each kind of delivery', () => {
    const xml = serializeLineups([
      {
        id: 'mixed',
        type: 'DTV',
        displayName: [{ value: 'Mixed' }],
        entries: [
          {
            station: { xmltvId: 'dvb.example.tv' },
            dvb: [
              {
                originalNetworkId: 8442,
                transportId: 2049,
                serviceId: 4351,
                lcn: '3',
                serviceName: 'Three',
                providerName: 'Example',
                encrypted: true,
              },
            ],
          },
          { station: { xmltvId: 'stb.example.tv' }, stb: [{ preset: '101' }] },
          {
            station: { xmltvId: 'iptv.example.tv' },
            iptv: [{ url: 'udp://239.0.0.1', port: 1234 }],
          },
        ],
      },
    ]);

    // A station with no name of its own is named by its id, which the schema
    // requires and is the only thing certain to be there.
    expect(xml).toContain('<name>dvb.example.tv</name>');
    expect(xml).toContain(
      '      <dvb-channel>\n' +
        '        <original-network-id>8442</original-network-id>\n' +
        '        <transport-id>2049</transport-id>\n' +
        '        <service-id>4351</service-id>\n' +
        '        <lcn>3</lcn>\n' +
        '        <service-name>Three</service-name>\n' +
        '        <provider-name>Example</provider-name>\n' +
        '        <encrypted>true</encrypted>\n' +
        '      </dvb-channel>\n',
    );
    expect(xml).toContain('<stb-channel>\n        <stb-preset>101</stb-preset>\n');
    expect(xml).toContain('<iptv-url>udp://239.0.0.1</iptv-url>\n        <port>1234</port>\n');
  });

  it('refuses an entry delivered two ways at once', () => {
    // An xs:choice — a document with both would be rejected by anything that
    // validates it, so it is refused where it is written.
    expect(() =>
      serializeLineups([
        {
          id: 'both',
          type: 'DTV',
          displayName: [{ value: 'Both' }],
          entries: [
            {
              station: { xmltvId: 'one.example.tv' },
              dvb: [{ originalNetworkId: 1, serviceId: 2 }],
              iptv: [{ url: 'udp://239.0.0.1', port: 1234 }],
            },
          ],
        },
      ]),
    ).toThrow(/entry for "one.example.tv" describes dvb and iptv delivery/);
  });

  it('builds one list lineup per site', async () => {
    const dir = await tempDir();
    const lineups = await lineupsFromSites(lineupConfig(dir), { lang: 'sk' });

    expect(lineups).toEqual([
      {
        id: 'example.tv',
        type: 'List',
        displayName: [{ value: 'example.tv', lang: 'sk' }],
        entries: [
          { station: { xmltvId: 'one.example.tv', name: 'One', lang: 'sk' }, preset: '1' },
          { station: { xmltvId: 'two.example.tv', name: 'Two', lang: 'sk' }, preset: '2' },
        ],
      },
    ]);
  });
});

const xmllintAvailable = (() => {
  try {
    execFileSync('xmllint', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!xmllintAvailable)(
  'lineup schema validity (xmllint against xmltv-lineups.xsd)',
  () => {
    it('what --list-lineups prints validates against the official schema', async () => {
      const dir = await tempDir();
      const file = join(dir, 'lineups.xml');
      const { config: epg, options } = withLineups(dir, [
        {
          id: 'terrestrial',
          type: 'DTV',
          displayName: [{ value: 'Digital terrestrial', lang: 'en' }],
          logo: [{ url: 'https://example.tv/l.png', width: 64, height: 32 }],
          availability: [{ value: 'SK', area: 'country' }],
          entries: [
            {
              preset: '1',
              section: 'Entertainment',
              packages: [{ value: 'Basic', type: 'subscription' }],
              availability: [{ value: 'West', area: 'region' }],
              station: {
                xmltvId: 'one.example.tv',
                name: 'One',
                shortName: '1',
                lang: 'en',
                logo: [{ url: 'https://example.tv/one.png' }],
                type: 'TV',
                commercialFree: true,
                video: { format: 'HDTV', aspectRatio: '16:9' },
                audio: { format: 'stereo' },
              },
              dvb: [{ originalNetworkId: 8442, transportId: 2049, serviceId: 4351, lcn: '1' }],
            },
          ],
        },
        {
          id: 'analogue',
          type: 'Analog',
          displayName: [{ value: 'Analogue' }],
          entries: [
            {
              station: { xmltvId: 'two.example.tv' },
              analog: [{ system: 'PAL-B/G', number: 'E7', frequency: 189250, cni: '0x4101' }],
            },
          ],
        },
        {
          id: 'streams',
          type: 'IPTV',
          displayName: [{ value: 'Streams' }],
          entries: [
            {
              station: { xmltvId: 'three.example.tv' },
              iptv: [{ url: 'udp://239.0.0.1', port: 1234 }],
            },
            { station: { xmltvId: 'four.example.tv' }, stb: [{ preset: '101' }] },
          ],
        },
      ]);

      await runXmltvGrabber(epg, {
        ...options,
        argv: ['--list-lineups', '--output', file],
        stdout: new Sink(),
        stderr: new Sink(),
      });

      const schema = join(import.meta.dirname, 'fixtures', 'xmltv-lineups.xsd');

      expect(() =>
        execFileSync('xmllint', ['--noout', '--schema', schema, file], {
          encoding: 'utf8',
          stdio: 'pipe',
        }),
      ).not.toThrow();
    });
  },
);
