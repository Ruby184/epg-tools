/**
 * A fake grabber the test drives, rather than one it configures.
 *
 * The adapter spawns a *program*, so the program cannot be a worker thread —
 * there is no argv and no exit code in one, and the exit code is what most of
 * these tests are about. What it can be is a program that asks somebody what to
 * do: `fake-grabber.mjs` dials this socket, says what it was called with, and
 * does what comes back.
 *
 * Which buys the two things environment flags cannot:
 *
 * - **invocations are recorded live**, in memory, so counting runs needs no
 *   temp file and no polling;
 * - **each invocation can be answered differently**, so "the second stretch
 *   fails" or "it says `allatonce` only after the first run" is a line of test
 *   rather than a flag the program has to interpret.
 *
 * The program keeps its flags for when nothing is listening — the `epg try`
 * example config, and a hand-run in a shell.
 */

import { createServer, type Server } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** What the program is told to do with one invocation. */
export interface Instruction {
  /** Written to stdout, whole, before anything else happens. */
  write?: string;
  /** Written to stderr first, as a grabber says what it is doing. */
  stderr?: string;
  /** What to exit with. `0` unless something says otherwise. */
  exit?: number;
  /** Stay up instead of exiting, with stdout left open. */
  hang?: boolean;
}

/** One invocation, as the program reported it. */
export interface Invocation {
  argv: string[];
  /** The whole argument list, for a test that would rather match on one string. */
  said: string;
}

export interface Control {
  /** Where the program is told to dial: pass as `env.FAKE_CONTROL`. */
  path: string;
  /** Every invocation so far, in order, recorded as it happened. */
  invocations: Invocation[];
  /** The argument lists only, which is what most assertions want. */
  readonly said: string[];
  /** Answer each invocation. The default answers by what was asked for. */
  answer: (reply: (invocation: Invocation) => Instruction) => void;
  close: () => Promise<void>;
}

/** Today and the days after it, as XMLTV writes a time. */
function at(dayOffset: number, hour: number): string {
  const day = new Date(Date.now() + dayOffset * 86_400_000);
  const pad = (value: number) => String(value).padStart(2, '0');

  return (
    `${String(day.getUTCFullYear())}${pad(day.getUTCMonth() + 1)}${pad(day.getUTCDate())}` +
    `${pad(hour)}0000 +0000`
  );
}

const channelElement = (id: string, name: string) =>
  `  <channel id="${id}">\n    <display-name>${name}</display-name>\n  </channel>\n`;

const programmeElement = (id: string, dayOffset: number, hour: number, title: string) =>
  `  <programme start="${at(dayOffset, hour)}" stop="${at(dayOffset, hour + 1)}" channel="${id}">\n` +
  `    <title>${title}</title>\n  </programme>\n`;

/** The two channels every document here declares. */
export const CHANNELS = ['one.example', 'two.example'] as const;

/** A document: both channels, and a programme each on every day asked for. */
export function document(options: { days?: readonly number[] } = {}): string {
  const days = options.days ?? [0];

  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n' +
    channelElement('one.example', 'One') +
    channelElement('two.example', 'Two') +
    days
      .map(
        (day) =>
          programmeElement('one.example', day, 10, `First on ${String(day)}`) +
          programmeElement('two.example', day, 11, `Second on ${String(day)}`),
      )
      .join('') +
    '</tv>\n'
  );
}

/** The channel list on its own, which is what `--list-channels` answers. */
export function channelsOnly(): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n' +
    channelElement('one.example', 'One') +
    channelElement('two.example', 'Two') +
    '</tv>\n'
  );
}

/**
 * A document that stops part way through, as a dying program leaves one.
 *
 * Cut after `keep` programmes and left mid-element, with no closing tag: the
 * bytes simply stop, the pipe closes cleanly, and **nothing in the document
 * says so** — which is why the exit code beside it is what decides.
 */
export function cutShort(text: string, keep = 2): string {
  let at = 0;

  for (let found = 0; found <= keep; found++) {
    const next = text.indexOf('  <programme', at);

    if (next === -1) {
      break;
    }

    at = found === keep ? next : next + 1;
  }

  return `${text.slice(0, at)}  <programme start="`;
}

/** What a grabber says it supports, one per line. */
export function capabilities(names: readonly string[]): Instruction {
  return { write: `${names.join('\n')}\n` };
}

/**
 * The stretch an invocation asked for, as a grabber would answer it.
 *
 * `--offset` is where it starts and `--days` how long it runs; a grabber that
 * answered with days nobody asked for would hide the very thing the window
 * arithmetic is for. With neither, today and tomorrow.
 */
export function documentFor(invocation: Invocation): string {
  const value = (flag: string) => {
    const at = invocation.argv.indexOf(flag);

    return at === -1 ? undefined : Number(invocation.argv[at + 1]);
  };
  const offset = value('--offset') ?? 0;
  const days = value('--days') ?? 2;

  return document({ days: Array.from({ length: days }, (_, index) => offset + index) });
}

/**
 * What a program asked about nothing in particular should answer.
 *
 * The defaults are a working grabber: it supports the lot, covers somewhere,
 * downloads everything at once, and writes the days it was asked for.
 */
export function byDefault(invocation: Invocation): Instruction {
  const asked = (flag: string) => invocation.argv.includes(flag);

  if (asked('--capabilities')) {
    return capabilities(['baseline', 'manualconfig', 'apiconfig', 'preferredmethod']);
  }

  if (asked('--description')) {
    return { write: 'Somewhere on television\n' };
  }

  if (asked('--preferredmethod')) {
    return { write: 'allatonce\n' };
  }

  if (asked('--list-channels')) {
    return { write: channelsOnly() };
  }

  return { write: documentFor(invocation) };
}

/** Start the socket a fake grabber dials, and listen until it is closed. */
export async function startControl(): Promise<Control> {
  const path = join(await mkdtemp(join(tmpdir(), 'epg-control-')), 'sock');
  const invocations: Invocation[] = [];
  let reply: (invocation: Invocation) => Instruction = byDefault;
  /** What an answer threw, if one did — raised by `close` below. */
  let failed: unknown;

  const server: Server = createServer((socket) => {
    let held = '';

    socket.on('data', (chunk) => {
      held += chunk.toString('utf8');

      const end = held.indexOf('\n');

      if (end === -1) {
        return;
      }

      const argv = (JSON.parse(held.slice(0, end)) as { argv: string[] }).argv;
      const invocation: Invocation = { argv, said: argv.join(' ') };

      invocations.push(invocation);

      try {
        socket.end(`${JSON.stringify(reply(invocation))}\n`);
      } catch (error) {
        // An answer that throws would otherwise leave the program waiting for
        // one until the test timed out, which says nothing about why. It is
        // answered with a failure it will report, and kept for `close` to
        // raise — so a mistake in a test reads as a mistake in that test.
        failed ??= error;
        socket.end(`${JSON.stringify({ stderr: String(error), exit: 99 })}\n`);
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(path, resolve));

  return {
    path,
    invocations,
    get said(): string[] {
      return invocations.map((one) => one.said);
    },
    answer: (next) => {
      reply = next;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close(() => {
          if (failed !== undefined) {
            reject(failed instanceof Error ? failed : new Error(String(failed)));

            return;
          }

          resolve();
        });
      }),
  };
}
